// Invariants before config load
process.env.JWT_SECRET = 'test-only-jwt-secret-with-at-least-32-characters-for-testing';
process.env.DB_PASSWORD = 'test-only-database-password';

import assert from 'node:assert/strict';
import { describe, test, beforeEach } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Pool, PoolClient, QueryResult } from 'pg';

import {
  ChannelCapabilityMatrix,
  PublishIntent,
  StandardErrorCode,
} from '@whatsap-automat/contracts';

const { TenantScopedUoW } = require('../db/TenantScopedUoW') as typeof import('../db/TenantScopedUoW');
const {
  OutboxRepository,
} = require('../services/outbox/OutboxRepository') as typeof import('../services/outbox/OutboxRepository');
import type { OutboxRecord, OutboxStatus } from '../services/outbox/OutboxRepository';
const {
  CapabilityRegistry,
  PublishGateError,
} = require('../services/channels/CapabilityRegistry') as typeof import('../services/channels/CapabilityRegistry');
const {
  verifyWebhookHmac,
  verifyAntiReplayTimestamp,
  createWebhookIdempotencyMiddleware,
} = require('../middleware/webhookIdempotency') as typeof import('../middleware/webhookIdempotency');

// =============================================================================
// Mock In-Memory Database Engine for RLS and Outbox / Idempotency / Capabilities
// =============================================================================

interface MockDbRecord {
  id?: string | number;
  tenant_id: number;
  [key: string]: unknown;
}

interface MockClientState {
  sessionTenantId: number | null;
  inTransaction: boolean;
  queries: { sql: string; values?: unknown[] }[];
  forceErrorOnInsert?: boolean;
}

function createMockOutboxPool() {
  const tables: Record<string, MockDbRecord[]> = {
    processing_outbox: [],
    idempotency_ledger: [],
    channel_capabilities_snapshots: [],
  };

  const clientStates: MockClientState[] = [];

  const mockPool = {
    tables,
    clientStates,
    async connect(): Promise<PoolClient> {
      const clientState: MockClientState = {
        sessionTenantId: null,
        inTransaction: false,
        queries: [],
        forceErrorOnInsert: false,
      };
      clientStates.push(clientState);

      let snapshotOnBegin: Record<string, MockDbRecord[]> | null = null;

      const client: Partial<PoolClient> = {
        query: async (
          text: string | { text: string; values?: unknown[] },
          values?: unknown[]
        ): Promise<QueryResult<any>> => {
          const sql = (typeof text === 'string' ? text : text.text).trim();
          const sqlValues = typeof text === 'string' ? values || [] : text.values || [];
          clientState.queries.push({ sql, values: sqlValues });

          const upper = sql.toUpperCase();

          // Transaction Control
          if (upper === 'BEGIN') {
            clientState.inTransaction = true;
            snapshotOnBegin = {
              processing_outbox: tables.processing_outbox.map((r) => ({ ...r })),
              idempotency_ledger: tables.idempotency_ledger.map((r) => ({ ...r })),
              channel_capabilities_snapshots: tables.channel_capabilities_snapshots.map((r) => ({ ...r })),
            };
            return { rows: [], rowCount: 0, command: 'BEGIN', oid: 0, fields: [] };
          }
          if (upper === 'COMMIT') {
            clientState.inTransaction = false;
            clientState.sessionTenantId = null;
            snapshotOnBegin = null;
            return { rows: [], rowCount: 0, command: 'COMMIT', oid: 0, fields: [] };
          }
          if (upper === 'ROLLBACK') {
            clientState.inTransaction = false;
            clientState.sessionTenantId = null;
            if (snapshotOnBegin) {
              tables.processing_outbox.length = 0;
              tables.processing_outbox.push(...snapshotOnBegin.processing_outbox);
              tables.idempotency_ledger.length = 0;
              tables.idempotency_ledger.push(...snapshotOnBegin.idempotency_ledger);
              tables.channel_capabilities_snapshots.length = 0;
              tables.channel_capabilities_snapshots.push(...snapshotOnBegin.channel_capabilities_snapshots);
              snapshotOnBegin = null;
            }
            return { rows: [], rowCount: 0, command: 'ROLLBACK', oid: 0, fields: [] };
          }

          // SET LOCAL app.current_tenant_id
          const setMatch = sql.match(/SET LOCAL app\.current_tenant_id\s*=\s*'(\d+)'/i);
          if (setMatch) {
            clientState.sessionTenantId = parseInt(setMatch[1], 10);
            return { rows: [], rowCount: 0, command: 'SET', oid: 0, fields: [] };
          }

          const effectiveTenantId = clientState.sessionTenantId;

          // 1. processing_outbox
          if (sql.includes('processing_outbox')) {
            const table = tables.processing_outbox;

            if (upper.startsWith('INSERT')) {
              if (clientState.forceErrorOnInsert) {
                throw new Error('Simulated database error during outbox insert');
              }
              // RLS WITH CHECK: Fail-closed if no sessionTenantId or mismatch
              const insertTenantId = Number(sqlValues[0]);
              if (!effectiveTenantId || effectiveTenantId !== insertTenantId) {
                const err = new Error('new row violates row-level security policy for table "processing_outbox"');
                (err as any).code = '44501';
                throw err;
              }

              const idempotencyKey = String(sqlValues[5]);
              const existingIdx = table.findIndex(
                (r) => r.tenant_id === insertTenantId && r.idempotency_key === idempotencyKey
              );

              if (existingIdx >= 0) {
                // ON CONFLICT (idempotency_key) DO UPDATE SET updated_at = NOW()
                const existing = table[existingIdx];
                existing.updated_at = new Date();
                return { rows: [existing], rowCount: 1, command: 'INSERT', oid: 0, fields: [] };
              }

              const newRow: MockDbRecord = {
                id: (sqlValues[3] as string) || crypto.randomUUID(),
                tenant_id: insertTenantId,
                workspace_id: sqlValues[1] ?? null,
                event_type: sqlValues[2],
                event_id: (sqlValues[3] as string) || crypto.randomUUID(),
                correlation_id: sqlValues[4],
                idempotency_key: idempotencyKey,
                payload: sqlValues[6],
                status: 'pending',
                retry_count: 0,
                max_retries: sqlValues[7] ?? 5,
                next_retry_at: sqlValues[8] ? new Date(sqlValues[8] as string) : new Date(),
                last_error: null,
                created_at: new Date(),
                updated_at: new Date(),
              };
              table.push(newRow);
              return { rows: [newRow], rowCount: 1, command: 'INSERT', oid: 0, fields: [] };
            }

            if (upper.startsWith('SELECT')) {
              // RLS USING: Fail-closed
              if (!effectiveTenantId) {
                return { rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] };
              }

              let filtered = table.filter((r) => r.tenant_id === effectiveTenantId);

              // WHERE tenant_id = $1 AND id = $2
              if (sql.includes('id = $2')) {
                const targetId = String(sqlValues[1]);
                filtered = filtered.filter((r) => String(r.id) === targetId);
              }
              // WHERE tenant_id = $1 AND idempotency_key = $2
              if (sql.includes('idempotency_key = $2')) {
                const targetKey = String(sqlValues[1]);
                filtered = filtered.filter((r) => r.idempotency_key === targetKey);
              }

              return { rows: filtered, rowCount: filtered.length, command: 'SELECT', oid: 0, fields: [] };
            }

            if (upper.includes('WITH CLAIMABLE AS') || upper.startsWith('UPDATE PROCESSING_OUTBOX')) {
              if (!effectiveTenantId) {
                return { rows: [], rowCount: 0, command: 'UPDATE', oid: 0, fields: [] };
              }

              if (upper.includes('WITH CLAIMABLE AS')) {
                const limit = Number(sqlValues[1] || 10);
                const claimable = table
                  .filter(
                    (r) =>
                      r.tenant_id === effectiveTenantId &&
                      (r.status === 'pending' || r.status === 'delivery_unknown')
                  )
                  .slice(0, limit);

                for (const row of claimable) {
                  row.status = 'processing';
                  row.updated_at = new Date();
                }
                return { rows: claimable, rowCount: claimable.length, command: 'UPDATE', oid: 0, fields: [] };
              }

              // Standard UPDATE
              // SET status = $1, last_error = ..., next_retry_at = $3, retry_count = ..., updated_at = NOW()
              // WHERE tenant_id = $5 AND id = $6
              const newStatus = sqlValues[0] as OutboxStatus;
              const error = sqlValues[1] as string | null;
              const nextRetryAt = sqlValues[2] as Date | null;
              const incrementRetry = Boolean(sqlValues[3]);
              const tenantId = Number(sqlValues[4]);
              const id = String(sqlValues[5]);

              if (effectiveTenantId !== tenantId) {
                return { rows: [], rowCount: 0, command: 'UPDATE', oid: 0, fields: [] };
              }

              const row = table.find((r) => r.tenant_id === tenantId && String(r.id) === id);
              if (!row) {
                return { rows: [], rowCount: 0, command: 'UPDATE', oid: 0, fields: [] };
              }

              row.status = newStatus;
              if (error !== null) row.last_error = error;
              if (nextRetryAt !== null) row.next_retry_at = nextRetryAt;
              if (incrementRetry) row.retry_count = Number(row.retry_count || 0) + 1;
              row.updated_at = new Date();

              return { rows: [row], rowCount: 1, command: 'UPDATE', oid: 0, fields: [] };
            }
          }

          // 2. idempotency_ledger
          if (sql.includes('idempotency_ledger')) {
            const table = tables.idempotency_ledger;

            if (upper.startsWith('INSERT')) {
              const insertTenantId = Number(sqlValues[0]);
              if (!effectiveTenantId || effectiveTenantId !== insertTenantId) {
                const err = new Error('new row violates row-level security policy for table "idempotency_ledger"');
                (err as any).code = '44501';
                throw err;
              }

              const key = String(sqlValues[1]);
              const existing = table.find((r) => r.tenant_id === insertTenantId && r.idempotency_key === key);
              if (existing) {
                const err = new Error('duplicate key value violates unique constraint "uq_idempotency_ledger"');
                (err as any).code = '23505';
                throw err;
              }

              const newRow: MockDbRecord = {
                id: crypto.randomUUID(),
                tenant_id: insertTenantId,
                idempotency_key: key,
                source: sqlValues[2],
                request_hash: sqlValues[3],
                response_status: sqlValues[4] || 200,
                response_body: sqlValues[5],
                created_at: new Date(),
              };
              table.push(newRow);
              return { rows: [newRow], rowCount: 1, command: 'INSERT', oid: 0, fields: [] };
            }

            if (upper.startsWith('SELECT')) {
              if (!effectiveTenantId) {
                return { rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] };
              }
              const key = String(sqlValues[1]);
              const filtered = table.filter(
                (r) => r.tenant_id === effectiveTenantId && r.idempotency_key === key
              );
              return { rows: filtered, rowCount: filtered.length, command: 'SELECT', oid: 0, fields: [] };
            }
          }

          // 3. channel_capabilities_snapshots
          if (sql.includes('channel_capabilities_snapshots')) {
            const table = tables.channel_capabilities_snapshots;

            if (upper.startsWith('INSERT')) {
              const insertTenantId = Number(sqlValues[0]);
              if (!effectiveTenantId || effectiveTenantId !== insertTenantId) {
                const err = new Error('new row violates row-level security policy for table "channel_capabilities_snapshots"');
                (err as any).code = '44501';
                throw err;
              }

              const connectionId = String(sqlValues[1]);
              const channel = String(sqlValues[2]);
              const matrix = sqlValues[3];
              const healthStatus = String(sqlValues[4]);

              const existingIdx = table.findIndex(
                (r) => r.tenant_id === insertTenantId && r.connection_id === connectionId
              );

              if (existingIdx >= 0) {
                table[existingIdx].channel = channel;
                table[existingIdx].matrix = matrix;
                table[existingIdx].health_status = healthStatus;
                table[existingIdx].last_evaluated_at = new Date();
                table[existingIdx].updated_at = new Date();
                return { rows: [table[existingIdx]], rowCount: 1, command: 'INSERT', oid: 0, fields: [] };
              }

              const newRow: MockDbRecord = {
                id: crypto.randomUUID(),
                tenant_id: insertTenantId,
                connection_id: connectionId,
                channel,
                matrix,
                health_status: healthStatus,
                last_evaluated_at: new Date(),
                created_at: new Date(),
                updated_at: new Date(),
              };
              table.push(newRow);
              return { rows: [newRow], rowCount: 1, command: 'INSERT', oid: 0, fields: [] };
            }

            if (upper.startsWith('SELECT')) {
              if (!effectiveTenantId) {
                return { rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] };
              }
              const connectionId = String(sqlValues[1]);
              const filtered = table.filter(
                (r) => r.tenant_id === effectiveTenantId && r.connection_id === connectionId
              );
              return { rows: filtered, rowCount: filtered.length, command: 'SELECT', oid: 0, fields: [] };
            }

            if (upper.startsWith('UPDATE')) {
              if (!effectiveTenantId) {
                return { rows: [], rowCount: 0, command: 'UPDATE', oid: 0, fields: [] };
              }
              const healthStatus = String(sqlValues[0]);
              const matrix = sqlValues[1];
              const tenantId = Number(sqlValues[2]);
              const connectionId = String(sqlValues[3]);

              const row = table.find((r) => r.tenant_id === tenantId && r.connection_id === connectionId);
              if (row) {
                row.health_status = healthStatus;
                row.matrix = matrix;
                row.last_evaluated_at = new Date();
                row.updated_at = new Date();
                return { rows: [row], rowCount: 1, command: 'UPDATE', oid: 0, fields: [] };
              }
              return { rows: [], rowCount: 0, command: 'UPDATE', oid: 0, fields: [] };
            }
          }

          return { rows: [], rowCount: 0, command: 'UNKNOWN', oid: 0, fields: [] };
        },
        release: () => {},
      };

      return client as PoolClient;
    },
  };

  return mockPool;
}

// Helper to create mock Express Req/Res
function createMockHttp(options: {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: any;
  tenantId?: number;
  rawBody?: Buffer;
}) {
  const req: any = {
    method: options.method || 'POST',
    url: options.url || '/api/webhooks/whatsapp',
    originalUrl: options.url || '/api/webhooks/whatsapp',
    headers: options.headers || {},
    body: options.body || {},
    tenantId: options.tenantId,
    rawBody: options.rawBody || Buffer.from(JSON.stringify(options.body || {}), 'utf8'),
  };

  const res: any = {
    statusCode: 200,
    body: null,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(data: any) {
      this.body = data;
      return this;
    },
  };

  return { req, res };
}

// Sample valid ChannelCapabilityMatrix for tests
function createSampleMatrix(overrides?: Partial<ChannelCapabilityMatrix>): ChannelCapabilityMatrix {
  return {
    connectionId: 'conn-wa-test-1',
    tenantId: '1',
    channel: 'whatsapp-cloud',
    features: {
      text: true,
      image: true,
      audio: true,
      video: false, // video disabled for feature-unsupported test
      document: true,
      template: true,
      interactive: true,
      reactions: true,
      typing: true,
      readReceipt: true,
    },
    scopes: ['messages:read', 'messages:write', 'templates:read'],
    policies: {
      sessionWindowHours: 24,
      requiresHsmTemplateOutsideWindow: true,
      rateLimitPerMinute: 80,
      requiresOptIn: true,
    },
    health: {
      status: 'healthy',
      lastCheckedAt: new Date().toISOString(),
      latencyMs: 45,
    },
    budget: {
      tier: 'standard',
      costPerMessageCents: 5,
      monthlyBudgetLimitCents: 10000, // 100 USD
      currentMonthSpendCents: 2000,
    },
    regional: {
      blacklistedCountries: ['KP', 'IR', 'SY'],
    },
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// =============================================================================
// Test Suites
// =============================================================================

describe('Phase 2 Foundation 1: Processing Outbox, Idempotency & Capability Registry', () => {
  // ---------------------------------------------------------------------------
  // Suite 1: Migration 024 DDL, Constraints, and Engine-Level RLS Verification
  // ---------------------------------------------------------------------------
  describe('Suite 1: Migration 024 DDL & Schema Static Verification', () => {
    const migrationPath = path.join(__dirname, '../db/migrations/024_create_processing_outbox_and_capabilities.sql');
    let sqlContent: string;

    beforeEach(() => {
      assert.ok(fs.existsSync(migrationPath), `Migration file must exist at ${migrationPath}`);
      sqlContent = fs.readFileSync(migrationPath, 'utf8');
    });

    test('defines processing_outbox table with delivery_unknown status and correct schema', () => {
      assert.match(sqlContent, /CREATE TABLE IF NOT EXISTS processing_outbox/i);
      assert.match(sqlContent, /id UUID PRIMARY KEY DEFAULT gen_random_uuid\(\)/i);
      assert.match(sqlContent, /tenant_id INTEGER NOT NULL REFERENCES tenants\(id\)/i);
      assert.match(sqlContent, /workspace_id INTEGER REFERENCES workspaces\(id\)/i);
      assert.match(sqlContent, /idempotency_key TEXT NOT NULL/i);
      assert.match(sqlContent, /CONSTRAINT uq_processing_outbox_tenant_idempotency UNIQUE \(tenant_id, idempotency_key\)/i);
      assert.match(sqlContent, /status VARCHAR\(50\) NOT NULL DEFAULT 'pending'/i);

      // Verify all 7 required status values in check constraint
      const statusCheckMatch = sqlContent.match(/CONSTRAINT chk_outbox_status CHECK\s*\(\s*status IN\s*\(([^)]+)\)\s*\)/i);
      assert.ok(statusCheckMatch, 'chk_outbox_status constraint must exist');
      const statuses = statusCheckMatch[1];
      assert.ok(statuses.includes("'pending'"), "status must include 'pending'");
      assert.ok(statuses.includes("'processing'"), "status must include 'processing'");
      assert.ok(statuses.includes("'dispatched'"), "status must include 'dispatched'");
      assert.ok(statuses.includes("'completed'"), "status must include 'completed'");
      assert.ok(statuses.includes("'failed'"), "status must include 'failed'");
      assert.ok(statuses.includes("'delivery_unknown'"), "status must include 'delivery_unknown' (ADR-007)");
      assert.ok(statuses.includes("'dead_letter'"), "status must include 'dead_letter'");
    });

    test('defines idempotency_ledger table with unique constraint and idempotency_keys view', () => {
      assert.match(sqlContent, /CREATE TABLE IF NOT EXISTS idempotency_ledger/i);
      assert.match(sqlContent, /CONSTRAINT uq_idempotency_ledger UNIQUE \(tenant_id, idempotency_key\)/i);
      assert.match(sqlContent, /CREATE OR REPLACE VIEW idempotency_keys AS/i);
    });

    test('defines channel_capabilities_snapshots table with unique connection per tenant', () => {
      assert.match(sqlContent, /CREATE TABLE IF NOT EXISTS channel_capabilities_snapshots/i);
      assert.match(sqlContent, /CONSTRAINT uq_channel_capabilities_connection UNIQUE \(tenant_id, connection_id\)/i);
      assert.match(sqlContent, /matrix JSONB NOT NULL/i);
      assert.match(sqlContent, /health_status VARCHAR\(50\) NOT NULL DEFAULT 'healthy'/i);
    });

    test('enables and forces RLS on all 3 tables with AS PERMISSIVE isolation policies', () => {
      const requiredTables = [
        'processing_outbox',
        'idempotency_ledger',
        'channel_capabilities_snapshots',
      ];

      for (const table of requiredTables) {
        const enableRegex = new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`, 'i');
        const forceRegex = new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`, 'i');
        const policyRegex = new RegExp(
          `CREATE POLICY tenant_isolation_policy ON ${table}\\s+AS PERMISSIVE\\s+USING\\s*\\(tenant_id = NULLIF\\(current_setting\\('app\\.current_tenant_id', true\\), ''\\)::integer\\)`,
          'i'
        );

        assert.match(sqlContent, enableRegex, `RLS must be enabled on ${table}`);
        assert.match(sqlContent, forceRegex, `RLS must be forced on ${table}`);
        assert.match(sqlContent, policyRegex, `Policy on ${table} must be AS PERMISSIVE with app.current_tenant_id`);
      }

      // Invariant: No RESTRICTIVE policy should exist (which would lock out all users)
      assert.doesNotMatch(sqlContent, /AS RESTRICTIVE/i, 'Migration must NOT contain AS RESTRICTIVE policies');
    });

    test('documents rollback / revert statements in migration comment block', () => {
      assert.match(sqlContent, /REVERT \/ ROLLBACK SPECIFICATION/i);
      assert.match(sqlContent, /DROP TABLE IF EXISTS processing_outbox CASCADE/i);
      assert.match(sqlContent, /DROP TABLE IF EXISTS idempotency_ledger CASCADE/i);
      assert.match(sqlContent, /DROP TABLE IF EXISTS channel_capabilities_snapshots CASCADE/i);
      assert.match(sqlContent, /DROP VIEW IF EXISTS idempotency_keys CASCADE/i);
    });
  });

  // ---------------------------------------------------------------------------
  // Suite 2: Transactional Outbox Persistence and Status Lifecycle
  // ---------------------------------------------------------------------------
  describe('Suite 2: Transactional Outbox Persistence & Status Lifecycle in TenantScopedUoW', () => {
    let mockPool: ReturnType<typeof createMockOutboxPool>;
    let uow: TenantScopedUoW;
    let repo: OutboxRepository;

    beforeEach(() => {
      mockPool = createMockOutboxPool();
      uow = new TenantScopedUoW(mockPool as unknown as Pool);
      repo = new OutboxRepository(uow);
    });

    test('enqueues outbox record inside TenantScopedUoW transaction', async () => {
      const record = await repo.enqueue(1, {
        eventType: 'com.whatsapautomat.channel.message.received',
        correlationId: 'corr-1001',
        idempotencyKey: 'msg:wamid-12345',
        payload: { text: 'Hello from customer' },
      });

      assert.ok(record.id, 'Record must have generated UUID');
      assert.strictEqual(record.tenant_id, 1);
      assert.strictEqual(record.status, 'pending');
      assert.strictEqual(record.idempotency_key, 'msg:wamid-12345');
      assert.strictEqual(record.retry_count, 0);
      assert.strictEqual(record.max_retries, 5);

      // Verify camelCase accessors
      assert.strictEqual(record.tenantId, 1);
      assert.strictEqual(record.idempotencyKey, 'msg:wamid-12345');
    });

    test('fail-closed: querying outbox without active tenant returns null/empty', async () => {
      await repo.enqueue(1, {
        eventType: 'test.event',
        correlationId: 'c1',
        idempotencyKey: 'key-1',
        payload: { val: 1 },
      });

      // Raw query without app.current_tenant_id set
      const client = await mockPool.connect();
      const res = await client.query('SELECT * FROM processing_outbox WHERE idempotency_key = $1', ['key-1']);
      assert.strictEqual(res.rows.length, 0, 'Un-scoped query must return 0 rows (fail-closed)');
    });

    test('cross-tenant isolation: Tenant 1 cannot access Tenant 2 outbox records', async () => {
      await repo.enqueue(1, {
        eventType: 'test.event.t1',
        correlationId: 'c1',
        idempotencyKey: 'key-t1',
        payload: { secret: 'tenant1_secret' },
      });

      await repo.enqueue(2, {
        eventType: 'test.event.t2',
        correlationId: 'c2',
        idempotencyKey: 'key-t2',
        payload: { secret: 'tenant2_secret' },
      });

      const foundByT1 = await repo.findByIdempotencyKey(1, 'key-t2');
      assert.strictEqual(foundByT1, null, 'Tenant 1 must not find Tenant 2 record');

      const foundByT2 = await repo.findByIdempotencyKey(2, 'key-t1');
      assert.strictEqual(foundByT2, null, 'Tenant 2 must not find Tenant 1 record');
    });

    test('transaction atomicity: rolls back outbox insert on error during transaction', async () => {
      await assert.rejects(
        async () => {
          await uow.run(1, async (txClient) => {
            await repo.enqueue(
              1,
              {
                eventType: 'test.failing',
                correlationId: 'c-err',
                idempotencyKey: 'key-fail',
                payload: {},
              },
              txClient
            );
            throw new Error('Simulated database error during transaction');
          });
        },
        /Simulated database error during transaction/
      );

      // Verify no records committed to table due to rollback
      assert.strictEqual(mockPool.tables.processing_outbox.length, 0);
    });

    test('supports full status lifecycle: pending -> processing -> dispatched -> completed', async () => {
      const created = await repo.enqueue(1, {
        eventType: 'order.dispatched',
        correlationId: 'c-lifecycle',
        idempotencyKey: 'key-lifecycle',
        payload: { orderId: 42 },
      });

      // 1. Claim pending -> marks 'processing'
      const claimed = await repo.claimPending(1, 10);
      assert.strictEqual(claimed.length, 1);
      assert.strictEqual(claimed[0].status, 'processing');

      // 2. Mark dispatched
      const dispatched = await repo.markDispatched(1, created.id);
      assert.strictEqual(dispatched?.status, 'dispatched');

      // 3. Mark completed
      const completed = await repo.markCompleted(1, created.id);
      assert.strictEqual(completed?.status, 'completed');
    });

    test('supports delivery_unknown semantics (ADR-007) and retry scheduling', async () => {
      const created = await repo.enqueue(1, {
        eventType: 'message.send',
        correlationId: 'c-ad07',
        idempotencyKey: 'key-ad07',
        payload: { to: '123' },
      });

      // Network timeout occurred while sending -> delivery_unknown
      const unknownRecord = await repo.markDeliveryUnknown(
        1,
        created.id,
        'ETIMEDOUT: Meta Graph API socket hung up'
      );
      assert.strictEqual(unknownRecord?.status, 'delivery_unknown');
      assert.strictEqual(unknownRecord?.last_error, 'ETIMEDOUT: Meta Graph API socket hung up');
      assert.strictEqual(unknownRecord?.retry_count, 0, 'delivery_unknown must not increment retry count immediately');

      // Schedule retry
      const retryDate = new Date(Date.now() + 5000);
      const scheduled = await repo.scheduleRetry(1, created.id, 'Will retry after backoff', retryDate);
      assert.strictEqual(scheduled?.status, 'pending');
      assert.strictEqual(scheduled?.retry_count, 1);
      assert.strictEqual(scheduled?.last_error, 'Will retry after backoff');

      // Dead letter after reaching max retries
      const deadLetter = await repo.markDeadLetter(1, created.id, 'Max retries exceeded');
      assert.strictEqual(deadLetter?.status, 'dead_letter');
      assert.strictEqual(deadLetter?.retry_count, 2);
    });

    test('enqueue returns existing record on duplicate idempotency key without creating row', async () => {
      const first = await repo.enqueue(1, {
        eventType: 'event.once',
        correlationId: 'c-once',
        idempotencyKey: 'key-once-1',
        payload: { step: 1 },
      });

      const second = await repo.enqueue(1, {
        eventType: 'event.once',
        correlationId: 'c-once',
        idempotencyKey: 'key-once-1',
        payload: { step: 2 },
      });

      assert.strictEqual(first.id, second.id);
      assert.strictEqual(mockPool.tables.processing_outbox.length, 1);
    });
  });

  // ---------------------------------------------------------------------------
  // Suite 3: HMAC SHA-256 Signature Verification & Anti-Replay Tolerances
  // ---------------------------------------------------------------------------
  describe('Suite 3: Webhook HMAC SHA-256 & Anti-Replay Tolerances (+/- 300s)', () => {
    const testSecret = 'whsec_very_secure_shared_secret_12345';
    const testPayload = JSON.stringify({ event: 'message.received', id: 'msg-001' });

    function computeValidSignature(secret: string, body: string): string {
      const hmac = crypto.createHmac('sha256', secret).update(body).digest('hex');
      return `sha256=${hmac}`;
    }

    test('validates correct HMAC SHA-256 signature with sha256= prefix and timingSafeEqual', () => {
      const validSig = computeValidSignature(testSecret, testPayload);
      assert.strictEqual(verifyWebhookHmac(testSecret, testPayload, validSig), true);
    });

    test('validates correct HMAC SHA-256 signature without sha256= prefix', () => {
      const validSig = computeValidSignature(testSecret, testPayload).slice(7);
      assert.strictEqual(verifyWebhookHmac(testSecret, testPayload, validSig), true);
    });

    test('rejects tampered payload with original signature', () => {
      const validSig = computeValidSignature(testSecret, testPayload);
      const tamperedPayload = JSON.stringify({ event: 'message.received', id: 'msg-001', injected: true });
      assert.strictEqual(verifyWebhookHmac(testSecret, tamperedPayload, validSig), false);
    });

    test('rejects wrong secret', () => {
      const sigWithWrongSecret = computeValidSignature('wrong-secret-value', testPayload);
      assert.strictEqual(verifyWebhookHmac(testSecret, testPayload, sigWithWrongSecret), false);
    });

    test('rejects missing or empty signature header', () => {
      assert.strictEqual(verifyWebhookHmac(testSecret, testPayload, undefined), false);
      assert.strictEqual(verifyWebhookHmac(testSecret, testPayload, ''), false);
    });

    test('rejects non-hex or malformed signature', () => {
      assert.strictEqual(verifyWebhookHmac(testSecret, testPayload, 'sha256=not-a-valid-hex-string!!'), false);
    });

    test('anti-replay: allows timestamps within +/- 300s tolerance', () => {
      const now = Date.now();

      // Current timestamp
      const checkNow = verifyAntiReplayTimestamp(now, 300);
      assert.strictEqual(checkNow.valid, true);

      // 150s in the past
      const checkPast = verifyAntiReplayTimestamp(now - 150_000, 300);
      assert.strictEqual(checkPast.valid, true);

      // 150s in the future (acceptable clock skew)
      const checkFuture = verifyAntiReplayTimestamp(now + 150_000, 300);
      assert.strictEqual(checkFuture.valid, true);

      // Exactly 300s
      const checkBoundary = verifyAntiReplayTimestamp(now - 300_000, 300);
      assert.strictEqual(checkBoundary.valid, true);
    });

    test('anti-replay: rejects timestamps older than 300s (stale replay)', () => {
      const now = Date.now();
      const staleTime = now - 301_000; // 301s in past

      const check = verifyAntiReplayTimestamp(staleTime, 300);
      assert.strictEqual(check.valid, false);
      assert.ok(check.reason?.includes('outside allowable anti-replay window'));
      assert.ok(check.skewSeconds! >= 300);
    });

    test('anti-replay: rejects timestamps more than 300s in the future (far future attack)', () => {
      const now = Date.now();
      const futureTime = now + 305_000;

      const check = verifyAntiReplayTimestamp(futureTime, 300);
      assert.strictEqual(check.valid, false);
      assert.ok(check.reason?.includes('outside allowable anti-replay window'));
    });

    test('anti-replay: supports seconds format, milliseconds format, and ISO strings', () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      assert.strictEqual(verifyAntiReplayTimestamp(nowSeconds, 300).valid, true);

      const nowMs = Date.now();
      assert.strictEqual(verifyAntiReplayTimestamp(nowMs, 300).valid, true);

      const nowIso = new Date().toISOString();
      assert.strictEqual(verifyAntiReplayTimestamp(nowIso, 300).valid, true);

      // Invalid format
      assert.strictEqual(verifyAntiReplayTimestamp('invalid-date-string', 300).valid, false);
    });
  });

  // ---------------------------------------------------------------------------
  // Suite 4: Ingress Deduplication via Idempotency Ledger
  // ---------------------------------------------------------------------------
  describe('Suite 4: Ingress Deduplication via idempotency_ledger & Outbox Enqueue', () => {
    let mockPool: ReturnType<typeof createMockOutboxPool>;
    let uow: TenantScopedUoW;
    let repo: OutboxRepository;
    const secret = 'whsec_test_secret_for_middleware';

    beforeEach(() => {
      mockPool = createMockOutboxPool();
      uow = new TenantScopedUoW(mockPool as unknown as Pool);
      repo = new OutboxRepository(uow);
    });

    test('first submission persists to idempotency_ledger and processing_outbox, returning HTTP 200', async () => {
      const middleware = createWebhookIdempotencyMiddleware({
        secret,
        uow,
        outboxRepo: repo,
      });

      const body = { entry: [{ changes: [{ value: { messages: [{ id: 'wamid-first-1' }] } }] }] };
      const rawBody = Buffer.from(JSON.stringify(body), 'utf8');
      const sig = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;

      const { req, res } = createMockHttp({
        headers: {
          'x-hub-signature-256': sig,
          'x-timestamp': String(Date.now()),
        },
        body,
        rawBody,
        tenantId: 1,
      });

      await middleware(req, res, () => {});

      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(res.body.status, 'accepted');
      assert.strictEqual(res.body.idempotencyKey, 'wamid-first-1');

      // Verify records in DB
      assert.strictEqual(mockPool.tables.idempotency_ledger.length, 1);
      assert.strictEqual(mockPool.tables.processing_outbox.length, 1);
      assert.strictEqual(mockPool.tables.idempotency_ledger[0].idempotency_key, 'wamid-first-1');
      assert.strictEqual(mockPool.tables.processing_outbox[0].idempotency_key, 'wamid-first-1');
    });

    test('duplicate submission returns HTTP 200 immediately with zero new rows in outbox', async () => {
      const middleware = createWebhookIdempotencyMiddleware({
        secret,
        uow,
        outboxRepo: repo,
      });

      const body = { idempotencyKey: 'custom-key-dup-1', event: 'contact.updated' };
      const rawBody = Buffer.from(JSON.stringify(body), 'utf8');
      const sig = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;

      // Request 1
      const http1 = createMockHttp({
        headers: { 'x-hub-signature-256': sig, 'x-timestamp': String(Date.now()) },
        body,
        rawBody,
        tenantId: 1,
      });
      await middleware(http1.req, http1.res, () => {});
      assert.strictEqual(http1.res.statusCode, 200);
      assert.strictEqual(mockPool.tables.processing_outbox.length, 1);

      // Request 2 (Duplicate)
      const http2 = createMockHttp({
        headers: { 'x-hub-signature-256': sig, 'x-timestamp': String(Date.now() + 1000) },
        body,
        rawBody,
        tenantId: 1,
      });
      await middleware(http2.req, http2.res, () => {});

      assert.strictEqual(http2.res.statusCode, 200);
      assert.strictEqual(http2.res.body.success, true);
      // Ensure outbox still has exactly 1 row (no duplicate row)
      assert.strictEqual(mockPool.tables.processing_outbox.length, 1);
      assert.strictEqual(mockPool.tables.idempotency_ledger.length, 1);
    });

    test('multi-tenant deduplication isolation: Tenant 1 and Tenant 2 use same idempotencyKey independently', async () => {
      const middleware = createWebhookIdempotencyMiddleware({
        secret,
        uow,
        outboxRepo: repo,
      });

      const body = { idempotencyKey: 'shared-event-id-99', data: 'sample' };
      const rawBody = Buffer.from(JSON.stringify(body), 'utf8');
      const sig = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;

      // Tenant 1
      const httpT1 = createMockHttp({
        headers: { 'x-hub-signature-256': sig, 'x-timestamp': String(Date.now()) },
        body,
        rawBody,
        tenantId: 1,
      });
      await middleware(httpT1.req, httpT1.res, () => {});
      assert.strictEqual(httpT1.res.statusCode, 200);

      // Tenant 2 with same idempotencyKey
      const httpT2 = createMockHttp({
        headers: { 'x-hub-signature-256': sig, 'x-timestamp': String(Date.now()) },
        body,
        rawBody,
        tenantId: 2,
      });
      await middleware(httpT2.req, httpT2.res, () => {});
      assert.strictEqual(httpT2.res.statusCode, 200);

      // Both tenants have their own row
      assert.strictEqual(mockPool.tables.idempotency_ledger.length, 2);
      assert.strictEqual(mockPool.tables.processing_outbox.length, 2);
    });

    test('rejects webhook with invalid HMAC signature with HTTP 401 ProblemDetails', async () => {
      const middleware = createWebhookIdempotencyMiddleware({
        secret,
        uow,
        outboxRepo: repo,
      });

      const { req, res } = createMockHttp({
        headers: { 'x-hub-signature-256': 'sha256=badbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbad' },
        body: { some: 'payload' },
        tenantId: 1,
      });

      await middleware(req, res, () => {});

      assert.strictEqual(res.statusCode, 401);
      assert.strictEqual(res.body.code, StandardErrorCode.UNAUTHORIZED);
      assert.strictEqual(res.body.title, 'Invalid Webhook Signature');
    });

    test('rejects webhook with timestamp out of window with HTTP 400 ProblemDetails', async () => {
      const middleware = createWebhookIdempotencyMiddleware({
        secret,
        toleranceSeconds: 300,
        uow,
        outboxRepo: repo,
      });

      const body = { msg: 'old' };
      const rawBody = Buffer.from(JSON.stringify(body), 'utf8');
      const sig = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;

      const { req, res } = createMockHttp({
        headers: {
          'x-hub-signature-256': sig,
          'x-timestamp': String(Date.now() - 400_000), // 400s old
        },
        body,
        rawBody,
        tenantId: 1,
      });

      await middleware(req, res, () => {});

      assert.strictEqual(res.statusCode, 400);
      assert.strictEqual(res.body.code, StandardErrorCode.VALIDATION_ERROR);
      assert.strictEqual(res.body.title, 'Timestamp Out of Allowed Replay Window');
    });

    test('rejects request with missing tenant context with HTTP 403 ProblemDetails', async () => {
      const middleware = createWebhookIdempotencyMiddleware({
        secret,
        uow,
        outboxRepo: repo,
      });

      const body = { msg: 'no tenant' };
      const rawBody = Buffer.from(JSON.stringify(body), 'utf8');
      const sig = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;

      const { req, res } = createMockHttp({
        headers: { 'x-hub-signature-256': sig },
        body,
        rawBody,
        // No tenantId provided
      });

      await middleware(req, res, () => {});

      assert.strictEqual(res.statusCode, 403);
      assert.strictEqual(res.body.code, StandardErrorCode.POLICY_DENIED);
      assert.strictEqual(res.body.title, 'Missing Tenancy Context');
    });
  });

  // ---------------------------------------------------------------------------
  // Suite 5: CapabilityRegistry 6-Dimension Evaluation & Publish Gate
  // ---------------------------------------------------------------------------
  describe('Suite 5: CapabilityRegistry 6-Dimension Evaluation & Deterministic Publish Gate', () => {
    let mockPool: ReturnType<typeof createMockOutboxPool>;
    let uow: TenantScopedUoW;
    let registry: CapabilityRegistry;

    beforeEach(() => {
      mockPool = createMockOutboxPool();
      uow = new TenantScopedUoW(mockPool as unknown as Pool);
      registry = new CapabilityRegistry(uow, { ttlMs: 10_000 });
    });

    test('persists and retrieves capability matrix snapshot with in-memory caching', async () => {
      const matrix = createSampleMatrix();
      await registry.saveSnapshot(1, matrix);

      // Verify persisted in DB table
      assert.strictEqual(mockPool.tables.channel_capabilities_snapshots.length, 1);
      assert.strictEqual(mockPool.tables.channel_capabilities_snapshots[0].connection_id, matrix.connectionId);

      // Retrieve snapshot
      const retrieved = await registry.getSnapshot(1, matrix.connectionId);
      assert.ok(retrieved);
      assert.strictEqual(retrieved.connectionId, matrix.connectionId);
      assert.strictEqual(retrieved.channel, 'whatsapp-cloud');
      assert.strictEqual(retrieved.features.text, true);

      // Cache invalidation
      registry.invalidateCache(1, matrix.connectionId);
      const retrievedAfterInvalidate = await registry.getSnapshot(1, matrix.connectionId);
      assert.ok(retrievedAfterInvalidate);
    });

    test('permits free-form text message inside 24h WhatsApp session window', async () => {
      const matrix = createSampleMatrix();
      await registry.saveSnapshot(1, matrix);

      // Last customer interaction was 2 hours ago
      const intent: PublishIntent = {
        messageKind: 'text',
        correlationId: 'corr-gate-1',
        lastCustomerInteractionAt: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
        isTemplate: false,
      };

      const result = await registry.evaluatePublish(1, matrix.connectionId, intent);
      assert.strictEqual(result.permitted, true);

      // assertCanPublish resolves without throwing
      await assert.doesNotReject(async () => {
        await registry.assertCanPublish(1, matrix.connectionId, intent);
      });
    });

    test('blocks free-form text outside 24h WhatsApp window with CH_WA_WINDOW_CLOSED (403)', async () => {
      const matrix = createSampleMatrix();
      await registry.saveSnapshot(1, matrix);

      // Last interaction was 25 hours ago
      const intent: PublishIntent = {
        messageKind: 'text',
        correlationId: 'corr-gate-2',
        lastCustomerInteractionAt: new Date(Date.now() - 25 * 3600 * 1000).toISOString(),
        isTemplate: false,
      };

      const result = await registry.evaluatePublish(1, matrix.connectionId, intent);
      assert.strictEqual(result.permitted, false);
      if (!result.permitted) {
        assert.strictEqual(result.reasonCode, 'CH_WA_WINDOW_CLOSED');
        assert.strictEqual(result.problemDetails.code, StandardErrorCode.POLICY_DENIED);
        assert.strictEqual(result.problemDetails.title, 'Customer Service Window Closed');
        assert.ok(result.problemDetails.detail.includes('24h customer service window has expired'));
      }

      // assertCanPublish throws PublishGateError
      await assert.rejects(
        async () => {
          await registry.assertCanPublish(1, matrix.connectionId, intent);
        },
        (err: any) => {
          assert.ok(err instanceof PublishGateError);
          assert.strictEqual(err.code, 'CH_WA_WINDOW_CLOSED');
          return true;
        }
      );
    });

    test('permits message outside 24h window when sending an approved HSM template', async () => {
      const matrix = createSampleMatrix();
      await registry.saveSnapshot(1, matrix);

      // 48 hours elapsed, but sending template
      const intent: PublishIntent = {
        messageKind: 'template',
        correlationId: 'corr-gate-3',
        lastCustomerInteractionAt: new Date(Date.now() - 48 * 3600 * 1000).toISOString(),
        isTemplate: true,
      };

      const result = await registry.evaluatePublish(1, matrix.connectionId, intent);
      assert.strictEqual(result.permitted, true);
    });

    test('blocks unsupported technical feature with CAPABILITY_UNSUPPORTED (403)', async () => {
      const matrix = createSampleMatrix(); // video is false
      await registry.saveSnapshot(1, matrix);

      const intent: PublishIntent = {
        messageKind: 'video',
        correlationId: 'corr-gate-4',
      };

      const result = await registry.evaluatePublish(1, matrix.connectionId, intent);
      assert.strictEqual(result.permitted, false);
      if (!result.permitted) {
        assert.strictEqual(result.reasonCode, 'CAPABILITY_UNSUPPORTED');
        assert.strictEqual(result.problemDetails.code, StandardErrorCode.POLICY_DENIED);
        assert.ok(result.problemDetails.detail.includes("does not support 'video' payloads"));
      }
    });

    test('blocks unhealthy connection (down / needs_reauthorization) with CHANNEL_UNHEALTHY (403)', async () => {
      const matrix = createSampleMatrix();
      await registry.saveSnapshot(1, matrix);

      // Update connection health to 'down'
      await registry.updateHealth(1, matrix.connectionId, {
        status: 'down',
        lastCheckedAt: new Date().toISOString(),
        errorMessage: 'Connection dropped by remote provider',
      });

      const intent: PublishIntent = {
        messageKind: 'text',
        correlationId: 'corr-gate-5',
      };

      const result = await registry.evaluatePublish(1, matrix.connectionId, intent);
      assert.strictEqual(result.permitted, false);
      if (!result.permitted) {
        assert.strictEqual(result.reasonCode, 'CHANNEL_UNHEALTHY');
        assert.strictEqual(result.problemDetails.code, StandardErrorCode.POLICY_DENIED);
        assert.ok(result.problemDetails.detail.includes("connection is in status 'down'"));
      }
    });

    test('blocks recipient in blacklisted country with REGION_RESTRICTED (403)', async () => {
      const matrix = createSampleMatrix(); // KP, IR, SY blacklisted
      await registry.saveSnapshot(1, matrix);

      const intent: PublishIntent = {
        messageKind: 'text',
        correlationId: 'corr-gate-6',
        recipientCountry: 'kp', // test lowercase normalization
      };

      const result = await registry.evaluatePublish(1, matrix.connectionId, intent);
      assert.strictEqual(result.permitted, false);
      if (!result.permitted) {
        assert.strictEqual(result.reasonCode, 'REGION_RESTRICTED');
        assert.strictEqual(result.problemDetails.code, StandardErrorCode.POLICY_DENIED);
        assert.ok(result.problemDetails.detail.includes("country 'KP' is prohibited"));
      }
    });

    test('blocks publish when monthly budget is exceeded with BUDGET_EXCEEDED (429)', async () => {
      const matrix = createSampleMatrix({
        budget: {
          tier: 'standard',
          costPerMessageCents: 10,
          monthlyBudgetLimitCents: 5000,
          currentMonthSpendCents: 4995, // Next 10 cents message puts it at 5005 > 5000
        },
      });
      await registry.saveSnapshot(1, matrix);

      const intent: PublishIntent = {
        messageKind: 'text',
        correlationId: 'corr-gate-7',
      };

      const result = await registry.evaluatePublish(1, matrix.connectionId, intent);
      assert.strictEqual(result.permitted, false);
      if (!result.permitted) {
        assert.strictEqual(result.reasonCode, 'BUDGET_EXCEEDED');
        assert.strictEqual(result.problemDetails.code, StandardErrorCode.RATE_LIMITED);
        assert.strictEqual(result.problemDetails.status, 429);
        assert.ok(result.problemDetails.detail.includes('Monthly budget limit of 5000 cents reached'));
      }
    });

    test('returns CAPABILITY_UNSUPPORTED with 404 when connection snapshot is not registered', async () => {
      const intent: PublishIntent = {
        messageKind: 'text',
        correlationId: 'corr-gate-unknown',
      };

      const result = await registry.evaluatePublish(1, 'non-existent-connection', intent);
      assert.strictEqual(result.permitted, false);
      if (!result.permitted) {
        assert.strictEqual(result.reasonCode, 'CAPABILITY_UNSUPPORTED');
        assert.strictEqual(result.problemDetails.code, StandardErrorCode.NOT_FOUND);
      }
    });
  });
});
