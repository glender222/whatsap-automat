import type { TenantScopedUoW } from '../../../db/TenantScopedUoW';
import { AiQuotaReservationStore } from '../gateway/AiQuotaReservationStore';
import type { BoundedTextAdapter } from '../gateway/BoundedTextCompletion';
import type { createTenantBoundedModelExecution } from '../gateway/TenantBoundedModelExecution';
import { AgentExecutionEvaluator } from './AgentExecutionEvaluator';
import type { ExecutionMode } from './AgentExecutionEvidence';
import { AgentStudioPublications, dispatchPublishedAgent } from './AgentStudioPublications';
import { BoundedAgentDispatch } from './BoundedAgentDispatch';
import { CatalogRouterCheckpointRuntime } from '../runtime/CatalogRouterCheckpointRuntime';
import { CatalogExecutionEvaluator } from './CatalogExecutionEvaluator';
import { CatalogPublicationGate } from './CatalogPublicationGate';

type StudioEvaluationResult = Awaited<ReturnType<AgentExecutionEvaluator['evaluate']>> |
  Awaited<ReturnType<CatalogExecutionEvaluator['evaluate']>>;
interface StudioExecutionEvaluator {
  evaluate(command: Parameters<AgentExecutionEvaluator['evaluate']>[0]): Promise<StudioEvaluationResult>;
  read(...args: Parameters<AgentExecutionEvaluator['read']>): Promise<StudioEvaluationResult | null>;
  cancel(...args: Parameters<AgentExecutionEvaluator['cancel']>): Promise<StudioEvaluationResult | null>;
}

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
    new AgentStudioPublications('provider', (db, tenantId) => execution.policy.assertStrict(db, tenantId), new CatalogPublicationGate(uow)),
    new CatalogExecutionEvaluator(uow, new CatalogRouterCheckpointRuntime(uow, undefined, undefined, execution), 'provider'));
}

export function createStudioProviderAccess(
  uow: TenantScopedUoW, execution: ReturnType<typeof createTenantBoundedModelExecution>,
) {
  const studio = createStudioProviderExecution(uow, execution);
  return async (tenantId: number): Promise<StudioAccess | null> => {
    const policy = await execution.policy.mode(tenantId);
    if (policy === 'paused') return { studio, availability: 'paused' };
    if (policy !== 'strict') return null;
    const transport = await execution.resolveTransport({ tenantId }).catch(() => null);
    return { studio, availability: transport ? 'ready' : 'credential_required' };
  };
}

function createStudioExecution<Mode extends ExecutionMode>(
  uow: TenantScopedUoW, mode: Mode, dispatcher: Pick<BoundedAgentDispatch, 'dispatch'>, publications: AgentStudioPublications,
  catalog?: CatalogExecutionEvaluator,
) {
  const linear = new AgentExecutionEvaluator(uow, dispatcher, mode);
  const evaluator: StudioExecutionEvaluator = catalog ? {
    async evaluate(command: Parameters<AgentExecutionEvaluator['evaluate']>[0]) {
      const { rows: [suite] } = await uow.run(command.tenantId, (db) => db.query(`
        SELECT execution_profile FROM agent_eval_suites WHERE tenant_id=$1 AND agent_graph_id=$2 AND id=$3
      `, [command.tenantId, command.graphId, command.suiteId]));
      const result = await (suite?.execution_profile === 'catalog-router-v1' ? catalog : linear).evaluate(command);
      return withReadiness(command.tenantId, result);
    },
    read: (...args: Parameters<AgentExecutionEvaluator['read']>) => observe(false, ...args),
    cancel: (...args: Parameters<AgentExecutionEvaluator['cancel']>) => observe(true, ...args),
  } : linear;

  async function observe(cancel: boolean, tenantId: number, graphId: string, version: number, runId: string) {
    const { rows: [run] } = await uow.run(tenantId, (db) => db.query(`
      SELECT execution_profile FROM agent_eval_runs
      WHERE tenant_id=$1 AND agent_graph_id=$2 AND graph_version=$3 AND id=$4 AND execution_mode=$5
    `, [tenantId, graphId, version, runId, mode]));
    const selected = catalog && run?.execution_profile === 'catalog-router-v1' ? catalog : linear;
    const result = await (cancel ? selected.cancel(tenantId, graphId, version, runId) : selected.read(tenantId, graphId, version, runId));
    return result ? withReadiness(tenantId,result) : null;
  }

  async function withReadiness(tenantId: number, result: StudioEvaluationResult): Promise<StudioEvaluationResult> {
    if (!('profile' in result) || result.profile !== 'catalog-router-v1' || result.status !== 'completed' || !result.passed) return result;
    const readiness = await uow.run(tenantId, async (db) => {
      await db.query("SET LOCAL statement_timeout='1000ms'");
      await db.query("SET LOCAL lock_timeout='1000ms'");
      return publications.catalogReadiness(db,tenantId,result.graphId,result.version,result.runId);
    });
    return { ...result, ...readiness };
  }
  return {
    mode,
    publications,
    evaluator,
    execute: (command: Parameters<typeof dispatchPublishedAgent>[3] & { version: number }) =>
      dispatchPublishedAgent(uow, publications, dispatcher, command),
  };
}

export type StudioVerification = ReturnType<typeof createStudioVerification>;
export type StudioAccess = {
  studio: StudioVerification | ReturnType<typeof createStudioProviderExecution>;
  availability: 'ready' | 'paused' | 'credential_required';
};
export type StudioProviderAccess = ReturnType<typeof createStudioProviderAccess>;
