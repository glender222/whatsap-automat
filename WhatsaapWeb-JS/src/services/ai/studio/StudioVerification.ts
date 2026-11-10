import type { TenantScopedUoW } from '../../../db/TenantScopedUoW';
import { AiQuotaReservationStore } from '../gateway/AiQuotaReservationStore';
import type { BoundedTextAdapter } from '../gateway/BoundedTextCompletion';
import type { createTenantBoundedModelExecution } from '../gateway/TenantBoundedModelExecution';
import { AgentExecutionEvaluator } from './AgentExecutionEvaluator';
import type { ExecutionMode } from './AgentExecutionEvidence';
import { AgentStudioPublications, dispatchPublishedAgent } from './AgentStudioPublications';
import { BoundedAgentDispatch } from './BoundedAgentDispatch';

/** Explicit verification composition. Its publications are never used by the provider runtime. */
export function createStudioVerification(uow: TenantScopedUoW, adapter: BoundedTextAdapter) {
  const dispatcher = new BoundedAgentDispatch(new AiQuotaReservationStore(uow), adapter, false);
  return createStudioExecution(uow, 'verification', dispatcher, new AgentStudioPublications('verification'));
}

export function createStudioProviderExecution(
  uow: TenantScopedUoW, execution: ReturnType<typeof createTenantBoundedModelExecution>,
) {
  const dispatcher: Pick<BoundedAgentDispatch, 'dispatch'> = {
    async dispatch(command) {
      const transport = await execution.resolveTransport({ tenantId: command.tenantId }).catch(() => null);
      if (!transport) return { status: 'provider_unavailable', publicationEvidence: false };
      return new BoundedAgentDispatch(execution.quota, transport.adapter, transport.isByok).dispatch(command);
    },
  };
  return createStudioExecution(uow, 'provider', dispatcher,
    new AgentStudioPublications('provider', (db, tenantId) => execution.policy.assertStrict(db, tenantId)));
}

function createStudioExecution<Mode extends ExecutionMode>(
  uow: TenantScopedUoW, mode: Mode, dispatcher: Pick<BoundedAgentDispatch, 'dispatch'>, publications: AgentStudioPublications,
) {
  return {
    mode,
    publications,
    evaluator: new AgentExecutionEvaluator(uow, dispatcher, mode),
    execute: (command: Parameters<typeof dispatchPublishedAgent>[3] & { version: number }) =>
      dispatchPublishedAgent(uow, publications, dispatcher, command),
  };
}

export type StudioVerification = ReturnType<typeof createStudioVerification>;
