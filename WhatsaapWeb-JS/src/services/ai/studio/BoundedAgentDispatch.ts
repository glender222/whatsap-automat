import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { AgentGraphVersionV1 } from '@whatsap-automat/contracts';
import type { AiQuotaReservationStore, AiQuotaSettlement } from '../gateway/AiQuotaReservationStore';
import {
  boundedTextCapability, boundedTextCost, type BoundedTextAdapter, type BoundedTextRequest, type BoundedTextResult,
} from '../gateway/BoundedTextCompletion';
import { compileAgentExecutionProfile } from './AgentExecutionProfile';

interface DispatchCommand {
  readonly tenantId: number;
  readonly attemptId: string;
  readonly graph: AgentGraphVersionV1;
  readonly input: string;
  readonly timeoutMs: number;
}

type PreflightError = 'REVISION_SCOPE' | 'REVISION_PROFILE' | 'MODEL_CAPABILITY' | 'TEXT_INPUT' | 'DISPATCH_BUDGET';

type DispatchPreflight = { readonly ok: false; readonly code: PreflightError } | {
  readonly ok: true;
  readonly request: BoundedTextRequest;
  readonly requestHash: string;
  readonly maxTokens: number;
  readonly maxCostMicroUsd: number;
  readonly timeoutMs: number;
};

type DispatchResult = { readonly publicationEvidence: false } & (
  { readonly status: 'preflight_rejected'; readonly code: PreflightError } |
  { readonly status: 'not_dispatched'; readonly reason: 'claim_unavailable' | 'deadline_expired' } |
  { readonly status: 'uncertain'; readonly reason: 'provider_outcome' | 'accounting' } |
  { readonly status: 'budget_exhausted' | 'output_unusable'; readonly ledgerId: number } |
  { readonly status: 'completed'; readonly ledgerId: number; readonly costMicroUsd: number;
    readonly usage: BoundedTextResult['usage']; readonly output: NonNullable<BoundedTextResult['output']> }
);

export function preflightBoundedAgentDispatch(command: Omit<DispatchCommand, 'attemptId'>): DispatchPreflight {
  const { tenantId, graph, input, timeoutMs } = command;
  if (!Number.isSafeInteger(tenantId) || tenantId < 1 || graph.tenantId !== String(tenantId)) {
    return { ok: false, code: 'REVISION_SCOPE' };
  }
  const compiled = compileAgentExecutionProfile(graph);
  if (!compiled.compatible) return { ok: false, code: 'REVISION_PROFILE' };
  const { graphId, version, specHash, limits, completion } = compiled.plan;
  const capability = boundedTextCapability;
  if (completion.provider !== capability.provider || completion.model !== capability.model) {
    return { ok: false, code: 'MODEL_CAPABILITY' };
  }
  if (typeof input !== 'string' || !input.trim() || input.length > 4096 || /[\u0000\uD800-\uDFFF]/u.test(input)) {
    return { ok: false, code: 'TEXT_INPUT' };
  }
  // The whole context window covers provider-added formatting without estimating tokenization.
  const maxTokens = capability.maxPromptTokens + completion.maxTokens;
  const maxCostMicroUsd = boundedTextCost(capability.maxPromptTokens, completion.maxTokens);
  if (completion.maxTokens > capability.maxCompletionTokens || maxTokens > limits.maxModelTokens ||
      maxCostMicroUsd > limits.maxCostMicroUsd || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 ||
      timeoutMs > capability.maxTimeoutMs || timeoutMs > limits.maxDurationSeconds * 1000) {
    return { ok: false, code: 'DISPATCH_BUDGET' };
  }
  const request = { system: completion.prompt, input, maxCompletionTokens: completion.maxTokens };
  const requestHash = createHash('sha256').update(JSON.stringify([
    capability.id, tenantId, graphId, version, specHash, maxTokens, maxCostMicroUsd, timeoutMs, request,
  ])).digest('hex');
  return { ok: true, request, requestHash, maxTokens, maxCostMicroUsd, timeoutMs };
}

async function completeWithinDeadline(adapter: BoundedTextAdapter, request: BoundedTextRequest, remainingMs: number) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('Bounded completion deadline elapsed'));
      }, remainingMs);
    });
    return await Promise.race([deadline, adapter.complete(request, controller.signal)]);
  } finally {
    clearTimeout(timer);
  }
}

/** Internal attempt execution. Production composition depends on coordinated quota admission for every caller. */
export class BoundedAgentDispatch {
  constructor(
    private readonly quota: Pick<AiQuotaReservationStore, 'reserve' | 'claim' | 'settle'>,
    private readonly adapter: BoundedTextAdapter,
    private readonly isByok: boolean,
  ) {}

  async dispatch(command: DispatchCommand): Promise<DispatchResult> {
    const started = performance.now();
    const noEvidence = { publicationEvidence: false } as const;
    const plan = preflightBoundedAgentDispatch(command);
    if (!plan.ok) return { ...noEvidence, status: 'preflight_rejected', code: plan.code };
    const capability = boundedTextCapability;
    if (this.adapter.capabilityId !== capability.id) {
      return { ...noEvidence, status: 'preflight_rejected', code: 'MODEL_CAPABILITY' };
    }

    const { tenantId, attemptId } = command;
    await this.quota.reserve(tenantId, {
      id: attemptId, requestHash: plan.requestHash, operation: 'eval', provider: capability.provider,
      model: capability.model, maxCostMicroUsd: plan.maxCostMicroUsd, maxTokens: plan.maxTokens,
    });
    const permit = await this.quota.claim(tenantId, attemptId, plan.requestHash);
    if (!permit) return { ...noEvidence, status: 'not_dispatched', reason: 'claim_unavailable' };
    const remainingMs = Math.floor(Math.min(plan.timeoutMs - (performance.now() - started), permit.dispatchBefore.getTime() - Date.now()));
    const settle = (values: Pick<AiQuotaSettlement, 'status' | 'costMicroUsd' | 'promptTokens' | 'completionTokens'>) =>
      this.quota.settle(tenantId, {
        ...values, id: attemptId, claimToken: permit.token, isByok: this.isByok,
        latencyMs: Math.floor(performance.now() - started),
      });

    if (remainingMs <= 0) {
      try {
        await settle({ status: 'timeout', costMicroUsd: 0, promptTokens: 0, completionTokens: 0 });
        return { ...noEvidence, status: 'not_dispatched', reason: 'deadline_expired' };
      } catch {
        return { ...noEvidence, status: 'uncertain', reason: 'accounting' };
      }
    }

    let result: BoundedTextResult;
    const responseDeadline = performance.now() + remainingMs;
    try {
      result = await completeWithinDeadline(this.adapter, plan.request, remainingMs);
    } catch {
      return { ...noEvidence, status: 'uncertain', reason: 'provider_outcome' };
    }
    const usage = result?.usage;
    if (!usage) return { ...noEvidence, status: 'uncertain', reason: 'provider_outcome' };
    const responseWasLate = performance.now() >= responseDeadline;
    const output = responseWasLate ? null : result.output;
    const { promptTokens, completionTokens, cachedTokens } = usage;
    if (![promptTokens, completionTokens, cachedTokens].every(Number.isSafeInteger) ||
        promptTokens < 1 || completionTokens < 0 || cachedTokens < 0 || cachedTokens > promptTokens ||
        promptTokens + completionTokens > 2_147_483_647) {
      return { ...noEvidence, status: 'uncertain', reason: 'provider_outcome' };
    }
    const costMicroUsd = boundedTextCost(promptTokens, completionTokens, cachedTokens);
    const exceedsBound = promptTokens > capability.maxPromptTokens || completionTokens > plan.request.maxCompletionTokens ||
      costMicroUsd > plan.maxCostMicroUsd;
    try {
      const { ledgerId, overrun } = await settle({
        status: exceedsBound ? 'budget_exhausted' : responseWasLate ? 'timeout' : output ? 'success' : 'failed',
        costMicroUsd, promptTokens, completionTokens,
      });
      if (overrun || exceedsBound) return { ...noEvidence, status: 'budget_exhausted', ledgerId };
      if (!output) return { ...noEvidence, status: 'output_unusable', ledgerId };
      return { ...noEvidence, status: 'completed', ledgerId, costMicroUsd, usage, output };
    } catch {
      return { ...noEvidence, status: 'uncertain', reason: 'accounting' };
    }
  }
}
