import crypto from 'node:crypto';
import { Pool } from 'pg';
import defaultPool from '../../config/database';
import { TenantScopedUoW } from '../../db/TenantScopedUoW';
import { PgUnitOfWork } from '../../shared/PgUnitOfWork';
import { OutboxRepository } from '../outbox/OutboxRepository';
import {
  InboundWebhookResult,
  TriggerInactiveError,
  TriggerNotFoundError,
  WebhookAuthenticationError,
  WorkflowIdempotencyConflictError,
  WorkflowInputError,
  WorkflowNotPublishedError,
} from './types';

export const WORKFLOW_WEBHOOK_EVENT = 'workflow.trigger.webhook';
const ledgerSource = 'workflow_webhook_trigger';

function hash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function verifyWebhookToken(token: string | undefined, expectedHash: string | null): void {
  if (!token || !expectedHash || !/^[0-9a-f]{64}$/i.test(expectedHash)) {
    throw new WebhookAuthenticationError();
  }
  if (!crypto.timingSafeEqual(Buffer.from(hash(token), 'hex'), Buffer.from(expectedHash, 'hex'))) {
    throw new WebhookAuthenticationError();
  }
}

function requestKey(
  headers: Record<string, string | string[] | undefined>,
  body: Record<string, unknown>
): string {
  const value = headers['idempotency-key'] ?? headers['x-idempotency-key'] ??
    (typeof body.id === 'string' ? body.id : crypto.randomUUID());
  if (typeof value !== 'string' || !/^[\x20-\x7e]{1,128}$/.test(value.trim())) {
    throw new WorkflowInputError('Idempotency key must be 1-128 printable ASCII characters.');
  }
  return value.trim();
}

function payloadHash(body: Record<string, unknown>): string {
  return hash(JSON.stringify(body, (_key, value: unknown) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
    const object = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(object).sort().map((key) => [key, object[key]]));
  }));
}

export class WorkflowTriggerService {
  private readonly endpointLookup: PgUnitOfWork;

  constructor(
    pool: Pool = defaultPool,
    private readonly uow = new TenantScopedUoW(pool),
    private readonly outbox = new OutboxRepository(uow)
  ) {
    this.endpointLookup = new PgUnitOfWork(pool);
  }

  async processInboundWebhook(
    endpointKey: string,
    rawToken: string | undefined,
    headers: Record<string, string | string[] | undefined>,
    body: Record<string, unknown>
  ): Promise<InboundWebhookResult> {
    const resolved = await this.endpointLookup.transaction(async ({ client }) => {
      await client.query("SELECT set_config('app.workflow_endpoint_key', $1, true)", [endpointKey]);
      const { rows } = await client.query(`
        SELECT id, tenant_id, auth_token_hash
        FROM workflow_triggers WHERE endpoint_key = $1 AND type = 'webhook'
      `, [endpointKey]);
      return rows[0];
    });
    if (!resolved) throw new TriggerNotFoundError(endpointKey);
    verifyWebhookToken(rawToken, resolved.auth_token_hash);

    const tenantId = Number(resolved.tenant_id);
    const idempotencyKey = requestKey(headers, body);
    const scopedDigest = hash(JSON.stringify([resolved.id, idempotencyKey]));
    const ledgerKey = `workflow:${scopedDigest}`;
    const bodyHash = payloadHash(body);

    return this.uow.run(tenantId, async (client) => {
      const { rows: [trigger] } = await client.query(`
        SELECT workflow_id, auth_token_hash, is_active FROM workflow_triggers
        WHERE id = $1 AND tenant_id = $2 AND endpoint_key = $3 AND type = 'webhook'
        FOR SHARE
      `, [resolved.id, tenantId, endpointKey]);
      if (!trigger) throw new TriggerNotFoundError(endpointKey);
      verifyWebhookToken(rawToken, trigger.auth_token_hash);
      if (!trigger.is_active) throw new TriggerInactiveError(endpointKey);

      const claim = await client.query(`
        INSERT INTO idempotency_ledger (tenant_id, idempotency_key, source, request_hash, response_status)
        VALUES ($1, $2, $3, $4, 202)
        ON CONFLICT (tenant_id, idempotency_key) DO NOTHING RETURNING id
      `, [tenantId, ledgerKey, ledgerSource, bodyHash]);
      if (!claim.rows.length) {
        const { rows: [prior] } = await client.query(`
          SELECT source, request_hash, response_body FROM idempotency_ledger
          WHERE tenant_id = $1 AND idempotency_key = $2
        `, [tenantId, ledgerKey]);
        if (!prior?.response_body || prior.source !== ledgerSource || prior.request_hash !== bodyHash) {
          throw new WorkflowIdempotencyConflictError();
        }
        return { ...prior.response_body, duplicate: true } as InboundWebhookResult;
      }

      const { rows: [definition] } = await client.query(`
        SELECT definition.workspace_id, revision.id AS revision_id
        FROM workflow_definitions AS definition
        JOIN workflow_revisions AS revision
          ON revision.id = definition.published_revision_id
         AND revision.tenant_id = definition.tenant_id AND revision.workflow_id = definition.id
        WHERE definition.id = $1 AND definition.tenant_id = $2
          AND definition.status = 'published' AND revision.status = 'published'
        FOR SHARE OF definition
      `, [trigger.workflow_id, tenantId]);
      if (!definition) throw new WorkflowNotPublishedError(trigger.workflow_id);

      const runId = `run_${crypto.randomUUID()}`;
      const providedCorrelation = headers['x-correlation-id'];
      const correlationId = typeof providedCorrelation === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(providedCorrelation)
        ? providedCorrelation
        : `corr_${crypto.randomUUID()}`;
      const temporalWorkflowId = `wf_${tenantId}_${scopedDigest}`;
      const result = {
        status: 'accepted' as const,
        runId,
        workflowId: trigger.workflow_id,
        revisionId: definition.revision_id,
        idempotencyKey,
      };

      await client.query(`
        INSERT INTO workflow_runs (
          id, tenant_id, workspace_id, workflow_id, revision_id, temporal_workflow_id,
          correlation_id, trigger_type, trigger_payload, status, current_step
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'webhook', $8, 'queued', 'ingress')
      `, [runId, tenantId, definition.workspace_id, result.workflowId, result.revisionId,
        temporalWorkflowId, correlationId, JSON.stringify(body)]);
      await this.outbox.enqueue(tenantId, {
        workspaceId: definition.workspace_id,
        eventType: WORKFLOW_WEBHOOK_EVENT,
        correlationId,
        idempotencyKey: ledgerKey,
        payload: { runId },
      }, client);
      await client.query('INSERT INTO workflow_dispatch_tenants (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING', [tenantId]);
      await client.query('UPDATE idempotency_ledger SET response_body = $1 WHERE id = $2',
        [JSON.stringify(result), claim.rows[0].id]);

      return { ...result, duplicate: false };
    });
  }
}

export const workflowTriggerService = new WorkflowTriggerService();
