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
import type { OutboxRelayDaemonOptions } from '../services/outbox/OutboxRelayDaemon';

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
// Mock In-Memory Database Pool for Outbox
// =============================================================================

interface MockDbRecord {
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

interface MockClientState {
  sessionTenantId: number | null;
  inTransaction: boolean;
  queries: { sql: string; values?: unknown[] }[];
}

function createMockOutboxPool() {
  const table: MockDbRecord[] = [];
  const clientStates: MockClientState[] = [];

  const mockPool = {
    table,
    clientStates,
    async connect(): Promise<PoolClient> {
      const state: MockClientState = {
        sessionTenantId: null,
        inTransaction: false,
        queries: [],
      };
      clientStates.push(state);

      const client: Partial<PoolClient> = {
        query: async (
          text: string | { text: string; values?: unknown[] },
          values?: unknown[]
        ): Promise<QueryResult<any>> => {
          const sql = (typeof text === 'string' ? text : text.text).trim();
          const sqlValues = typeof text === 'string' ? values || [] : text.values || [];
          state.queries.push({ sql, values: sqlValues });

          const upper = sql.toUpperCase();

          if (upper === 'BEGIN') {
            state.inTransaction = true;
            return { rows: [], rowCount: 0, command: 'BEGIN', oid: 0, fields: [] };
          }
          if (upper === 'COMMIT') {
            state.inTransaction = false;
            state.sessionTenantId = null;
            return { rows: [], rowCount: 0, command: 'COMMIT', oid: 0, fields: [] };
          }
          if (upper === 'ROLLBACK') {
            state.inTransaction = false;
            state.sessionTenantId = null;
            return { rows: [], rowCount: 0, command: 'ROLLBACK', oid: 0, fields: [] };
          }

          const setMatch = sql.match(/SET LOCAL app\.current_tenant_id\s*=\s*'(\d+)'/i);
          if (setMatch) {
            state.sessionTenantId = parseInt(setMatch[1], 10);
            return { rows: [], rowCount: 0, command: 'SET', oid: 0, fields: [] };
          }

          const effectiveTenantId = state.sessionTenantId;

          // INSERT into processing_outbox
          if (upper.startsWith('INSERT INTO PROCESSING_OUTBOX')) {
            const insertTenantId = Number(sqlValues[0]);
            if (!effectiveTenantId || effectiveTenantId !== insertTenantId) {
              const err = new Error('violates row-level security policy for table "processing_outbox"');
              (err as any).code = '44501';
              throw err;
            }

            const idempotencyKey = String(sqlValues[5]);
            const existingIdx = table.findIndex(
              (r) => r.tenant_id === insertTenantId && r.idempotency_key === idempotencyKey
            );
            if (existingIdx >= 0) {
              table[existingIdx].updated_at = new Date();
              return { rows: [table[existingIdx]], rowCount: 1, command: 'INSERT', oid: 0, fields: [] };
            }

            const newRow: MockDbRecord = {
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

          // SELECT with FOR UPDATE SKIP LOCKED in WITH claimable AS (...)
          if (upper.includes('WITH CLAIMABLE AS')) {
            if (!effectiveTenantId) {
              return { rows: [], rowCount: 0, command: 'UPDATE', oid: 0, fields: [] };
            }

            const now = Date.now();
            const limit = Number(sqlValues[1] || 10);
            const claimable = table
              .filter(
                (r) =>
                  r.tenant_id === effectiveTenantId &&
                  (r.status === 'pending' || r.status === 'delivery_unknown') &&
                  (r.next_retry_at === null || r.next_retry_at.getTime() <= now)
              )
              .slice(0, limit);

            for (const row of claimable) {
              row.status = 'processing';
              row.updated_at = new Date();
            }

            return { rows: claimable, rowCount: claimable.length, command: 'UPDATE', oid: 0, fields: [] };
          }

          // UPDATE processing_outbox SET status = ...
          if (upper.startsWith('UPDATE PROCESSING_OUTBOX')) {
            const newStatus = sqlValues[0] as OutboxStatus;
            const error = sqlValues[1] as string | null;
            const nextRetryAt = sqlValues[2] as Date | null;
            const incrementRetry = Boolean(sqlValues[3]);
            const tenantId = Number(sqlValues[4]);
            const id = String(sqlValues[5]);

            if (effectiveTenantId !== tenantId) {
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

          // Standard SELECT
          if (upper.startsWith('SELECT')) {
            if (!effectiveTenantId) {
              return { rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] };
            }
            let filtered = table.filter((r) => r.tenant_id === effectiveTenantId);
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
        release: () => {},
      };

      return client as PoolClient;
    },
  };

  return mockPool;
}

// =============================================================================
// Mock Temporal Client Generator
// =============================================================================

function createMockTemporalClient(options?: {
  onStartWorkflow?: (workflowType: unknown, startOpts: WorkflowStartOptions) => Promise<WorkflowHandle>;
}) {
  const startedWorkflows: { workflowType: unknown; options: WorkflowStartOptions }[] = [];

  const workflowClient: ITemporalWorkflowClient = {
    start: async (workflowType, startOpts) => {
      startedWorkflows.push({ workflowType, options: startOpts });
      if (options?.onStartWorkflow) {
        return options.onStartWorkflow(workflowType, startOpts);
      }
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

  return { client, startedWorkflows };
}

// =============================================================================
// Test Suites
// =============================================================================

describe('PR-F4-01: Temporal OSS Bridge & Outbox Relay Daemon', () => {
  // ---------------------------------------------------------------------------
  // Suite 1: TemporalClientFactory
  // ---------------------------------------------------------------------------
  describe('Suite 1: TemporalClientFactory Singleton & Connection Pool', () => {
    let factory: TemporalClientFactory;

    beforeEach(() => {
      factory = new TemporalClientFactory();
    });

    afterEach(async () => {
      await factory.close();
      temporalClientFactory.reset();
    });

    test('1.1: Maintains singleton instance across multiple calls without re-connecting', async () => {
      const { client: mockClient } = createMockTemporalClient();
      let connectCallCount = 0;

      factory.setClientProvider(async () => {
        connectCallCount++;
        return mockClient;
      });

      const client1 = await factory.getClient();
      const client2 = await factory.getClient();
      const client3 = await factory.getClient();

      assert.strictEqual(client1, client2);
      assert.strictEqual(client2, client3);
      assert.strictEqual(connectCallCount, 1, 'Provider should only be called once for singleton instance');
      assert.strictEqual(factory.isConnected(), true);
    });

    test('1.2: Reads configuration defaults from environment variables', async () => {
      const originalAddress = process.env.TEMPORAL_ADDRESS;
      const originalNamespace = process.env.TEMPORAL_NAMESPACE;
      const originalIdentity = process.env.TEMPORAL_CLIENT_IDENTITY;

      process.env.TEMPORAL_ADDRESS = 'temporal.corp.internal:7233';
      process.env.TEMPORAL_NAMESPACE = 'production-automation';
      process.env.TEMPORAL_CLIENT_IDENTITY = 'backend-worker-pod-42';

      try {
        const customFactory = new TemporalClientFactory();
        let capturedOptions: any = null;

        customFactory.setClientProvider(async (opts) => {
          capturedOptions = opts;
          const { client } = createMockTemporalClient();
          return client;
        });

        await customFactory.getClient({ address: 'override:7233' });
        assert.strictEqual(capturedOptions.address, 'override:7233');

        await customFactory.close();
      } finally {
        process.env.TEMPORAL_ADDRESS = originalAddress;
        process.env.TEMPORAL_NAMESPACE = originalNamespace;
        process.env.TEMPORAL_CLIENT_IDENTITY = originalIdentity;
      }
    });

    test('1.3: setMockClient directly registers testing mock without factory function', async () => {
      const { client: mockClient } = createMockTemporalClient();
      factory.setMockClient(mockClient);

      const resolved = await factory.getClient();
      assert.strictEqual(resolved, mockClient);
      assert.strictEqual(factory.isConnected(), true);
    });

    test('1.4: close() and reset() clean up connection and clear singleton cache', async () => {
      let closeCalled = false;
      const mockClient: ITemporalClient = {
        workflow: {
          start: async () => ({} as any),
          execute: async () => ({}),
          getHandle: () => ({} as any),
        },
        close: async () => {
          closeCalled = true;
        },
      };

      factory.setMockClient(mockClient);
      await factory.getClient();
      assert.strictEqual(factory.isConnected(), true);

      await factory.close();
      assert.strictEqual(closeCalled, true);
      assert.strictEqual(factory.isConnected(), false);
    });

    test('1.5: getTemporalClient helper delegates to temporalClientFactory', async () => {
      const { client: mockClient } = createMockTemporalClient();
      temporalClientFactory.setMockClient(mockClient);

      const client = await getTemporalClient();
      assert.strictEqual(client, mockClient);
    });

    test('1.6: Throws TemporalConnectionError on cluster connection failure', async () => {
      factory.setClientProvider(async () => {
        throw new Error('Connection refused (gRPC status: UNAVAILABLE)');
      });

      await assert.rejects(
        async () => {
          await factory.getClient();
        },
        (err: any) => {
          return err.message.includes('Connection refused');
        }
      );
      assert.strictEqual(factory.isConnected(), false);
    });
  });

  // ---------------------------------------------------------------------------
  // Suite 2: OutboxRelayDaemon - Poller & Happy Path Dispatch
  // ---------------------------------------------------------------------------
  describe('Suite 2: OutboxRelayDaemon Poller & Idempotent Dispatch', () => {
    let mockPool: ReturnType<typeof createMockOutboxPool>;
    let uow: TenantScopedUoW;
    let repo: OutboxRepository;
    let mockTemporal: ReturnType<typeof createMockTemporalClient>;
    let daemon: OutboxRelayDaemon;

    beforeEach(() => {
      mockPool = createMockOutboxPool();
      uow = new TenantScopedUoW(mockPool as unknown as Pool);
      repo = new OutboxRepository(uow);
      mockTemporal = createMockTemporalClient();

      daemon = new OutboxRelayDaemon({
        outboxRepo: repo,
        temporalClientProvider: async () => mockTemporal.client,
        pollIntervalMs: 100,
        batchSize: 5,
        tenantIds: [1],
      });
    });

    afterEach(async () => {
      await daemon.stop();
    });

    test('2.1: Lifecycle management: start() and stop() control timer and metrics', async () => {
      assert.strictEqual(daemon.getMetrics().isRunning, false);
      await daemon.start();
      assert.strictEqual(daemon.getMetrics().isRunning, true);
      await daemon.stop();
      assert.strictEqual(daemon.getMetrics().isRunning, false);
    });

    test('2.2: Claims pending outbox records and dispatches them to Temporal with deterministic ID', async () => {
      // Enqueue record
      const record = await repo.enqueue(1, {
        eventType: 'automation.order.created',
        correlationId: 'corr-001',
        idempotencyKey: 'ord-12345',
        payload: { orderId: 'ord-12345', amount: 1500 },
      });

      assert.strictEqual(record.status, 'pending');

      // Process batch
      const processedCount = await daemon.processBatch(1);
      assert.strictEqual(processedCount, 1);

      // Verify workflow started in Temporal
      assert.strictEqual(mockTemporal.startedWorkflows.length, 1);
      const dispatched = mockTemporal.startedWorkflows[0];
      assert.strictEqual(dispatched.workflowType, 'automation.order.created');
      assert.strictEqual(dispatched.options.workflowId, 'wf_1_ord-12345');
      assert.strictEqual(dispatched.options.taskQueue, 'automation-workflows-v1');

      // Verify outbox record transitioned to 'dispatched'
      const updated = await repo.findById(1, record.id);
      assert.strictEqual(updated?.status, 'dispatched');

      // Verify metrics
      const metrics = daemon.getMetrics();
      assert.strictEqual(metrics.totalProcessed, 1);
      assert.strictEqual(metrics.totalDispatched, 1);
    });

    test('2.3: Respects custom taskQueue and workflowType in payload', async () => {
      await repo.enqueue(1, {
        eventType: 'generic.event',
        correlationId: 'corr-002',
        idempotencyKey: 'custom-flow-1',
        payload: {
          taskQueue: 'channel-less-workflows-v1',
          workflowType: 'ChannelLessBusinessWorkflow',
          data: { foo: 'bar' },
        },
      });

      await daemon.processBatch(1);

      assert.strictEqual(mockTemporal.startedWorkflows.length, 1);
      const dispatched = mockTemporal.startedWorkflows[0];
      assert.strictEqual(dispatched.workflowType, 'ChannelLessBusinessWorkflow');
      assert.strictEqual(dispatched.options.taskQueue, 'channel-less-workflows-v1');
    });

    test('2.4: Processes batches up to batchSize', async () => {
      for (let i = 1; i <= 7; i++) {
        await repo.enqueue(1, {
          eventType: 'bulk.event',
          correlationId: `corr-bulk-${i}`,
          idempotencyKey: `bulk-key-${i}`,
          payload: { index: i },
        });
      }

      // Batch size is 5, so first batch processes 5
      const firstBatch = await daemon.processBatch(1);
      assert.strictEqual(firstBatch, 5);
      assert.strictEqual(mockTemporal.startedWorkflows.length, 5);

      // Second batch processes remaining 2
      const secondBatch = await daemon.processBatch(1);
      assert.strictEqual(secondBatch, 2);
      assert.strictEqual(mockTemporal.startedWorkflows.length, 7);
    });
  });

  // ---------------------------------------------------------------------------
  // Suite 3: ADR-007 delivery_unknown Semantics & Exponential Backoff
  // ---------------------------------------------------------------------------
  describe('Suite 3: ADR-007 delivery_unknown Semantics & Exponential Backoff', () => {
    let mockPool: ReturnType<typeof createMockOutboxPool>;
    let uow: TenantScopedUoW;
    let repo: OutboxRepository;
    let daemon: OutboxRelayDaemon;
    let shouldFail = false;

    beforeEach(() => {
      mockPool = createMockOutboxPool();
      uow = new TenantScopedUoW(mockPool as unknown as Pool);
      repo = new OutboxRepository(uow);
      shouldFail = false;

      const mockTemporal = createMockTemporalClient({
        onStartWorkflow: async () => {
          if (shouldFail) {
            throw new Error('ETIMEDOUT: Temporal gRPC connection timed out');
          }
          return {
            workflowId: 'wf-ok',
            result: async () => ({}),
            terminate: async () => {},
            signal: async () => {},
            query: async () => ({}),
          };
        },
      });

      daemon = new OutboxRelayDaemon({
        outboxRepo: repo,
        temporalClientProvider: async () => mockTemporal.client,
        pollIntervalMs: 50,
        batchSize: 10,
        tenantIds: [1],
        baseBackoffMs: 200,
        maxBackoffMs: 5000,
      });
    });

    test('3.1: Transient network failure marks record as delivery_unknown (ADR-007)', async () => {
      const record = await repo.enqueue(1, {
        eventType: 'transient.event',
        correlationId: 'c-transient',
        idempotencyKey: 'key-transient-1',
        payload: {},
      });

      shouldFail = true;
      await daemon.processBatch(1);

      const updated = await repo.findById(1, record.id);
      assert.strictEqual(updated?.status, 'delivery_unknown');
      assert.strictEqual(updated?.retry_count, 1);
      assert.ok(updated?.last_error?.includes('ETIMEDOUT'));
      assert.ok(updated?.next_retry_at instanceof Date);

      const metrics = daemon.getMetrics();
      assert.strictEqual(metrics.totalDeliveryUnknown, 1);
    });

    test('3.2: Exponential backoff increases delay on subsequent failures', async () => {
      const record = await repo.enqueue(1, {
        eventType: 'retry.event',
        correlationId: 'c-exp',
        idempotencyKey: 'key-exp-1',
        payload: {},
      });

      shouldFail = true;
      const beforeAttempt1 = Date.now();
      await daemon.processBatch(1);

      const rec1 = await repo.findById(1, record.id);
      assert.strictEqual(rec1?.retry_count, 1);
      const delay1 = rec1!.next_retry_at!.getTime() - beforeAttempt1;
      // Base backoff is 200ms -> delay1 ~ 200ms
      assert.ok(delay1 >= 180 && delay1 <= 350, `Expected ~200ms backoff, got ${delay1}ms`);

      // Simulate time passing: set next_retry_at to past so it can be reclaimed
      const row = mockPool.table.find((r) => r.id === record.id);
      row!.next_retry_at = new Date(Date.now() - 100);

      // Attempt 2 failure -> delay ~ 400ms (200 * 2^1)
      const beforeAttempt2 = Date.now();
      await daemon.processBatch(1);

      const rec2 = await repo.findById(1, record.id);
      assert.strictEqual(rec2?.retry_count, 2);
      const delay2 = rec2!.next_retry_at!.getTime() - beforeAttempt2;
      assert.ok(delay2 >= 380 && delay2 <= 550, `Expected ~400ms backoff, got ${delay2}ms`);
    });

    test('3.3: Automatically recovers and dispatches once Temporal becomes available', async () => {
      const record = await repo.enqueue(1, {
        eventType: 'recovery.event',
        correlationId: 'c-rec',
        idempotencyKey: 'key-rec-1',
        payload: {},
      });

      // 1. First poll fails -> delivery_unknown
      shouldFail = true;
      await daemon.processBatch(1);
      assert.strictEqual((await repo.findById(1, record.id))?.status, 'delivery_unknown');

      // 2. Temporal recovers, timer elapses
      shouldFail = false;
      const row = mockPool.table.find((r) => r.id === record.id);
      row!.next_retry_at = new Date(Date.now() - 10);

      // 3. Second poll claims and succeeds -> dispatched
      await daemon.processBatch(1);
      const finalRecord = await repo.findById(1, record.id);
      assert.strictEqual(finalRecord?.status, 'dispatched');
    });
  });

  // ---------------------------------------------------------------------------
  // Suite 4: Dead Letter Handling & Max Retries
  // ---------------------------------------------------------------------------
  describe('Suite 4: Dead Letter Handling & Max Retries', () => {
    let mockPool: ReturnType<typeof createMockOutboxPool>;
    let uow: TenantScopedUoW;
    let repo: OutboxRepository;
    let daemon: OutboxRelayDaemon;
    let failureType = 'transient';

    beforeEach(() => {
      mockPool = createMockOutboxPool();
      uow = new TenantScopedUoW(mockPool as unknown as Pool);
      repo = new OutboxRepository(uow);

      const mockTemporal = createMockTemporalClient({
        onStartWorkflow: async () => {
          if (failureType === 'permanent') {
            const err = new Error('INVALID_ARGUMENT: Workflow definition dag graph is malformed');
            (err as any).code = 'INVALID_ARGUMENT';
            throw err;
          }
          throw new Error('Connection failed');
        },
      });

      daemon = new OutboxRelayDaemon({
        outboxRepo: repo,
        temporalClientProvider: async () => mockTemporal.client,
        tenantIds: [1],
      });
    });

    test('4.1: Permanent error immediately marks record as dead_letter', async () => {
      const record = await repo.enqueue(1, {
        eventType: 'malformed.event',
        correlationId: 'c-bad',
        idempotencyKey: 'key-bad-1',
        payload: {},
      });

      failureType = 'permanent';
      await daemon.processBatch(1);

      const updated = await repo.findById(1, record.id);
      assert.strictEqual(updated?.status, 'dead_letter');
      assert.ok(updated?.last_error?.includes('Permanent dispatch failure'));

      const metrics = daemon.getMetrics();
      assert.strictEqual(metrics.totalDeadLetter, 1);
    });

    test('4.2: Exceeding max_retries transitions record to dead_letter', async () => {
      const record = await repo.enqueue(1, {
        eventType: 'maxretries.event',
        correlationId: 'c-max',
        idempotencyKey: 'key-max-1',
        payload: {},
        maxRetries: 3,
      });

      failureType = 'transient';

      // Simulate 2 previous failed retries
      const row = mockPool.table.find((r) => r.id === record.id);
      row!.retry_count = 2;

      // 3rd failure reaches max_retries = 3
      await daemon.processBatch(1);

      const updated = await repo.findById(1, record.id);
      assert.strictEqual(updated?.status, 'dead_letter');
      assert.strictEqual(updated?.retry_count, 3);
    });
  });

  // ---------------------------------------------------------------------------
  // Suite 5: Idempotent Deduplication
  // ---------------------------------------------------------------------------
  describe('Suite 5: Idempotent Deduplication with Temporal', () => {
    let mockPool: ReturnType<typeof createMockOutboxPool>;
    let uow: TenantScopedUoW;
    let repo: OutboxRepository;
    let daemon: OutboxRelayDaemon;

    beforeEach(() => {
      mockPool = createMockOutboxPool();
      uow = new TenantScopedUoW(mockPool as unknown as Pool);
      repo = new OutboxRepository(uow);

      const mockTemporal = createMockTemporalClient({
        onStartWorkflow: async (workflowType, opts) => {
          // Throws WorkflowExecutionAlreadyStartedError
          throw new WorkflowExecutionAlreadyStartedError(
            `Workflow execution already started for workflowId: ${opts.workflowId}`,
            opts.workflowId,
            'existing-run-id'
          );
        },
      });

      daemon = new OutboxRelayDaemon({
        outboxRepo: repo,
        temporalClientProvider: async () => mockTemporal.client,
        tenantIds: [1],
      });
    });

    test('5.1: WorkflowExecutionAlreadyStartedError is recognized as idempotent and marked dispatched', async () => {
      const record = await repo.enqueue(1, {
        eventType: 'duplicate.event',
        correlationId: 'c-dup',
        idempotencyKey: 'key-dup-1',
        payload: {},
      });

      const outcome = await daemon.dispatchRecord(1, record);
      assert.strictEqual(outcome, 'dispatched');

      const updated = await repo.findById(1, record.id);
      assert.strictEqual(updated?.status, 'dispatched');

      const metrics = daemon.getMetrics();
      assert.strictEqual(metrics.totalDispatched, 1);
      assert.strictEqual(metrics.totalDeliveryUnknown, 0);
    });
  });

  // ---------------------------------------------------------------------------
  // Suite 6: Multi-Tenant Polling Isolation
  // ---------------------------------------------------------------------------
  describe('Suite 6: Multi-Tenant Polling Isolation', () => {
    let mockPool: ReturnType<typeof createMockOutboxPool>;
    let uow: TenantScopedUoW;
    let repo: OutboxRepository;
    let mockTemporal: ReturnType<typeof createMockTemporalClient>;
    let daemon: OutboxRelayDaemon;

    beforeEach(() => {
      mockPool = createMockOutboxPool();
      uow = new TenantScopedUoW(mockPool as unknown as Pool);
      repo = new OutboxRepository(uow);
      mockTemporal = createMockTemporalClient();

      daemon = new OutboxRelayDaemon({
        outboxRepo: repo,
        temporalClientProvider: async () => mockTemporal.client,
        tenantIds: [1, 2],
      });
    });

    test('6.1: Processes records across configured tenants while maintaining tenant isolation', async () => {
      // Enqueue for Tenant 1
      const rec1 = await repo.enqueue(1, {
        eventType: 't1.event',
        correlationId: 'c-t1',
        idempotencyKey: 'key-t1',
        payload: { tenant: 1 },
      });

      // Enqueue for Tenant 2
      const rec2 = await repo.enqueue(2, {
        eventType: 't2.event',
        correlationId: 'c-t2',
        idempotencyKey: 'key-t2',
        payload: { tenant: 2 },
      });

      const processedCount = await daemon.processBatch();
      assert.strictEqual(processedCount, 2);

      // Verify workflow starts
      assert.strictEqual(mockTemporal.startedWorkflows.length, 2);
      const wf1 = mockTemporal.startedWorkflows.find((w) => w.options.workflowId === 'wf_1_key-t1');
      const wf2 = mockTemporal.startedWorkflows.find((w) => w.options.workflowId === 'wf_2_key-t2');
      assert.ok(wf1, 'Tenant 1 workflow must be dispatched');
      assert.ok(wf2, 'Tenant 2 workflow must be dispatched');

      // Verify outbox statuses
      assert.strictEqual((await repo.findById(1, rec1.id))?.status, 'dispatched');
      assert.strictEqual((await repo.findById(2, rec2.id))?.status, 'dispatched');
    });
  });
});
