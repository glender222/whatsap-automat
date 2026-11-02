import crypto from 'node:crypto';
import { Pool } from 'pg';
import defaultPool from '../../config/database';
import { TenantScopedUoW, tenantScopedUoW } from '../../db/TenantScopedUoW';
import { OutboxRepository, outboxRepository } from '../outbox/OutboxRepository';
import { Queryable } from '../../shared/UnitOfWorkPort';
import {
  InboundWebhookResult,
  TriggerNotFoundError,
  TriggerInactiveError,
  WebhookAuthenticationError,
  WorkflowNotPublishedError,
} from './types';

export class WorkflowTriggerService {
  constructor(
    private readonly pool: Pool = defaultPool,
    private readonly uow: TenantScopedUoW = tenantScopedUoW,
    private readonly outboxRepo: OutboxRepository = outboxRepository
  ) {}

  /**
   * Resolves a channel-less inbound webhook and writes to processing_outbox within TenantScopedUoW.
   */
  async processInboundWebhook(
    endpointKey: string,
    rawToken: string | undefined,
    headers: Record<string, string | string[] | undefined>,
    body: Record<string, unknown>
  ): Promise<InboundWebhookResult> {
    // 1. Global lookup by unique endpoint_key
    const triggerRes = await this.pool.query(
      `SELECT id, tenant_id, workspace_id, workflow_id, type, endpoint_key, auth_token_hash, is_active, metadata
       FROM workflow_triggers
       WHERE endpoint_key = $1
       LIMIT 1;`,
      [endpointKey]
    );

    if (!triggerRes.rows || triggerRes.rows.length === 0) {
      throw new TriggerNotFoundError(endpointKey);
    }

    const trigger = triggerRes.rows[0];
    if (!trigger.is_active) {
      throw new TriggerInactiveError(endpointKey);
    }
    if (trigger.type !== 'webhook') {
      throw new Error(`Trigger type '${trigger.type}' is not configured for webhook ingestion`);
    }

    // 2. Token verification via timingSafeEqual
    if (trigger.auth_token_hash) {
      if (!rawToken) {
        throw new WebhookAuthenticationError('Missing mandatory webhook token');
      }
      const computedHash = crypto.createHash('sha256').update(rawToken.trim()).digest('hex');
      const hashBuf = Buffer.from(computedHash, 'utf8');
      const storedBuf = Buffer.from(trigger.auth_token_hash, 'utf8');

      if (hashBuf.length !== storedBuf.length || !crypto.timingSafeEqual(hashBuf, storedBuf)) {
        throw new WebhookAuthenticationError('Invalid webhook authentication token');
      }
    }

    const tenantId = Number(trigger.tenant_id);

    // 3. Resolve Idempotency Key
    const headerIdempKey = (headers['x-idempotency-key'] || headers['idempotency-key']) as string | undefined;
    const bodyId = typeof body?.id === 'string' && body.id.trim().length > 0 ? body.id.trim() : undefined;
    const idempotencyKey = headerIdempKey || bodyId || crypto.randomUUID();

    // 4. Enter TenantScopedUoW transaction
    return this.uow.run(tenantId, async (client: Queryable) => {
      // 4.1 Check idempotency ledger for duplicate requests
      const ledgerCheck = await client.query(
        `SELECT response_status, response_body
         FROM idempotency_ledger
         WHERE tenant_id = $1 AND idempotency_key = $2
         LIMIT 1;`,
        [tenantId, idempotencyKey]
      );

      if (ledgerCheck.rows && ledgerCheck.rows.length > 0) {
        const cached = ledgerCheck.rows[0];
        const parsedBody =
          typeof cached.response_body === 'string'
            ? JSON.parse(cached.response_body)
            : cached.response_body;

        return {
          status: 'accepted',
          runId: parsedBody.runId,
          workflowId: parsedBody.workflowId,
          revisionId: parsedBody.revisionId,
          idempotencyKey,
          duplicate: true,
        };
      }

      // 4.2 Verify target published revision in workflow_definitions
      const wfDefRes = await client.query(
        `SELECT id, published_revision_id, status
         FROM workflow_definitions
         WHERE id = $1 AND tenant_id = $2
         LIMIT 1;`,
        [trigger.workflow_id, tenantId]
      );

      if (!wfDefRes.rows || wfDefRes.rows.length === 0) {
        throw new Error(`Associated workflow definition '${trigger.workflow_id}' not found`);
      }

      const wfDef = wfDefRes.rows[0];
      if (wfDef.status !== 'published' || !wfDef.published_revision_id) {
        throw new WorkflowNotPublishedError(trigger.workflow_id);
      }

      // Verify revision status in workflow_revisions
      const revRes = await client.query(
        `SELECT id, revision_number
         FROM workflow_revisions
         WHERE id = $1 AND tenant_id = $2
         LIMIT 1;`,
        [wfDef.published_revision_id, tenantId]
      );

      if (!revRes.rows || revRes.rows.length === 0) {
        throw new Error(`Published revision '${wfDef.published_revision_id}' does not exist in revision store`);
      }

      const runId = `run_${crypto.randomUUID()}`;
      const correlationId = (headers['x-correlation-id'] as string) || `corr_${crypto.randomUUID()}`;
      const temporalWorkflowId = `wf_${tenantId}_${idempotencyKey}`;

      const acceptedPayload = {
        status: 'accepted',
        runId,
        workflowId: trigger.workflow_id,
        revisionId: wfDef.published_revision_id,
        idempotencyKey,
      };

      // 4.3 Persist into workflow_runs
      await client.query(
        `INSERT INTO workflow_runs (
           id, tenant_id, workspace_id, workflow_id, revision_id,
           temporal_workflow_id, correlation_id, trigger_type, trigger_payload,
           status, current_step, step_count, state_snapshot, started_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'webhook', $8, 'queued', 'phase_ingestion', 0, '{}', NOW());`,
        [
          runId,
          tenantId,
          trigger.workspace_id || null,
          trigger.workflow_id,
          wfDef.published_revision_id,
          temporalWorkflowId,
          correlationId,
          JSON.stringify(body || {}),
        ]
      );

      // 4.4 Persist into idempotency_ledger
      const requestHash = crypto.createHash('sha256').update(JSON.stringify(body || {})).digest('hex');
      await client.query(
        `INSERT INTO idempotency_ledger (
           tenant_id, idempotency_key, source, request_hash, response_status, response_body, created_at
         ) VALUES ($1, $2, 'workflow_webhook_trigger', $3, 202, $4, NOW());`,
        [tenantId, idempotencyKey, requestHash, JSON.stringify(acceptedPayload)]
      );

      // 4.5 Enqueue into processing_outbox
      await this.outboxRepo.enqueue(
        tenantId,
        {
          workspaceId: trigger.workspace_id || null,
          eventType: 'workflow.trigger.webhook',
          eventId: crypto.randomUUID(),
          correlationId,
          idempotencyKey,
          payload: {
            workflowId: trigger.workflow_id,
            revisionId: wfDef.published_revision_id,
            triggerId: trigger.id,
            triggerType: 'webhook',
            endpointKey,
            runId,
            triggerPayload: body || {},
            taskQueue: 'automation-workflows-v1',
            workflowType: 'ChannelLessBusinessWorkflow',
          },
        },
        client
      );

      return {
        ...acceptedPayload,
        status: 'accepted',
        duplicate: false,
      };
    });
  }
}

export const workflowTriggerService = new WorkflowTriggerService();
