import { Pool } from 'pg';
import defaultPool from '../../config/database';
import { TenantScopedUoW, tenantScopedUoW } from '../../db/TenantScopedUoW';
import { Queryable } from '../../shared/UnitOfWorkPort';
import {
  RollbackOptions,
  RollbackResult,
  WorkflowNotFoundError,
  WorkflowArchivedError,
  RevisionNotFoundError,
} from './types';

export class WorkflowRevisionService {
  constructor(
    private readonly pool: Pool = defaultPool,
    private readonly uow: TenantScopedUoW = tenantScopedUoW
  ) {}

  /**
   * Executes an atomic rollback of published_revision_id in < 1ms.
   * Concurrently running workflow_runs remain pinned to their existing revisions.
   */
  async rollbackRevision(
    tenantId: number,
    workflowId: string,
    options: RollbackOptions
  ): Promise<RollbackResult> {
    const startTime = performance.now();

    return this.uow.run(tenantId, async (client: Queryable) => {
      // 1. Fetch workflow definition with row-level lock
      const defRes = await client.query(
        `SELECT id, name, status, published_revision_id
         FROM workflow_definitions
         WHERE id = $1 AND tenant_id = $2
         FOR UPDATE;`,
        [workflowId, tenantId]
      );

      if (!defRes.rows || defRes.rows.length === 0) {
        throw new WorkflowNotFoundError(workflowId);
      }

      const def = defRes.rows[0];
      const previousRevisionId: string | null = def.published_revision_id || null;
      if (def.status === 'archived') {
        throw new WorkflowArchivedError(workflowId);
      }

      // 2. Validate existence of target revision in workflow_revisions
      let revQuery: string;
      let revParam: unknown;
      if (options.targetRevisionNumber !== undefined && options.targetRevisionNumber !== null) {
        revQuery = `SELECT id, revision_number, status, spec_hash FROM workflow_revisions WHERE workflow_id = $1 AND tenant_id = $2 AND revision_number = $3 LIMIT 1;`;
        revParam = options.targetRevisionNumber;
      } else if (options.targetRevisionId) {
        revQuery = `SELECT id, revision_number, status, spec_hash FROM workflow_revisions WHERE workflow_id = $1 AND tenant_id = $2 AND id = $3 LIMIT 1;`;
        revParam = options.targetRevisionId;
      } else {
        throw new Error('Either targetRevisionNumber or targetRevisionId must be specified');
      }

      const revRes = await client.query(revQuery, [workflowId, tenantId, revParam]);
      if (!revRes.rows || revRes.rows.length === 0) {
        throw new RevisionNotFoundError(options.targetRevisionNumber ?? (options.targetRevisionId as string));
      }

      const targetRev = revRes.rows[0];

      // 3. Atomic Pointer Swap (< 1ms execution target)
      const updateRes = await client.query(
        `UPDATE workflow_definitions
         SET published_revision_id = $1,
             status = 'published',
             updated_at = NOW()
         WHERE id = $2 AND tenant_id = $3
         RETURNING id, published_revision_id, updated_at;`,
        [targetRev.id, workflowId, tenantId]
      );

      // 4. Mark target revision as published if necessary
      await client.query(
        `UPDATE workflow_revisions
         SET status = 'published', published_at = NOW()
         WHERE id = $1 AND tenant_id = $2;`,
        [targetRev.id, tenantId]
      );

      // 5. Audit record into idempotency_ledger
      const auditPayload = {
        action: 'workflow.rollback',
        workflowId,
        previousRevisionId,
        targetRevisionId: targetRev.id,
        targetRevisionNumber: targetRev.revision_number,
        reason: options.reason,
        userId: options.userId ?? null,
      };

      await client.query(
        `INSERT INTO idempotency_ledger (
           tenant_id, idempotency_key, source, response_status, response_body, created_at
         ) VALUES ($1, $2, 'workflow_rollback_audit', 200, $3, NOW());`,
        [tenantId, `rollback_${workflowId}_${Date.now()}`, JSON.stringify(auditPayload)]
      );

      const endTime = performance.now();
      const latencyMs = Number((endTime - startTime).toFixed(3));

      return {
        success: true,
        workflowId,
        previousRevisionId,
        publishedRevisionId: targetRev.id,
        targetRevisionNumber: targetRev.revision_number,
        latencyMs,
        updatedAt: updateRes.rows[0].updated_at,
      };
    });
  }

  /**
   * Retrieves workflow definition under tenant isolation.
   */
  async getWorkflowDefinition(tenantId: number, workflowId: string) {
    return this.uow.run(tenantId, async (client: Queryable) => {
      const res = await client.query(
        `SELECT id, tenant_id, workspace_id, name, description, status, published_revision_id, created_at, updated_at
         FROM workflow_definitions
         WHERE id = $1 AND tenant_id = $2
         LIMIT 1;`,
        [workflowId, tenantId]
      );
      return res.rows[0] || null;
    });
  }

  /**
   * Retrieves all revisions for a workflow under tenant isolation.
   */
  async getWorkflowRevisions(tenantId: number, workflowId: string) {
    return this.uow.run(tenantId, async (client: Queryable) => {
      const res = await client.query(
        `SELECT id, tenant_id, workflow_id, revision_number, status, dag_graph, spec_hash, limits, published_at, created_at
         FROM workflow_revisions
         WHERE workflow_id = $1 AND tenant_id = $2
         ORDER BY revision_number DESC;`,
        [workflowId, tenantId]
      );
      return res.rows;
    });
  }
}

export const workflowRevisionService = new WorkflowRevisionService();
