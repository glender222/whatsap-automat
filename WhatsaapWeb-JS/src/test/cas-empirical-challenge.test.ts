// Invariants before config load
process.env.JWT_SECRET = 'test-only-jwt-secret-with-at-least-32-characters-for-testing';
process.env.DB_PASSWORD = 'test-only-database-password';

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { Pool, PoolClient, QueryResult } from 'pg';

const {
  ConversationCasService,
  CasConflictError,
  ConversationNotFoundError,
} = require('../services/conversations/ConversationCasService') as typeof import('../services/conversations/ConversationCasService');
type TakeoverResult = import('../services/conversations/ConversationCasService').TakeoverResult;

const { TenantScopedUoW } = require('../db/TenantScopedUoW') as typeof import('../db/TenantScopedUoW');
const { setSocketIo } = require('../sockets/socketEmitter') as typeof import('../sockets/socketEmitter');
const createConversationRoutes = require('../routes/conversationRoutes').default as typeof import('../routes/conversationRoutes').default;

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

export function createEmpiricalMockPool() {
  const conversations: MockConversationRow[] = [
    {
      id: 101,
      company_id: 1, // Tenant 1
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
      company_id: 2, // Tenant 2
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
            for (const entry of clientState.undoLog) {
              Object.assign(entry.row, entry.original);
            }
            clientState.undoLog = [];
            return { rows: [], rowCount: 0, command: 'ROLLBACK', oid: 0, fields: [] };
          }

          const setMatch = sql.match(/SET LOCAL app\.current_tenant_id\s*=\s*'(\d+)'/i);
          if (setMatch) {
            clientState.sessionTenantId = parseInt(setMatch[1], 10);
            return { rows: [], rowCount: 0, command: 'SET', oid: 0, fields: [] };
          }

          const effectiveTenantId = clientState.sessionTenantId;

          // Fail-Closed RLS Enforcement
          if (!effectiveTenantId || effectiveTenantId <= 0) {
            if (upper.startsWith('SELECT')) {
              return { rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] };
            }
            if (upper.startsWith('UPDATE')) {
              return { rows: [], rowCount: 0, command: 'UPDATE', oid: 0, fields: [] };
            }
          }

          if (sql.includes('conversations')) {
            if (upper.startsWith('UPDATE CONVERSATIONS')) {
              const id = Number(sqlValues[sqlValues.length - 3]);
              const tenantId = Number(sqlValues[sqlValues.length - 2]);
              const expectedVersion = Number(sqlValues[sqlValues.length - 1]);

              const row = conversations.find(
                (r) =>
                  r.company_id === effectiveTenantId &&
                  r.company_id === tenantId &&
                  r.id === id &&
                  r.version === expectedVersion
              );

              if (!row) {
                return { rows: [], rowCount: 0, command: 'UPDATE', oid: 0, fields: [] };
              }

              clientState.undoLog.push({ row, original: { ...row } });
              row.version += 1;
              row.updated_at = new Date();

              if (sql.includes('owner_type') && sql.includes('ownership_epoch') && sql.includes("'human'")) {
                row.owner_type = 'human';
                row.owner_id = String(sqlValues[0]);
                row.assigned_user_id = Number(sqlValues[1]);
                row.ownership_epoch += 1;
                row.ia_paused = true;
                row.ia_paused_by = Number(sqlValues[1]);
                row.ia_paused_at = new Date();
              } else if (sql.includes('ia_paused = true')) {
                row.ia_paused = true;
                row.ia_paused_by = Number(sqlValues[0]);
                row.ia_paused_at = new Date();
                row.ia_resume_at = sqlValues[1] ? new Date(sqlValues[1] as string) : null;
              } else if (sql.includes('ia_paused = false')) {
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

            if (upper.startsWith('SELECT')) {
              let matched = conversations.filter((r) => r.company_id === effectiveTenantId);
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

        release() {
          clientState.released = true;
        },
      };

      return client as PoolClient;
    },
  };

  return { mockPool: mockPool as unknown as Pool, conversations, operationalActions, clientStates };
}

// Route Invocation Helper
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

describe('M1 Challenger 2: Adversarial Empirical Challenges', () => {
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

  // ===========================================================================
  // Section 1: Cross-Tenant Isolation Fail-Closed Verification
  // ===========================================================================
  describe('Challenge 1: Cross-Tenant Isolation (Fail-Closed 404/403 & No Leakage)', () => {
    test('1.1: Tenant 1 attempting takeover of Tenant 2 conversation (201) returns 404 without body tenantId', async () => {
      const { mockPool } = createEmpiricalMockPool();
      const uow = new TenantScopedUoW(mockPool);
      const service = new ConversationCasService(uow);
      const router = createConversationRoutes(service);

      // Tenant 1 user (companyId = 1) attempts takeover on conversation 201 (belongs to company 2)
      const res = await invokeRoute(
        router,
        'post',
        '/:id/takeover',
        { id: '201' },
        { schemaVersion: 1, expectedVersion: 1, reason: 'Cross-tenant attack' },
        { userId: 10, companyId: 1 }
      );

      assert.equal(res.status, 404, 'Must fail-closed with 404 Not Found');
      assert.equal(res.headers['content-type'], 'application/problem+json');
      assert.equal(res.body.code, 'NOT_FOUND');
      assert.equal(emittedEvents.length, 0, 'Zero socket emissions on cross-tenant failure');
    });

    test('1.2: Tenant 1 attempting takeover with explicit body tenantId = 2 returns 403 POLICY_DENIED', async () => {
      const { mockPool } = createEmpiricalMockPool();
      const uow = new TenantScopedUoW(mockPool);
      const service = new ConversationCasService(uow);
      const router = createConversationRoutes(service);

      const res = await invokeRoute(
        router,
        'post',
        '/:id/takeover',
        { id: '201' },
        { schemaVersion: 1, expectedVersion: 1, tenantId: 2 },
        { userId: 10, companyId: 1 }
      );

      assert.equal(res.status, 403, 'Must reject explicit tenant mismatch with 403 Forbidden');
      assert.equal(res.headers['content-type'], 'application/problem+json');
      assert.equal(res.body.code, 'POLICY_DENIED');
      assert.equal(emittedEvents.length, 0);
    });

    test('1.3: Tenant 1 attempting pause-ai on Tenant 2 conversation returns 404 / 403 fail-closed', async () => {
      const { mockPool } = createEmpiricalMockPool();
      const uow = new TenantScopedUoW(mockPool);
      const service = new ConversationCasService(uow);
      const router = createConversationRoutes(service);

      // Without body tenantId -> 404
      const res404 = await invokeRoute(
        router,
        'post',
        '/:id/pause-ai',
        { id: '201' },
        { schemaVersion: 1, expectedVersion: 1 },
        { userId: 10, companyId: 1 }
      );
      assert.equal(res404.status, 404);

      // With mismatched body tenantId -> 403
      const res403 = await invokeRoute(
        router,
        'post',
        '/:id/pause-ai',
        { id: '201' },
        { schemaVersion: 1, expectedVersion: 1, tenantId: 2 },
        { userId: 10, companyId: 1 }
      );
      assert.equal(res403.status, 403);
      assert.equal(emittedEvents.length, 0);
    });

    test('1.4: Tenant 1 attempting resume-ai on Tenant 2 conversation returns 404 / 403 fail-closed', async () => {
      const { mockPool } = createEmpiricalMockPool();
      const uow = new TenantScopedUoW(mockPool);
      const service = new ConversationCasService(uow);
      const router = createConversationRoutes(service);

      // Without body tenantId -> 404
      const res404 = await invokeRoute(
        router,
        'post',
        '/:id/resume-ai',
        { id: '201' },
        { schemaVersion: 1, expectedVersion: 1 },
        { userId: 10, companyId: 1 }
      );
      assert.equal(res404.status, 404);

      // With mismatched body tenantId -> 403
      const res403 = await invokeRoute(
        router,
        'post',
        '/:id/resume-ai',
        { id: '201' },
        { schemaVersion: 1, expectedVersion: 1, tenantId: 2 },
        { userId: 10, companyId: 1 }
      );
      assert.equal(res403.status, 403);
      assert.equal(emittedEvents.length, 0);
    });

    test('1.5: Direct service calls across tenants fail-closed (validateEpoch false, getConversationState null)', async () => {
      const { mockPool } = createEmpiricalMockPool();
      const uow = new TenantScopedUoW(mockPool);
      const service = new ConversationCasService(uow);

      // Tenant 1 tries to validate epoch of Tenant 2's conversation
      const epochValid = await service.validateEpoch({
        tenantId: 1,
        conversationId: 201,
        expectedEpoch: 0,
      });
      assert.equal(epochValid, false, 'validateEpoch across tenants must return false');

      // Tenant 1 tries to get state of Tenant 2's conversation
      const state = await service.getConversationState({
        tenantId: 1,
        conversationId: 201,
      });
      assert.equal(state, null, 'getConversationState across tenants must return null');
    });

    test('1.6: Socket.IO emission during legitimate Tenant 1 takeover NEVER leaks into Tenant 2 room', async () => {
      const { mockPool } = createEmpiricalMockPool();
      const uow = new TenantScopedUoW(mockPool);
      const service = new ConversationCasService(uow);

      await service.takeoverConversation({
        tenantId: 1,
        conversationId: 101,
        expectedVersion: 1,
        userId: 42,
      });

      // Verify emitted rooms
      const tenant2Events = emittedEvents.filter(
        (e) => e.room.includes(':2') || e.room === 'tenant:2' || e.room === 'conversation:2:201'
      );
      assert.equal(tenant2Events.length, 0, 'No events must leak to Tenant 2 rooms');

      const tenant1Events = emittedEvents.filter((e) => e.room === 'tenant:1');
      assert.equal(tenant1Events.length, 1, 'Exactly one event in tenant:1 room');
    });
  });

  // ===========================================================================
  // Section 2: Boundary Values & Error Invariants
  // ===========================================================================
  describe('Challenge 2: Boundary Values & Robust Error Handling', () => {
    test('2.1: Negative version (-1) returns 400 Bad Request via route and throws in service', async () => {
      const { mockPool } = createEmpiricalMockPool();
      const uow = new TenantScopedUoW(mockPool);
      const service = new ConversationCasService(uow);
      const router = createConversationRoutes(service);

      // Route rejection
      const res = await invokeRoute(
        router,
        'post',
        '/:id/takeover',
        { id: '101' },
        { schemaVersion: 1, expectedVersion: -1 },
        { userId: 1, companyId: 1 }
      );
      assert.equal(res.status, 400);
      assert.equal(res.body.code, 'VALIDATION_ERROR');

      // Service rejection
      await assert.rejects(
        () => service.takeoverConversation({ tenantId: 1, conversationId: 101, expectedVersion: -1, userId: 1 }),
        /Invalid expectedVersion: -1/
      );
    });

    test('2.2: NaN version is rejected with 400 Bad Request via route', async () => {
      const { mockPool } = createEmpiricalMockPool();
      const uow = new TenantScopedUoW(mockPool);
      const service = new ConversationCasService(uow);
      const router = createConversationRoutes(service);

      const res = await invokeRoute(
        router,
        'post',
        '/:id/takeover',
        { id: '101' },
        { schemaVersion: 1, expectedVersion: NaN },
        { userId: 1, companyId: 1 }
      );
      assert.equal(res.status, 400);
      assert.equal(res.body.code, 'VALIDATION_ERROR');
    });

    test('2.3: Float/decimal version (1.5) is rejected with 400 Bad Request', async () => {
      const { mockPool } = createEmpiricalMockPool();
      const uow = new TenantScopedUoW(mockPool);
      const service = new ConversationCasService(uow);
      const router = createConversationRoutes(service);

      const res = await invokeRoute(
        router,
        'post',
        '/:id/takeover',
        { id: '101' },
        { schemaVersion: 1, expectedVersion: 1.5 },
        { userId: 1, companyId: 1 }
      );
      assert.equal(res.status, 400);
      assert.equal(res.body.code, 'VALIDATION_ERROR');
    });

    test('2.4: String versions ("1", "stale_version") are rejected with 400 Bad Request', async () => {
      const { mockPool } = createEmpiricalMockPool();
      const uow = new TenantScopedUoW(mockPool);
      const service = new ConversationCasService(uow);
      const router = createConversationRoutes(service);

      const res = await invokeRoute(
        router,
        'post',
        '/:id/takeover',
        { id: '101' },
        { schemaVersion: 1, expectedVersion: '1' },
        { userId: 1, companyId: 1 }
      );
      assert.equal(res.status, 400);
      assert.equal(res.body.code, 'VALIDATION_ERROR');
    });

    test('2.5: Missing expectedVersion returns 400 Bad Request via route and throws in service', async () => {
      const { mockPool } = createEmpiricalMockPool();
      const uow = new TenantScopedUoW(mockPool);
      const service = new ConversationCasService(uow);
      const router = createConversationRoutes(service);

      const res = await invokeRoute(
        router,
        'post',
        '/:id/takeover',
        { id: '101' },
        { schemaVersion: 1 },
        { userId: 1, companyId: 1 }
      );
      assert.equal(res.status, 400);
      assert.equal(res.body.code, 'VALIDATION_ERROR');

      await assert.rejects(
        () => service.takeoverConversation({ tenantId: 1, conversationId: 101, expectedVersion: undefined as any, userId: 1 }),
        /Invalid expectedVersion/
      );
    });

    test('2.6: Missing userId returns 400 Bad Request', async () => {
      const { mockPool } = createEmpiricalMockPool();
      const uow = new TenantScopedUoW(mockPool);
      const service = new ConversationCasService(uow);
      const router = createConversationRoutes(service);

      // Unauthenticated / missing user in req.user and body
      const res = await invokeRoute(
        router,
        'post',
        '/:id/takeover',
        { id: '101' },
        { schemaVersion: 1, expectedVersion: 1 },
        { userId: null, companyId: 1 }
      );
      assert.equal(res.status, 400);
      assert.equal(res.body.code, 'VALIDATION_ERROR');
      assert.ok(res.body.detail.includes('Missing authenticated user ID'));
    });

    test('2.7: Stale version (expectedVersion: 0 when current is 2) returns 409 Conflict with RFC 7807 problem details', async () => {
      const { mockPool } = createEmpiricalMockPool();
      const uow = new TenantScopedUoW(mockPool);
      const service = new ConversationCasService(uow);
      const router = createConversationRoutes(service);

      // Advance to v2
      await service.takeoverConversation({ tenantId: 1, conversationId: 101, expectedVersion: 1, userId: 1 });

      // Stale version 0
      const res = await invokeRoute(
        router,
        'post',
        '/:id/takeover',
        { id: '101' },
        { schemaVersion: 1, expectedVersion: 0 },
        { userId: 2, companyId: 1 }
      );
      assert.equal(res.status, 409);
      assert.equal(res.headers['content-type'], 'application/problem+json');
      assert.equal(res.body.code, 'CONFLICT');
      assert.equal(res.body.metadata.expectedVersion, 0);
      assert.equal(res.body.metadata.currentVersion, 2);
    });

    test('2.8: Far-future version (expectedVersion: 9999 when current is 1) returns 409 Conflict with RFC 7807 problem details', async () => {
      const { mockPool } = createEmpiricalMockPool();
      const uow = new TenantScopedUoW(mockPool);
      const service = new ConversationCasService(uow);
      const router = createConversationRoutes(service);

      const res = await invokeRoute(
        router,
        'post',
        '/:id/takeover',
        { id: '101' },
        { schemaVersion: 1, expectedVersion: 9999 },
        { userId: 2, companyId: 1 }
      );
      assert.equal(res.status, 409);
      assert.equal(res.headers['content-type'], 'application/problem+json');
      assert.equal(res.body.code, 'CONFLICT');
      assert.equal(res.body.metadata.expectedVersion, 9999);
      assert.equal(res.body.metadata.currentVersion, 1);
    });

    test('2.9: Invalid conversation ID ("abc", "0", "-5") returns 400 Bad Request', async () => {
      const { mockPool } = createEmpiricalMockPool();
      const uow = new TenantScopedUoW(mockPool);
      const service = new ConversationCasService(uow);
      const router = createConversationRoutes(service);

      for (const invalidId of ['abc', '0', '-5', 'NaN']) {
        const res = await invokeRoute(
          router,
          'post',
          '/:id/takeover',
          { id: invalidId },
          { schemaVersion: 1, expectedVersion: 1 },
          { userId: 1, companyId: 1 }
        );
        assert.equal(res.status, 400, `ID ${invalidId} must return 400`);
        assert.equal(res.body.code, 'VALIDATION_ERROR');
      }
    });

    test('2.10: schemaVersion: 2 is rejected with 400 Bad Request', async () => {
      const { mockPool } = createEmpiricalMockPool();
      const uow = new TenantScopedUoW(mockPool);
      const service = new ConversationCasService(uow);
      const router = createConversationRoutes(service);

      const res = await invokeRoute(
        router,
        'post',
        '/:id/takeover',
        { id: '101' },
        { schemaVersion: 2, expectedVersion: 1 },
        { userId: 1, companyId: 1 }
      );
      assert.equal(res.status, 400);
      assert.equal(res.body.code, 'VALIDATION_ERROR');
    });

    test('2.11: pause-ai with invalid durationSeconds (-60, 0, "60") returns 400 Bad Request', async () => {
      const { mockPool } = createEmpiricalMockPool();
      const uow = new TenantScopedUoW(mockPool);
      const service = new ConversationCasService(uow);
      const router = createConversationRoutes(service);

      for (const dur of [-60, 0, '60', 1.5]) {
        const res = await invokeRoute(
          router,
          'post',
          '/:id/pause-ai',
          { id: '101' },
          { schemaVersion: 1, expectedVersion: 1, durationSeconds: dur },
          { userId: 1, companyId: 1 }
        );
        assert.equal(res.status, 400, `durationSeconds ${dur} must return 400`);
        assert.equal(res.body.code, 'VALIDATION_ERROR');
      }
    });

    test('2.12: validateEpoch edge cases (negative epoch, invalid tenant, invalid convId) return false', async () => {
      const { mockPool } = createEmpiricalMockPool();
      const uow = new TenantScopedUoW(mockPool);
      const service = new ConversationCasService(uow);

      assert.equal(await service.validateEpoch({ tenantId: 1, conversationId: 101, expectedEpoch: -1 }), false);
      assert.equal(await service.validateEpoch({ tenantId: -1, conversationId: 101, expectedEpoch: 0 }), false);
      assert.equal(await service.validateEpoch({ tenantId: 1, conversationId: -1, expectedEpoch: 0 }), false);
      assert.equal(await service.validateEpoch({ tenantId: 1, conversationId: 101, expectedEpoch: undefined as any }), false);
    });

    test('2.13: Direct service call with expectedVersion = NaN fails-closed with CasConflictError (409)', async () => {
      const { mockPool } = createEmpiricalMockPool();
      const uow = new TenantScopedUoW(mockPool);
      const service = new ConversationCasService(uow);

      await assert.rejects(
        () => service.takeoverConversation({ tenantId: 1, conversationId: 101, expectedVersion: NaN, userId: 1 }),
        (err: any) => {
          assert.ok(err instanceof CasConflictError);
          assert.equal(err.statusCode, 409);
          return true;
        }
      );
    });
  });

  // ===========================================================================
  // Section 3: Stress & Concurrency Matrix
  // ===========================================================================
  describe('Challenge 3: Mixed Concurrent Cross-Tenant Stress Matrix', () => {
    test('100 mixed concurrent requests across 2 tenants: strict CAS isolation, exactly 1 winner per tenant, 0 leaks', async () => {
      const { mockPool, conversations, operationalActions } = createEmpiricalMockPool();
      const uow = new TenantScopedUoW(mockPool);
      const service = new ConversationCasService(uow);
      const router = createConversationRoutes(service);

      // 25 legitimate Tenant 1 takeovers (expectedVersion: 1)
      const t1Takeovers = Array.from({ length: 25 }, (_, i) =>
        invokeRoute(
          router,
          'post',
          '/:id/takeover',
          { id: '101' },
          { schemaVersion: 1, expectedVersion: 1 },
          { userId: i + 1, companyId: 1 }
        )
      );

      // 25 legitimate Tenant 1 pause-ai requests (expectedVersion: 1)
      const t1Pauses = Array.from({ length: 25 }, (_, i) =>
        invokeRoute(
          router,
          'post',
          '/:id/pause-ai',
          { id: '101' },
          { schemaVersion: 1, expectedVersion: 1, durationSeconds: 300 },
          { userId: i + 1, companyId: 1 }
        )
      );

      // 25 legitimate Tenant 2 takeovers (expectedVersion: 1)
      const t2Takeovers = Array.from({ length: 25 }, (_, i) =>
        invokeRoute(
          router,
          'post',
          '/:id/takeover',
          { id: '201' },
          { schemaVersion: 1, expectedVersion: 1 },
          { userId: i + 100, companyId: 2 }
        )
      );

      // 25 malicious cross-tenant attacks (Tenant 1 users attempting to takeover Tenant 2 conv 201)
      const crossTenantAttacks = Array.from({ length: 25 }, (_, i) =>
        invokeRoute(
          router,
          'post',
          '/:id/takeover',
          { id: '201' },
          { schemaVersion: 1, expectedVersion: 1, reason: `Hacker ${i}` },
          { userId: i + 200, companyId: 1 }
        )
      );

      const allOps = await Promise.all([
        ...t1Takeovers,
        ...t1Pauses,
        ...t2Takeovers,
        ...crossTenantAttacks,
      ]);

      assert.equal(allOps.length, 100);

      // 1. Analyze Tenant 1 results (50 requests competing for conv 101 with expectedVersion 1)
      const t1Results = allOps.slice(0, 50);
      const t1Winners = t1Results.filter((r) => r.status === 200);
      const t1Conflicts = t1Results.filter((r) => r.status === 409);
      assert.equal(t1Winners.length, 1, 'Exactly one operation must win for Tenant 1 conv 101');
      assert.equal(t1Conflicts.length, 49, 'Exactly 49 operations must conflict for Tenant 1 conv 101');

      // 2. Analyze Tenant 2 results (25 requests competing for conv 201 with expectedVersion 1)
      const t2Results = allOps.slice(50, 75);
      const t2Winners = t2Results.filter((r) => r.status === 200);
      const t2Conflicts = t2Results.filter((r) => r.status === 409);
      assert.equal(t2Winners.length, 1, 'Exactly one operation must win for Tenant 2 conv 201');
      assert.equal(t2Conflicts.length, 24, 'Exactly 24 operations must conflict for Tenant 2 conv 201');

      // 3. Analyze Cross-tenant attacks (25 requests from Tenant 1 on Tenant 2)
      const attackResults = allOps.slice(75, 100);
      const attackBlocked = attackResults.filter((r) => r.status === 404);
      assert.equal(attackBlocked.length, 25, 'All 25 cross-tenant attacks must be blocked with 404 Not Found');

      // 4. Verify Final State in DB
      const c101 = conversations.find((c) => c.id === 101)!;
      const c201 = conversations.find((c) => c.id === 201)!;
      assert.equal(c101.version, 2, 'Tenant 1 conv version must be strictly 2');
      assert.equal(c201.version, 2, 'Tenant 2 conv version must be strictly 2');

      // 5. Verify Socket Emissions: strictly 2 events for Tenant 1, 2 events for Tenant 2, ZERO cross-tenant leaks
      const t1SocketEvents = emittedEvents.filter((e) => e.room.startsWith('tenant:1') || e.room.startsWith('conversation:1'));
      const t2SocketEvents = emittedEvents.filter((e) => e.room.startsWith('tenant:2') || e.room.startsWith('conversation:2'));
      const crossLeakedEvents = emittedEvents.filter(
        (e) => (e.room.includes(':1') && e.payload?.conversationId === '201') ||
               (e.room.includes(':2') && e.payload?.conversationId === '101')
      );

      assert.equal(t1SocketEvents.length, 2, 'Tenant 1 room got exactly 2 emissions (1 tenant, 1 conv)');
      assert.equal(t2SocketEvents.length, 2, 'Tenant 2 room got exactly 2 emissions (1 tenant, 1 conv)');
      assert.equal(crossLeakedEvents.length, 0, 'Zero cross-tenant leaks detected in socket emissions');
    });
  });
});
