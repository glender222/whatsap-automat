/**
 * Common tenant, actor, and context definitions for Whatsap-Automat v0.4
 *
 * TenantActor derives exclusively from authenticated session/connection.
 * In legacy persistence, tenantId maps directly to company_id.
 */

export interface TenantActor {
  readonly tenantId: string;
  readonly userId: string | null;
  readonly roles: readonly string[];
  readonly requestId: string;
}

export interface TenantContext {
  readonly tenantId: string;
  readonly correlationId: string;
  readonly actor?: TenantActor;
}

export interface CursorPaginationParams {
  readonly cursor?: string;
  readonly limit?: number;
  readonly direction?: 'forward' | 'backward';
}

export interface PaginatedResponse<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
  readonly prevCursor: string | null;
  readonly totalCount?: number;
  readonly hasMore: boolean;
}

export const StandardHeaders = {
  IDEMPOTENCY_KEY: 'idempotency-key',
  CORRELATION_ID: 'x-correlation-id',
  IF_MATCH: 'if-match',
  ETAG: 'etag',
  EVENT_VERSION: 'x-event-version',
} as const;
