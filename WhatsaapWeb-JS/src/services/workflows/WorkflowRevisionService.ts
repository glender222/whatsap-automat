import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { computeWorkflowSpecHash } from '@whatsap-automat/contracts';
import defaultPool from '../../config/database';
import { TenantScopedUoW } from '../../db/TenantScopedUoW';
import { Queryable } from '../../shared/UnitOfWorkPort';
import {
  RollbackOptions,
  RollbackResult,
  WorkflowNotFoundError,
  WorkflowArchivedError,
  WorkflowInputError,
  WorkflowNotPublishedError,
  RevisionNotFoundError,
  TriggerNotFoundError,
} from './types';
import { validateWorkflowRevision } from './validateWorkflowRevision';

type ValidatedRevision = ReturnType<typeof validateWorkflowRevision>;

async function lockDefinition(client: Queryable, tenantId: number, workflowId: string) {
  const { rows: [definition] } = await client.query(`
    SELECT id, status FROM workflow_definitions WHERE id = $1 AND tenant_id = $2 FOR UPDATE
  `, [workflowId, tenantId]);
  if (!definition) throw new WorkflowNotFoundError(workflowId);
  if (definition.status === 'archived') throw new WorkflowArchivedError(workflowId);
  return definition;
}

async function insertDraft(
  client: Queryable,
  tenantId: number,
  workflowId: string,
  revisionNumber: number,
  revision: ValidatedRevision
) {
  const id = `revision_${randomUUID()}`;
  const specHash = computeWorkflowSpecHash(revision.dagGraph, revision.limits);
  await client.query(`
    INSERT INTO workflow_revisions (id, tenant_id, workflow_id, revision_number, dag_graph, spec_hash, limits)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
  `, [id, tenantId, workflowId, revisionNumber, JSON.stringify(revision.dagGraph), specHash, JSON.stringify(revision.limits)]);
  return { id, workflowId, revisionNumber, specHash, status: 'draft' as const };
}

export class WorkflowRevisionService {
  constructor(
    pool: Pool = defaultPool,
    private readonly uow = new TenantScopedUoW(pool)
  ) {}

  async createWorkflow(tenantId: number, input: { name: unknown; description?: unknown; dagGraph: unknown; limits?: unknown }) {
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 255 ||
        (input.description !== undefined && (typeof input.description !== 'string' || input.description.length > 2000))) {
      throw new WorkflowInputError('A workflow needs a name of up to 255 characters and an optional short description.');
    }
    const name = input.name.trim();
    const description = input.description ?? null;
    const revision = validateWorkflowRevision(input.dagGraph, input.limits);
    const workflowId = `workflow_${randomUUID()}`;
    return this.uow.run(tenantId, async (client) => {
      await client.query(`
        INSERT INTO workflow_definitions (id, tenant_id, name, description) VALUES ($1, $2, $3, $4)
      `, [workflowId, tenantId, name, description]);
      const draft = await insertDraft(client, tenantId, workflowId, 1, revision);
      return { workflowId, name, status: 'draft' as const, revision: draft };
    });
  }

  async createRevision(tenantId: number, workflowId: string, graph: unknown, limits: unknown) {
    const revision = validateWorkflowRevision(graph, limits);
    return this.uow.run(tenantId, async (client) => {
      await lockDefinition(client, tenantId, workflowId);
      const { rows: [{ next_revision: revisionNumber }] } = await client.query(`
        SELECT COALESCE(max(revision_number), 0) + 1 AS next_revision
        FROM workflow_revisions WHERE tenant_id = $1 AND workflow_id = $2
      `, [tenantId, workflowId]);
      return insertDraft(client, tenantId, workflowId, revisionNumber, revision);
    });
  }

  async publishRevision(tenantId: number, workflowId: string, revisionId: string) {
    return this.uow.run(tenantId, async (client) => {
      await lockDefinition(client, tenantId, workflowId);
      const { rows: [revision] } = await client.query(`
        SELECT status, dag_graph, limits FROM workflow_revisions
        WHERE id = $1 AND tenant_id = $2 AND workflow_id = $3
      `, [revisionId, tenantId, workflowId]);
      if (!revision || revision.status === 'archived') throw new RevisionNotFoundError(revisionId);
      validateWorkflowRevision(revision.dag_graph, revision.limits);
      await client.query(`
        UPDATE workflow_revisions SET status = 'published', published_at = COALESCE(published_at, NOW())
        WHERE id = $1 AND tenant_id = $2
      `, [revisionId, tenantId]);
      await client.query(`
        UPDATE workflow_definitions SET published_revision_id = $1, status = 'published', updated_at = NOW()
        WHERE id = $2 AND tenant_id = $3
      `, [revisionId, workflowId, tenantId]);
      return { workflowId, publishedRevisionId: revisionId, status: 'published' as const };
    });
  }

  async createWebhookTrigger(tenantId: number, workflowId: string) {
    const id = `trigger_${randomUUID()}`;
    const endpointKey = randomBytes(18).toString('hex');
    const token = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    return this.uow.run(tenantId, async (client) => {
      const definition = await lockDefinition(client, tenantId, workflowId);
      if (definition.status !== 'published') throw new WorkflowNotPublishedError(workflowId);
      await client.query(`
        INSERT INTO workflow_triggers (id, tenant_id, workflow_id, type, endpoint_key, auth_token_hash)
        VALUES ($1, $2, $3, 'webhook', $4, $5)
      `, [id, tenantId, workflowId, endpointKey, tokenHash]);
      return { id, workflowId, type: 'webhook' as const, endpointKey, token };
    });
  }

  async setWebhookTriggerActive(tenantId: number, workflowId: string, triggerId: string, isActive: boolean) {
    return this.uow.run(tenantId, async (client) => {
      const { rows: [trigger] } = await client.query(`
        UPDATE workflow_triggers SET is_active = $4, updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2 AND workflow_id = $3 AND type = 'webhook'
        RETURNING id, workflow_id AS "workflowId", endpoint_key AS "endpointKey", is_active AS "isActive"
      `, [triggerId, tenantId, workflowId, isActive]);
      if (!trigger) throw new TriggerNotFoundError(triggerId);
      return trigger;
    });
  }

  async getRun(tenantId: number, runId: string) {
    return this.uow.run(tenantId, async (client) => {
      const { rows: [run] } = await client.query(`
        SELECT id, tenant_id::text AS "tenantId", workspace_id::text AS "workspaceId",
               workflow_id AS "workflowId", revision_id AS "revisionId", temporal_workflow_id AS "temporalWorkflowId",
               temporal_run_id AS "temporalRunId", correlation_id AS "correlationId", trigger_type AS "triggerType",
               trigger_payload AS "inputPayload", state_snapshot AS "outputPayload", status, current_step AS "currentStep",
               step_count AS "stepCount", started_at AS "startedAt", completed_at AS "completedAt", error_details AS "errorDetails"
        FROM workflow_runs WHERE id = $1 AND tenant_id = $2
      `, [runId, tenantId]);
      return run ?? null;
    });
  }

  /**
   * Atomically swaps the published revision pointer.
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
        revQuery = `SELECT id, revision_number, status FROM workflow_revisions WHERE workflow_id = $1 AND tenant_id = $2 AND revision_number = $3 LIMIT 1;`;
        revParam = options.targetRevisionNumber;
      } else if (options.targetRevisionId) {
        revQuery = `SELECT id, revision_number, status FROM workflow_revisions WHERE workflow_id = $1 AND tenant_id = $2 AND id = $3 LIMIT 1;`;
        revParam = options.targetRevisionId;
      } else {
        throw new Error('Either targetRevisionNumber or targetRevisionId must be specified');
      }

      const revRes = await client.query(revQuery, [workflowId, tenantId, revParam]);
      if (revRes.rows[0]?.status !== 'published') {
        throw new RevisionNotFoundError(options.targetRevisionNumber ?? (options.targetRevisionId as string));
      }

      const targetRev = revRes.rows[0];

      // 3. Atomic pointer swap
      const updateRes = await client.query(
        `UPDATE workflow_definitions
         SET published_revision_id = $1,
             status = 'published',
             updated_at = NOW()
         WHERE id = $2 AND tenant_id = $3
         RETURNING id, published_revision_id, updated_at;`,
        [targetRev.id, workflowId, tenantId]
      );

      // 4. Audit record into idempotency_ledger
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
        [tenantId, `rollback_${randomUUID()}`, JSON.stringify(auditPayload)]
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
