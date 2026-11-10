import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { boundedTextBudget, boundedTextCapability, isBoundedText, type BoundedTextAdapter, type BoundedTextRequest } from './BoundedTextCompletion';
import { dispatchBoundedText, type BoundedTextQuota } from './BoundedTextDispatcher';
import type { ModelCompletionResult, ModelGatewayRequest, TestByokConnectionRequestV1, TestByokConnectionResultV1 } from './types';

export interface ModelGatewayAdmission {
  readonly modeForTenant: (tenantId: number) => Promise<'legacy' | 'draining' | 'strict'>;
  readonly strict: StrictModelGateway;
  readonly withLegacyDispatch?: <T>(tenantId: number, operation: () => Promise<T>) => Promise<T>;
}

type ResolveStrictTransport = (scope: { tenantId: number; probeApiKey?: string }) => Promise<{
  adapter: BoundedTextAdapter; isByok: boolean;
}>;

export function deniedStrictCapability(message: string): Error {
  return Object.assign(new Error(message), { code: 'POLICY_DENIED', statusCode: 422 });
}

/** Strict capabilities use the same durable quota protocol as Studio. */
export class StrictModelGateway {
  constructor(private readonly quota: BoundedTextQuota, private readonly resolveTransport: ResolveStrictTransport) {}

  async complete(tenantId: number, request: ModelGatewayRequest): Promise<ModelCompletionResult> {
    const started = performance.now();
    const capability = boundedTextCapability;
    const [system, user] = request.messages;
    if (request.provider !== capability.provider || request.model !== capability.model ||
        request.messages.length !== 2 || system?.role !== 'system' || user?.role !== 'user' ||
        system.name !== undefined || user.name !== undefined || system.toolCallId !== undefined || user.toolCallId !== undefined ||
        request.tools?.length || request.temperature !== undefined || request.workspaceId != null ||
        request.agentRunId != null || request.conversationId != null || request.maxTokens === undefined) {
      throw deniedStrictCapability('Completion requires the bounded text profile and an explicit output token limit');
    }
    const result = await this.dispatch(tenantId, {
      system: system.content, input: user.content, maxCompletionTokens: request.maxTokens,
    }, request.timeoutMs ?? capability.maxTimeoutMs, started, 'completion');
    return {
      provider: capability.provider, model: capability.model, toolCalls: [], text: result.output.text,
      finishReason: result.output.finishReason, costMicroUsd: result.costMicroUsd,
      usage: {
        promptTokens: result.usage.promptTokens, completionTokens: result.usage.completionTokens,
        totalTokens: result.usage.promptTokens + result.usage.completionTokens,
      },
      latencyMs: Math.floor(performance.now() - started),
    };
  }

  async testConnection(tenantId: number, params: TestByokConnectionRequestV1): Promise<TestByokConnectionResultV1> {
    const started = performance.now();
    const capability = boundedTextCapability;
    if (params.provider !== capability.provider || (params.model != null && params.model !== capability.model) || params.baseUrl != null) {
      throw deniedStrictCapability('Connection test requires the bounded model and the official provider endpoint');
    }
    const result = await this.dispatch(tenantId, { system: 'Reply with one word.', input: 'ping', maxCompletionTokens: 1 },
      10_000, started, 'probe', params.apiKey ?? undefined);
    if (!result.output.text.trim()) throw new Error('Bounded connection test returned no text');
    return { ok: true, provider: capability.provider, latencyMs: Math.floor(performance.now() - started) };
  }

  private async dispatch(tenantId: number, request: BoundedTextRequest, timeoutMs: number, started: number,
    purpose: 'completion' | 'probe', probeApiKey?: string) {
    const budget = boundedTextBudget(request.maxCompletionTokens, timeoutMs);
    if (!budget || !isBoundedText(request.system) || !isBoundedText(request.input)) {
      throw deniedStrictCapability('Completion text or budget is outside the bounded profile');
    }
    let transport: Awaited<ReturnType<ResolveStrictTransport>>;
    try {
      transport = await this.resolveTransport({ tenantId, probeApiKey });
    } catch {
      throw deniedStrictCapability('Bounded provider transport is unavailable');
    }
    const requestHash = createHash('sha256').update(JSON.stringify([
      boundedTextCapability.id, tenantId, purpose, timeoutMs, request,
    ])).digest('hex');
    const result = await dispatchBoundedText(this.quota, transport.adapter, {
      tenantId, attemptId: randomUUID(), operation: 'completion', isByok: transport.isByok, started,
      plan: { request, timeoutMs, requestHash, ...budget },
    });
    if (result.status === 'completed') return result;
    if (result.status === 'capability_unavailable') throw deniedStrictCapability('Bounded provider capability is unavailable');
    if (result.status === 'uncertain') {
      throw Object.assign(new Error('Provider outcome or accounting is unconfirmed'), { code: 'MODEL_OUTCOME_UNCONFIRMED', statusCode: 502 });
    }
    throw Object.assign(new Error('Bounded provider attempt returned no usable completion'), { code: 'PROVIDER_ERROR', statusCode: 502 });
  }
}
