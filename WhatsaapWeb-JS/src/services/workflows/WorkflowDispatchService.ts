import { Pool } from 'pg';
import defaultPool from '../../config/database';
import { TenantScopedUoW } from '../../db/TenantScopedUoW';
import { OutboxRecord } from '../outbox/OutboxRepository';
import { WorkflowStartOptions } from '../temporal/types';
import { DurableWorkflowInput } from '../temporal/workflows/types';
import { validateWorkflowRevision } from './validateWorkflowRevision';
import { WorkflowInputError } from './types';

export const AUTOMATION_TASK_QUEUE = 'automation-workflows-v1';

function permanentError(message: string): Error {
  return Object.assign(new Error(message), { code: 'PERMANENT_ERROR' });
}

export class WorkflowDispatchService {
  constructor(private readonly db: Pool = defaultPool, private readonly uow = new TenantScopedUoW(db)) {}

  async getTenantIds(): Promise<number[]> {
    const { rows } = await this.db.query<{ tenant_id: number }>('SELECT tenant_id FROM workflow_dispatch_tenants ORDER BY tenant_id');
    return rows.map((row) => row.tenant_id);
  }

  async prepare(tenantId: number, record: OutboxRecord): Promise<{ workflowType: string; options: WorkflowStartOptions }> {
    const payload = record.payload as { runId?: unknown } | null;
    if (record.tenant_id !== tenantId || typeof payload?.runId !== 'string' || !payload.runId) {
      throw permanentError('The outbox record does not reference a workflow run in its tenant.');
    }

    return this.uow.run(tenantId, async (client) => {
      const { rows: [run] } = await client.query(`
        SELECT run.id, run.tenant_id, run.workflow_id, run.revision_id, run.temporal_workflow_id,
               run.trigger_type, run.trigger_payload, run.correlation_id, revision.dag_graph, revision.limits
        FROM workflow_runs AS run
        JOIN workflow_revisions AS revision ON revision.id = run.revision_id
          AND revision.tenant_id = run.tenant_id AND revision.workflow_id = run.workflow_id
        WHERE run.id = $1 AND run.tenant_id = $2 AND run.correlation_id = $3
      `, [payload.runId, tenantId, record.correlation_id]);
      if (!run) throw permanentError('The pinned workflow revision was not found.');

      try {
        const revision = validateWorkflowRevision(run.dag_graph, run.limits);
        const input: DurableWorkflowInput = {
          tenantId,
          workflowId: run.workflow_id,
          runId: run.id,
          revisionId: run.revision_id,
          triggerType: run.trigger_type,
          triggerPayload: run.trigger_payload,
          correlationId: run.correlation_id,
          dagGraph: revision.dagGraph,
          limits: revision.limits,
        };
        return {
          workflowType: 'DurableAutomationWorkflow',
          options: {
            workflowId: run.temporal_workflow_id,
            taskQueue: AUTOMATION_TASK_QUEUE,
            args: [input],
            workflowIdReusePolicy: 'REJECT_DUPLICATE',
            workflowExecutionTimeout: Math.min(revision.limits.maxDurationSeconds, revision.limits.timeoutSeconds) * 1000 + 60_000,
          },
        };
      } catch (error) {
        if (error instanceof WorkflowInputError) throw permanentError('The pinned workflow revision is not executable.');
        throw error;
      }
    });
  }
}
