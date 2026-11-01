// Invariants before config load
process.env.JWT_SECRET = 'test-only-jwt-secret-with-at-least-32-characters-for-testing';
process.env.DB_PASSWORD = 'test-only-database-password';

import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { Pool, PoolClient, QueryResult } from 'pg';
import type { NextFunction, Response } from 'express';

const {
  ConversationCasService,
  CasConflictError,
  ConversationNotFoundError,
} = require('../services/conversations/ConversationCasService') as typeof import('../services/conversations/ConversationCasService');
type TakeoverResult = import('../services/conversations/ConversationCasService').TakeoverResult;

const { TenantScopedUoW } = require('../db/TenantScopedUoW') as typeof import('../db/TenantScopedUoW');
const { setSocketIo } = require('../sockets/socketEmitter') as typeof import('../sockets/socketEmitter');
const createConversationRoutes = require('../routes/conversationRoutes').default as typeof import('../routes/conversationRoutes').default;
import type { JwtRequest } from '../middleware/jwtAuth';

// =============================================================================
// Mock Database Pool & Concurrency-Safe Per-Client Undo Log Pattern
// =============================================================================

export interface MockConversationRow {
  id: number;
  company_id: number;
  external_conversation_id: string;
  title: string | null;
  status: string;
  version: number;
  ownership_epoch: number;
  owner_type: 'human' | 'ai_agent';
  owner_id: string | null;
  assigned_user_id: number | null;
  ia_paused: boolean;
  ia_paused_by: number | null;
  ia_paused_at: Date | null;
  ia_resume_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface MockOperationalActionRow {
  id: number;
  company_id: number;
  conversation_id: number;
  actor_user_id: number | null;
  action_type: string;
  status: string;
  description: string;
  metadata_json: Record<string, unknown>;
  occurred_at: Date;
}

export interface MockClientState {
  id: number;
  sessionTenantId: number | null;
  inTransaction: boolean;
  queries: { sql: string; values?: unknown[] }[];
  undoLog: { row: MockConversationRow; original: MockConversationRow }[];
  released: boolean;
}

export function createMockCasPool(initialConversations?: MockConversationRow[]) {
  const conversations: MockConversationRow[] = initialConversations
    ? initialConversations.map((c) => ({ ...c }))
    : [
        {
          id: 101,
          company_id: 1,
          external_conversation_id: '549111223344@c.us',
          title: 'Customer Alpha (Tenant 1)',
          status: 'open',
          version: 1,
          ownership_epoch: 0,
          owner_type: 'ai_agent',
          owner_id: null,
          assigned_user_id: null,
          ia_paused: false,
          ia_paused_by: null,
          ia_paused_at: null,
          ia_resume_at: null,
          created_at: new Date('2026-11-01T00:00:00Z'),
          updated_at: new Date('2026-11-01T00:00:00Z'),
        },
        {
          id: 201,
          company_id: 2, // Tenant 2 for cross-tenant isolation testing
          external_conversation_id: '549222334455@c.us',
          title: 'Customer Beta (Tenant 2)',
          status: 'open',
          version: 1,
          ownership_epoch: 0,
          owner_type: 'ai_agent',
          owner_id: null,
          assigned_user_id: null,
          ia_paused: false,
          ia_paused_by: null,
          ia_paused_at: null,
          ia_resume_at: null,
          created_at: new Date('2026-11-01T00:00:00Z'),
          updated_at: new Date('2026-11-01T00:00:00Z'),
        },
      ];

  const operationalActions: MockOperationalActionRow[] = [];
  const clientStates: MockClientState[] = [];
  let clientCounter = 0;

  const mockPool = {
    tables: {
      conversations,
      operational_actions: operationalActions,
    },
    clientStates,

    async connect(): Promise<PoolClient> {
      clientCounter++;
      const clientState: MockClientState = {
        id: clientCounter,
        sessionTenantId: null,
        inTransaction: false,
        queries: [],
        undoLog: [],
        released: false,
      };
      clientStates.push(clientState);

      const client: Partial<PoolClient> = {
        query: async (
          text: string | { text: string; values?: unknown[] },
          values?: unknown[]
        ): Promise<QueryResult<any>> => {
          const sql = (typeof text === 'string' ? text : text.text).trim();
          const sqlValues = typeof text === 'string' ? values || [] : text.values || [];
          clientState.queries.push({ sql, values: sqlValues });

          const upper = sql.toUpperCase();

          // 1. Transaction Boundaries
          if (upper === 'BEGIN') {
            clientState.inTransaction = true;
            clientState.undoLog = [];
            return { rows: [], rowCount: 0, command: 'BEGIN', oid: 0, fields: [] };
          }

          if (upper === 'COMMIT') {
            clientState.inTransaction = false;
            clientState.sessionTenantId = null;
            clientState.undoLog = [];
            return { rows: [], rowCount: 0, command: 'COMMIT', oid: 0, fields: [] };
          }

          if (upper === 'ROLLBACK') {
            clientState.inTransaction = false;
            clientState.sessionTenantId = null;
            // Concurrency-safe rollback: revert only rows mutated by THIS client
            for (const entry of clientState.undoLog) {
              Object.assign(entry.row, entry.original);
            }
            clientState.undoLog = [];
            return { rows: [], rowCount: 0, command: 'ROLLBACK', oid: 0, fields: [] };
          }

          // 2. SET LOCAL app.current_tenant_id
          const setMatch = sql.match(/SET LOCAL app\.current_tenant_id\s*=\s*'(\d+)'/i);
          if (setMatch) {
            clientState.sessionTenantId = parseInt(setMatch[1], 10);
            return { rows: [], rowCount: 0, command: 'SET', oid: 0, fields: [] };
          }

          const effectiveTenantId = clientState.sessionTenantId;

          // 3. Fail-Closed RLS Enforcement
          if (!effectiveTenantId || effectiveTenantId <= 0) {
            if (upper.startsWith('SELECT')) {
              return { rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] };
            }
            if (upper.startsWith('UPDATE')) {
              return { rows: [], rowCount: 0, command: 'UPDATE', oid: 0, fields: [] };
            }
          }

          // 4. Query Handling: conversations table
          if (sql.includes('conversations')) {
            // A. Atomic CAS UPDATE
            if (upper.startsWith('UPDATE CONVERSATIONS')) {
              // Extraction invariant across Takeover, Pause AI, and Resume AI:
              // last param: expectedVersion
              // second-to-last: company_id
              // third-to-last: id
              const id = Number(sqlValues[sqlValues.length - 3]);
              const tenantId = Number(sqlValues[sqlValues.length - 2]);
              const expectedVersion = Number(sqlValues[sqlValues.length - 1]);

              // Check matching row inside effective tenant
              const row = conversations.find(
                (r) =>
                  r.company_id === effectiveTenantId &&
                  r.company_id === tenantId &&
                  r.id === id &&
                  r.version === expectedVersion
              );

              if (!row) {
                // CAS Mismatch or Not Found: 0 rows affected
                return { rows: [], rowCount: 0, command: 'UPDATE', oid: 0, fields: [] };
              }

              // Record in client's private undo log before mutating
              clientState.undoLog.push({ row, original: { ...row } });

              // Perform Atomic Mutation
              row.version += 1;
              row.updated_at = new Date();

              // Takeover mutation
              if (sql.includes('owner_type') && sql.includes('ownership_epoch') && sql.includes("'human'")) {
                row.owner_type = 'human';
                row.owner_id = String(sqlValues[0]);
                row.assigned_user_id = Number(sqlValues[1]);
                row.ownership_epoch += 1;
                row.ia_paused = true;
                row.ia_paused_by = Number(sqlValues[1]);
                row.ia_paused_at = new Date();
              } else if (sql.includes('ia_paused = true')) {
                // Pause AI mutation
                row.ia_paused = true;
                row.ia_paused_by = Number(sqlValues[0]);
                row.ia_paused_at = new Date();
                row.ia_resume_at = sqlValues[1] ? new Date(sqlValues[1] as string) : null;
              } else if (sql.includes('ia_paused = false')) {
                // Resume AI mutation
                row.ia_paused = false;
                row.ia_paused_by = null;
                row.ia_paused_at = null;
                row.ia_resume_at = null;
                row.owner_type = 'ai_agent';
                row.owner_id = null;
                row.ownership_epoch += 1;
              }

              return { rows: [{ ...row }], rowCount: 1, command: 'UPDATE', oid: 0, fields: [] };
            }

            // B. SELECT Queries (State read, Fallback 404/409 check, or Epoch check)
            if (upper.startsWith('SELECT')) {
              let matched = conversations.filter((r) => r.company_id === effectiveTenantId);

              // WHERE id = $1 AND company_id = $2
              const targetId = Number(sqlValues[0]);
              const targetCompanyId = sqlValues[1] !== undefined ? Number(sqlValues[1]) : undefined;

              if (targetId) {
                matched = matched.filter((r) => r.id === targetId);
              }
              if (targetCompanyId !== undefined) {
                matched = matched.filter((r) => r.company_id === targetCompanyId);
              }

              return {
                rows: matched.map((r) => ({ ...r })),
                rowCount: matched.length,
                command: 'SELECT',
                oid: 0,
                fields: [],
              };
            }
          }

          // 5. INSERT INTO operational_actions (Audit Trail)
          if (sql.includes('operational_actions') && upper.startsWith('INSERT')) {
            const auditRow: MockOperationalActionRow = {
              id: operationalActions.length + 1,
              company_id: effectiveTenantId!,
              conversation_id: Number(sqlValues[1]),
              actor_user_id: sqlValues[2] ? Number(sqlValues[2]) : null,
              action_type: String(sqlValues[3] || 'action'),
              status: 'completed',
              description: String(sqlValues[3] || ''),
              metadata_json:
                typeof sqlValues[4] === 'string'
                  ? JSON.parse(sqlValues[4])
                  : (sqlValues[4] as Record<string, unknown>) || {},
              occurred_at: new Date(),
            };
            operationalActions.push(auditRow);
            return { rows: [{ id: auditRow.id }], rowCount: 1, command: 'INSERT', oid: 0, fields: [] };
          }

          return { rows: [], rowCount: 0, command: 'RAW', oid: 0, fields: [] };
        },

        release(releaseErr?: Error | boolean) {
          clientState.released = true;
        },
      };

      return client as PoolClient;
    },
  };

  return { mockPool: mockPool as unknown as Pool, conversations, operationalActions, clientStates };
}

// =============================================================================
// Helper: Route Dispatcher for In-Memory Testing
// =============================================================================

async function invokeRoute(
  router: any,
  method: 'get' | 'post' | 'patch',
  path: string,
  params: Record<string, string>,
  body?: any,
  user?: any,
  headers: Record<string, string> = {}
) {
  const layer = router.stack.find(
    (candidate: any) => candidate.route?.path === path && candidate.route?.methods?.[method]
  );
  assert.ok(layer, `Route ${method.toUpperCase()} ${path} must exist`);
  const handler = layer.route.stack[0].handle;

  let statusCode = 200;
  let jsonBody: any = null;
  const resHeaders: Record<string, string> = {};

  const req: any = {
    method: method.toUpperCase(),
    params,
    body: body || {},
    headers: { ...headers },
    user: user || { userId: 1, companyId: 1 },
    whatsappCompanyId: user?.companyId || 1,
    originalUrl: `/api/conversations/${params.id}${path.replace('/:id', '')}`,
  };

  const res: any = {
    setHeader(name: string, value: string) {
      resHeaders[name.toLowerCase()] = value;
      return res;
    },
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(data: any) {
      jsonBody = data;
      return res;
    },
  };

  let nextErr: any = null;
  await handler(req, res, (err: any) => {
    nextErr = err;
  });

  return { status: statusCode, headers: resHeaders, body: jsonBody, error: nextErr };
}

// =============================================================================
// PR-F3-01 CAS Concurrency & Ownership Epoch Test Suite
// =============================================================================

describe('PR-F3-01: Control de Concurrencia CAS y Ownership Epoch (WAA-008, SEC-004, ADR-008)', () => {
  const migrationPath = path.resolve(__dirname, '../db/migrations/025_add_conversation_cas_and_channels.sql');

  // Track socket emissions
  const emittedEvents: Array<{ room: string; event: string; payload: any }> = [];
  const mockIo = {
    to(room: string) {
      return {
        emit(event: string, payload: any) {
          emittedEvents.push({ room, event, payload });
        },
      };
    },
  } as any;

  beforeEach(() => {
    emittedEvents.length = 0;
    setSocketIo(mockIo);
  });

  afterEach(() => {
    emittedEvents.length = 0;
    setSocketIo(null as any);
  });

  // ---------------------------------------------------------------------------
  // Suite 1: Migration 025 Static DDL Verification
  // ---------------------------------------------------------------------------
  describe('Suite 1: Migration 025 Static DDL & Schema Verification', () => {
    test('1.1: Migration file 025 exists and references PR-F3-01 specifications', () => {
      assert.ok(fs.existsSync(migrationPath), 'Migration 025 file must exist');
      const content = fs.readFileSync(migrationPath, 'utf8');
      assert.ok(content.includes('Migration 025'), 'Header must reference Migration 025');
      assert.ok(content.includes('PR-F3-01'), 'Header must reference PR-F3-01');
      assert.ok(content.includes('WAA-008'), 'Header must reference WAA-008');
      assert.ok(content.includes('SEC-004'), 'Header must reference SEC-004');
    });

    test('1.2: ALTER TABLE conversations adds CAS and ownership columns with defaults', () => {
      const content = fs.readFileSync(migrationPath, 'utf8');
      assert.ok(/ALTER TABLE conversations/i.test(content), 'Must alter conversations');
      assert.ok(/version INTEGER NOT NULL DEFAULT 1/i.test(content), 'Must add version with default 1');
      assert.ok(/ownership_epoch INTEGER NOT NULL DEFAULT 0/i.test(content), 'Must add ownership_epoch with default 0');
      assert.ok(/owner_type VARCHAR\(50\) NOT NULL DEFAULT 'ai_agent'/i.test(content), 'Must add owner_type default ai_agent');
      assert.ok(/owner_id VARCHAR\(255\)/i.test(content), 'Must add owner_id VARCHAR(255)');
    });

    test('1.3: Check constraint chk_conversations_owner_type restricts allowed owner states', () => {
      const content = fs.readFileSync(migrationPath, 'utf8');
      assert.ok(/chk_conversations_owner_type/i.test(content), 'Must define check constraint name');
      assert.ok(/human/i.test(content) && /ai_agent/i.test(content), 'Must include human and ai_agent in check constraint');
    });

    test('1.4: Supporting indexes for company owner and epoch fencing are created', () => {
      const content = fs.readFileSync(migrationPath, 'utf8');
      assert.ok(/idx_conversations_company_owner/i.test(content), 'Must create idx_conversations_company_owner');
      assert.ok(/idx_conversations_epoch_fencing/i.test(content), 'Must create idx_conversations_epoch_fencing');
    });

    test('1.5: Table channel_connections is created with composite unique constraint', () => {
      const content = fs.readFileSync(migrationPath, 'utf8');
      assert.ok(/CREATE TABLE IF NOT EXISTS channel_connections/i.test(content), 'Must create channel_connections');
      assert.ok(/tenant_id INTEGER NOT NULL REFERENCES tenants\(id\)/i.test(content), 'Must reference tenants(id)');
      assert.ok(/uq_channel_connections_tenant_channel_account/i.test(content), 'Must create composite unique constraint');
      assert.ok(/chk_channel_connections_status/i.test(content), 'Must define status check constraint');
    });

    test('1.6: RLS is enabled and forced on channel_connections with AS PERMISSIVE policy', () => {
      const content = fs.readFileSync(migrationPath, 'utf8');
      assert.ok(/ALTER TABLE channel_connections ENABLE ROW LEVEL SECURITY/i.test(content), 'Must enable RLS');
      assert.ok(/ALTER TABLE channel_connections FORCE ROW LEVEL SECURITY/i.test(content), 'Must force RLS');
      assert.ok(/CREATE POLICY tenant_isolation_policy ON channel_connections\s+AS PERMISSIVE/i.test(content), 'Must be AS PERMISSIVE');
      assert.ok(!content.includes('AS RESTRICTIVE'), 'Must NOT contain AS RESTRICTIVE policies alone');
    });

    test('1.7: Rollback / revert specification is documented in comment block', () => {
      const content = fs.readFileSync(migrationPath, 'utf8');
      assert.ok(/REVERT \/ ROLLBACK SPECIFICATION/i.test(content), 'Must include rollback specification block');
      assert.ok(content.includes('DROP TABLE IF EXISTS channel_connections'), 'Must document channel_connections drop');
      assert.ok(content.includes('DROP COLUMN IF EXISTS version'), 'Must document version column drop');
    });
  });

  // ---------------------------------------------------------------------------
  // Suite 2: Sequential Takeover & Service CAS Lifecycle
  // ---------------------------------------------------------------------------
  describe('Suite 2: Sequential Takeover & Service CAS Lifecycle', () => {
    test('2.1: First takeover transitions v1 -> v2, epoch 0 -> 1, owner_type -> human', async () => {
      const { mockPool, conversations } = createMockCasPool();
      const uow = new TenantScopedUoW(mockPool);
      const service = new ConversationCasService(uow);

      const result = await service.takeoverConversation({
        tenantId: 1,
        conversationId: 101,
        expectedVersion: 1,
        userId: 10,
        reason: 'Operator taking over chat',
      });

      assert.equal(result.success, true);
      assert.equal(result.conversationId, '101');
      assert.equal(result.previousVersion, 1);
      assert.equal(result.newVersion, 2);
      assert.equal(result.epoch, 1);
      assert.equal(result.ownerType, 'human');
      assert.equal(result.ownerId, '10');
      assert.equal(result.aiPaused, true);

      // Verify DB row mutation
      const row = conversations.find((c) => c.id === 101)!;
      assert.equal(row.version, 2);
      assert.equal(row.ownership_epoch, 1);
      assert.equal(row.owner_type, 'human');
      assert.equal(row.owner_id, '10');
      assert.equal(row.ia_paused, true);
      assert.equal(row.assigned_user_id, 10);
    });

    test('2.2: Sequential takeover chain v1 -> v2 -> v3 -> v4 maintains strict monotonic ordering', async () => {
      const { mockPool, conversations } = createMockCasPool();
      const uow = new TenantScopedUoW(mockPool);
      const service = new ConversationCasService(uow);

      // Step 1: User 1 takes over (v1 -> v2, epoch 0 -> 1)
      const res1 = await service.takeoverConversation({
        tenantId: 1,
        conversationId: 101,
        expectedVersion: 1,
        userId: 1,
      });
      assert.equal(res1.newVersion, 2);
      assert.equal(res1.epoch, 1);

      // Step 2: User 2 takes over (v2 -> v3, epoch 1 -> 2)
      const res2 = await service.takeoverConversation({
        tenantId: 1,
        conversationId: 101,
        expectedVersion: 2,
        userId: 2,
      });
      assert.equal(res2.newVersion, 3);
      assert.equal(res2.epoch, 2);

      // Step 3: User 3 takes over (v3 -> v4, epoch 2 -> 3)
      const res3 = await service.takeoverConversation({
        tenantId: 1,
        conversationId: 101,
        expectedVersion: 3,
        userId: 3,
      });
      assert.equal(res3.newVersion, 4);
      assert.equal(res3.epoch, 3);

      const row = conversations.find((c) => c.id === 101)!;
      assert.equal(row.version, 4);
      assert.equal(row.ownership_epoch, 3);
      assert.equal(row.owner_id, '3');
    });

    test('2.3: Pause AI increments version (v4 -> v5) with aiPaused = true', async () => {
      const { mockPool, conversations } = createMockCasPool();
      const uow = new TenantScopedUoW(mockPool);
      const service = new ConversationCasService(uow);

      // Takeover to v2
      await service.takeoverConversation({ tenantId: 1, conversationId: 101, expectedVersion: 1, userId: 1 });

      // Pause AI (v2 -> v3)
      const pauseRes = await service.pauseAi({
        tenantId: 1,
        conversationId: 101,
        expectedVersion: 2,
        userId: 1,
        durationSeconds: 1800,
        reason: 'Temporary manual review',
      });

      assert.equal(pauseRes.success, true);
      assert.equal(pauseRes.previousVersion, 2);
      assert.equal(pauseRes.newVersion, 3);
      assert.equal(pauseRes.aiPaused, true);

      const row = conversations.find((c) => c.id === 101)!;
      assert.equal(row.version, 3);
      assert.equal(row.ia_paused, true);
    });

    test('2.4: Resume AI increments version (v3 -> v4) and epoch, restoring owner_type = ai_agent', async () => {
      const { mockPool, conversations } = createMockCasPool();
      const uow = new TenantScopedUoW(mockPool);
      const service = new ConversationCasService(uow);

      // Takeover to v2 (epoch 1)
      await service.takeoverConversation({ tenantId: 1, conversationId: 101, expectedVersion: 1, userId: 1 });

      // Resume AI (v2 -> v3, epoch 1 -> 2)
      const resumeRes = await service.resumeAi({
        tenantId: 1,
        conversationId: 101,
        expectedVersion: 2,
        userId: 1,
        reason: 'Human completed resolution, restoring AI',
      });

      assert.equal(resumeRes.success, true);
      assert.equal(resumeRes.previousVersion, 2);
      assert.equal(resumeRes.newVersion, 3);
      assert.equal(resumeRes.epoch, 2);
      assert.equal(resumeRes.ownerType, 'ai_agent');
      assert.equal(resumeRes.ownerId, null);
      assert.equal(resumeRes.aiPaused, false);

      const row = conversations.find((c) => c.id === 101)!;
      assert.equal(row.version, 3);
      assert.equal(row.ownership_epoch, 2);
      assert.equal(row.owner_type, 'ai_agent');
      assert.equal(row.ia_paused, false);
    });
  });

  // ---------------------------------------------------------------------------
  // Suite 3: 50 Parallel Requests Race Condition Stress Harness
  // ---------------------------------------------------------------------------
  describe('Suite 3: 50 Parallel Requests Race Condition Harness', () => {
    test('50 parallel concurrent takeover requests with expectedVersion = 1: exactly 1 wins (200), 49 conflict (409)', async () => {
      const { mockPool, conversations, operationalActions } = createMockCasPool();
      const uow = new TenantScopedUoW(mockPool);
      const service = new ConversationCasService(uow);

      const concurrencyCount = 50;
      const requests = Array.from({ length: concurrencyCount }, (_, i) =>
        service.takeoverConversation({
          tenantId: 1,
          conversationId: 101,
          expectedVersion: 1,
          userId: i + 1,
          reason: `Race contestant ${i + 1}`,
        })
      );

      const results = await Promise.allSettled(requests);

      const fulfilled = results.filter((r): r is PromiseFulfilledResult<TakeoverResult> => r.status === 'fulfilled');
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');

      // Mathematical invariant: exactly 1 winner, exactly 49 conflicts
      assert.equal(fulfilled.length, 1, 'Exactly one concurrent request must succeed');
      assert.equal(rejected.length, 49, 'Exactly 49 concurrent requests must fail with conflict');

      // Check winner details
      const winner = fulfilled[0].value;
      assert.equal(winner.previousVersion, 1);
      assert.equal(winner.newVersion, 2);
      assert.equal(winner.epoch, 1);
      assert.equal(winner.ownerType, 'human');

      // Check loser errors
      for (const failure of rejected) {
        const error = failure.reason;
        assert.ok(error instanceof CasConflictError, 'Error must be an instance of CasConflictError');
        assert.equal(error.statusCode, 409);
        assert.equal(error.expectedVersion, 1);
        assert.equal(error.currentVersion, 2);
      }

      // Database final state: strictly version 2, epoch 1 (no double increments or corruptions)
      const conv = conversations.find((c) => c.id === 101)!;
      assert.equal(conv.version, 2, 'Final DB version must be exactly 2');
      assert.equal(conv.ownership_epoch, 1, 'Final DB epoch must be exactly 1');
      assert.equal(conv.owner_type, 'human');

      // Audit trail: exactly 1 takeover logged
      assert.equal(operationalActions.length, 1, 'Audit log must record exactly 1 successful takeover');
    });
  });

  // ---------------------------------------------------------------------------
  // Suite 4: Stale & Future Version Rejection
  // ---------------------------------------------------------------------------
  describe('Suite 4: Stale & Future Version Rejection', () => {
    test('4.1: Stale expectedVersion is rejected with 409 CasConflictError', async () => {
      const { mockPool } = createMockCasPool();
      const uow = new TenantScopedUoW(mockPool);
      const service = new ConversationCasService(uow);

      // Advance to v2
      await service.takeoverConversation({ tenantId: 1, conversationId: 101, expectedVersion: 1, userId: 1 });

      // Stale attempt with expectedVersion = 1 (current is 2)
      await assert.rejects(
        async () => {
          await service.takeoverConversation({ tenantId: 1, conversationId: 101, expectedVersion: 1, userId: 2 });
        },
        (err: any) => {
          assert.ok(err instanceof CasConflictError);
          assert.equal(err.statusCode, 409);
          assert.equal(err.expectedVersion, 1);
          assert.equal(err.currentVersion, 2);
          return true;
        }
      );
    });

    test('4.2: Future expectedVersion is rejected with 409 CasConflictError', async () => {
      const { mockPool } = createMockCasPool();
      const uow = new TenantScopedUoW(mockPool);
      const service = new ConversationCasService(uow);

      // Current is 1, caller sends expectedVersion = 99
      await assert.rejects(
        async () => {
          await service.takeoverConversation({ tenantId: 1, conversationId: 101, expectedVersion: 99, userId: 1 });
        },
        (err: any) => {
          assert.ok(err instanceof CasConflictError);
          assert.equal(err.statusCode, 409);
          assert.equal(err.expectedVersion, 99);
          assert.equal(err.currentVersion, 1);
          return true;
        }
      );
    });

    test('4.3: Non-existent conversation throws ConversationNotFoundError (404), distinguished from 409', async () => {
      const { mockPool } = createMockCasPool();
      const uow = new TenantScopedUoW(mockPool);
      const service = new ConversationCasService(uow);

      await assert.rejects(
        async () => {
          await service.takeoverConversation({ tenantId: 1, conversationId: 99999, expectedVersion: 1, userId: 1 });
        },
        (err: any) => {
          assert.ok(err instanceof ConversationNotFoundError);
          assert.equal(err.statusCode, 404);
          return true;
        }
      );
    });

    test('4.4: Cross-tenant conversation query throws 404 Not Found (fail-closed isolation)', async () => {
      const { mockPool } = createMockCasPool();
      const uow = new TenantScopedUoW(mockPool);
      const service = new ConversationCasService(uow);

      // Conversation 201 belongs to Tenant 2; Tenant 1 attempts takeover
      await assert.rejects(
        async () => {
          await service.takeoverConversation({ tenantId: 1, conversationId: 201, expectedVersion: 1, userId: 1 });
        },
        (err: any) => {
          assert.ok(err instanceof ConversationNotFoundError);
          assert.equal(err.statusCode, 404);
          return true;
        }
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Suite 5: AI Epoch Fencing & Invalidation Harness (validateEpoch)
  // ---------------------------------------------------------------------------
  describe('Suite 5: AI Epoch Fencing & Invalidation Harness', () => {
    test('5.1: Matching epoch for AI agent returns true', async () => {
      const { mockPool } = createMockCasPool();
      const uow = new TenantScopedUoW(mockPool);
      const service = new ConversationCasService(uow);

      // Conversation 101 starts at epoch 0, owner_type = 'ai_agent', ia_paused = false
      const valid = await service.validateEpoch({ tenantId: 1, conversationId: 101, expectedEpoch: 0 });
      assert.equal(valid, true);
    });

    test('5.2: Invalidation on human takeover: epoch changes to 1, validateEpoch(0) returns false', async () => {
      const { mockPool } = createMockCasPool();
      const uow = new TenantScopedUoW(mockPool);
      const service = new ConversationCasService(uow);

      // Human takes over
      await service.takeoverConversation({ tenantId: 1, conversationId: 101, expectedVersion: 1, userId: 1 });

      // AI worker with epoch 0 checks if it can send response
      const valid = await service.validateEpoch({ tenantId: 1, conversationId: 101, expectedEpoch: 0 });
      assert.equal(valid, false, 'AI generation must be fenced out after takeover');
    });

    test('5.3: Stale epoch validation returns false', async () => {
      const { mockPool } = createMockCasPool();
      const uow = new TenantScopedUoW(mockPool);
      const service = new ConversationCasService(uow);

      const valid = await service.validateEpoch({ tenantId: 1, conversationId: 101, expectedEpoch: 99 });
      assert.equal(valid, false);
    });

    test('5.4: Paused conversation causes validateEpoch to return false', async () => {
      const { mockPool } = createMockCasPool();
      const uow = new TenantScopedUoW(mockPool);
      const service = new ConversationCasService(uow);

      // Pause AI
      await service.pauseAi({ tenantId: 1, conversationId: 101, expectedVersion: 1, userId: 1 });

      const valid = await service.validateEpoch({ tenantId: 1, conversationId: 101, expectedEpoch: 0 });
      assert.equal(valid, false, 'AI must not dispatch when ia_paused is true');
    });

    test('5.5: Non-existent conversation validateEpoch returns false', async () => {
      const { mockPool } = createMockCasPool();
      const uow = new TenantScopedUoW(mockPool);
      const service = new ConversationCasService(uow);

      const valid = await service.validateEpoch({ tenantId: 1, conversationId: 99999, expectedEpoch: 0 });
      assert.equal(valid, false);
    });

    test('5.6: Async LLM generation pipeline: AI suppresses message transmission after human takeover', async () => {
      const { mockPool } = createMockCasPool();
      const uow = new TenantScopedUoW(mockPool);
      const service = new ConversationCasService(uow);

      // Step 1: AI worker reads conversation at T0
      const initialEpoch = 0;
      let outboundMessageSent = false;

      // Simulated background LLM turn
      const runAiTurn = async () => {
        // Simulates async processing delay
        await new Promise((resolve) => setTimeout(resolve, 20));

        // Step 4: Before dispatching outbound message, check fencing token
        const canDispatch = await service.validateEpoch({
          tenantId: 1,
          conversationId: 101,
          expectedEpoch: initialEpoch,
        });

        if (canDispatch) {
          outboundMessageSent = true;
        }
      };

      // Start AI turn in background
      const aiPromise = runAiTurn();

      // Step 2: Human supervisor triggers takeover while AI is generating
      await service.takeoverConversation({
        tenantId: 1,
        conversationId: 101,
        expectedVersion: 1,
        userId: 42,
        reason: 'Customer requested human assistance',
      });

      // Wait for AI turn to conclude
      await aiPromise;

      // Step 5: Verification: AI turn detected fence invalidation and suppressed outbound message
      assert.equal(outboundMessageSent, false, 'Double-response prevented: AI turn must suppress outbound dispatch');
    });
  });

  // ---------------------------------------------------------------------------
  // Suite 6: Real-time Socket.IO Ownership Changed Verification
  // ---------------------------------------------------------------------------
  describe('Suite 6: Real-time Socket.IO Ownership Changed Verification', () => {
    test('6.1: Real-time notification emitted to tenant room and conversation room on takeover', async () => {
      const { mockPool } = createMockCasPool();
      const uow = new TenantScopedUoW(mockPool);
      const service = new ConversationCasService(uow);

      await service.takeoverConversation({
        tenantId: 1,
        conversationId: 101,
        expectedVersion: 1,
        userId: 55,
      });

      assert.equal(emittedEvents.length, 2);

      // Event 1: to tenant room
      const tenantEvent = emittedEvents.find((e) => e.room === 'tenant:1');
      assert.ok(tenantEvent, 'Must emit to tenant:1 room');
      assert.equal(tenantEvent.event, 'conversation.ownership_changed');
      assert.equal(tenantEvent.payload.conversationId, '101');
      assert.equal(tenantEvent.payload.previousVersion, 1);
      assert.equal(tenantEvent.payload.newVersion, 2);
      assert.equal(tenantEvent.payload.epoch, 1);
      assert.equal(tenantEvent.payload.ownerType, 'human');
      assert.equal(tenantEvent.payload.ownerId, '55');

      // Event 2: to conversation room
      const convEvent = emittedEvents.find((e) => e.room === 'conversation:1:101');
      assert.ok(convEvent, 'Must emit to conversation:1:101 room');
      assert.equal(convEvent.event, 'conversation.ownership_changed');
    });

    test('6.2: Real-time notification emitted on pauseAi and resumeAi', async () => {
      const { mockPool } = createMockCasPool();
      const uow = new TenantScopedUoW(mockPool);
      const service = new ConversationCasService(uow);

      await service.pauseAi({
        tenantId: 1,
        conversationId: 101,
        expectedVersion: 1,
        userId: 55,
      });

      assert.equal(emittedEvents.length, 2);
      assert.equal(emittedEvents[0].payload.aiPaused, true);

      emittedEvents.length = 0;

      await service.resumeAi({
        tenantId: 1,
        conversationId: 101,
        expectedVersion: 2,
        userId: 55,
      });

      assert.equal(emittedEvents.length, 2);
      assert.equal(emittedEvents[0].payload.aiPaused, false);
      assert.equal(emittedEvents[0].payload.ownerType, 'ai_agent');
    });

    test('6.3: Zero emissions on 409 conflict during concurrent requests', async () => {
      const { mockPool } = createMockCasPool();
      const uow = new TenantScopedUoW(mockPool);
      const service = new ConversationCasService(uow);

      const requests = Array.from({ length: 50 }, (_, i) =>
        service.takeoverConversation({
          tenantId: 1,
          conversationId: 101,
          expectedVersion: 1,
          userId: i + 1,
        })
      );

      await Promise.allSettled(requests);

      // Exactly 1 winner -> exactly 2 socket emissions (1 to tenant, 1 to conversation room)
      assert.equal(emittedEvents.length, 2, 'Losers must NOT produce socket emissions');
    });
  });

  // ---------------------------------------------------------------------------
  // Suite 7: REST API Route Integration (conversationRoutes.ts)
  // ---------------------------------------------------------------------------
  describe('Suite 7: REST API Route Integration', () => {
    test('7.1: POST /:id/takeover returns 200 OK with TakeoverResult', async () => {
      const { mockPool } = createMockCasPool();
      const uow = new TenantScopedUoW(mockPool);
      const service = new ConversationCasService(uow);
      const router = createConversationRoutes(service);

      const response = await invokeRoute(
        router,
        'post',
        '/:id/takeover',
        { id: '101' },
        { schemaVersion: 1, expectedVersion: 1, reason: 'Escalation' },
        { userId: 7, companyId: 1 }
      );

      assert.equal(response.status, 200);
      assert.equal(response.body.success, true);
      assert.equal(response.body.data.conversationId, '101');
      assert.equal(response.body.data.newVersion, 2);
      assert.equal(response.body.data.epoch, 1);
      assert.equal(response.body.data.ownerType, 'human');
      assert.equal(response.body.data.ownerId, '7');
    });

    test('7.2: POST /:id/takeover with stale version returns 409 Conflict with RFC 7807 Problem Details', async () => {
      const { mockPool } = createMockCasPool();
      const uow = new TenantScopedUoW(mockPool);
      const service = new ConversationCasService(uow);
      const router = createConversationRoutes(service);

      // First takeover succeeds (v1 -> v2)
      await invokeRoute(
        router,
        'post',
        '/:id/takeover',
        { id: '101' },
        { schemaVersion: 1, expectedVersion: 1 },
        { userId: 7, companyId: 1 }
      );

      // Second takeover with stale version 1 returns 409
      const response = await invokeRoute(
        router,
        'post',
        '/:id/takeover',
        { id: '101' },
        { schemaVersion: 1, expectedVersion: 1 },
        { userId: 8, companyId: 1 }
      );

      assert.equal(response.status, 409);
      assert.equal(response.headers['content-type'], 'application/problem+json');
      assert.equal(response.body.code, 'CONFLICT');
      assert.equal(response.body.status, 409);
      assert.equal(response.body.metadata.expectedVersion, 1);
      assert.equal(response.body.metadata.currentVersion, 2);
    });

    test('7.3: 50 concurrent HTTP takeover requests: strictly 1 returns 200, 49 return 409', async () => {
      const { mockPool } = createMockCasPool();
      const uow = new TenantScopedUoW(mockPool);
      const service = new ConversationCasService(uow);
      const router = createConversationRoutes(service);

      const requests = Array.from({ length: 50 }, (_, i) =>
        invokeRoute(
          router,
          'post',
          '/:id/takeover',
          { id: '101' },
          { schemaVersion: 1, expectedVersion: 1 },
          { userId: i + 1, companyId: 1 }
        )
      );

      const responses = await Promise.all(requests);
      const successes = responses.filter((r) => r.status === 200);
      const conflicts = responses.filter((r) => r.status === 409);

      assert.equal(successes.length, 1, 'Exactly one HTTP request must return 200');
      assert.equal(conflicts.length, 49, 'Exactly 49 HTTP requests must return 409');
    });

    test('7.4: POST /:id/pause-ai and POST /:id/resume-ai return 200 OK', async () => {
      const { mockPool } = createMockCasPool();
      const uow = new TenantScopedUoW(mockPool);
      const service = new ConversationCasService(uow);
      const router = createConversationRoutes(service);

      // Pause AI
      const pauseRes = await invokeRoute(
        router,
        'post',
        '/:id/pause-ai',
        { id: '101' },
        { schemaVersion: 1, expectedVersion: 1, durationSeconds: 600 },
        { userId: 7, companyId: 1 }
      );

      assert.equal(pauseRes.status, 200);
      assert.equal(pauseRes.body.data.aiPaused, true);
      assert.equal(pauseRes.body.data.newVersion, 2);

      // Resume AI
      const resumeRes = await invokeRoute(
        router,
        'post',
        '/:id/resume-ai',
        { id: '101' },
        { schemaVersion: 1, expectedVersion: 2 },
        { userId: 7, companyId: 1 }
      );

      assert.equal(resumeRes.status, 200);
      assert.equal(resumeRes.body.data.aiPaused, false);
      assert.equal(resumeRes.body.data.ownerType, 'ai_agent');
      assert.equal(resumeRes.body.data.newVersion, 3);
    });

    test('7.5: Schema validation rejection: negative expectedVersion returns 400 Bad Request with Problem Details', async () => {
      const { mockPool } = createMockCasPool();
      const uow = new TenantScopedUoW(mockPool);
      const service = new ConversationCasService(uow);
      const router = createConversationRoutes(service);

      const response = await invokeRoute(
        router,
        'post',
        '/:id/takeover',
        { id: '101' },
        { schemaVersion: 1, expectedVersion: -1 },
        { userId: 7, companyId: 1 }
      );

      assert.equal(response.status, 400);
      assert.equal(response.headers['content-type'], 'application/problem+json');
      assert.equal(response.body.code, 'VALIDATION_ERROR');
    });

    test('7.6: Non-existent conversation returns 404 Not Found with Problem Details', async () => {
      const { mockPool } = createMockCasPool();
      const uow = new TenantScopedUoW(mockPool);
      const service = new ConversationCasService(uow);
      const router = createConversationRoutes(service);

      const response = await invokeRoute(
        router,
        'post',
        '/:id/takeover',
        { id: '99999' },
        { schemaVersion: 1, expectedVersion: 1 },
        { userId: 7, companyId: 1 }
      );

      assert.equal(response.status, 404);
      assert.equal(response.headers['content-type'], 'application/problem+json');
      assert.equal(response.body.code, 'NOT_FOUND');
    });
  });
});
