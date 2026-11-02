// Invariants before config load
process.env.JWT_SECRET = 'test-only-jwt-secret-with-at-least-32-characters-for-testing';
process.env.DB_PASSWORD = 'test-only-database-password';

import assert from 'node:assert/strict';
import { describe, test, beforeEach, afterEach } from 'node:test';
import crypto from 'node:crypto';
import type { Pool, PoolClient, QueryResult } from 'pg';

import type {
  ITemporalClient,
  ITemporalWorkflowClient,
  WorkflowHandle,
  WorkflowStartOptions,
} from '../services/temporal/types';
import type {
  OutboxRecord,
  OutboxStatus,
} from '../services/outbox/OutboxRepository';

const {
  TemporalClientFactory,
  temporalClientFactory,
  getTemporalClient,
} = require('../services/temporal/TemporalClientFactory') as typeof import('../services/temporal/TemporalClientFactory');
const {
  TemporalConnectionError,
  WorkflowExecutionAlreadyStartedError,
} = require('../services/temporal/types') as typeof import('../services/temporal/types');
const {
  OutboxRelayDaemon,
} = require('../services/outbox/OutboxRelayDaemon') as typeof import('../services/outbox/OutboxRelayDaemon');
const {
  OutboxRepository,
} = require('../services/outbox/OutboxRepository') as typeof import('../services/outbox/OutboxRepository');
const { TenantScopedUoW } = require('../db/TenantScopedUoW') as typeof import('../db/TenantScopedUoW');

// =============================================================================
// Advanced Concurrent Mock Pool with Real Tuple Locking & SKIP LOCKED Semantics
// =============================================================================

interface StoredOutboxRow {
  id: string;
  tenant_id: number;
  workspace_id?: number | null;
  event_type: string;
  event_id: string;
  correlation_id: string;
  idempotency_key: string;
  payload: any;
  status: OutboxStatus;
  retry_count: number;
  max_retries: number;
  next_retry_at: Date | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

function createConcurrentOutboxPool(options?: { simulatedLatencyMs?: number }) {
  const table: StoredOutboxRow[] = [];
  // Set of row IDs currently locked by an active uncommitted transaction
  const lockedRowIds = new Map<string, string>(); // rowId -> transactionId
  let txCounter = 0;

  const delay = async () => {
    if (options?.simulatedLatencyMs && options.simulatedLatencyMs > 0) {
      await new Promise((r) => setTimeout(r, Math.random() * options.simulatedLatencyMs!));
    }
  };

  const pool = {
    table,
    lockedRowIds,
    async connect(): Promise<PoolClient> {
      const txId = `tx_${++txCounter}_${Date.now()}`;
      let sessionTenantId: number | null = null;
      let inTransaction = false;
      const myLockedRows = new Set<string>();

      const client: Partial<PoolClient> = {
        query: async (
          text: string | { text: string; values?: unknown[] },
          values?: unknown[]
        ): Promise<QueryResult<any>> => {
          await delay();

          const sql = (typeof text === 'string' ? text : text.text).trim();
          const sqlValues = typeof text === 'string' ? values || [] : text.values || [];
          const upper = sql.toUpperCase();

          if (upper === 'BEGIN') {
            inTransaction = true;
            return { rows: [], rowCount: 0, command: 'BEGIN', oid: 0, fields: [] };
          }

          if (upper === 'COMMIT') {
            inTransaction = false;
            sessionTenantId = null;
            // Release all locks held by this transaction
            for (const rId of myLockedRows) {
              lockedRowIds.delete(rId);
            }
            myLockedRows.clear();
            return { rows: [], rowCount: 0, command: 'COMMIT', oid: 0, fields: [] };
          }

          if (upper === 'ROLLBACK') {
            inTransaction = false;
            sessionTenantId = null;
            // Release all locks held by this transaction
            for (const rId of myLockedRows) {
              lockedRowIds.delete(rId);
            }
            myLockedRows.clear();
            return { rows: [], rowCount: 0, command: 'ROLLBACK', oid: 0, fields: [] };
          }

          const setMatch = sql.match(/SET LOCAL app\.current_tenant_id\s*=\s*'(\d+)'/i);
          if (setMatch) {
            sessionTenantId = parseInt(setMatch[1], 10);
            return { rows: [], rowCount: 0, command: 'SET', oid: 0, fields: [] };
          }

          const effectiveTenant = sessionTenantId;

          // INSERT into processing_outbox
          if (upper.startsWith('INSERT INTO PROCESSING_OUTBOX')) {
            const insertTenantId = Number(sqlValues[0]);
            if (!effectiveTenant || effectiveTenant !== insertTenantId) {
              const err = new Error('violates row-level security policy for table "processing_outbox"');
              (err as any).code = '44501';
              throw err;
            }

            const idempotencyKey = String(sqlValues[5]);
            const existing = table.find(
              (r) => r.tenant_id === insertTenantId && r.idempotency_key === idempotencyKey
            );
            if (existing) {
              existing.updated_at = new Date();
              return { rows: [existing], rowCount: 1, command: 'INSERT', oid: 0, fields: [] };
            }

            const newRow: StoredOutboxRow = {
              id: (sqlValues[3] as string) || crypto.randomUUID(),
              tenant_id: insertTenantId,
              workspace_id: sqlValues[1] ?? null,
              event_type: String(sqlValues[2]),
              event_id: (sqlValues[3] as string) || crypto.randomUUID(),
              correlation_id: String(sqlValues[4]),
              idempotency_key: idempotencyKey,
              payload: sqlValues[6],
              status: 'pending',
              retry_count: 0,
              max_retries: Number(sqlValues[7] ?? 5),
              next_retry_at: sqlValues[8] ? new Date(sqlValues[8] as string) : null,
              last_error: null,
              created_at: new Date(),
              updated_at: new Date(),
            };
            table.push(newRow);
            return { rows: [newRow], rowCount: 1, command: 'INSERT', oid: 0, fields: [] };
          }

          // WITH claimable AS (...) UPDATE processing_outbox ... FOR UPDATE SKIP LOCKED
          if (upper.includes('WITH CLAIMABLE AS')) {
            if (!effectiveTenant) {
              return { rows: [], rowCount: 0, command: 'UPDATE', oid: 0, fields: [] };
            }

            const now = Date.now();
            const limit = Number(sqlValues[1] || 10);

            // Filter rows matching WHERE condition AND NOT locked by another transaction
            const eligibleRows: StoredOutboxRow[] = [];
            for (const r of table) {
              if (eligibleRows.length >= limit) break;

              const isMatch =
                r.tenant_id === effectiveTenant &&
                (r.status === 'pending' || r.status === 'delivery_unknown') &&
                (r.next_retry_at === null || r.next_retry_at.getTime() <= now);

              if (isMatch) {
                // SKIP LOCKED semantics: if locked by another tx, skip!
                const currentLockHolder = lockedRowIds.get(r.id);
                if (currentLockHolder && currentLockHolder !== txId) {
                  // Row locked by another concurrent transaction -> SKIP!
                  continue;
                }

                // Acquire lock for this transaction
                lockedRowIds.set(r.id, txId);
                myLockedRows.add(r.id);

                // Update row state to processing
                r.status = 'processing';
                r.updated_at = new Date();
                eligibleRows.push(r);
              }
            }

            return { rows: eligibleRows, rowCount: eligibleRows.length, command: 'UPDATE', oid: 0, fields: [] };
          }

          // UPDATE processing_outbox SET status = ...
          if (upper.startsWith('UPDATE PROCESSING_OUTBOX')) {
            const newStatus = sqlValues[0] as OutboxStatus;
            const error = sqlValues[1] as string | null;
            const nextRetryAt = sqlValues[2] as Date | null;
            const incrementRetry = Boolean(sqlValues[3]);
            const tenantId = Number(sqlValues[4]);
            const id = String(sqlValues[5]);

            if (effectiveTenant !== tenantId) {
              return { rows: [], rowCount: 0, command: 'UPDATE', oid: 0, fields: [] };
            }

            const row = table.find((r) => r.tenant_id === tenantId && r.id === id);
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

          // SELECT
          if (upper.startsWith('SELECT')) {
            if (!effectiveTenant) {
              return { rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] };
            }
            let filtered = table.filter((r) => r.tenant_id === effectiveTenant);
            if (sql.includes('id = $2')) {
              filtered = filtered.filter((r) => r.id === String(sqlValues[1]));
            }
            if (sql.includes('idempotency_key = $2')) {
              filtered = filtered.filter((r) => r.idempotency_key === String(sqlValues[1]));
            }
            return { rows: filtered, rowCount: filtered.length, command: 'SELECT', oid: 0, fields: [] };
          }

          return { rows: [], rowCount: 0, command: 'UNKNOWN', oid: 0, fields: [] };
        },
        release: () => {
          // If released without commit, release held locks
          for (const rId of myLockedRows) {
            lockedRowIds.delete(rId);
          }
          myLockedRows.clear();
        },
      };

      return client as PoolClient;
    },
  };

  return pool;
}

// =============================================================================
// Mock Temporal Client Generator for Adversarial Stress Testing
// =============================================================================

function createStressMockTemporalClient(options?: {
  activeExecutions?: Set<string>;
  simulatedDelayMs?: number;
  failureRate?: number; // 0.0 to 1.0
  onStartWorkflow?: (workflowType: unknown, startOpts: WorkflowStartOptions) => Promise<WorkflowHandle>;
}) {
  const activeExecutions = options?.activeExecutions || new Set<string>();
  const startCalls: { workflowType: unknown; options: WorkflowStartOptions; timestamp: number }[] = [];
  let alreadyStartedCount = 0;
  let successfulStarts = 0;

  const workflowClient: ITemporalWorkflowClient = {
    start: async (workflowType, startOpts) => {
      startCalls.push({ workflowType, options: startOpts, timestamp: Date.now() });

      if (options?.simulatedDelayMs && options.simulatedDelayMs > 0) {
        await new Promise((r) => setTimeout(r, Math.random() * options.simulatedDelayMs!));
      }

      if (options?.onStartWorkflow) {
        return options.onStartWorkflow(workflowType, startOpts);
      }

      // Check for duplicate workflow execution in Temporal
      if (activeExecutions.has(startOpts.workflowId)) {
        alreadyStartedCount++;
        throw new WorkflowExecutionAlreadyStartedError(
          `Workflow execution already started for workflowId: ${startOpts.workflowId}`,
          startOpts.workflowId,
          `run-${startOpts.workflowId}`
        );
      }

      // Intermittent failure simulation
      if (options?.failureRate && Math.random() < options.failureRate) {
        throw new Error('ETIMEDOUT: Temporal gRPC frontend connection timeout');
      }

      activeExecutions.add(startOpts.workflowId);
      successfulStarts++;

      return {
        workflowId: startOpts.workflowId,
        firstExecutionRunId: `run-${Date.now()}`,
        result: async () => ({ status: 'completed' }),
        terminate: async () => {},
        signal: async () => {},
        query: async () => ({ state: 'running' }),
      };
    },
    execute: async (workflowType, startOpts) => {
      const handle = await workflowClient.start(workflowType, startOpts);
      return handle.result();
    },
    getHandle: (workflowId, runId) => ({
      workflowId,
      firstExecutionRunId: runId,
      result: async () => ({ status: 'completed' }),
      terminate: async () => {},
      signal: async () => {},
      query: async () => ({ state: 'running' }),
    }),
  };

  const client: ITemporalClient = {
    workflow: workflowClient,
    close: async () => {},
  };

  return {
    client,
    startCalls,
    activeExecutions,
    get alreadyStartedCount() {
      return alreadyStartedCount;
    },
    get successfulStarts() {
      return successfulStarts;
    },
  };
}

// =============================================================================
// ADVERSARIAL EMPIRICAL CHALLENGE SUITES
// =============================================================================

describe('ADVERSARIAL EMPIRICAL HARNESS: OutboxRelayDaemon & TemporalClientFactory', () => {
  // ---------------------------------------------------------------------------
  // Suite 1: High-Concurrency Competing Pollers & Daemons (FOR UPDATE SKIP LOCKED)
  // ---------------------------------------------------------------------------
  describe('Suite 1: High-Concurrency Competing Pollers & Row-Locking Race Harness', () => {
    test('1.1: 10 parallel daemons competing for 50 records: zero duplicate claims, zero data loss', async () => {
      const pool = createConcurrentOutboxPool({ simulatedLatencyMs: 5 });
      const uow = new TenantScopedUoW(pool as unknown as Pool);
      const repo = new OutboxRepository(uow);
      const mockTemporal = createStressMockTemporalClient({ simulatedDelayMs: 2 });

      // Seed 50 pending records
      const recordIds: string[] = [];
      for (let i = 1; i <= 50; i++) {
        const rec = await repo.enqueue(1, {
          eventType: 'order.placed',
          correlationId: `corr-${i}`,
          idempotencyKey: `idem-key-${i}`,
          payload: { orderId: i, amount: 100 * i },
        });
        recordIds.push(rec.id);
      }

      assert.strictEqual(pool.table.length, 50, 'Table should contain exactly 50 seed records');

      // Create 10 independent daemon instances pointing to the same repo
      const daemons: InstanceType<typeof OutboxRelayDaemon>[] = [];
      const numDaemons = 10;
      for (let d = 0; d < numDaemons; d++) {
        daemons.push(
          new OutboxRelayDaemon({
            outboxRepo: repo,
            temporalClientProvider: async () => mockTemporal.client,
            batchSize: 5,
            tenantIds: [1],
          })
        );
      }

      // Execute parallel bursts across all 10 daemons until outbox is fully drained
      let totalClaimed = 0;
      let rounds = 0;
      const maxRounds = 20;

      while (totalClaimed < 50 && rounds < maxRounds) {
        rounds++;
        // Run processBatch on all 10 daemons concurrently!
        const batchResults = await Promise.all(daemons.map((d) => d.processBatch(1)));
        const roundClaimed = batchResults.reduce((sum, count) => sum + count, 0);
        totalClaimed += roundClaimed;
        if (roundClaimed === 0) break;
      }

      // EMPIRICAL INVARIANTS:
      // 1. Total records processed must equal exactly 50
      assert.strictEqual(totalClaimed, 50, `Expected 50 total records claimed across all daemons, got ${totalClaimed}`);

      // 2. Temporal should have received exactly 50 workflow starts
      assert.strictEqual(
        mockTemporal.successfulStarts,
        50,
        `Expected 50 successful Temporal workflow starts, got ${mockTemporal.successfulStarts}`
      );

      // 3. No duplicate workflow starts should have occurred
      assert.strictEqual(
        mockTemporal.alreadyStartedCount,
        0,
        `No WorkflowExecutionAlreadyStartedError should occur in pure partition competition, got ${mockTemporal.alreadyStartedCount}`
      );

      // 4. Verify unique dispatch set: all 50 distinct records dispatched
      const dispatchedIds = new Set(mockTemporal.startCalls.map((c) => c.options.workflowId));
      assert.strictEqual(dispatchedIds.size, 50, 'All 50 workflowIds must be unique and non-overlapping');

      // 5. Verify database final state: every record in table is 'dispatched'
      for (const row of pool.table) {
        assert.strictEqual(
          row.status,
          'dispatched',
          `Record ${row.id} should be 'dispatched', found '${row.status}'`
        );
      }

      // 6. Verify zero locks remain held after completion
      assert.strictEqual(pool.lockedRowIds.size, 0, 'No row locks should remain held after transactions complete');
    });

    test('1.2: SKIP LOCKED verification: concurrent pollers skip rows locked by active in-flight transaction', async () => {
      const pool = createConcurrentOutboxPool();
      const uow = new TenantScopedUoW(pool as unknown as Pool);
      const repo = new OutboxRepository(uow);

      // Seed 10 records
      for (let i = 1; i <= 10; i++) {
        await repo.enqueue(1, {
          eventType: 'test.skip_locked',
          correlationId: `c-${i}`,
          idempotencyKey: `key-skip-${i}`,
          payload: { index: i },
        });
      }

      // Connect Client 1 and start an explicit transaction that claims 5 records
      const client1 = await pool.connect();
      await client1.query('BEGIN');
      await client1.query("SET LOCAL app.current_tenant_id = '1'");

      const claimSql = `
        WITH claimable AS (
          SELECT id
          FROM processing_outbox
          WHERE tenant_id = $1
            AND status IN ('pending', 'delivery_unknown')
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

      // Client 1 claims first 5 records
      const res1 = await client1.query(claimSql, [1, 5]);
      assert.strictEqual(res1.rows.length, 5);
      const client1RowIds = new Set(res1.rows.map((r: any) => r.id));

      // Client 2 connects concurrently (while Client 1 transaction is STILL ACTIVE and uncommitted)
      const client2 = await pool.connect();
      await client2.query('BEGIN');
      await client2.query("SET LOCAL app.current_tenant_id = '1'");

      // Client 2 claims 5 records — MUST SKIP the 5 records locked by Client 1!
      const res2 = await client2.query(claimSql, [1, 5]);
      assert.strictEqual(res2.rows.length, 5);
      const client2RowIds = new Set(res2.rows.map((r: any) => r.id));

      // Assert intersection is EMPTY: Client 2 did not claim any row held by Client 1
      for (const id of client2RowIds) {
        assert.ok(!client1RowIds.has(id), `Client 2 claimed locked row ${id} held by Client 1!`);
      }

      // Commit both
      await client1.query('COMMIT');
      client1.release();
      await client2.query('COMMIT');
      client2.release();

      // Client 3 attempts to claim: all 10 are now 'processing', so Client 3 gets 0 rows
      const client3 = await pool.connect();
      await client3.query('BEGIN');
      await client3.query("SET LOCAL app.current_tenant_id = '1'");
      const res3 = await client3.query(claimSql, [1, 5]);
      assert.strictEqual(res3.rows.length, 0, 'No more pending records should be claimable');
      await client3.query('COMMIT');
      client3.release();
    });

    test('1.3: Cross-tenant multi-daemon concurrency: strict isolation without leakage', async () => {
      const pool = createConcurrentOutboxPool({ simulatedLatencyMs: 3 });
      const uow = new TenantScopedUoW(pool as unknown as Pool);
      const repo = new OutboxRepository(uow);
      const mockTemporal = createStressMockTemporalClient({ simulatedDelayMs: 1 });

      // Seed 25 records for Tenant 1, 25 for Tenant 2, 25 for Tenant 3
      for (let i = 1; i <= 25; i++) {
        await repo.enqueue(1, {
          eventType: 't1.event',
          correlationId: `c1-${i}`,
          idempotencyKey: `idem-t1-${i}`,
          payload: { tenant: 1 },
        });
        await repo.enqueue(2, {
          eventType: 't2.event',
          correlationId: `c2-${i}`,
          idempotencyKey: `idem-t2-${i}`,
          payload: { tenant: 2 },
        });
        await repo.enqueue(3, {
          eventType: 't3.event',
          correlationId: `c3-${i}`,
          idempotencyKey: `idem-t3-${i}`,
          payload: { tenant: 3 },
        });
      }

      assert.strictEqual(pool.table.length, 75);

      // 3 specialized daemons for each tenant + 1 multi-tenant daemon
      const daemonT1 = new OutboxRelayDaemon({
        outboxRepo: repo,
        temporalClientProvider: async () => mockTemporal.client,
        batchSize: 5,
        tenantIds: [1],
      });
      const daemonT2 = new OutboxRelayDaemon({
        outboxRepo: repo,
        temporalClientProvider: async () => mockTemporal.client,
        batchSize: 5,
        tenantIds: [2],
      });
      const daemonT3 = new OutboxRelayDaemon({
        outboxRepo: repo,
        temporalClientProvider: async () => mockTemporal.client,
        batchSize: 5,
        tenantIds: [3],
      });
      const daemonAll = new OutboxRelayDaemon({
        outboxRepo: repo,
        temporalClientProvider: async () => mockTemporal.client,
        batchSize: 5,
        tenantIds: [1, 2, 3],
      });

      // Fire parallel bursts until empty
      for (let round = 0; round < 15; round++) {
        await Promise.all([
          daemonT1.processBatch(),
          daemonT2.processBatch(),
          daemonT3.processBatch(),
          daemonAll.processBatch(),
        ]);
      }

      // Assert: exactly 75 dispatches
      assert.strictEqual(mockTemporal.successfulStarts, 75);

      // Verify each tenant has exactly 25 workflow starts with proper prefix
      const t1Starts = mockTemporal.startCalls.filter((c) => c.options.workflowId.startsWith('wf_1_'));
      const t2Starts = mockTemporal.startCalls.filter((c) => c.options.workflowId.startsWith('wf_2_'));
      const t3Starts = mockTemporal.startCalls.filter((c) => c.options.workflowId.startsWith('wf_3_'));

      assert.strictEqual(t1Starts.length, 25, 'Tenant 1 should have exactly 25 starts');
      assert.strictEqual(t2Starts.length, 25, 'Tenant 2 should have exactly 25 starts');
      assert.strictEqual(t3Starts.length, 25, 'Tenant 3 should have exactly 25 starts');
    });
  });

  // ---------------------------------------------------------------------------
  // Suite 2: Fast Burst Idempotency & WorkflowExecutionAlreadyStartedError
  // ---------------------------------------------------------------------------
  describe('Suite 2: Fast Burst Idempotency & WorkflowExecutionAlreadyStartedError Harness', () => {
    test('2.1: 50 concurrent duplicate dispatch calls for identical idempotency key: 1 starts, 49 absorbed idempotently', async () => {
      const pool = createConcurrentOutboxPool();
      const uow = new TenantScopedUoW(pool as unknown as Pool);
      const repo = new OutboxRepository(uow);

      // Create Temporal mock with simulated duplicate detection
      const mockTemporal = createStressMockTemporalClient({ simulatedDelayMs: 2 });

      const daemon = new OutboxRelayDaemon({
        outboxRepo: repo,
        temporalClientProvider: async () => mockTemporal.client,
        tenantIds: [1],
      });

      // Enqueue a single record
      const record = await repo.enqueue(1, {
        eventType: 'burst.order.created',
        correlationId: 'burst-corr-1',
        idempotencyKey: 'burst-key-unique-123',
        payload: { orderId: 999 },
      });

      // Simulate 50 concurrent dispatchRecord attempts on the SAME record (e.g. rapid poller burst / retry race)
      const dispatchPromises: Promise<'dispatched' | 'delivery_unknown' | 'dead_letter'>[] = [];
      for (let i = 0; i < 50; i++) {
        dispatchPromises.push(daemon.dispatchRecord(1, record));
      }

      const results = await Promise.all(dispatchPromises);

      // EMPIRICAL INVARIANTS:
      // 1. Every single call MUST return 'dispatched' (none should fail or return error)
      for (let i = 0; i < results.length; i++) {
        assert.strictEqual(results[i], 'dispatched', `Call ${i} failed with result: ${results[i]}`);
      }

      // 2. In Temporal, exactly 1 start succeeded, and 49 threw WorkflowExecutionAlreadyStartedError
      assert.strictEqual(mockTemporal.successfulStarts, 1, 'Only 1 workflow should have started');
      assert.strictEqual(
        mockTemporal.alreadyStartedCount,
        49,
        '49 calls should have encountered and absorbed alreadyStarted error'
      );

      // 3. Daemon metrics: totalDispatched should be 50, zero failures
      const metrics = daemon.getMetrics();
      assert.strictEqual(metrics.totalDispatched, 50);
      assert.strictEqual(metrics.totalDeliveryUnknown, 0);
      assert.strictEqual(metrics.totalDeadLetter, 0);

      // 4. Outbox record final status is 'dispatched'
      const finalRec = await repo.findById(1, record.id);
      assert.strictEqual(finalRec?.status, 'dispatched');
    });

    test('2.2: Comprehensive error pattern matrix: isAlreadyStartedError catches all valid Temporal & gRPC representations', async () => {
      const pool = createConcurrentOutboxPool();
      const uow = new TenantScopedUoW(pool as unknown as Pool);
      const repo = new OutboxRepository(uow);

      // Test cases covering different SDK error structures
      const errorVariants: { description: string; errorFactory: () => Error }[] = [
        {
          description: 'Official WorkflowExecutionAlreadyStartedError instance',
          errorFactory: () =>
            new WorkflowExecutionAlreadyStartedError(
              'Workflow execution already started: workflowId="wf_1_k1", runId="run-1"',
              'wf_1_k1',
              'run-1'
            ),
        },
        {
          description: 'Temporal SDK custom error with code WORKFLOW_EXECUTION_ALREADY_STARTED',
          errorFactory: () => {
            const err = new Error('Workflow execution already started');
            (err as any).code = 'WORKFLOW_EXECUTION_ALREADY_STARTED';
            return err;
          },
        },
        {
          description: 'gRPC ALREADY_EXISTS code string',
          errorFactory: () => {
            const err = new Error('6 ALREADY_EXISTS: Workflow execution already started');
            (err as any).code = 'ALREADY_EXISTS';
            return err;
          },
        },
        {
          description: 'gRPC ALREADY_EXISTS in error message with generic code',
          errorFactory: () => {
            const err = new Error('Client execution rejected: workflow already exists in cluster');
            (err as any).code = 6;
            return err;
          },
        },
        {
          description: 'Case-insensitive message match: "WORKFLOW EXECUTION ALREADY STARTED"',
          errorFactory: () => new Error('CRITICAL: WORKFLOW EXECUTION ALREADY STARTED FOR wf_1_k'),
        },
        {
          description: 'Simple message match: "already started"',
          errorFactory: () => new Error('workflow is already started'),
        },
      ];

      for (let idx = 0; idx < errorVariants.length; idx++) {
        const { description, errorFactory } = errorVariants[idx];

        const mockTemporal = createStressMockTemporalClient({
          onStartWorkflow: async () => {
            throw errorFactory();
          },
        });

        const daemon = new OutboxRelayDaemon({
          outboxRepo: repo,
          temporalClientProvider: async () => mockTemporal.client,
          tenantIds: [1],
        });

        const rec = await repo.enqueue(1, {
          eventType: 'matrix.event',
          correlationId: `c-matrix-${idx}`,
          idempotencyKey: `matrix-key-${idx}`,
          payload: {},
        });

        const outcome = await daemon.dispatchRecord(1, rec);
        assert.strictEqual(
          outcome,
          'dispatched',
          `Variant '${description}' failed to be recognized as already started! Returned '${outcome}'`
        );

        const updated = await repo.findById(1, rec.id);
        assert.strictEqual(
          updated?.status,
          'dispatched',
          `Record status should be 'dispatched' for variant '${description}'`
        );
      }
    });

    test('2.3: Negative control: transient network or permanent syntax errors are NOT misidentified as already started', async () => {
      const pool = createConcurrentOutboxPool();
      const uow = new TenantScopedUoW(pool as unknown as Pool);
      const repo = new OutboxRepository(uow);

      const nonAlreadyStartedErrors: { error: Error; expectedOutcome: 'delivery_unknown' | 'dead_letter' }[] = [
        {
          error: new Error('ECONNREFUSED: Connection refused at 127.0.0.1:7233'),
          expectedOutcome: 'delivery_unknown',
        },
        {
          error: new Error('ETIMEDOUT: gRPC stream timed out waiting for response headers'),
          expectedOutcome: 'delivery_unknown',
        },
        {
          error: (() => {
            const err = new Error('INVALID_ARGUMENT: TaskQueue must be non-empty');
            (err as any).code = 'INVALID_ARGUMENT';
            return err;
          })(),
          expectedOutcome: 'dead_letter',
        },
        {
          error: new Error('Workflow definition non-deterministic error in branch node'),
          expectedOutcome: 'dead_letter',
        },
      ];

      for (let i = 0; i < nonAlreadyStartedErrors.length; i++) {
        const { error, expectedOutcome } = nonAlreadyStartedErrors[i];

        const mockTemporal = createStressMockTemporalClient({
          onStartWorkflow: async () => {
            throw error;
          },
        });

        const daemon = new OutboxRelayDaemon({
          outboxRepo: repo,
          temporalClientProvider: async () => mockTemporal.client,
          tenantIds: [1],
        });

        const rec = await repo.enqueue(1, {
          eventType: 'negative.event',
          correlationId: `c-neg-${i}`,
          idempotencyKey: `key-neg-${i}`,
          payload: {},
        });

        const outcome = await daemon.dispatchRecord(1, rec);
        assert.strictEqual(
          outcome,
          expectedOutcome,
          `Error "${error.message}" should resolve to '${expectedOutcome}', got '${outcome}'`
        );
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Suite 3: Mathematical & Empirical Verification of Exponential Backoff & Dead-Lettering
  // ---------------------------------------------------------------------------
  describe('Suite 3: Mathematical Exponential Backoff & Dead-Lettering Oracle', () => {
    test('3.1: Mathematical precision test: baseBackoffMs * 2^(retryCount - 1) across full retry ladder', async () => {
      const pool = createConcurrentOutboxPool();
      const uow = new TenantScopedUoW(pool as unknown as Pool);
      const repo = new OutboxRepository(uow);

      const baseBackoffMs = 500;
      const maxBackoffMs = 30_000;
      const maxRetries = 6;

      const mockTemporal = createStressMockTemporalClient({
        onStartWorkflow: async () => {
          throw new Error('ETIMEDOUT: cluster unreachable');
        },
      });

      const daemon = new OutboxRelayDaemon({
        outboxRepo: repo,
        temporalClientProvider: async () => mockTemporal.client,
        baseBackoffMs,
        maxBackoffMs,
        tenantIds: [1],
      });

      const rec = await repo.enqueue(1, {
        eventType: 'math.test',
        correlationId: 'c-math',
        idempotencyKey: 'key-math-1',
        payload: {},
        maxRetries,
      });

      // Oracle expectation:
      // Failure 1 (from retryCount 0 -> 1): delay = 500 * 2^0 = 500 ms
      // Failure 2 (from retryCount 1 -> 2): delay = 500 * 2^1 = 1000 ms
      // Failure 3 (from retryCount 2 -> 3): delay = 500 * 2^2 = 2000 ms
      // Failure 4 (from retryCount 3 -> 4): delay = 500 * 2^3 = 4000 ms
      // Failure 5 (from retryCount 4 -> 5): delay = 500 * 2^4 = 8000 ms
      // Failure 6 (from retryCount 5 -> 6): 6 >= maxRetries (6) -> DEAD LETTER!

      const expectedDelays = [500, 1000, 2000, 4000, 8000];

      for (let attempt = 1; attempt <= 5; attempt++) {
        const expectedDelay = expectedDelays[attempt - 1];

        // Fetch current row state
        const currentRow = (await repo.findById(1, rec.id))!;
        const beforeTime = Date.now();

        const outcome = await daemon.dispatchRecord(1, currentRow);
        assert.strictEqual(outcome, 'delivery_unknown', `Attempt ${attempt} should be 'delivery_unknown'`);

        const updatedRow = (await repo.findById(1, rec.id))!;
        assert.strictEqual(
          updatedRow.retry_count,
          attempt,
          `Attempt ${attempt}: DB retry_count should be ${attempt}`
        );

        const scheduledTime = updatedRow.next_retry_at!.getTime();
        const actualDelay = scheduledTime - beforeTime;

        // Tolerance window: within ±100ms of expectedDelay
        const diff = Math.abs(actualDelay - expectedDelay);
        assert.ok(
          diff <= 100,
          `Attempt ${attempt}: expected backoff ${expectedDelay}ms, got ${actualDelay}ms (diff: ${diff}ms)`
        );

        // Advance row's next_retry_at to past so it can be reclaimed for next attempt
        const rawRow = pool.table.find((r) => r.id === rec.id)!;
        rawRow.next_retry_at = new Date(Date.now() - 50);
      }

      // 6th Attempt: Reaches maxRetries (6 >= 6) -> DEAD LETTER!
      const rowBefore6 = (await repo.findById(1, rec.id))!;
      const outcome6 = await daemon.dispatchRecord(1, rowBefore6);

      assert.strictEqual(outcome6, 'dead_letter', '6th failure must transition to dead_letter');

      const deadRow = (await repo.findById(1, rec.id))!;
      assert.strictEqual(deadRow.status, 'dead_letter');
      assert.strictEqual(deadRow.retry_count, 6);
      assert.ok(deadRow.last_error?.includes('max retries exceeded'));

      // Verify dead-letter metrics
      const metrics = daemon.getMetrics();
      assert.strictEqual(metrics.totalDeadLetter, 1);
      assert.strictEqual(metrics.totalDeliveryUnknown, 5);
    });

    test('3.2: Max backoff cap: delays exceeding maxBackoffMs are capped at maxBackoffMs', async () => {
      const pool = createConcurrentOutboxPool();
      const uow = new TenantScopedUoW(pool as unknown as Pool);
      const repo = new OutboxRepository(uow);

      const baseBackoffMs = 1000;
      const maxBackoffMs = 2500; // Cap at 2500ms

      const mockTemporal = createStressMockTemporalClient({
        onStartWorkflow: async () => {
          throw new Error('ETIMEDOUT');
        },
      });

      const daemon = new OutboxRelayDaemon({
        outboxRepo: repo,
        temporalClientProvider: async () => mockTemporal.client,
        baseBackoffMs,
        maxBackoffMs,
        tenantIds: [1],
      });

      const rec = await repo.enqueue(1, {
        eventType: 'cap.test',
        correlationId: 'c-cap',
        idempotencyKey: 'key-cap-1',
        payload: {},
        maxRetries: 10,
      });

      // Attempt 1: 1000 * 2^0 = 1000ms (< 2500)
      const before1 = Date.now();
      await daemon.dispatchRecord(1, (await repo.findById(1, rec.id))!);
      const delay1 = (await repo.findById(1, rec.id))!.next_retry_at!.getTime() - before1;
      assert.ok(Math.abs(delay1 - 1000) <= 80, `Expected ~1000ms, got ${delay1}ms`);

      // Attempt 2: 1000 * 2^1 = 2000ms (< 2500)
      const before2 = Date.now();
      await daemon.dispatchRecord(1, (await repo.findById(1, rec.id))!);
      const delay2 = (await repo.findById(1, rec.id))!.next_retry_at!.getTime() - before2;
      assert.ok(Math.abs(delay2 - 2000) <= 80, `Expected ~2000ms, got ${delay2}ms`);

      // Attempt 3: 1000 * 2^2 = 4000ms -> CAPPED at 2500ms!
      const before3 = Date.now();
      await daemon.dispatchRecord(1, (await repo.findById(1, rec.id))!);
      const delay3 = (await repo.findById(1, rec.id))!.next_retry_at!.getTime() - before3;
      assert.ok(Math.abs(delay3 - 2500) <= 80, `Expected capped 2500ms, got ${delay3}ms`);

      // Attempt 4: 1000 * 2^3 = 8000ms -> CAPPED at 2500ms!
      const before4 = Date.now();
      await daemon.dispatchRecord(1, (await repo.findById(1, rec.id))!);
      const delay4 = (await repo.findById(1, rec.id))!.next_retry_at!.getTime() - before4;
      assert.ok(Math.abs(delay4 - 2500) <= 80, `Expected capped 2500ms, got ${delay4}ms`);
    });

    test('3.3: Boundary conditions: maxRetries = 1 immediately dead-letters on first failure', async () => {
      const pool = createConcurrentOutboxPool();
      const uow = new TenantScopedUoW(pool as unknown as Pool);
      const repo = new OutboxRepository(uow);

      const mockTemporal = createStressMockTemporalClient({
        onStartWorkflow: async () => {
          throw new Error('Immediate failure');
        },
      });

      const daemon = new OutboxRelayDaemon({
        outboxRepo: repo,
        temporalClientProvider: async () => mockTemporal.client,
        tenantIds: [1],
      });

      const rec = await repo.enqueue(1, {
        eventType: 'boundary.test',
        correlationId: 'c-b1',
        idempotencyKey: 'key-b1',
        payload: {},
        maxRetries: 1, // Max 1 retry (zero transient tolerance)
      });

      const outcome = await daemon.dispatchRecord(1, rec);
      assert.strictEqual(outcome, 'dead_letter');

      const dead = await repo.findById(1, rec.id);
      assert.strictEqual(dead?.status, 'dead_letter');
      assert.strictEqual(dead?.retry_count, 1);
    });

    test('3.4: Permanent error immediately dead-letters regardless of remaining retries', async () => {
      const pool = createConcurrentOutboxPool();
      const uow = new TenantScopedUoW(pool as unknown as Pool);
      const repo = new OutboxRepository(uow);

      const mockTemporal = createStressMockTemporalClient({
        onStartWorkflow: async () => {
          const err = new Error('INVALID_ARGUMENT: Workflow DAG contains cyclic dependency');
          (err as any).code = 'INVALID_ARGUMENT';
          throw err;
        },
      });

      const daemon = new OutboxRelayDaemon({
        outboxRepo: repo,
        temporalClientProvider: async () => mockTemporal.client,
        tenantIds: [1],
      });

      const rec = await repo.enqueue(1, {
        eventType: 'perm.test',
        correlationId: 'c-perm',
        idempotencyKey: 'key-perm-1',
        payload: {},
        maxRetries: 10, // Has 10 retries configured
      });

      // On attempt 1, encounters permanent error -> MUST NOT schedule backoff, MUST dead-letter
      const outcome = await daemon.dispatchRecord(1, rec);
      assert.strictEqual(outcome, 'dead_letter');

      const dead = await repo.findById(1, rec.id);
      assert.strictEqual(dead?.status, 'dead_letter');
      assert.strictEqual(dead?.retry_count, 1, 'Retry count incremented to 1');
      assert.ok(dead?.last_error?.includes('Permanent dispatch failure'));
    });
  });

  // ---------------------------------------------------------------------------
  // Suite 4: TemporalClientFactory High-Concurrency Singleton & Recovery
  // ---------------------------------------------------------------------------
  describe('Suite 4: TemporalClientFactory High-Concurrency Singleton & Recovery', () => {
    let factory: InstanceType<typeof TemporalClientFactory>;

    beforeEach(() => {
      factory = new TemporalClientFactory();
    });

    afterEach(async () => {
      await factory.close();
      temporalClientFactory.reset();
    });

    test('4.1: 50 concurrent getClient() callers during initialization: provider called exactly once, all resolve identical instance', async () => {
      let providerCallCount = 0;
      const { client: mockClient } = createStressMockTemporalClient();

      factory.setClientProvider(async () => {
        providerCallCount++;
        // Simulate async connection handshake delay
        await new Promise((r) => setTimeout(r, 20));
        return mockClient;
      });

      // Fire 50 concurrent getClient requests
      const promises: Promise<ITemporalClient>[] = [];
      for (let i = 0; i < 50; i++) {
        promises.push(factory.getClient());
      }

      const clients = await Promise.all(promises);

      // Invariants:
      // 1. Provider must be called exactly once
      assert.strictEqual(providerCallCount, 1, `Provider called ${providerCallCount} times, expected exactly 1`);

      // 2. All 50 resolved instances must be strictly identical
      for (let i = 0; i < clients.length; i++) {
        assert.strictEqual(clients[i], mockClient, `Caller ${i} received different instance`);
      }

      assert.strictEqual(factory.isConnected(), true);
    });

    test('4.2: Connection failure storm: all callers reject, promise cleared, subsequent retry reconnects cleanly', async () => {
      let attempt = 0;
      const { client: mockClient } = createStressMockTemporalClient();

      factory.setClientProvider(async () => {
        attempt++;
        if (attempt === 1) {
          await new Promise((r) => setTimeout(r, 10));
          throw new Error('Connection refused: Temporal frontend unavailable');
        }
        return mockClient;
      });

      // Wave 1: 10 concurrent callers during failure
      const wave1 = Promise.allSettled(Array.from({ length: 10 }, () => factory.getClient()));
      const wave1Results = await wave1;

      // All 10 must reject
      for (const res of wave1Results) {
        assert.strictEqual(res.status, 'rejected');
        assert.ok((res as PromiseRejectedResult).reason.message.includes('Connection refused'));
      }

      // Cached promise must be cleared
      assert.strictEqual(factory.isConnected(), false);

      // Wave 2: 10 concurrent callers after recovery
      const wave2 = await Promise.all(Array.from({ length: 10 }, () => factory.getClient()));

      // All 10 must resolve to mockClient
      for (const client of wave2) {
        assert.strictEqual(client, mockClient);
      }

      assert.strictEqual(attempt, 2, 'Provider should have been called twice (1 failed, 1 succeeded)');
      assert.strictEqual(factory.isConnected(), true);
    });
  });
});
