import { Queryable } from '../../shared/UnitOfWorkPort';
import { TenantScopedUoW, tenantScopedUoW } from '../../db/TenantScopedUoW';

export type OutboxStatus =
  | 'pending'
  | 'processing'
  | 'dispatched'
  | 'completed'
  | 'failed'
  | 'delivery_unknown'
  | 'dead_letter';

export interface OutboxRecord<TPayload = unknown> {
  id: string;
  tenant_id: number;
  workspace_id?: number | null;
  event_type: string;
  event_id: string;
  correlation_id: string;
  idempotency_key: string;
  payload: TPayload;
  status: OutboxStatus;
  retry_count: number;
  max_retries: number;
  next_retry_at?: Date | null;
  last_error?: string | null;
  lease_token?: string;
  created_at: Date;
  updated_at: Date;

  // CamelCase accessors
  tenantId?: number;
  workspaceId?: number | null;
  eventType?: string;
  eventId?: string;
  correlationId?: string;
  idempotencyKey?: string;
  retryCount?: number;
  maxRetries?: number;
  nextRetryAt?: Date | null;
  lastError?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface EnqueueOutboxOptions<TPayload = unknown> {
  workspaceId?: number | null;
  eventType: string;
  eventId?: string;
  correlationId: string;
  idempotencyKey: string;
  payload: TPayload;
  maxRetries?: number;
  nextRetryAt?: Date | null;
}

export interface MarkStatusOptions {
  error?: string;
  nextRetryAt?: Date | null;
  incrementRetry?: boolean;
  leaseToken?: string;
}

export function mapRowToOutboxRecord<T = unknown>(row: any): OutboxRecord<T> {
  if (!row) {
    throw new Error('Cannot map empty row to OutboxRecord');
  }

  let payload = row.payload;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      // Keep string if not json
    }
  }

  const tenantId = Number(row.tenant_id ?? row.tenantId);
  const workspaceId = row.workspace_id !== undefined ? row.workspace_id : (row.workspaceId ?? null);
  const eventType = String(row.event_type ?? row.eventType);
  const eventId = String(row.event_id ?? row.eventId);
  const correlationId = String(row.correlation_id ?? row.correlationId);
  const idempotencyKey = String(row.idempotency_key ?? row.idempotencyKey);
  const status = (row.status as OutboxStatus) || 'pending';
  const retryCount = Number(row.retry_count ?? row.retryCount ?? 0);
  const maxRetries = Number(row.max_retries ?? row.maxRetries ?? 5);
  const nextRetryAt = row.next_retry_at ? new Date(row.next_retry_at) : (row.nextRetryAt ? new Date(row.nextRetryAt) : null);
  const lastError = row.last_error !== undefined ? row.last_error : (row.lastError ?? null);
  const createdAt = row.created_at ? new Date(row.created_at) : new Date();
  const updatedAt = row.updated_at ? new Date(row.updated_at) : new Date();

  return {
    id: String(row.id),
    tenant_id: tenantId,
    workspace_id: workspaceId,
    event_type: eventType,
    event_id: eventId,
    correlation_id: correlationId,
    idempotency_key: idempotencyKey,
    payload,
    status,
    retry_count: retryCount,
    max_retries: maxRetries,
    next_retry_at: nextRetryAt,
    last_error: lastError,
    ...(row.lease_token ? { lease_token: String(row.lease_token) } : {}),
    created_at: createdAt,
    updated_at: updatedAt,

    // CamelCase aliases
    tenantId,
    workspaceId,
    eventType,
    eventId,
    correlationId,
    idempotencyKey,
    retryCount,
    maxRetries,
    nextRetryAt,
    lastError,
    createdAt,
    updatedAt,
  };
}

export class OutboxRepository {
  constructor(private readonly uow: TenantScopedUoW = tenantScopedUoW) {}

  /**
   * Enqueues an event into processing_outbox.
   * If an event with the same idempotency_key already exists, returns the existing record.
   */
  async enqueue<T = unknown>(
    tenantId: number,
    options: EnqueueOutboxOptions<T>,
    client?: Queryable
  ): Promise<OutboxRecord<T>> {
    const execute = async (qClient: Queryable): Promise<OutboxRecord<T>> => {
      const sql = `
        INSERT INTO processing_outbox (
          tenant_id, workspace_id, event_type, event_id, correlation_id,
          idempotency_key, payload, status, retry_count, max_retries,
          next_retry_at, created_at, updated_at
        ) VALUES (
          $1, $2, $3, COALESCE($4::uuid, gen_random_uuid()), $5,
          $6, $7, 'pending', 0, COALESCE($8, 5),
          COALESCE($9, NOW()), NOW(), NOW()
        )
        ON CONFLICT (tenant_id, idempotency_key) DO UPDATE
          SET updated_at = processing_outbox.updated_at
        RETURNING *;
      `;

      const values = [
        tenantId,
        options.workspaceId ?? null,
        options.eventType,
        options.eventId || null,
        options.correlationId,
        options.idempotencyKey,
        typeof options.payload === 'object' && options.payload !== null
          ? JSON.stringify(options.payload)
          : options.payload,
        options.maxRetries ?? 5,
        options.nextRetryAt || null,
      ];

      const res = await qClient.query(sql, values);
      if (res.rows && res.rows.length > 0) {
        return mapRowToOutboxRecord<T>(res.rows[0]);
      }

      // Fallback query if conflict without returning row
      const selectSql = `
        SELECT * FROM processing_outbox
        WHERE tenant_id = $1 AND idempotency_key = $2
        LIMIT 1;
      `;
      const fallbackRes = await qClient.query(selectSql, [tenantId, options.idempotencyKey]);
      if (fallbackRes.rows && fallbackRes.rows.length > 0) {
        return mapRowToOutboxRecord<T>(fallbackRes.rows[0]);
      }

      throw new Error(`Failed to enqueue or retrieve outbox record for idempotency_key: ${options.idempotencyKey}`);
    };

    if (client) {
      return execute(client);
    }
    return this.uow.run(tenantId, execute);
  }

  /**
   * Finds an outbox record by primary key (UUID).
   */
  async findById<T = unknown>(
    tenantId: number,
    id: string,
    client?: Queryable
  ): Promise<OutboxRecord<T> | null> {
    const execute = async (qClient: Queryable): Promise<OutboxRecord<T> | null> => {
      const sql = `
        SELECT * FROM processing_outbox
        WHERE tenant_id = $1 AND id = $2
        LIMIT 1;
      `;
      const res = await qClient.query(sql, [tenantId, id]);
      if (res.rows && res.rows.length > 0) {
        return mapRowToOutboxRecord<T>(res.rows[0]);
      }
      return null;
    };

    if (client) {
      return execute(client);
    }
    return this.uow.run(tenantId, execute);
  }

  /**
   * Finds an outbox record by idempotency key.
   */
  async findByIdempotencyKey<T = unknown>(
    tenantId: number,
    idempotencyKey: string,
    client?: Queryable
  ): Promise<OutboxRecord<T> | null> {
    const execute = async (qClient: Queryable): Promise<OutboxRecord<T> | null> => {
      const sql = `
        SELECT * FROM processing_outbox
        WHERE tenant_id = $1 AND idempotency_key = $2
        LIMIT 1;
      `;
      const res = await qClient.query(sql, [tenantId, idempotencyKey]);
      if (res.rows && res.rows.length > 0) {
        return mapRowToOutboxRecord<T>(res.rows[0]);
      }
      return null;
    };

    if (client) {
      return execute(client);
    }
    return this.uow.run(tenantId, execute);
  }

  /**
   * Claims pending/claimable records for processing with row locking.
   * Eligible states: 'pending' or 'delivery_unknown' where next_retry_at is null or in the past.
   */
  async claimPending<T = unknown>(
    tenantId: number,
    limit: number = 10,
    client?: Queryable
  ): Promise<OutboxRecord<T>[]> {
    const execute = async (qClient: Queryable): Promise<OutboxRecord<T>[]> => {
      const sql = `
        WITH claimable AS (
          SELECT id
          FROM processing_outbox
          WHERE tenant_id = $1
            AND status IN ('pending', 'delivery_unknown')
            -- Owned by MetaInboundWorker; an uncertain runtime must never be replayed by this relay.
            AND event_type <> 'whatsapp.inbound.received'
            AND (next_retry_at IS NULL OR next_retry_at <= NOW())
          ORDER BY created_at ASC
          LIMIT $2
          FOR UPDATE SKIP LOCKED
        )
        UPDATE processing_outbox o
        SET status = 'processing',
            updated_at = NOW()
        FROM claimable c
        WHERE o.id = c.id
        RETURNING o.*;
      `;
      const res = await qClient.query(sql, [tenantId, limit]);
      return (res.rows || []).map((row) => mapRowToOutboxRecord<T>(row));
    };

    if (client) {
      return execute(client);
    }
    return this.uow.run(tenantId, execute);
  }

  async claimWorkflowDispatch(tenantId: number, limit: number, leaseMs: number): Promise<OutboxRecord[]> {
    return this.uow.run(tenantId, async (client) => {
      const { rows } = await client.query(`
        WITH claimable AS (
          SELECT id FROM processing_outbox
          WHERE tenant_id = $1 AND event_type = 'workflow.trigger.webhook'
            AND status IN ('pending', 'processing', 'delivery_unknown')
            AND (next_retry_at IS NULL OR next_retry_at <= NOW())
          ORDER BY created_at, id LIMIT $2 FOR UPDATE SKIP LOCKED
        )
        UPDATE processing_outbox AS outbox
        SET status = 'processing', lease_token = gen_random_uuid(), updated_at = NOW(),
            next_retry_at = NOW() + ($3::integer * interval '1 millisecond')
        FROM claimable WHERE outbox.id = claimable.id
        RETURNING outbox.*
      `, [tenantId, limit, leaseMs]);
      return rows.map((row) => mapRowToOutboxRecord(row));
    });
  }

  /**
   * Updates status and retry metadata for an outbox record.
   */
  async markStatus<T = unknown>(
    tenantId: number,
    id: string,
    status: OutboxStatus,
    options?: MarkStatusOptions,
    client?: Queryable
  ): Promise<OutboxRecord<T> | null> {
    const execute = async (qClient: Queryable): Promise<OutboxRecord<T> | null> => {
      const leaseAssignments = options?.leaseToken ? ', lease_token = NULL' : '';
      const leaseCondition = options?.leaseToken ? "AND status = 'processing' AND lease_token = $7::uuid" : '';
      const sql = `
        UPDATE processing_outbox
        SET status = $1,
            last_error = CASE WHEN $2::text IS NOT NULL THEN $2 ELSE last_error END,
            next_retry_at = $3,
            retry_count = CASE WHEN $4 = true THEN retry_count + 1 ELSE retry_count END,
            updated_at = NOW()${leaseAssignments}
        WHERE tenant_id = $5 AND id = $6 ${leaseCondition}
        RETURNING *;
      `;
      const res = await qClient.query(sql, [
        status,
        options?.error !== undefined ? options.error : null,
        options?.nextRetryAt || null,
        Boolean(options?.incrementRetry),
        tenantId,
        id,
        ...(options?.leaseToken ? [options.leaseToken] : []),
      ]);
      if (res.rows && res.rows.length > 0) {
        return mapRowToOutboxRecord<T>(res.rows[0]);
      }
      return null;
    };

    if (client) {
      return execute(client);
    }
    return this.uow.run(tenantId, execute);
  }

  /**
   * Marks record as 'delivery_unknown' per ADR-007.
   * Indicates dispatch outcome was ambiguous (network timeout, 5xx, or crash).
   */
  async markDeliveryUnknown<T = unknown>(
    tenantId: number,
    id: string,
    error?: string,
    client?: Queryable
  ): Promise<OutboxRecord<T> | null> {
    return this.markStatus<T>(tenantId, id, 'delivery_unknown', { error, incrementRetry: false }, client);
  }

  async markProcessing<T = unknown>(
    tenantId: number,
    id: string,
    client?: Queryable
  ): Promise<OutboxRecord<T> | null> {
    return this.markStatus<T>(tenantId, id, 'processing', undefined, client);
  }

  async markDispatched<T = unknown>(
    tenantId: number,
    id: string,
    client?: Queryable
  ): Promise<OutboxRecord<T> | null> {
    return this.markStatus<T>(tenantId, id, 'dispatched', undefined, client);
  }

  async markCompleted<T = unknown>(
    tenantId: number,
    id: string,
    client?: Queryable
  ): Promise<OutboxRecord<T> | null> {
    return this.markStatus<T>(tenantId, id, 'completed', undefined, client);
  }

  async markFailed<T = unknown>(
    tenantId: number,
    id: string,
    error: string,
    client?: Queryable
  ): Promise<OutboxRecord<T> | null> {
    return this.markStatus<T>(tenantId, id, 'failed', { error, incrementRetry: true }, client);
  }

  async scheduleRetry<T = unknown>(
    tenantId: number,
    id: string,
    error: string,
    nextRetryAt: Date,
    client?: Queryable
  ): Promise<OutboxRecord<T> | null> {
    return this.markStatus<T>(
      tenantId,
      id,
      'pending',
      { error, nextRetryAt, incrementRetry: true },
      client
    );
  }

  async markDeadLetter<T = unknown>(
    tenantId: number,
    id: string,
    error: string,
    client?: Queryable
  ): Promise<OutboxRecord<T> | null> {
    return this.markStatus<T>(
      tenantId,
      id,
      'dead_letter',
      { error, incrementRetry: true },
      client
    );
  }
}

export const outboxRepository = new OutboxRepository();
