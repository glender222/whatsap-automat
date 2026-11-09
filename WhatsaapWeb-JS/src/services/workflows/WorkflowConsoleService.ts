import { TenantScopedUoW, tenantScopedUoW } from '../../db/TenantScopedUoW';
import { RevisionNotFoundError, WorkflowNotFoundError } from './types';

const workflowFields = `id, name, description, status, published_revision_id AS "publishedRevisionId", updated_at AS "updatedAt"`;
const recentLimit = 50;

export class WorkflowConsoleService {
  constructor(private readonly uow: TenantScopedUoW = tenantScopedUoW) {}

  list(tenantId: number, offset: number, limit: number) {
    return this.uow.run(tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT ${workflowFields} FROM workflow_definitions
         WHERE tenant_id = $1 ORDER BY updated_at DESC, id LIMIT $2 OFFSET $3`,
        [tenantId, limit + 1, offset],
      );
      return { items: rows.slice(0, limit), hasMore: rows.length > limit };
    });
  }

  getDetail(tenantId: number, workflowId: string, includeWebhooks: boolean) {
    return this.uow.run(tenantId, async (client) => {
      const { rows: [workflow] } = await client.query(
        `SELECT ${workflowFields} FROM workflow_definitions WHERE tenant_id = $1 AND id = $2`,
        [tenantId, workflowId],
      );
      if (!workflow) throw new WorkflowNotFoundError(workflowId);
      const { rows: revisions } = await client.query(
        `SELECT id, revision_number AS "revisionNumber", status, created_at AS "createdAt"
         FROM workflow_revisions WHERE tenant_id = $1 AND workflow_id = $2
         ORDER BY (id IS NOT DISTINCT FROM $4) DESC, revision_number DESC LIMIT $3`,
        [tenantId, workflowId, recentLimit, workflow.publishedRevisionId],
      );
      const { rows: runs } = await client.query(
        `SELECT run.id, run.status, run.revision_id AS "revisionId", revision.revision_number AS "revisionNumber",
                run.started_at AS "startedAt", run.completed_at AS "completedAt", run.current_step AS "currentStep"
         FROM workflow_runs run JOIN workflow_revisions revision
           ON revision.id = run.revision_id AND revision.tenant_id = run.tenant_id AND revision.workflow_id = run.workflow_id
         WHERE run.tenant_id = $1 AND run.workflow_id = $2 ORDER BY run.started_at DESC, run.id LIMIT $3`,
        [tenantId, workflowId, recentLimit],
      );
      if (!includeWebhooks) return { workflow, revisions, runs };
      const { rows: webhooks } = await client.query(
        `SELECT id, endpoint_key AS "endpointKey", is_active AS "isActive", created_at AS "createdAt"
         FROM workflow_triggers WHERE tenant_id = $1 AND workflow_id = $2 AND type = 'webhook'
         ORDER BY is_active DESC, created_at DESC, id`,
        [tenantId, workflowId],
      );
      return { workflow, revisions, runs, webhooks };
    });
  }

  getRevision(tenantId: number, workflowId: string, revisionId: string) {
    return this.uow.run(tenantId, async (client) => {
      const { rows: [revision] } = await client.query(
        `SELECT id, revision_number AS "revisionNumber", status, dag_graph AS "dagGraph", limits, spec_hash AS "specHash"
         FROM workflow_revisions WHERE tenant_id = $1 AND workflow_id = $2 AND id = $3`,
        [tenantId, workflowId, revisionId],
      );
      if (!revision) throw new RevisionNotFoundError(revisionId);
      return revision;
    });
  }
}

export const workflowConsoleService = new WorkflowConsoleService();
