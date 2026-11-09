import { ApplicationFailure } from '@temporalio/activity';
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
         temporal_run_id = COALESCE(temporal_run_id, $8),
         completed_at = CASE
           WHEN $6 IN ('completed', 'failed', 'cancelled') THEN COALESCE(completed_at, NOW())
           ELSE NULL
         END
       WHERE id = $1 AND tenant_id = $2
         AND ($8::text IS NULL OR temporal_run_id IS NULL OR temporal_run_id = $8)
         AND ($9::text IS NULL OR temporal_workflow_id = $9)
         AND ($10::text IS NULL OR workflow_id = $10)
         AND step_count <= $4
         AND (status NOT IN ('completed', 'failed', 'cancelled') OR status = $6
              OR error_details->>'code' = 'TEMPORAL_DISPATCH_UNCONFIRMED')
       RETURNING id, current_step, step_count, status, completed_at;`,
      [
        input.runId,
        input.tenantId,
        input.currentStep,
        input.stepCount,
        JSON.stringify(input.stateSnapshot || {}),
        input.status,
        input.errorDetails ? JSON.stringify(input.errorDetails) : null,
        input.temporalRunId ?? null,
        input.temporalWorkflowId ?? null,
        input.workflowId ?? null,
      ]
    );
    if (!updateRes.rows[0]) {
      throw ApplicationFailure.nonRetryable('The workflow run does not accept this checkpoint.', 'INVALID_WORKFLOW_CHECKPOINT');
    }

    return {
      runId: input.runId,
      stepCount: input.stepCount,
      status: input.status,
      updatedAt: new Date().toISOString(),
    };
  });
}
