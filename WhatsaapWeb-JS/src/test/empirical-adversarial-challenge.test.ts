// Invariants before config load
process.env.JWT_SECRET = 'test-only-jwt-secret-with-at-least-32-characters-for-testing';
process.env.DB_PASSWORD = 'test-only-database-password';

import assert from 'node:assert/strict';
import { describe, test, beforeEach } from 'node:test';
import crypto from 'node:crypto';
import type { Pool, PoolClient, QueryResult } from 'pg';

import {
  ChannelCapabilityMatrix,
  PublishIntent,
  StandardErrorCode,
  evaluatePublishGate,
} from '@whatsap-automat/contracts';

const { TenantScopedUoW } = require('../db/TenantScopedUoW') as typeof import('../db/TenantScopedUoW');
const { OutboxRepository } = require('../services/outbox/OutboxRepository') as typeof import('../services/outbox/OutboxRepository');
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
// Mock In-Memory Database Engine
// =============================================================================

interface MockDbRecord {
  id?: string | number;
  tenant_id: number;
  [key: string]: unknown;
}

function createMockChallengePool() {
  const tables: Record<string, MockDbRecord[]> = {
    processing_outbox: [],
    idempotency_ledger: [],
    channel_capabilities_snapshots: [],
  };

  const mockPool = {
    tables,
    async connect(): Promise<PoolClient> {
      let sessionTenantId: number | null = null;
      let inTransaction = false;

      const client: Partial<PoolClient> = {
        query: async (
          text: string | { text: string; values?: unknown[] },
          values?: unknown[]
        ): Promise<QueryResult<any>> => {
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
            return { rows: [], rowCount: 0, command: 'COMMIT', oid: 0, fields: [] };
          }
          if (upper === 'ROLLBACK') {
            inTransaction = false;
            sessionTenantId = null;
            return { rows: [], rowCount: 0, command: 'ROLLBACK', oid: 0, fields: [] };
          }
          if (sql.startsWith('SET LOCAL app.current_tenant_id')) {
            sessionTenantId = Number(sqlValues[0]);
            return { rows: [], rowCount: 0, command: 'SET', oid: 0, fields: [] };
          }

          // INSERT channel_capabilities_snapshots
          if (upper.includes('INSERT INTO CHANNEL_CAPABILITIES_SNAPSHOTS')) {
            const tenantId = Number(sqlValues[0]);
            const connectionId = String(sqlValues[1]);
            const channel = String(sqlValues[2]);
            const matrix = sqlValues[3];
            const healthStatus = String(sqlValues[4]);

            const existingIdx = tables.channel_capabilities_snapshots.findIndex(
              (r) => r.tenant_id === tenantId && r.connection_id === connectionId
            );
            const record = {
              tenant_id: tenantId,
              connection_id: connectionId,
              channel,
              matrix,
              health_status: healthStatus,
            };

            if (existingIdx >= 0) {
              tables.channel_capabilities_snapshots[existingIdx] = record;
            } else {
              tables.channel_capabilities_snapshots.push(record);
            }
            return { rows: [], rowCount: 1, command: 'INSERT', oid: 0, fields: [] };
          }

          // UPDATE channel_capabilities_snapshots
          if (upper.includes('UPDATE CHANNEL_CAPABILITIES_SNAPSHOTS')) {
            const healthStatus = String(sqlValues[0]);
            const matrix = sqlValues[1];
            const tenantId = Number(sqlValues[2]);
            const connectionId = String(sqlValues[3]);

            const existing = tables.channel_capabilities_snapshots.find(
              (r) => r.tenant_id === tenantId && r.connection_id === connectionId
            );
            if (existing) {
              existing.health_status = healthStatus;
              existing.matrix = matrix;
              return { rows: [], rowCount: 1, command: 'UPDATE', oid: 0, fields: [] };
            }
            return { rows: [], rowCount: 0, command: 'UPDATE', oid: 0, fields: [] };
          }

          // SELECT FROM channel_capabilities_snapshots
          if (upper.includes('FROM CHANNEL_CAPABILITIES_SNAPSHOTS')) {
            const tenantId = Number(sqlValues[0]);
            const connectionId = String(sqlValues[1]);
            const rows = tables.channel_capabilities_snapshots.filter(
              (r) => r.tenant_id === tenantId && r.connection_id === connectionId
            );
            return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] };
          }

          // SELECT FROM idempotency_ledger
          if (upper.includes('FROM IDEMPOTENCY_LEDGER')) {
            const tenantId = Number(sqlValues[0]);
            const key = String(sqlValues[1]);
            const rows = tables.idempotency_ledger.filter(
              (r) => r.tenant_id === tenantId && r.idempotency_key === key
            );
            return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] };
          }

          // INSERT INTO idempotency_ledger
          if (upper.includes('INSERT INTO IDEMPOTENCY_LEDGER')) {
            const tenantId = Number(sqlValues[0]);
            const idempotencyKey = String(sqlValues[1]);
            const source = String(sqlValues[2]);
            const requestHash = String(sqlValues[3]);
            const responseStatus = Number(sqlValues[4]);
            const responseBody = sqlValues[5];

            tables.idempotency_ledger.push({
              tenant_id: tenantId,
              idempotency_key: idempotencyKey,
              source,
              request_hash: requestHash,
              response_status: responseStatus,
              response_body: responseBody,
            });
            return { rows: [], rowCount: 1, command: 'INSERT', oid: 0, fields: [] };
          }

          // INSERT INTO processing_outbox
          if (upper.includes('INSERT INTO PROCESSING_OUTBOX')) {
            const tenantId = Number(sqlValues[0]);
            const eventType = String(sqlValues[2]);
            const correlationId = String(sqlValues[3]);
            const idempotencyKey = String(sqlValues[4]);
            const payload = sqlValues[5];

            const rec = {
              id: 'mock-outbox-uuid-' + Math.random().toString(36).substring(7),
              tenant_id: tenantId,
              event_type: eventType,
              correlation_id: correlationId,
              idempotency_key: idempotencyKey,
              payload,
              status: 'pending',
              retry_count: 0,
              max_retries: 5,
              created_at: new Date(),
              updated_at: new Date(),
            };
            tables.processing_outbox.push(rec);
            return { rows: [rec], rowCount: 1, command: 'INSERT', oid: 0, fields: [] };
          }

          return { rows: [], rowCount: 0, command: 'UNKNOWN', oid: 0, fields: [] };
        },
        release: () => {},
      } as PoolClient;

      return client as PoolClient;
    },
  };

  return mockPool;
}

function createBaselineCapabilityMatrix(overrides?: Partial<ChannelCapabilityMatrix>): ChannelCapabilityMatrix {
  return {
    connectionId: 'conn-challenge-001',
    tenantId: '10',
    channel: 'whatsapp-cloud', // Canonical channel kind
    features: {
      text: true,
      image: true,
      audio: true,
      video: false, // Default: video disabled
      document: true,
      template: true,
      interactive: true,
      reactions: true,
      typing: true,
      readReceipt: true,
    },
    scopes: ['messages.read', 'messages.send'],
    policies: {
      sessionWindowHours: 24,
      requiresHsmTemplateOutsideWindow: true,
      rateLimitPerMinute: 60,
      requiresOptIn: true,
    },
    health: {
      status: 'healthy',
      lastCheckedAt: new Date().toISOString(),
      latencyMs: 85,
    },
    budget: {
      tier: 'standard',
      costPerMessageCents: 5,
      monthlyBudgetLimitCents: 10000,
      currentMonthSpendCents: 5000,
    },
    regional: {
      blacklistedCountries: ['KP', 'SY', 'IR'],
    },
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// =============================================================================
// ADVERSARIAL TEST SUITE
// =============================================================================

describe('Adversarial Verification: CapabilityRegistry, HMAC Security & Anti-Replay Timing Boundaries', () => {
  const secret = 'super-secure-production-webhook-secret-key-256';
  const testPayload = JSON.stringify({ event: 'message.received', id: 'wamid.12345', text: 'Hello automated world' });

  // ---------------------------------------------------------------------------
  // 1. HMAC Security & Adversarial Attack Vectors
  // ---------------------------------------------------------------------------
  describe('1. HMAC SHA-256 Cryptographic & Forgery Resilience', () => {
    test('1.1 Accepts valid HMAC with standard sha256= prefix', () => {
      const validHmac = crypto.createHmac('sha256', secret).update(testPayload).digest('hex');
      const header = `sha256=${validHmac}`;
      assert.strictEqual(verifyWebhookHmac(secret, testPayload, header), true);
    });

    test('1.2 Accepts valid HMAC without prefix (raw hex)', () => {
      const validHmac = crypto.createHmac('sha256', secret).update(testPayload).digest('hex');
      assert.strictEqual(verifyWebhookHmac(secret, testPayload, validHmac), true);
    });

    test('1.3 Rejects forged / randomly generated 64-character hex signature', () => {
      const forged = 'sha256=' + 'a1b2c3d4e5f6'.repeat(5) + 'abcd';
      assert.strictEqual(verifyWebhookHmac(secret, testPayload, forged), false);
    });

    test('1.4 Rejects replay of valid signature on modified payload (tampered body)', () => {
      const validHmac = crypto.createHmac('sha256', secret).update(testPayload).digest('hex');
      const modifiedPayload = JSON.stringify({ event: 'message.received', id: 'wamid.12345', text: 'Tampered malicious payload' });
      assert.strictEqual(verifyWebhookHmac(secret, modifiedPayload, `sha256=${validHmac}`), false);
    });

    test('1.5 Rejects subtle single-character bit flips across all byte positions (boundary & middle)', () => {
      const validHmac = crypto.createHmac('sha256', secret).update(testPayload).digest('hex');

      // Flip first char (pos 0)
      const flip0 = (validHmac[0] === 'a' ? 'b' : 'a') + validHmac.slice(1);
      assert.strictEqual(verifyWebhookHmac(secret, testPayload, `sha256=${flip0}`), false, 'Failed to reject flip at index 0');

      // Flip middle char (pos 31)
      const flip31 = validHmac.slice(0, 31) + (validHmac[31] === 'a' ? 'b' : 'a') + validHmac.slice(32);
      assert.strictEqual(verifyWebhookHmac(secret, testPayload, `sha256=${flip31}`), false, 'Failed to reject flip at index 31');

      // Flip last char (pos 63)
      const flip63 = validHmac.slice(0, 63) + (validHmac[63] === 'a' ? 'b' : 'a');
      assert.strictEqual(verifyWebhookHmac(secret, testPayload, `sha256=${flip63}`), false, 'Failed to reject flip at index 63');
    });

    test('1.6 Rejects partial, truncated, extended, and malformed signature prefixes', () => {
      const validHmac = crypto.createHmac('sha256', secret).update(testPayload).digest('hex');

      // Empty hex after prefix
      assert.strictEqual(verifyWebhookHmac(secret, testPayload, 'sha256='), false);

      // Prefix without equals ('s' is invalid hex)
      assert.strictEqual(verifyWebhookHmac(secret, testPayload, 'sha256'), false);

      // Truncated signatures
      assert.strictEqual(verifyWebhookHmac(secret, testPayload, 'sha256=a'), false);
      assert.strictEqual(verifyWebhookHmac(secret, testPayload, 'sha256=1234567890abcdef'), false);
      assert.strictEqual(verifyWebhookHmac(secret, testPayload, 'sha256=' + validHmac.slice(0, 63)), false);

      // Extended signature (65 chars)
      assert.strictEqual(verifyWebhookHmac(secret, testPayload, 'sha256=' + validHmac + '0'), false);

      // Wrong algorithm prefix ('sha1=' fails hex check)
      assert.strictEqual(verifyWebhookHmac(secret, testPayload, 'sha1=' + validHmac), false);

      // Non-hex characters in body ('g' is not hex)
      assert.strictEqual(verifyWebhookHmac(secret, testPayload, 'sha256=' + 'g'.repeat(64)), false);
    });

    test('1.7 Correctly validates and protects empty body payloads', () => {
      const emptyString = '';
      const emptyBuffer = Buffer.from('');
      const emptyHmac = crypto.createHmac('sha256', secret).update(emptyString).digest('hex');

      assert.strictEqual(verifyWebhookHmac(secret, emptyString, `sha256=${emptyHmac}`), true);
      assert.strictEqual(verifyWebhookHmac(secret, emptyBuffer, `sha256=${emptyHmac}`), true);

      // Mismatched: non-empty body with empty body signature
      assert.strictEqual(verifyWebhookHmac(secret, '{"non":"empty"}', `sha256=${emptyHmac}`), false);

      // Mismatched: empty body with non-empty signature
      const validNonEmptyHmac = crypto.createHmac('sha256', secret).update(testPayload).digest('hex');
      assert.strictEqual(verifyWebhookHmac(secret, emptyString, `sha256=${validNonEmptyHmac}`), false);
    });

    test('1.8 Fails-closed on missing secrets or headers', () => {
      const validHmac = crypto.createHmac('sha256', secret).update(testPayload).digest('hex');
      assert.strictEqual(verifyWebhookHmac('', testPayload, `sha256=${validHmac}`), false);
      assert.strictEqual(verifyWebhookHmac(secret, testPayload, ''), false);
      assert.strictEqual(verifyWebhookHmac(secret, testPayload, undefined), false);
    });

    test('1.9 Every equal-length signature uses the constant-time comparison', (context) => {
      const validHmac = crypto.createHmac('sha256', secret).update(testPayload).digest('hex');
      const mismatch0 = (validHmac[0] === 'a' ? 'b' : 'a') + validHmac.slice(1);
      const mismatch63 = validHmac.slice(0, 63) + (validHmac[63] === 'a' ? 'b' : 'a');
      const compare = context.mock.method(crypto, 'timingSafeEqual');
      assert.equal(verifyWebhookHmac(secret, testPayload, `sha256=${validHmac}`), true);
      assert.equal(verifyWebhookHmac(secret, testPayload, `sha256=${mismatch0}`), false);
      assert.equal(verifyWebhookHmac(secret, testPayload, `sha256=${mismatch63}`), false);
      assert.equal(verifyWebhookHmac(secret, testPayload, `sha256=${validHmac.slice(0, -1)}`), false);
      assert.equal(compare.mock.callCount(), 3);
      assert.deepEqual(compare.mock.calls.map(({ arguments: [actual, received] }) => [actual.toString(), received.toString()]), [
        [validHmac, validHmac], [validHmac, mismatch0], [validHmac, mismatch63],
      ]);
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Anti-Replay Timing Boundaries (+/- 300s window)
  // ---------------------------------------------------------------------------
  describe('2. Anti-Replay Timing Boundary Enforcement', () => {
    const tolerance = 300;

    test('2.1 Exact boundary: delta = 299s (past) MUST pass', () => {
      const now = Date.now();
      const timestamp299 = now - 299 * 1000;
      const res = verifyAntiReplayTimestamp(timestamp299, tolerance, now);
      assert.strictEqual(res.valid, true, 'exact delta = 299s failed');
      assert.ok(res.skewSeconds !== undefined && Math.round(res.skewSeconds) === 299);
    });

    test('2.2 Exact boundary: delta = 300s (past) MUST pass', () => {
      const now = Date.now();
      const timestamp300 = now - 300 * 1000;
      const res = verifyAntiReplayTimestamp(timestamp300, tolerance, now);
      assert.strictEqual(res.valid, true, 'exact delta = 300s failed');
      assert.ok(res.skewSeconds !== undefined && Math.round(res.skewSeconds) === 300);
    });

    test('2.3 Exact boundary: delta = 301s (past) MUST fail', () => {
      const now = Date.now();
      const timestamp301 = now - 301 * 1000;
      const res = verifyAntiReplayTimestamp(timestamp301, tolerance, now);
      assert.strictEqual(res.valid, false, 'exact delta = 301s unexpectedly passed');
      assert.ok(res.skewSeconds !== undefined && Math.round(res.skewSeconds) === 301);
      assert.ok(res.reason?.includes('outside allowable anti-replay window'));
    });

    test('2.4 Exact boundary: delta = -299s (future) MUST pass', () => {
      const now = Date.now();
      const timestampFuture299 = now + 299 * 1000;
      const res = verifyAntiReplayTimestamp(timestampFuture299, tolerance, now);
      assert.strictEqual(res.valid, true, 'exact future delta = -299s failed');
      assert.ok(res.skewSeconds !== undefined && Math.round(res.skewSeconds) === 299);
    });

    test('2.5 Exact boundary: delta = -300s (future) MUST pass', () => {
      const now = Date.now();
      const timestampFuture300 = now + 300 * 1000;
      const res = verifyAntiReplayTimestamp(timestampFuture300, tolerance, now);
      assert.strictEqual(res.valid, true, 'exact future delta = -300s failed');
      assert.ok(res.skewSeconds !== undefined && Math.round(res.skewSeconds) === 300);
    });

    test('2.6 Exact boundary: delta = -301s (future) MUST fail', () => {
      const now = Date.now();
      const timestampFuture301 = now + 301 * 1000;
      const res = verifyAntiReplayTimestamp(timestampFuture301, tolerance, now);
      assert.strictEqual(res.valid, false, 'exact future delta = -301s unexpectedly passed');
      assert.ok(res.skewSeconds !== undefined && Math.round(res.skewSeconds) === 301);
      assert.ok(res.reason?.includes('outside allowable anti-replay window'));
    });

    test('2.7 Sub-second precision boundary (exact ms evaluation: 300,000ms vs 300,001ms)', () => {
      const now = Date.now();
      // Exactly 300,000ms skew (<= 300s)
      const exact300000ms = now - 300000;
      assert.strictEqual(verifyAntiReplayTimestamp(exact300000ms, tolerance, now).valid, true);

      // 300,001ms skew (300.001s > 300s)
      const exact300001ms = now - 300001;
      assert.strictEqual(verifyAntiReplayTimestamp(exact300001ms, tolerance, now).valid, false);
    });

    test('2.8 Epoch seconds integer truncation behavior (boundary analysis)', () => {
      const now = Date.now();
      // Safe inside window (250s ago in epoch seconds)
      const safeSec = Math.floor(now / 1000) - 250;
      assert.strictEqual(verifyAntiReplayTimestamp(safeSec, tolerance).valid, true);

      // Safe in future (250s in future in epoch seconds)
      const safeFutureSec = Math.floor(now / 1000) + 250;
      assert.strictEqual(verifyAntiReplayTimestamp(safeFutureSec, tolerance).valid, true);

      // ISO 8601 string within tolerance
      const isoStr = new Date(now - 120000).toISOString();
      assert.strictEqual(verifyAntiReplayTimestamp(isoStr, tolerance).valid, true);
    });

    test('2.9 Rejects malformed and adversarial timestamp headers', () => {
      assert.strictEqual(verifyAntiReplayTimestamp('', tolerance).valid, false);
      assert.strictEqual(verifyAntiReplayTimestamp('   ', tolerance).valid, false);
      assert.strictEqual(verifyAntiReplayTimestamp('not-a-timestamp', tolerance).valid, false);
      assert.strictEqual(verifyAntiReplayTimestamp('abc123xyz', tolerance).valid, false);
      assert.strictEqual(verifyAntiReplayTimestamp('NaN', tolerance).valid, false);
      assert.strictEqual(verifyAntiReplayTimestamp('null', tolerance).valid, false);
      assert.strictEqual(verifyAntiReplayTimestamp('undefined', tolerance).valid, false);
      assert.strictEqual(verifyAntiReplayTimestamp(null, tolerance).valid, false);
      assert.strictEqual(verifyAntiReplayTimestamp(undefined, tolerance).valid, false);
      assert.strictEqual(verifyAntiReplayTimestamp('Infinity', tolerance).valid, false);
      assert.strictEqual(verifyAntiReplayTimestamp('-Infinity', tolerance).valid, false);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Publish Gate 6-Dimensional Adversarial Evaluation
  // ---------------------------------------------------------------------------
  describe('3. CapabilityRegistry & Publish Gate 6 Dimensions', () => {
    let mockPool: ReturnType<typeof createMockChallengePool>;
    let uow: any;
    let registry: any;

    beforeEach(() => {
      mockPool = createMockChallengePool();
      uow = new TenantScopedUoW(mockPool as unknown as Pool);
      registry = new CapabilityRegistry(uow, { ttlMs: 10_000 });
    });

    test('3.1 Dimension 1 (Connection Health): Blocks down / needs_reauthorization connections', async () => {
      const downMatrix = createBaselineCapabilityMatrix({
        health: { status: 'down', lastCheckedAt: new Date().toISOString(), errorMessage: 'Meta Graph API Disconnected' },
      });
      await registry.saveSnapshot(10, downMatrix);

      const intent: PublishIntent = {
        messageKind: 'text',
        lastCustomerInteractionAt: new Date(),
        correlationId: 'corr-health-01',
      };

      const result = await registry.evaluatePublish(10, downMatrix.connectionId, intent);
      assert.strictEqual(result.permitted, false);
      if (!result.permitted) {
        assert.strictEqual(result.reasonCode, 'CHANNEL_UNHEALTHY');
        assert.ok(result.problemDetails.detail.includes('Meta Graph API Disconnected'));
      }

      await assert.rejects(
        async () => registry.assertCanPublish(10, downMatrix.connectionId, intent),
        (err: any) => err instanceof PublishGateError && err.code === 'CHANNEL_UNHEALTHY'
      );

      // Verify degraded status is permitted
      await registry.updateHealth(10, downMatrix.connectionId, {
        status: 'degraded',
        lastCheckedAt: new Date().toISOString(),
      });
      const degradedRes = await registry.evaluatePublish(10, downMatrix.connectionId, intent);
      assert.strictEqual(degradedRes.permitted, true);
    });

    test('3.2 Dimension 2 (Technical Feature Support): Blocks unsupported media kinds', async () => {
      const matrix = createBaselineCapabilityMatrix({
        features: {
          text: true,
          image: true,
          audio: false,
          video: false,
          document: false,
          template: true,
          interactive: false,
          reactions: false,
          typing: false,
          readReceipt: false,
        },
      });
      await registry.saveSnapshot(10, matrix);

      // Text allowed
      const textRes = await registry.evaluatePublish(10, matrix.connectionId, {
        messageKind: 'text',
        lastCustomerInteractionAt: new Date(),
        correlationId: 'corr-feat-01',
      });
      assert.strictEqual(textRes.permitted, true);

      // Video blocked
      const videoRes = await registry.evaluatePublish(10, matrix.connectionId, {
        messageKind: 'video',
        lastCustomerInteractionAt: new Date(),
        correlationId: 'corr-feat-02',
      });
      assert.strictEqual(videoRes.permitted, false);
      if (!videoRes.permitted) {
        assert.strictEqual(videoRes.reasonCode, 'CAPABILITY_UNSUPPORTED');
        assert.ok(videoRes.problemDetails.detail.includes("does not support 'video'"));
      }

      // Audio blocked
      const audioRes = await registry.evaluatePublish(10, matrix.connectionId, {
        messageKind: 'audio',
        lastCustomerInteractionAt: new Date(),
        correlationId: 'corr-feat-03',
      });
      assert.strictEqual(audioRes.permitted, false);
      if (!audioRes.permitted) {
        assert.strictEqual(audioRes.reasonCode, 'CAPABILITY_UNSUPPORTED');
      }

      // Document blocked via assertCanPublish
      await assert.rejects(
        async () => registry.assertCanPublish(10, matrix.connectionId, { messageKind: 'document', lastCustomerInteractionAt: new Date(), correlationId: 'corr-feat-04' }),
        (err: any) => err instanceof PublishGateError && err.code === 'CAPABILITY_UNSUPPORTED'
      );
    });

    test('3.3 Dimension 3 (Regional Restrictions): Blocks blacklisted country codes', async () => {
      const matrix = createBaselineCapabilityMatrix({
        regional: { blacklistedCountries: ['KP', 'SY', 'IR'] },
      });
      await registry.saveSnapshot(10, matrix);

      // Recipient in KP (uppercase)
      const kpRes = await registry.evaluatePublish(10, matrix.connectionId, {
        messageKind: 'text',
        recipientCountry: 'KP',
        lastCustomerInteractionAt: new Date(),
        correlationId: 'corr-reg-01',
      });
      assert.strictEqual(kpRes.permitted, false);
      if (!kpRes.permitted) {
        assert.strictEqual(kpRes.reasonCode, 'REGION_RESTRICTED');
        assert.ok(kpRes.problemDetails.detail.includes("country 'KP'"));
      }

      // Recipient in kp (lowercase case-insensitivity)
      const kpLowerRes = await registry.evaluatePublish(10, matrix.connectionId, {
        messageKind: 'text',
        recipientCountry: 'kp',
        lastCustomerInteractionAt: new Date(),
        correlationId: 'corr-reg-02',
      });
      assert.strictEqual(kpLowerRes.permitted, false);
      if (!kpLowerRes.permitted) {
        assert.strictEqual(kpLowerRes.reasonCode, 'REGION_RESTRICTED');
      }

      // Recipient in US (permitted)
      const usRes = await registry.evaluatePublish(10, matrix.connectionId, {
        messageKind: 'text',
        recipientCountry: 'US',
        lastCustomerInteractionAt: new Date(),
        correlationId: 'corr-reg-03',
      });
      assert.strictEqual(usRes.permitted, true);
    });

    test('3.4 Dimension 4 (Budget Exhaustion): Blocks messages exceeding monthly spend limit', async () => {
      const matrix = createBaselineCapabilityMatrix({
        budget: {
          tier: 'standard',
          costPerMessageCents: 10,
          monthlyBudgetLimitCents: 1000,
          currentMonthSpendCents: 995, // 995 + 10 = 1005 > 1000
        },
      });
      await registry.saveSnapshot(10, matrix);

      const res = await registry.evaluatePublish(10, matrix.connectionId, {
        messageKind: 'text',
        lastCustomerInteractionAt: new Date(),
        correlationId: 'corr-budget-01',
      });
      assert.strictEqual(res.permitted, false);
      if (!res.permitted) {
        assert.strictEqual(res.reasonCode, 'BUDGET_EXCEEDED');
        assert.ok(res.problemDetails.detail.includes('budget limit of 1000 cents reached'));
      }

      await assert.rejects(
        async () => registry.assertCanPublish(10, matrix.connectionId, { messageKind: 'text', lastCustomerInteractionAt: new Date(), correlationId: 'corr-budget-02' }),
        (err: any) => err instanceof PublishGateError && err.code === 'BUDGET_EXCEEDED'
      );

      // Within budget: spend 990 + 10 = 1000 <= 1000
      const withinBudgetMatrix = createBaselineCapabilityMatrix({
        budget: {
          tier: 'standard',
          costPerMessageCents: 10,
          monthlyBudgetLimitCents: 1000,
          currentMonthSpendCents: 990,
        },
      });
      await registry.saveSnapshot(10, withinBudgetMatrix);
      const withinRes = await registry.evaluatePublish(10, withinBudgetMatrix.connectionId, {
        messageKind: 'text',
        lastCustomerInteractionAt: new Date(),
        correlationId: 'corr-budget-03',
      });
      assert.strictEqual(withinRes.permitted, true);
    });

    test('3.5 Dimension 5 (Session Window / 24h WhatsApp Window): Policy enforcement and template bypass', async () => {
      const now = Date.now();
      const matrix = createBaselineCapabilityMatrix({
        policies: {
          sessionWindowHours: 24,
          requiresHsmTemplateOutsideWindow: true,
          requiresOptIn: true,
        },
      });
      await registry.saveSnapshot(10, matrix);

      // Scenario A: Inside window (last interaction 2 hours ago), non-template -> Permitted
      const insideRes = await registry.evaluatePublish(10, matrix.connectionId, {
        messageKind: 'text',
        isTemplate: false,
        lastCustomerInteractionAt: new Date(now - 2 * 3600 * 1000),
        correlationId: 'corr-win-01',
      });
      assert.strictEqual(insideRes.permitted, true);

      // Scenario B: Window open at 23.9 hours -> Permitted
      const borderInsideRes = await registry.evaluatePublish(10, matrix.connectionId, {
        messageKind: 'text',
        isTemplate: false,
        lastCustomerInteractionAt: new Date(now - 23.9 * 3600 * 1000),
        correlationId: 'corr-win-02',
      });
      assert.strictEqual(borderInsideRes.permitted, true);

      // Scenario C: Window expired at 24.1 hours, non-template -> Blocked with CH_WA_WINDOW_CLOSED
      const expiredRes = await registry.evaluatePublish(10, matrix.connectionId, {
        messageKind: 'text',
        isTemplate: false,
        lastCustomerInteractionAt: new Date(now - 24.1 * 3600 * 1000),
        correlationId: 'corr-win-03',
      });
      assert.strictEqual(expiredRes.permitted, false);
      if (!expiredRes.permitted) {
        assert.strictEqual(expiredRes.reasonCode, 'CH_WA_WINDOW_CLOSED');
        assert.ok(expiredRes.problemDetails.detail.includes('24h customer service window has expired'));
      }

      // Scenario D: Window expired, but WITH HSM template -> Permitted (bypasses window)
      const templateBypassRes = await registry.evaluatePublish(10, matrix.connectionId, {
        messageKind: 'template',
        isTemplate: true,
        lastCustomerInteractionAt: new Date(now - 72 * 3600 * 1000),
        correlationId: 'corr-win-04',
      });
      assert.strictEqual(templateBypassRes.permitted, true);

      // Scenario E: No interaction history at all, non-template -> Blocked
      const noHistoryRes = await registry.evaluatePublish(10, matrix.connectionId, {
        messageKind: 'text',
        isTemplate: false,
        lastCustomerInteractionAt: undefined,
        correlationId: 'corr-win-05',
      });
      assert.strictEqual(noHistoryRes.permitted, false);
      if (!noHistoryRes.permitted) {
        assert.strictEqual(noHistoryRes.reasonCode, 'CH_WA_WINDOW_CLOSED');
      }

      // Scenario F: Adversarial check — Malformed date string behavior
      // In evaluatePublishGate, new Date('malformed-date').getTime() results in NaN.
      // Hardened fail-closed defense rejects non-finite timestamps with CH_WA_WINDOW_CLOSED.
      const malformedDateRes = await registry.evaluatePublish(10, matrix.connectionId, {
        messageKind: 'text',
        isTemplate: false,
        lastCustomerInteractionAt: 'invalid-non-iso-timestamp',
        correlationId: 'corr-win-06',
      });
      // We empirically verify fail-closed defense is enforced:
      assert.strictEqual(malformedDateRes.permitted, false, 'Fail-closed verification: malformed date string is rejected');
      if (!malformedDateRes.permitted) {
        assert.strictEqual(malformedDateRes.reasonCode, 'CH_WA_WINDOW_CLOSED');
      }
    });

    test('3.6 Dimension 6 (Dynamic Connection Snapshot & Registry Lifecycle)', async () => {
      // Non-existent connectionId
      const missingRes = await registry.evaluatePublish(10, 'non-existent-conn', {
        messageKind: 'text',
        correlationId: 'corr-reg-01',
      });
      assert.strictEqual(missingRes.permitted, false);
      if (!missingRes.permitted) {
        assert.strictEqual(missingRes.reasonCode, 'CAPABILITY_UNSUPPORTED');
        assert.strictEqual(missingRes.problemDetails.status, 404);
      }

      await assert.rejects(
        async () => registry.assertCanPublish(10, 'non-existent-conn', { messageKind: 'text', correlationId: 'corr-reg-02' }),
        (err: any) => err instanceof PublishGateError && err.code === 'CAPABILITY_UNSUPPORTED'
      );

      // Invalidate cache and re-fetch
      const matrix = createBaselineCapabilityMatrix();
      await registry.saveSnapshot(10, matrix);
      registry.invalidateCache(10, matrix.connectionId);
      const snapshot = await registry.getSnapshot(10, matrix.connectionId);
      assert.ok(snapshot !== null);
      assert.strictEqual(snapshot.connectionId, matrix.connectionId);
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Express Middleware End-to-End Integration
  // ---------------------------------------------------------------------------
  describe('4. Webhook Idempotency Middleware Adversarial Ingress', () => {
    let mockPool: ReturnType<typeof createMockChallengePool>;
    let uow: any;
    let outboxRepo: any;
    let middleware: any;

    beforeEach(() => {
      mockPool = createMockChallengePool();
      uow = new TenantScopedUoW(mockPool as unknown as Pool);
      outboxRepo = new OutboxRepository(uow);
      middleware = createWebhookIdempotencyMiddleware({
        secret,
        uow,
        outboxRepo,
        toleranceSeconds: 300,
        requireTimestamp: true,
      });
    });

    test('4.1 Rejects ingress with 401 on forged signature', async () => {
      let statusCode = 0;
      let responseJson: any = null;

      const req: any = {
        method: 'POST',
        url: '/webhooks/whatsapp',
        headers: {
          'x-hub-signature-256': 'sha256=1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
          'x-timestamp': String(Math.floor(Date.now() / 1000)),
          'x-tenant-id': '10',
        },
        body: { id: 'wamid.12345' },
        rawBody: Buffer.from(JSON.stringify({ id: 'wamid.12345' })),
      };

      const res: any = {
        status(code: number) {
          statusCode = code;
          return this;
        },
        json(payload: any) {
          responseJson = payload;
          return this;
        },
      };

      await middleware(req, res, () => {});
      assert.strictEqual(statusCode, 401);
      assert.strictEqual(responseJson.code, StandardErrorCode.UNAUTHORIZED);
    });

    test('4.2 Rejects ingress with 400 on timestamp skew exceeding 300s', async () => {
      let statusCode = 0;
      let responseJson: any = null;

      const body = { id: 'wamid.12345' };
      const rawBody = Buffer.from(JSON.stringify(body));
      const validSig = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
      const expiredTimestamp = String(Date.now() - 305 * 1000);

      const req: any = {
        method: 'POST',
        url: '/webhooks/whatsapp',
        headers: {
          'x-hub-signature-256': validSig,
          'x-timestamp': expiredTimestamp,
          'x-tenant-id': '10',
        },
        body,
        rawBody,
      };

      const res: any = {
        status(code: number) {
          statusCode = code;
          return this;
        },
        json(payload: any) {
          responseJson = payload;
          return this;
        },
      };

      await middleware(req, res, () => {});
      assert.strictEqual(statusCode, 400);
      assert.strictEqual(responseJson.code, StandardErrorCode.VALIDATION_ERROR);
    });

    test('4.3 Enqueues valid webhook to outbox and idempotently deduplicates repeated delivery', async () => {
      let statusCode = 0;
      let responseJson: any = null;

      const body = { id: 'wamid.first.delivery', text: 'Order confirm' };
      const rawBody = Buffer.from(JSON.stringify(body));
      const validSig = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
      const validTimestamp = String(Date.now());

      const req: any = {
        method: 'POST',
        url: '/webhooks/whatsapp',
        headers: {
          'x-hub-signature-256': validSig,
          'x-timestamp': validTimestamp,
          'x-tenant-id': '10',
          'x-idempotency-key': 'key-webhook-unique-01',
        },
        body,
        rawBody,
      };

      const res: any = {
        status(code: number) {
          statusCode = code;
          return this;
        },
        json(payload: any) {
          responseJson = payload;
          return this;
        },
      };

      // First delivery: Enqueued
      await middleware(req, res, () => {});
      assert.strictEqual(statusCode, 200);
      assert.strictEqual(responseJson.status, 'accepted');
      assert.strictEqual(mockPool.tables.processing_outbox.length, 1);
      assert.strictEqual(mockPool.tables.idempotency_ledger.length, 1);

      // Replay delivery with identical idempotency key: Returns duplicate, outbox count remains 1
      statusCode = 0;
      responseJson = null;
      await middleware(req, res, () => {});
      assert.strictEqual(statusCode, 200);
      assert.strictEqual(mockPool.tables.processing_outbox.length, 1, 'Duplicate request enqueued extra outbox record!');
    });
  });
});
