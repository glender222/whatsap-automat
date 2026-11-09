import { WORKFLOW_RUN_STATUSES, type WorkflowRunStatus } from '@whatsap-automat/contracts';
import { TenantScopedUoW, tenantScopedUoW } from '../../db/TenantScopedUoW';
import type { OutboxStatus } from '../outbox/OutboxRepository';
import { WORKFLOW_WEBHOOK_EVENT } from './WorkflowTriggerService';

const persistedStatuses: readonly string[] = WORKFLOW_RUN_STATUSES.filter((status) => status !== 'timed_out');
const allowedFilters = new Set(['limit', 'cursor', 'workflowId', 'status']);
type Position = [recordedAt: string, runId: string];
type Filters = {
  limit: number;
  position: Position | null;
  workflowId: string | null;
  status: WorkflowRunStatus | null;
};

function encodePosition(position: Position): string {
  return Buffer.from(JSON.stringify(position)).toString('base64url');
}

function readPosition(cursor: unknown): Position | null {
  if (typeof cursor !== 'string' || !/^[A-Za-z0-9_-]{1,2048}$/.test(cursor)) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!Array.isArray(value) || value.length !== 2) return null;
    const [recordedAt, runId] = value as [unknown, unknown];
    if (typeof recordedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(recordedAt) ||
        typeof runId !== 'string' || !runId || [...runId].length > 255 || runId.includes('\u0000')) return null;
    const parsed = new Date(recordedAt);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== `${recordedAt.slice(0, 23)}Z` ||
        recordedAt.startsWith('0000-')) return null;
    const position: Position = [recordedAt, runId];
    return encodePosition(position) === cursor ? position : null;
  } catch {
    return null;
  }
}

export function parseExecutionFilters(query: Record<string, unknown>): Filters | null {
  if (Object.keys(query).some((key) => !allowedFilters.has(key))) return null;
  const { limit, cursor, workflowId, status } = query;
  if (limit !== undefined && (typeof limit !== 'string' || !/^[1-9]\d{0,2}$/.test(limit))) return null;
  const size = limit === undefined ? 25 : Number(limit);
  if (size > 100) return null;
  if (workflowId !== undefined && (typeof workflowId !== 'string' || !/^[A-Za-z0-9_-]{1,255}$/.test(workflowId))) return null;
  if (status !== undefined && (typeof status !== 'string' || !persistedStatuses.includes(status))) return null;
  const position = cursor === undefined ? null : readPosition(cursor);
  if (cursor !== undefined && !position) return null;
  return { limit: size, position, workflowId: workflowId ?? null, status: (status as WorkflowRunStatus | undefined) ?? null };
}

type ExecutionRow = {
  id: string;
  tenant_id: number;
  workflow_id: string;
  revision_id: string;
  trigger_type: string;
  status: WorkflowRunStatus;
  recorded_at: string;
  completed_at: Date | null;
  step_count: number;
  failure_code: 'TEMPORAL_DISPATCH_UNCONFIRMED' | 'LOOP_LIMIT_EXCEEDED' | 'WORKFLOW_FAILED' | null;
  dispatch_matches: number | null;
  dispatch_status: OutboxStatus | null;
  retry_count: number | null;
  max_retries: number | null;
  next_retry_at: Date | null;
  lease_expires_at: Date | null;
  dispatch_updated_at: Date | null;
};

function execution(row: ExecutionRow) {
  const dispatchEvidence = row.dispatch_matches === 1 ? 'recorded'
    : row.dispatch_matches === 2 ? 'ambiguous' : 'missing';
  return {
    id: row.id,
    tenantId: String(row.tenant_id),
    workflowId: row.workflow_id,
    workflowRunId: row.id,
    revisionId: row.revision_id,
    triggerType: row.trigger_type,
    status: row.status,
    recordedAt: row.recorded_at,
    completedAt: row.completed_at?.toISOString() ?? null,
    stepCount: row.step_count,
    failureCode: row.failure_code,
    dispatchEvidence,
    dispatch: dispatchEvidence === 'recorded' ? {
      status: row.dispatch_status!,
      retryCount: row.retry_count!,
      maxRetries: row.max_retries!,
      nextRetryAt: row.next_retry_at?.toISOString() ?? null,
      leaseExpiresAt: row.lease_expires_at?.toISOString() ?? null,
      updatedAt: row.dispatch_updated_at!.toISOString(),
    } : null,
  };
}

export class OperationExecutionService {
  constructor(private readonly uow: TenantScopedUoW = tenantScopedUoW) {}

  async list(tenantId: number, filters: Filters) {
    const { limit, position, workflowId, status } = filters;
    const { rows } = await this.uow.run(tenantId, (db) => db.query(`
      WITH page AS (
        SELECT id, tenant_id, workflow_id, revision_id, trigger_type, status, correlation_id, started_at, completed_at,
          step_count,
          CASE WHEN status = 'failed' THEN
            CASE error_details->>'code'
              WHEN 'TEMPORAL_DISPATCH_UNCONFIRMED' THEN 'TEMPORAL_DISPATCH_UNCONFIRMED'
              WHEN 'LOOP_LIMIT_EXCEEDED' THEN 'LOOP_LIMIT_EXCEEDED'
              ELSE 'WORKFLOW_FAILED'
            END
          END AS failure_code
        FROM workflow_runs
        WHERE tenant_id = $1
          AND ($2::text IS NULL OR workflow_id = $2)
          AND ($3::text IS NULL OR status = $3)
          AND ($4::timestamptz IS NULL OR (started_at, id) < ($4, $5::varchar))
        ORDER BY started_at DESC, id DESC LIMIT $6
      )
      SELECT page.id, page.tenant_id, page.workflow_id, page.revision_id, page.trigger_type, page.status,
        to_char(page.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS recorded_at,
        page.completed_at, page.step_count, page.failure_code,
        dispatch.matches AS dispatch_matches, dispatch.status AS dispatch_status,
        dispatch.retry_count, dispatch.max_retries, dispatch.next_retry_at, dispatch.lease_expires_at,
        dispatch.updated_at AS dispatch_updated_at
      FROM page
      LEFT JOIN LATERAL (
        SELECT candidates.*, count(*) OVER ()::integer AS matches
        FROM (
          SELECT status, retry_count, max_retries, updated_at,
            CASE WHEN status IN ('pending', 'delivery_unknown') THEN next_retry_at END AS next_retry_at,
            CASE WHEN status = 'processing' AND lease_token IS NOT NULL THEN next_retry_at END AS lease_expires_at
          FROM processing_outbox
          WHERE tenant_id = page.tenant_id AND correlation_id = page.correlation_id
            AND event_type = $7 AND payload->>'runId' = page.id
          LIMIT 2
        ) AS candidates
        LIMIT 1
      ) AS dispatch ON true
      ORDER BY page.started_at DESC, page.id DESC
    `, [tenantId, workflowId, status, position?.[0] ?? null, position?.[1] ?? null, limit + 1, WORKFLOW_WEBHOOK_EVENT]));

    const items = (rows as ExecutionRow[]).slice(0, limit).map(execution);
    const last = items[items.length - 1];
    return {
      items,
      nextCursor: rows.length > limit && last ? encodePosition([last.recordedAt, last.id]) : null,
      pageSummary: {
        retryCount: items.reduce((sum, item) => sum + (item.dispatch?.retryCount ?? 0), 0),
        deliveryUnknownCount: items.filter((item) => item.dispatch?.status === 'delivery_unknown').length,
      },
    };
  }
}
