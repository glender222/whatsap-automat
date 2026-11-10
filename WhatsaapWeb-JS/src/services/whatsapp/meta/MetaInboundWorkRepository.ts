import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import defaultPool from '../../../config/database';
import { TenantScopedUoW } from '../../../db/TenantScopedUoW';
import type { Queryable } from '../../../shared/UnitOfWorkPort';
import { OutboxRepository, type OutboxRecord } from '../../outbox/OutboxRepository';

export const META_INBOUND_EVENT_TYPE = 'whatsapp.inbound.received';

export interface MetaInboundReference {
  messageId: string;
  conversationId: string;
  phoneNumberId: string;
  inboundProviderMessageId: string;
}

export interface MetaInboundClaim extends MetaInboundReference {
  jobId: string;
  companyId: number;
  leaseToken: string;
}

export interface MetaInboundExecution extends MetaInboundReference {
  jobId: string;
  companyId: number;
  message: Record<string, any>;
}

export interface MetaInboundOutcome {
  status: 'completed' | 'skipped' | 'uncertain';
  code?: string;
}

export class InvalidMetaInboundWorkError extends Error {
  readonly code = 'META_INBOUND_REFERENCE_INVALID';
  constructor() { super('The inbound work does not reference a matching tenant message.'); }
}

function reference(value: unknown): MetaInboundReference {
  const row = value as Partial<MetaInboundReference> | null;
  if (!row || !/^[1-9]\d*$/.test(String(row.messageId || '')) ||
      !/^[1-9]\d*$/.test(String(row.conversationId || '')) ||
      typeof row.phoneNumberId !== 'string' || !/^\d{1,40}$/.test(row.phoneNumberId) ||
      typeof row.inboundProviderMessageId !== 'string' || !row.inboundProviderMessageId ||
      row.inboundProviderMessageId.length > 255) throw new InvalidMetaInboundWorkError();
  return {
    messageId: String(row.messageId), conversationId: String(row.conversationId),
    phoneNumberId: row.phoneNumberId, inboundProviderMessageId: row.inboundProviderMessageId,
  };
}

function safeCode(code: string | undefined, fallback: string): string {
  return code && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : fallback;
}

export function metaInboundWorkKey(companyId: number, phoneNumberId: string, wamid: string): string {
  return `meta-inbound:${createHash('sha256').update(JSON.stringify([companyId, phoneNumberId, wamid])).digest('hex')}`;
}

export class MetaInboundWorkRepository {
  private readonly outbox: OutboxRepository;
  constructor(private readonly db: Pool = defaultPool, private readonly uow = new TenantScopedUoW(db)) {
    this.outbox = new OutboxRepository(uow);
  }

  async enqueue(companyId: number, input: MetaInboundReference, client: Queryable): Promise<OutboxRecord> {
    const payload = reference(input);
    await client.query('INSERT INTO meta_inbound_work_tenants (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING', [companyId]);
    return this.outbox.enqueue(companyId, {
      eventType: META_INBOUND_EVENT_TYPE,
      correlationId: payload.inboundProviderMessageId,
      idempotencyKey: metaInboundWorkKey(companyId, payload.phoneNumberId, payload.inboundProviderMessageId),
      payload: { schemaVersion: 1, ...payload },
    }, client);
  }

  async getTenantIds(): Promise<number[]> {
    const { rows } = await this.db.query<{ tenant_id: number }>(
      'SELECT tenant_id FROM meta_inbound_work_tenants ORDER BY tenant_id');
    return rows.map((row) => row.tenant_id);
  }

  async recoverExpired(companyId: number): Promise<number> {
    return this.uow.run(companyId, async (db) => {
      const result = await db.query(`
        UPDATE processing_outbox SET status = 'delivery_unknown', lease_token = NULL,
          next_retry_at = NULL, last_error = 'META_INBOUND_RUNTIME_INTERRUPTED', updated_at = clock_timestamp()
        WHERE tenant_id = $1 AND event_type = $2 AND status = 'dispatched'
          AND next_retry_at <= clock_timestamp()
      `, [companyId, META_INBOUND_EVENT_TYPE]);
      return result.rowCount ?? 0;
    });
  }

  async claim(companyId: number, leaseMs: number): Promise<MetaInboundClaim | null> {
    return this.uow.run(companyId, async (db) => {
      const { rows: [row] } = await db.query(`
        WITH candidate AS (
          SELECT work.id FROM processing_outbox work
          WHERE work.tenant_id = $1 AND work.event_type = $2 AND work.status IN ('pending', 'processing')
            AND (work.next_retry_at IS NULL OR work.next_retry_at <= clock_timestamp())
            AND NOT EXISTS (
              SELECT 1 FROM processing_outbox previous
              WHERE previous.tenant_id = work.tenant_id AND previous.event_type = work.event_type
                AND previous.payload->>'conversationId' = work.payload->>'conversationId'
                AND previous.status IN ('pending', 'processing', 'dispatched')
                AND (previous.created_at, previous.id) < (work.created_at, work.id)
            )
          ORDER BY work.created_at, work.id LIMIT 1 FOR UPDATE OF work SKIP LOCKED
        )
        UPDATE processing_outbox AS work SET status = 'processing', lease_token = gen_random_uuid(),
          next_retry_at = clock_timestamp() + ($3::integer * interval '1 millisecond'), updated_at = clock_timestamp()
        FROM candidate WHERE work.id = candidate.id RETURNING work.*
      `, [companyId, META_INBOUND_EVENT_TYPE, leaseMs]);
      if (!row) return null;
      try {
        const ref = reference(row.payload);
        if (row.payload.schemaVersion !== 1 || row.idempotency_key !==
          metaInboundWorkKey(companyId, ref.phoneNumberId, ref.inboundProviderMessageId)) throw new InvalidMetaInboundWorkError();
        return { ...ref, companyId, jobId: row.id, leaseToken: row.lease_token };
      } catch {
        await db.query(`UPDATE processing_outbox SET status = 'dead_letter', lease_token = NULL,
          next_retry_at = NULL, last_error = 'META_INBOUND_REFERENCE_INVALID', updated_at = clock_timestamp()
          WHERE tenant_id = $1 AND id = $2 AND lease_token = $3`, [companyId, row.id, row.lease_token]);
        return null;
      }
    });
  }

  async load(claim: MetaInboundClaim): Promise<MetaInboundExecution> {
    return this.uow.run(claim.companyId, async (db) => {
      const { rows: [row] } = await db.query(`
        SELECT m.raw_payload_json, m.external_contact_id, c.external_conversation_id
        FROM messages m JOIN conversations c ON c.company_id = m.company_id AND c.id = m.conversation_id
        WHERE m.company_id = $1 AND m.id = $2 AND m.conversation_id = $3
          AND m.provider_message_id = $4 AND m.metadata_json #>> '{metadata,phone_number_id}' = $5
          AND m.direction = 'inbound' AND m.provider = 'meta-cloud' AND m.channel = 'whatsapp'
          AND c.provider = 'meta-cloud' AND c.channel = 'whatsapp'
      `, [claim.companyId, claim.messageId, claim.conversationId, claim.inboundProviderMessageId, claim.phoneNumberId]);
      if (!row?.raw_payload_json || typeof row.raw_payload_json !== 'object' || Array.isArray(row.raw_payload_json) ||
          row.raw_payload_json.id !== claim.inboundProviderMessageId ||
          typeof row.raw_payload_json.from !== 'string' || !/^[1-9]\d{6,14}$/.test(row.raw_payload_json.from) ||
          row.raw_payload_json.from !== row.external_contact_id ||
          row.raw_payload_json.from !== row.external_conversation_id) throw new InvalidMetaInboundWorkError();
      const { leaseToken: _lease, ...work } = claim;
      return { ...work, message: row.raw_payload_json };
    });
  }

  // This commit is the point of no automatic replay. A crash immediately after it
  // is also uncertain, even when the callback had not reached its first tool yet.
  async enterRuntime(claim: MetaInboundClaim, runtimeTimeoutMs: number): Promise<boolean> {
    return this.uow.run(claim.companyId, async (db) => {
      const result = await db.query(`
        UPDATE processing_outbox SET status = 'dispatched', updated_at = clock_timestamp(),
          next_retry_at = clock_timestamp() + ($4::integer * interval '1 millisecond')
        WHERE tenant_id = $1 AND id = $2 AND lease_token = $3 AND event_type = $5
          AND status = 'processing' AND next_retry_at > clock_timestamp()
      `, [claim.companyId, claim.jobId, claim.leaseToken, runtimeTimeoutMs, META_INBOUND_EVENT_TYPE]);
      return result.rowCount === 1;
    });
  }

  async isCurrent(claim: MetaInboundClaim, client?: Queryable): Promise<boolean> {
    const read = async (db: Queryable) => {
      const { rows } = await db.query(`
        SELECT id FROM processing_outbox WHERE tenant_id = $1 AND id = $2 AND lease_token = $3
          AND event_type = $4 AND status = 'dispatched' AND next_retry_at > clock_timestamp() FOR SHARE
      `, [claim.companyId, claim.jobId, claim.leaseToken, META_INBOUND_EVENT_TYPE]);
      return rows.length === 1;
    };
    return client ? read(client) : this.uow.run(claim.companyId, read);
  }

  async finish(claim: MetaInboundClaim, outcome: MetaInboundOutcome): Promise<boolean> {
    const uncertain = outcome.status === 'uncertain';
    const code = safeCode(outcome.code, uncertain ? 'META_INBOUND_RUNTIME_UNCERTAIN' : 'META_INBOUND_COMPLETED');
    return this.uow.run(claim.companyId, async (db) => {
      const result = await db.query(`
        UPDATE processing_outbox SET status = $4, lease_token = NULL, next_retry_at = NULL,
          last_error = $5, payload = payload || jsonb_build_object('outcome', $6::jsonb), updated_at = clock_timestamp()
        WHERE tenant_id = $1 AND id = $2 AND lease_token = $3 AND event_type = $7 AND status = 'dispatched'
          AND ($8::boolean OR next_retry_at > clock_timestamp())
      `, [claim.companyId, claim.jobId, claim.leaseToken, uncertain ? 'delivery_unknown' : 'completed',
        uncertain ? code : null, JSON.stringify({ status: outcome.status, code }), META_INBOUND_EVENT_TYPE, uncertain]);
      return result.rowCount === 1;
    });
  }

  async failBeforeRuntime(claim: MetaInboundClaim, permanent: boolean): Promise<boolean> {
    return this.uow.run(claim.companyId, async (db) => {
      const result = await db.query(`
        UPDATE processing_outbox SET status = CASE WHEN $4 OR retry_count + 1 >= max_retries THEN 'dead_letter' ELSE 'pending' END,
          retry_count = retry_count + 1, lease_token = NULL,
          next_retry_at = CASE WHEN $4 OR retry_count + 1 >= max_retries THEN NULL
            ELSE clock_timestamp() + (LEAST(60000, 1000 * power(2, retry_count)) * interval '1 millisecond') END,
          last_error = $5, updated_at = clock_timestamp()
        WHERE tenant_id = $1 AND id = $2 AND lease_token = $3 AND event_type = $6
          AND status = 'processing' AND next_retry_at > clock_timestamp()
      `, [claim.companyId, claim.jobId, claim.leaseToken, permanent,
        permanent ? 'META_INBOUND_REFERENCE_INVALID' : 'META_INBOUND_PREPARATION_FAILED', META_INBOUND_EVENT_TYPE]);
      return result.rowCount === 1;
    });
  }
}
