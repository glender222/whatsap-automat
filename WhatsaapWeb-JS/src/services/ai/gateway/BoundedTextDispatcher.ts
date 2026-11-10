import { performance } from 'node:perf_hooks';
import type { AiQuotaReservationStore, AiQuotaSettlement } from './AiQuotaReservationStore';
import {
  boundedTextBudget, boundedTextCapability, boundedTextCost, isBoundedText,
  type BoundedTextAdapter, type BoundedTextRequest, type BoundedTextResult,
} from './BoundedTextCompletion';

export type BoundedTextQuota = Pick<AiQuotaReservationStore, 'reserve' | 'claim' | 'settle'>;

export interface BoundedTextPlan {
  readonly request: BoundedTextRequest;
  readonly requestHash: string;
  readonly maxTokens: number;
  readonly maxCostMicroUsd: number;
  readonly timeoutMs: number;
}

export type BoundedTextDispatchResult =
  { readonly status: 'capability_unavailable' } |
  { readonly status: 'not_dispatched'; readonly reason: 'claim_unavailable' | 'deadline_expired' } |
  { readonly status: 'uncertain'; readonly reason: 'provider_outcome' | 'accounting' } |
  { readonly status: 'budget_exhausted' | 'output_unusable'; readonly ledgerId: number } |
  { readonly status: 'completed'; readonly ledgerId: number; readonly costMicroUsd: number;
    readonly usage: BoundedTextResult['usage']; readonly output: NonNullable<BoundedTextResult['output']> };

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

/** The caller supplies a validated plan and the transport bound to its provider capability. */
export async function dispatchBoundedText(
  quota: BoundedTextQuota,
  adapter: BoundedTextAdapter,
  command: { tenantId: number; attemptId: string; operation: 'eval' | 'completion'; plan: BoundedTextPlan;
    isByok: boolean; started: number },
): Promise<BoundedTextDispatchResult> {
  const { tenantId, attemptId, operation, plan, isByok, started } = command;
  const capability = boundedTextCapability;
  const budget = boundedTextBudget(plan.request.maxCompletionTokens, plan.timeoutMs);
  if (adapter.capabilityId !== capability.id || !budget || budget.maxTokens !== plan.maxTokens ||
      budget.maxCostMicroUsd !== plan.maxCostMicroUsd || !isBoundedText(plan.request.system) || !isBoundedText(plan.request.input)) {
    return { status: 'capability_unavailable' };
  }

  await quota.reserve(tenantId, {
    id: attemptId, requestHash: plan.requestHash, operation, provider: capability.provider,
    model: capability.model, maxCostMicroUsd: plan.maxCostMicroUsd, maxTokens: plan.maxTokens,
  });
  const permit = await quota.claim(tenantId, attemptId, plan.requestHash);
  if (!permit) return { status: 'not_dispatched', reason: 'claim_unavailable' };
  const remainingMs = Math.floor(Math.min(plan.timeoutMs - (performance.now() - started), permit.dispatchBefore.getTime() - Date.now()));
  const settle = (values: Pick<AiQuotaSettlement, 'status' | 'costMicroUsd' | 'promptTokens' | 'completionTokens'>) =>
    quota.settle(tenantId, {
      ...values, id: attemptId, claimToken: permit.token, isByok,
      latencyMs: Math.floor(performance.now() - started),
    });

  if (remainingMs <= 0) {
    try {
      await settle({ status: 'timeout', costMicroUsd: 0, promptTokens: 0, completionTokens: 0 });
      return { status: 'not_dispatched', reason: 'deadline_expired' };
    } catch {
      return { status: 'uncertain', reason: 'accounting' };
    }
  }

  let result: BoundedTextResult;
  const responseDeadline = performance.now() + remainingMs;
  try {
    result = await completeWithinDeadline(adapter, plan.request, remainingMs);
  } catch {
    return { status: 'uncertain', reason: 'provider_outcome' };
  }
  const usage = result?.usage;
  if (!usage) return { status: 'uncertain', reason: 'provider_outcome' };
  const responseWasLate = performance.now() >= responseDeadline;
  const output = responseWasLate ? null : result.output;
  const { promptTokens, completionTokens, cachedTokens } = usage;
  if (![promptTokens, completionTokens, cachedTokens].every(Number.isSafeInteger) ||
      promptTokens < 1 || completionTokens < 0 || cachedTokens < 0 || cachedTokens > promptTokens ||
      promptTokens + completionTokens > 2_147_483_647) {
    return { status: 'uncertain', reason: 'provider_outcome' };
  }
  const costMicroUsd = boundedTextCost(promptTokens, completionTokens, cachedTokens);
  const exceedsBound = promptTokens > capability.maxPromptTokens || completionTokens > plan.request.maxCompletionTokens ||
    costMicroUsd > plan.maxCostMicroUsd;
  try {
    const { ledgerId, overrun } = await settle({
      status: exceedsBound ? 'budget_exhausted' : responseWasLate ? 'timeout' : output ? 'success' : 'failed',
      costMicroUsd, promptTokens, completionTokens,
    });
    if (overrun || exceedsBound) return { status: 'budget_exhausted', ledgerId };
    if (!output) return { status: 'output_unusable', ledgerId };
    return { status: 'completed', ledgerId, costMicroUsd, usage, output };
  } catch {
    return { status: 'uncertain', reason: 'accounting' };
  }
}
