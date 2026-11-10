import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { AgentGraphVersionV1 } from '@whatsap-automat/contracts';
import {
  boundedTextCapability, boundedTextBudget, isBoundedText, type BoundedTextAdapter,
} from '../gateway/BoundedTextCompletion';
import {
  dispatchBoundedText, type BoundedTextDispatchResult, type BoundedTextPlan, type BoundedTextQuota,
} from '../gateway/BoundedTextDispatcher';
import { compileAgentExecutionProfile } from './AgentExecutionProfile';

interface DispatchCommand {
  readonly tenantId: number;
  readonly attemptId: string;
  readonly graph: AgentGraphVersionV1;
  readonly input: string;
  readonly timeoutMs: number;
  readonly operation?: 'eval' | 'completion';
}

type PreflightError = 'REVISION_SCOPE' | 'REVISION_PROFILE' | 'MODEL_CAPABILITY' | 'TEXT_INPUT' | 'DISPATCH_BUDGET';

type DispatchPreflight = { readonly ok: false; readonly code: PreflightError } | ({ readonly ok: true } & BoundedTextPlan);

type DispatchResult = { readonly publicationEvidence: false } & (
  { readonly status: 'preflight_rejected'; readonly code: PreflightError } |
  Exclude<BoundedTextDispatchResult, { status: 'capability_unavailable' }>
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
  if (!isBoundedText(input)) {
    return { ok: false, code: 'TEXT_INPUT' };
  }
  const budget = boundedTextBudget(completion.maxTokens, timeoutMs);
  if (!budget || budget.maxTokens > limits.maxModelTokens || budget.maxCostMicroUsd > limits.maxCostMicroUsd ||
      timeoutMs > limits.maxDurationSeconds * 1000) {
    return { ok: false, code: 'DISPATCH_BUDGET' };
  }
  const { maxTokens, maxCostMicroUsd } = budget;
  const request = { system: completion.prompt, input, maxCompletionTokens: completion.maxTokens };
  const requestHash = createHash('sha256').update(JSON.stringify([
    capability.id, tenantId, graphId, version, specHash, maxTokens, maxCostMicroUsd, timeoutMs, request,
  ])).digest('hex');
  return { ok: true, request, requestHash, maxTokens, maxCostMicroUsd, timeoutMs };
}

/** Internal attempt execution. Production composition depends on coordinated quota admission for every caller. */
export class BoundedAgentDispatch {
  constructor(
    private readonly quota: BoundedTextQuota,
    private readonly adapter: BoundedTextAdapter,
    private readonly isByok: boolean,
  ) {}

  async dispatch(command: DispatchCommand): Promise<DispatchResult> {
    const started = performance.now();
    const noEvidence = { publicationEvidence: false } as const;
    const plan = preflightBoundedAgentDispatch(command);
    if (!plan.ok) return { ...noEvidence, status: 'preflight_rejected', code: plan.code };

    const { tenantId, attemptId } = command;
    const result = await dispatchBoundedText(this.quota, this.adapter, {
      tenantId, attemptId, operation: command.operation ?? 'eval', plan, isByok: this.isByok, started,
    });
    if (result.status === 'capability_unavailable') {
      return { ...noEvidence, status: 'preflight_rejected', code: 'MODEL_CAPABILITY' };
    }
    return { ...noEvidence, ...result };
  }
}
