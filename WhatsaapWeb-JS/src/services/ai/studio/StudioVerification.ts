import type { TenantScopedUoW } from '../../../db/TenantScopedUoW';
import { AiQuotaReservationStore } from '../gateway/AiQuotaReservationStore';
import type { BoundedTextAdapter } from '../gateway/BoundedTextCompletion';
import { AgentExecutionEvaluator } from './AgentExecutionEvaluator';
import { AgentStudioPublications, dispatchPublishedAgent } from './AgentStudioPublications';
import { BoundedAgentDispatch } from './BoundedAgentDispatch';

/** Explicit verification composition. Its publications are never used by the provider runtime. */
export function createStudioVerification(uow: TenantScopedUoW, adapter: BoundedTextAdapter) {
  const mode = 'verification' as const;
  const dispatcher = new BoundedAgentDispatch(new AiQuotaReservationStore(uow), adapter, false);
  const publications = new AgentStudioPublications(mode);
  return {
    mode,
    publications,
    evaluator: new AgentExecutionEvaluator(uow, dispatcher, mode),
    execute: (command: Parameters<typeof dispatchPublishedAgent>[3] & { version: number }) =>
      dispatchPublishedAgent(uow, publications, dispatcher, command),
  };
}

export type StudioVerification = ReturnType<typeof createStudioVerification>;
