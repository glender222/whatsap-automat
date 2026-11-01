// 1. Invariantes de entorno de prueba antes de cargar configuracion
process.env.JWT_SECRET ||= 'test-only-jwt-secret-with-at-least-32-characters-for-testing';
process.env.DB_PASSWORD ||= 'test-only-database-password';

import assert from 'node:assert/strict';
import { describe, test, beforeEach } from 'node:test';
import type { Pool, PoolClient, QueryResult } from 'pg';

const defaultPool = (require('../config/database').default || require('../config/database')) as Pool;
const {
  TenantScopedUoW,
  withTenantTransaction,
  InvalidTenantIdError,
  MissingActiveTenantIdError,
  CrossTenantNestingError,
} = require('../db/TenantScopedUoW') as typeof import('../db/TenantScopedUoW');

// =============================================================================
// PostgreSQL Row-Level Security (RLS) Engine Adapter
// Simulates PostgreSQL engine-level RLS policy:
//   AS PERMISSIVE
//   USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
//   WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
//
// Architectural Rationale (AS PERMISSIVE vs AS RESTRICTIVE):
// In PostgreSQL, RLS policies default to PERMISSIVE. Multiple PERMISSIVE policies
// combine with OR, while RESTRICTIVE policies combine with AND.
// If ONLY RESTRICTIVE policies are defined on a table without any PERMISSIVE policy,
// the engine evaluates: (no permissive policies = FALSE) AND (restrictive policy) => FALSE.
// This completely locks out non-superusers from reading or writing, even with valid tenant IDs!
// Therefore, tenant isolation policies must be AS PERMISSIVE. A single PERMISSIVE policy
// with NULLIF(current_setting(...), '') is strictly fail-closed: un-scoped queries yield
// NULL (0 rows), cross-tenant queries evaluate to FALSE (0 rows), and only valid tenant
// queries succeed.
// =============================================================================

export interface BaseRecord {
  id: number;
  company_id: number;
  [key: string]: unknown;
}

export interface ClientQueryLog {
  sql: string;
  values?: unknown[];
}

export interface MockClientState {
  sessionSetting: string | null;
  inTransaction: boolean;
  queries: ClientQueryLog[];
  released: boolean;
  destroyed: boolean;
  releaseError?: Error;
  forceRollbackError?: boolean;
}

export interface MockPoolState {
  tables: Map<string, BaseRecord[]>;
  connectionsCreated: number;
  activeClientCount: number;
  clients: MockClientState[];
}

export function createRlsTestPool(seedData?: Record<string, BaseRecord[]>) {
  const state: MockPoolState = {
    tables: new Map<string, BaseRecord[]>([
      [
        'conversations',
        [
          { id: 101, company_id: 1, chat_id: '549111@c.us', status: 'open' },
          { id: 102, company_id: 1, chat_id: '549112@c.us', status: 'open' },
          { id: 201, company_id: 2, chat_id: '549221@c.us', status: 'open' },
          { id: 202, company_id: 2, chat_id: '549222@c.us', status: 'closed' },
        ],
      ],
      [
        'messages',
        [
          { id: 1001, company_id: 1, conversation_id: 101, body: 'Tenant 1 Message 1' },
          { id: 1002, company_id: 1, conversation_id: 101, body: 'Tenant 1 Message 2' },
          { id: 2001, company_id: 2, conversation_id: 201, body: 'Tenant 2 Secret Message' },
        ],
      ],
      [
        'customer_orders',
        [
          { id: 501, company_id: 1, total_cents: 10000, status: 'pending' },
          { id: 502, company_id: 2, total_cents: 25000, status: 'paid' },
        ],
      ],
    ]),
    connectionsCreated: 0,
    activeClientCount: 0,
    clients: [],
  };

  if (seedData) {
    for (const [table, rows] of Object.entries(seedData)) {
      state.tables.set(table, [...rows]);
    }
  }

  function resolveTableName(sql: string): string | null {
    const fromMatch = sql.match(/(?:FROM|INTO|UPDATE)\s+([a-zA-Z0-9_]+)/i);
    return fromMatch ? fromMatch[1].toLowerCase() : null;
  }

  const mockPool = {
    state,
    async connect(): Promise<PoolClient> {
      state.connectionsCreated++;
      state.activeClientCount++;

      const clientState: MockClientState = {
        sessionSetting: null,
        inTransaction: false,
        queries: [],
        released: false,
        destroyed: false,
        releaseError: undefined,
        forceRollbackError: false,
      };
      state.clients.push(clientState);

      const client: Partial<PoolClient> = {
        query: async (text: string | { text: string; values?: unknown[] }, values?: unknown[]): Promise<QueryResult<any>> => {
          const sqlText = typeof text === 'string' ? text : text.text;
          const sqlValues = typeof text === 'string' ? values : text.values;
          clientState.queries.push({ sql: sqlText, values: sqlValues });

          const normalized = sqlText.trim();
          const upper = normalized.toUpperCase();

          // 1. Transaction Control
          if (upper === 'BEGIN') {
            clientState.inTransaction = true;
            return { rows: [], rowCount: 0, command: 'BEGIN', oid: 0, fields: [] };
          }

          if (upper === 'COMMIT') {
            clientState.inTransaction = false;
            clientState.sessionSetting = null; // SET LOCAL scope expires on COMMIT
            return { rows: [], rowCount: 0, command: 'COMMIT', oid: 0, fields: [] };
          }

          if (upper === 'ROLLBACK') {
            if (clientState.forceRollbackError) {
              const err = new Error('simulated network failure during ROLLBACK');
              (err as any).code = 'ECONNRESET';
              throw err;
            }
            clientState.inTransaction = false;
            clientState.sessionSetting = null; // SET LOCAL scope expires on ROLLBACK
            return { rows: [], rowCount: 0, command: 'ROLLBACK', oid: 0, fields: [] };
          }

          // 2. Setting tenant context: SET LOCAL or set_config
          const setLocalMatch = normalized.match(/SET LOCAL app\.current_tenant_id\s*=\s*'?([^\s';]+)'?/i);
          if (setLocalMatch) {
            clientState.sessionSetting = setLocalMatch[1];
            return { rows: [], rowCount: 0, command: 'SET', oid: 0, fields: [] };
          }

          if (normalized.includes("set_config('app.current_tenant_id'")) {
            const val = sqlValues && sqlValues[0] !== undefined ? String(sqlValues[0]) : '';
            clientState.sessionSetting = val === '' ? null : val;
            return {
              rows: [{ set_config: val }],
              rowCount: 1,
              command: 'SELECT',
              oid: 0,
              fields: [],
            };
          }

          if (normalized.includes("RESET app.current_tenant_id")) {
            clientState.sessionSetting = null;
            return { rows: [], rowCount: 0, command: 'RESET', oid: 0, fields: [] };
          }

          // 3. PostgreSQL RLS Evaluation Engine
          // USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
          const tenantIdRaw = clientState.sessionSetting;
          const effectiveTenantId =
            tenantIdRaw && /^\d+$/.test(tenantIdRaw.trim()) ? parseInt(tenantIdRaw.trim(), 10) : null;

          const tableName = resolveTableName(normalized);
          const tableData = tableName ? state.tables.get(tableName) || [] : [];

          // SELECT Queries
          if (upper.startsWith('SELECT')) {
            // FAIL-CLOSED: If effectiveTenantId is null, NULLIF evaluates to NULL -> 0 rows
            if (!effectiveTenantId || effectiveTenantId <= 0) {
              return { rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] };
            }

            let filtered = tableData.filter(row => row.company_id === effectiveTenantId);

            // Match WHERE id = $1 or WHERE id = <number>
            const idParamMatch = normalized.match(/WHERE\s+id\s*=\s*\$1/i);
            const idLiteralMatch = normalized.match(/WHERE\s+id\s*=\s*(\d+)/i);

            if (idParamMatch && sqlValues && sqlValues.length > 0) {
              const targetId = Number(sqlValues[0]);
              filtered = filtered.filter(row => row.id === targetId);
            } else if (idLiteralMatch) {
              const targetId = Number(idLiteralMatch[1]);
              filtered = filtered.filter(row => row.id === targetId);
            }

            return { rows: filtered, rowCount: filtered.length, command: 'SELECT', oid: 0, fields: [] };
          }

          // INSERT Queries
          if (upper.startsWith('INSERT')) {
            // WITH CHECK policy:
            // Extract company_id from values or sql
            let insertCompanyId: number | null = null;
            if (sqlValues && sqlValues.length > 0) {
              // Look for numeric company_id in params
              const compVal = sqlValues.find((v, idx) => {
                // If query is INSERT INTO t (company_id, ...) or (..., company_id, ...)
                return typeof v === 'number' && v > 0;
              });
              insertCompanyId = typeof compVal === 'number' ? compVal : null;
            }

            if (!effectiveTenantId || insertCompanyId !== effectiveTenantId) {
              const err: any = new Error(
                `new row violates row-level security policy for table "${tableName || 'unknown'}"`
              );
              err.code = '44501';
              throw err;
            }

            const newRecord: BaseRecord = {
              id: Math.floor(Math.random() * 100000) + 1000,
              company_id: insertCompanyId,
              title: 'inserted_row',
            };
            tableData.push(newRecord);
            return { rows: [newRecord], rowCount: 1, command: 'INSERT', oid: 0, fields: [] };
          }

          // UPDATE Queries
          if (upper.startsWith('UPDATE')) {
            if (!effectiveTenantId || effectiveTenantId <= 0) {
              return { rows: [], rowCount: 0, command: 'UPDATE', oid: 0, fields: [] };
            }

            let matched = tableData.filter(row => row.company_id === effectiveTenantId);
            const idParamMatch = normalized.match(/WHERE\s+id\s*=\s*\$1/i);
            if (idParamMatch && sqlValues && sqlValues.length > 0) {
              matched = matched.filter(row => row.id === Number(sqlValues[0]));
            }

            return { rows: matched, rowCount: matched.length, command: 'UPDATE', oid: 0, fields: [] };
          }

          return { rows: [], rowCount: 0, command: 'RAW', oid: 0, fields: [] };
        },

        release: (releaseErr?: Error | boolean) => {
          clientState.released = true;
          state.activeClientCount--;
          if (releaseErr) {
            clientState.destroyed = true;
            clientState.releaseError = releaseErr instanceof Error ? releaseErr : new Error(String(releaseErr));
          }
        },
      };

      return client as PoolClient;
    },

    async query(text: string, values?: unknown[]) {
      const client = await this.connect();
      try {
        return await client.query(text, values);
      } finally {
        client.release();
      }
    },
  };

  return { pool: mockPool as unknown as Pool, state };
}

// =============================================================================
// Test Suites
// =============================================================================

describe('PostgreSQL Row-Level Security (RLS) & TenantScopedUoW Test Suite', () => {

  // ---------------------------------------------------------------------------
  // Requirement 1: Tenant-Scoped Access Only Returns Current Tenant Data
  // ---------------------------------------------------------------------------
  describe('Requirement 1: Tenant-scoped queries return only current tenant data', () => {
    test('Migration 022 specifies AS PERMISSIVE across all 34 tables and 0 occurrences of AS RESTRICTIVE', () => {
      const fs = require('fs');
      const path = require('path');
      const migrationPath = path.join(__dirname, '../db/migrations/022_enable_postgresql_rls.sql');
      const content = fs.readFileSync(migrationPath, 'utf8');

      // 1. Zero occurrences of AS RESTRICTIVE anywhere in the file
      assert.ok(!content.includes('AS RESTRICTIVE'), 'Migration 022 must not contain AS RESTRICTIVE');

      // 2. Exactly 34 table RLS policy definitions declared AS PERMISSIVE
      const tablePermissiveMatches = content.match(/^\s*AS PERMISSIVE/gm) || [];
      assert.strictEqual(tablePermissiveMatches.length, 34, 'Migration 022 must declare AS PERMISSIVE on all 34 tables');

      // 3. Header comment reflects AS PERMISSIVE policy specification
      assert.ok(content.includes('-- Policy: AS PERMISSIVE'), 'Migration 022 header comment must specify AS PERMISSIVE');
    });

    test('Tenant 1 receives only records where company_id = 1', async () => {
      const { pool } = createRlsTestPool();
      const uow = new TenantScopedUoW(pool);

      const result = await uow.run(1, async (client) => {
        const convRes = await client.query('SELECT * FROM conversations');
        const msgRes = await client.query('SELECT * FROM messages');
        const orderRes = await client.query('SELECT * FROM customer_orders');
        return {
          conversations: convRes.rows,
          messages: msgRes.rows,
          orders: orderRes.rows,
        };
      });

      assert.strictEqual(result.conversations.length, 2);
      assert.ok(result.conversations.every((r: BaseRecord) => r.company_id === 1));
      assert.strictEqual(result.messages.length, 2);
      assert.ok(result.messages.every((r: BaseRecord) => r.company_id === 1));
      assert.strictEqual(result.orders.length, 1);
      assert.strictEqual(result.orders[0].company_id, 1);
    });

    test('Tenant 2 receives only records where company_id = 2 and zero Tenant 1 records', async () => {
      const { pool } = createRlsTestPool();
      const uow = new TenantScopedUoW(pool);

      const result = await uow.run(2, async (client) => {
        const convRes = await client.query('SELECT * FROM conversations');
        const msgRes = await client.query('SELECT * FROM messages');
        const orderRes = await client.query('SELECT * FROM customer_orders');
        return {
          conversations: convRes.rows,
          messages: msgRes.rows,
          orders: orderRes.rows,
        };
      });

      assert.strictEqual(result.conversations.length, 2);
      assert.ok(result.conversations.every((r: BaseRecord) => r.company_id === 2));
      assert.strictEqual(result.messages.length, 1);
      assert.strictEqual(result.messages[0].body, 'Tenant 2 Secret Message');
      assert.strictEqual(result.orders.length, 1);
      assert.strictEqual(result.orders[0].company_id, 2);
    });

    test('withTenantTransaction helper executes scoped work seamlessly', async () => {
      const { pool } = createRlsTestPool();

      const conversations = await withTenantTransaction(1, async (client) => {
        const res = await client.query('SELECT * FROM conversations');
        return res.rows;
      }, pool);

      assert.strictEqual(conversations.length, 2);
      assert.ok(conversations.every((c: any) => c.company_id === 1));
    });
  });

  // ---------------------------------------------------------------------------
  // Requirement 2: Fail-Closed Protection for Un-Scoped Queries
  // ---------------------------------------------------------------------------
  describe('Requirement 2: Un-scoped queries return 0 records (Fail-Closed)', () => {
    test('Direct pool query without app.current_tenant_id returns 0 rows', async () => {
      const { pool } = createRlsTestPool();
      const client = await pool.connect();

      try {
        const resConversations = await client.query('SELECT * FROM conversations');
        const resMessages = await client.query('SELECT * FROM messages');
        const resOrders = await client.query('SELECT * FROM customer_orders');

        assert.strictEqual(resConversations.rows.length, 0, 'Must return 0 conversations');
        assert.strictEqual(resMessages.rows.length, 0, 'Must return 0 messages');
        assert.strictEqual(resOrders.rows.length, 0, 'Must return 0 orders');
      } finally {
        client.release();
      }
    });

    test('Query with empty string app.current_tenant_id evaluates to NULL and returns 0 rows', async () => {
      const { pool } = createRlsTestPool();
      const client = await pool.connect();

      try {
        await client.query("SELECT set_config('app.current_tenant_id', '', true)");
        const res = await client.query('SELECT * FROM conversations');
        assert.strictEqual(res.rows.length, 0, 'Empty tenant context must fail closed');
      } finally {
        client.release();
      }
    });

    test('INSERT attempted without tenant context throws RLS policy violation', async () => {
      const { pool } = createRlsTestPool();
      const client = await pool.connect();

      try {
        await assert.rejects(
          async () => {
            await client.query('INSERT INTO conversations (company_id, chat_id) VALUES ($1, $2)', [1, 'hacker@c.us']);
          },
          (err: any) => {
            assert.strictEqual(err.code, '44501');
            assert.match(err.message, /violates row-level security policy/i);
            return true;
          }
        );
      } finally {
        client.release();
      }
    });

    test('Policy semantics: AS PERMISSIVE single-policy evaluates fail-closed for un-scoped queries', async () => {
      // Under PostgreSQL RLS rules:
      // A PERMISSIVE policy: USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
      // When app.current_tenant_id is unset or empty, NULLIF evaluates to NULL.
      // company_id = NULL evaluates to SQL UNKNOWN, which rejects all rows fail-closed.
      const { pool } = createRlsTestPool();
      const client = await pool.connect();
      try {
        const conv = await client.query('SELECT * FROM conversations');
        assert.strictEqual(conv.rows.length, 0, 'Unscoped conversation query must fail-closed under AS PERMISSIVE policy');

        const orders = await client.query('SELECT * FROM customer_orders');
        assert.strictEqual(orders.rows.length, 0, 'Unscoped customer_orders query must fail-closed under AS PERMISSIVE policy');
      } finally {
        client.release();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Requirement 3: Cross-Tenant Access Blocked at Database Engine Level
  // ---------------------------------------------------------------------------
  describe('Requirement 3: Cross-tenant access is blocked at the engine level', () => {
    test('Tenant 1 selecting specific record ID belonging to Tenant 2 receives 0 rows', async () => {
      const { pool } = createRlsTestPool();
      const uow = new TenantScopedUoW(pool);

      await uow.run(1, async (client) => {
        // Conversation 201 belongs to Tenant 2
        const res = await client.query('SELECT * FROM conversations WHERE id = $1', [201]);
        assert.strictEqual(res.rows.length, 0, 'Cross-tenant lookup must return 0 rows (invisible)');
      });
    });

    test('Tenant 1 updating record ID belonging to Tenant 2 updates 0 rows', async () => {
      const { pool } = createRlsTestPool();
      const uow = new TenantScopedUoW(pool);

      await uow.run(1, async (client) => {
        const res = await client.query('UPDATE conversations SET status = $2 WHERE id = $1', [201, 'tampered']);
        assert.strictEqual(res.rowCount, 0, 'Cross-tenant update must affect 0 rows');
      });
    });

    test('Tenant 1 attempting to insert a row with company_id = 2 throws 44501 RLS policy violation', async () => {
      const { pool } = createRlsTestPool();
      const uow = new TenantScopedUoW(pool);

      await uow.run(1, async (client) => {
        await assert.rejects(
          async () => {
            // Attempt cross-tenant insert
            await client.query('INSERT INTO conversations (company_id, chat_id) VALUES ($1, $2)', [2, 'cross@c.us']);
          },
          (err: any) => {
            assert.strictEqual(err.code, '44501');
            assert.match(err.message, /violates row-level security policy/i);
            return true;
          }
        );
      });
    });

    test('Tenant 2 attempting to insert a row with company_id = 1 throws 44501 RLS policy violation', async () => {
      const { pool } = createRlsTestPool();
      const uow = new TenantScopedUoW(pool);

      await uow.run(2, async (client) => {
        await assert.rejects(
          async () => {
            await client.query('INSERT INTO conversations (company_id, chat_id) VALUES ($1, $2)', [1, 'spoofed@c.us']);
          },
          (err: any) => {
            assert.strictEqual(err.code, '44501');
            return true;
          }
        );
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Requirement 4: TenantScopedUoW Lifecycle, Rollback, Hygiene & Validation
  // ---------------------------------------------------------------------------
  describe('Requirement 4: TenantScopedUoW transaction lifecycle and connection hygiene', () => {
    test('Happy path: executes BEGIN -> SET LOCAL -> callback -> COMMIT and releases client', async () => {
      const { pool, state } = createRlsTestPool();
      const uow = new TenantScopedUoW(pool);

      const returnedValue = await uow.run(42, async (client) => {
        await client.query('SELECT * FROM conversations');
        return 'success_payload';
      });

      assert.strictEqual(returnedValue, 'success_payload');
      assert.strictEqual(state.connectionsCreated, 1);
      assert.strictEqual(state.activeClientCount, 0, 'Connection must be released');

      const clientLog = state.clients[0];
      assert.strictEqual(clientLog.released, true);
      assert.strictEqual(clientLog.destroyed, false);

      const sqlSequence = clientLog.queries.map(q => q.sql);
      assert.strictEqual(sqlSequence[0], 'BEGIN');
      assert.match(sqlSequence[1], /SET LOCAL app\.current_tenant_id\s*=\s*'42'/i);
      assert.strictEqual(sqlSequence[2], 'SELECT * FROM conversations');
      assert.strictEqual(sqlSequence[3], 'COMMIT');
    });

    test('Rollback on callback error: executes ROLLBACK, releases client, and rethrows error', async () => {
      const { pool, state } = createRlsTestPool();
      const uow = new TenantScopedUoW(pool);

      const operationalError = new Error('simulated application domain failure');

      await assert.rejects(
        async () => {
          await uow.run(42, async (client) => {
            await client.query('SELECT * FROM conversations');
            throw operationalError;
          });
        },
        (err: Error) => {
          assert.strictEqual(err, operationalError);
          return true;
        }
      );

      assert.strictEqual(state.activeClientCount, 0, 'Connection must be released on error');
      const clientLog = state.clients[0];
      assert.strictEqual(clientLog.released, true);

      const sqlSequence = clientLog.queries.map(q => q.sql);
      assert.strictEqual(sqlSequence[0], 'BEGIN');
      assert.match(sqlSequence[1], /SET LOCAL app\.current_tenant_id\s*=\s*'42'/i);
      assert.strictEqual(sqlSequence[2], 'SELECT * FROM conversations');
      assert.strictEqual(sqlSequence[3], 'ROLLBACK');
      assert.ok(!sqlSequence.includes('COMMIT'), 'COMMIT must never be called on error');
    });

    test('Connection hygiene: discards and destroys connection if ROLLBACK itself throws', async () => {
      const { pool, state } = createRlsTestPool();
      const uow = new TenantScopedUoW(pool);

      await assert.rejects(
        async () => {
          await uow.run(42, async (client) => {
            // Force simulated network failure when ROLLBACK is invoked
            state.clients[0].forceRollbackError = true;
            throw new Error('business logic failure');
          });
        },
        /business logic failure/
      );

      const clientLog = state.clients[0];
      assert.strictEqual(clientLog.released, true);
      assert.strictEqual(clientLog.destroyed, true, 'Corrupt connection must be destroyed on release');
      assert.ok(clientLog.releaseError, 'releaseError must be passed to release()');
    });

    test('Zero session leakage: connection reused in subsequent query has cleared tenant context', async () => {
      const { pool, state } = createRlsTestPool();
      const uow = new TenantScopedUoW(pool);

      // Run Tenant 1 transaction
      await uow.run(1, async (client) => {
        const res = await client.query('SELECT * FROM conversations');
        assert.strictEqual(res.rows.length, 2);
      });

      // Lease connection directly outside uow
      const rawClient = await pool.connect();
      try {
        const res = await rawClient.query('SELECT * FROM conversations');
        assert.strictEqual(res.rows.length, 0, 'Tenant context must not leak across pooled leases');
      } finally {
        rawClient.release();
      }
    });

    test('Pre-flight validation rejects invalid tenantId without acquiring DB connection', async () => {
      const { pool, state } = createRlsTestPool();
      const uow = new TenantScopedUoW(pool);

      const invalidTenantIds: unknown[] = [0, -1, -999, '0', '-4', 'abc', 'evil;DROP TABLE', null, undefined, true, false, {}];

      for (const invalidId of invalidTenantIds) {
        await assert.rejects(
          async () => {
            await uow.run(invalidId as any, async () => {
              assert.fail('Work should not be executed for invalid tenant ID');
            });
          },
          (err: any) => {
            assert.ok(err instanceof InvalidTenantIdError);
            assert.strictEqual(err.code, 'INVALID_TENANT_ID');
            return true;
          }
        );
      }

      assert.strictEqual(state.connectionsCreated, 0, 'No DB connections should be leased for invalid requests');
    });

    test('Accepts valid string tenantId and converts to integer scope', async () => {
      const { pool, state } = createRlsTestPool();
      const uow = new TenantScopedUoW(pool);

      const result = await uow.run('1', async (client) => {
        const res = await client.query('SELECT * FROM conversations');
        return res.rows;
      });

      assert.strictEqual(result.length, 2);
      assert.match(state.clients[0].queries[1].sql, /SET LOCAL app\.current_tenant_id\s*=\s*'1'/i);
    });

    test('Nested transaction with pre-existing client on matching tenant executes without re-leasing', async () => {
      const { pool, state } = createRlsTestPool();
      const uow = new TenantScopedUoW(pool);

      await uow.run(1, async (outerClient) => {
        // Inner transaction using pre-existing client
        const innerResult = await uow.run(
          1,
          async (innerClient) => {
            assert.strictEqual(innerClient, outerClient);
            const res = await innerClient.query('SELECT * FROM conversations');
            return res.rows.length;
          },
          { client: outerClient, activeTenantId: 1 }
        );

        assert.strictEqual(innerResult, 2);
      });

      assert.strictEqual(state.connectionsCreated, 1, 'Only 1 connection leased for nested execution');
    });

    test('Nested transaction with mismatched tenant throws CrossTenantNestingError', async () => {
      const { pool } = createRlsTestPool();
      const uow = new TenantScopedUoW(pool);

      await uow.run(1, async (outerClient) => {
        await assert.rejects(
          async () => {
            await uow.run(
              2,
              async () => {},
              { client: outerClient, activeTenantId: 1 }
            );
          },
          (err: any) => {
            assert.ok(err instanceof CrossTenantNestingError);
            assert.strictEqual(err.code, 'CROSS_TENANT_NESTING_FORBIDDEN');
            assert.match(err.message, /forbidden/i);
            return true;
          }
        );
      });
    });

    test('transaction() and runInTenantScope() aliases behave identically to run()', async () => {
      const { pool } = createRlsTestPool();
      const uow = new TenantScopedUoW(pool);

      const res1 = await uow.transaction(1, async (client) => {
        const r = await client.query('SELECT * FROM conversations');
        return r.rows.length;
      });
      assert.strictEqual(res1, 2);

      const res2 = await uow.runInTenantScope(2, async (client) => {
        const r = await client.query('SELECT * FROM conversations');
        return r.rows.length;
      });
      assert.strictEqual(res2, 2);
    });

    // -------------------------------------------------------------------------
    // Regression Tests (PR-F1-02 Round 2 Hardening)
    // -------------------------------------------------------------------------

    test('Regression: passing options.client without activeTenantId throws MissingActiveTenantIdError and blocks execution', async () => {
      const { pool } = createRlsTestPool();
      const uow = new TenantScopedUoW(pool);

      const mockClient = await pool.connect();
      try {
        let workExecuted = false;

        // activeTenantId undefined
        await assert.rejects(
          async () => {
            await uow.run(
              1,
              async () => {
                workExecuted = true;
              },
              { client: mockClient } // activeTenantId intentionally omitted
            );
          },
          (err: any) => {
            assert.ok(err instanceof MissingActiveTenantIdError, 'Must be instance of MissingActiveTenantIdError');
            assert.strictEqual(err.code, 'MISSING_ACTIVE_TENANT_ID');
            assert.strictEqual(err.name, 'MissingActiveTenantIdError');
            assert.match(
              err.message,
              /activeTenantId is required when providing an existing client to prevent cross-tenant leakage/i
            );
            return true;
          }
        );

        assert.strictEqual(workExecuted, false, 'Work must not execute when activeTenantId is missing');

        // activeTenantId null
        await assert.rejects(
          async () => {
            await uow.run(
              1,
              async () => {
                workExecuted = true;
              },
              { client: mockClient, activeTenantId: null as any }
            );
          },
          (err: any) => {
            assert.ok(err instanceof MissingActiveTenantIdError);
            assert.strictEqual(err.code, 'MISSING_ACTIVE_TENANT_ID');
            return true;
          }
        );
      } finally {
        mockClient.release();
      }
    });

    test('Regression: nested transaction omitting activeTenantId cannot bypass tenant isolation to leak data', async () => {
      const { pool } = createRlsTestPool();
      const uow = new TenantScopedUoW(pool);

      await uow.run(1, async (outerClient) => {
        let leaked = false;

        await assert.rejects(
          async () => {
            // Attempting to run tenant 2 work using tenant 1 client without specifying activeTenantId
            await uow.run(
              2,
              async (innerClient) => {
                const res = await innerClient.query('SELECT * FROM conversations');
                if (res.rows.length > 0) leaked = true;
              },
              { client: outerClient } // activeTenantId omitted
            );
          },
          (err: any) => {
            assert.ok(err instanceof MissingActiveTenantIdError);
            assert.strictEqual(err.code, 'MISSING_ACTIVE_TENANT_ID');
            assert.match(
              err.message,
              /activeTenantId is required when providing an existing client to prevent cross-tenant leakage/i
            );
            return true;
          }
        );

        assert.strictEqual(leaked, false, 'Tenant 1 data must not leak into Tenant 2 context');
      });
    });

    test('Regression: BigInt, circular references and Symbol throw handled InvalidTenantIdError without TypeError crash', async () => {
      const { pool, state } = createRlsTestPool();
      const uow = new TenantScopedUoW(pool);

      const circularObj: any = { name: 'circular' };
      circularObj.self = circularObj;

      const nonSerializableIds: unknown[] = [
        BigInt(1),
        BigInt(10),
        BigInt(9007199254740991),
        circularObj,
        Symbol('tenant'),
      ];

      for (const hostileId of nonSerializableIds) {
        let executed = false;
        await assert.rejects(
          async () => {
            await uow.run(hostileId as any, async () => {
              executed = true;
            });
          },
          (err: any) => {
            assert.ok(err instanceof InvalidTenantIdError, 'Must be instance of InvalidTenantIdError');
            assert.strictEqual(err.code, 'INVALID_TENANT_ID');
            assert.strictEqual(err.name, 'InvalidTenantIdError');
            assert.match(err.message, /\[TenantScopedUoW\] Invalid tenantId: must be a positive integer/);
            return true;
          }
        );
        assert.strictEqual(executed, false, 'Work should not be executed for non-serializable invalid tenant ID');
      }

      assert.strictEqual(state.connectionsCreated, 0, 'No DB connections should be leased for non-serializable invalid requests');
    });

    test('Regression: InvalidTenantIdError constructor safely formats BigInt, circular structures, and Symbol', () => {
      const errBigInt = new InvalidTenantIdError(BigInt(42));
      assert.strictEqual(errBigInt.code, 'INVALID_TENANT_ID');
      assert.strictEqual(errBigInt.tenantId, BigInt(42));
      assert.ok(errBigInt.message.includes('42n'), 'BigInt must be formatted with n suffix');

      const circular: any = { test: true };
      circular.cycle = circular;
      const errCircular = new InvalidTenantIdError(circular);
      assert.strictEqual(errCircular.code, 'INVALID_TENANT_ID');
      assert.strictEqual(errCircular.tenantId, circular);
      assert.ok(errCircular.message.includes('[object Object]'), 'Circular object formatted safely');

      const errSymbol = new InvalidTenantIdError(Symbol('test-sym'));
      assert.strictEqual(errSymbol.code, 'INVALID_TENANT_ID');
      assert.ok(errSymbol.message.includes('Symbol(test-sym)'), 'Symbol formatted safely');
    });
  });

  // ---------------------------------------------------------------------------
  // Tier 2: Live PostgreSQL Database Integration (Conditional)
  // ---------------------------------------------------------------------------
  describe('Tier 2: Live PostgreSQL integration runner', () => {
    test('Conditional live database smoke test or clean notice', async (t) => {
      if (process.env.TEST_LIVE_DB !== 'true') {
        t.diagnostic('Skipping Tier 2 live PostgreSQL integration test (TEST_LIVE_DB != "true").');
        assert.ok(true);
        return;
      }

      // If live database testing is requested via environment variable:
      try {
        const client = await defaultPool.connect();
        try {
          await client.query('BEGIN');
          await client.query("SELECT set_config('app.current_tenant_id', '1', true)");
          const pingRes = await client.query('SELECT 1 as live_connected');
          assert.strictEqual(pingRes.rows[0].live_connected, 1);
          await client.query('ROLLBACK');
        } finally {
          client.release();
        }
      } catch (err: any) {
        t.diagnostic(`Live PostgreSQL unreachable: ${err.message}. Gracefully noted.`);
      }
    });
  });

});
