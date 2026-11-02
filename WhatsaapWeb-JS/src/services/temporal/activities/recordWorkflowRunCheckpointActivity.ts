import { TenantScopedUoW, tenantScopedUoW } from '../../../db/TenantScopedUoW';
import { Queryable } from '../../../shared/UnitOfWorkPort';
import type { CheckpointInput, CheckpointResult } from './types';

/**
 * Persists intermediate execution checkpoints to workflow_runs table
 * under TenantScopedUoW RLS transaction.
 */
export async function recordWorkflowRunCheckpointActivity(
  input: CheckpointInput,
  uow: TenantScopedUoW = tenantScopedUoW
): Promise<CheckpointResult> {
  return await uow.run(input.tenantId, async (client: Queryable) => {
    const updateRes = await client.query(
      `UPDATE workflow_runs
       SET
         current_step = $3,
         step_count = $4,
         state_snapshot = $5,
         status = $6,
         error_details = $7,
         completed_at = CASE
           WHEN $6 IN ('completed', 'failed', 'cancelled') THEN NOW()
           ELSE completed_at
         END
       WHERE id = $1 AND tenant_id = $2
       RETURNING id, current_step, step_count, status, completed_at;`,
      [
        input.runId,
        input.tenantId,
        input.currentStep,
        input.stepCount,
        JSON.stringify(input.stateSnapshot || {}),
        input.status,
        input.errorDetails ? JSON.stringify(input.errorDetails) : null,
      ]
    );

    return {
      runId: input.runId,
      stepCount: input.stepCount,
      status: input.status,
      updatedAt: new Date().toISOString(),
    };
  });
}
