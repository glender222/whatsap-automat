// Invariants before config load
process.env.JWT_SECRET = 'test-only-jwt-secret-with-at-least-32-characters-for-testing';
process.env.DB_PASSWORD = 'test-only-database-password';

import assert from 'node:assert/strict';
import { describe, test, beforeEach } from 'node:test';
import crypto from 'node:crypto';
import type { Pool, PoolClient, QueryResult } from 'pg';

import {
  channelEventV1Schema,
  SendMessageCommandV1,
  InboundConnectionResolutionRequest,
  ChannelCapabilityMatrix,
  evaluatePublishGate,
} from '@whatsap-automat/contracts';

const { TenantScopedUoW } = require('../db/TenantScopedUoW') as typeof import('../db/TenantScopedUoW');
const { CapabilityRegistry, PublishGateError } = require('../services/channels/CapabilityRegistry') as typeof import('../services/channels/CapabilityRegistry');
const { verifyWebhookHmac, verifyAntiReplayTimestamp } = require('../middleware/webhookIdempotency') as typeof import('../middleware/webhookIdempotency');
const { MetaCloudAdapter } = require('../services/channels/MetaCloudAdapter') as typeof import('../services/channels/MetaCloudAdapter');

// -----------------------------------------------------------------------------
// Mock Pool for Adversarial Harness
// -----------------------------------------------------------------------------
function createAdversarialMockPool() {
  const channelConnections = [
    {
      id: 'conn-wa-01',
      tenant_id: 1,
      workspace_id: 1,
      channel: 'whatsapp-cloud',
      account_id: 'wa-phone-100',
      name: 'WhatsApp Test',
      status: 'active',
      credentials_encrypted: { accessToken: 'valid-wa-token', appSecret: 'super-secret-key-123' },
      metadata_json: {},
    },
    {
      id: 'conn-wa-inactive',
      tenant_id: 1,
      workspace_id: 1,
      channel: 'whatsapp-cloud',
      account_id: 'wa-phone-inactive',
      name: 'WhatsApp Inactive',
      status: 'inactive',
      credentials_encrypted: { accessToken: 'inactive-token', appSecret: 'super-secret-key-123' },
      metadata_json: {},
    },
    {
      id: 'conn-ig-01',
      tenant_id: 1,
      workspace_id: 1,
      channel: 'instagram',
      account_id: 'ig-account-200',
      name: 'Instagram Test',
      status: 'active',
      credentials_encrypted: { accessToken: 'valid-ig-token', appSecret: 'super-secret-key-123' },
      metadata_json: {},
    },
  ];

  const capabilitySnapshots: { tenant_id: number; connection_id: string; matrix: any }[] = [];

  const mockPool = {
    tables: {
      channel_connections: channelConnections,
      channel_capabilities_snapshots: capabilitySnapshots,
    },
    async query(text: string | { text: string; values?: unknown[] }, values?: unknown[]): Promise<QueryResult<any>> {
      const client = await mockPool.connect();
      try {
        return await client.query(text, values);
      } finally {
        client.release();
      }
    },
    async connect(): Promise<PoolClient> {
      let sessionTenantId: number | null = null;
      const client: Partial<PoolClient> = {
        query: async (text: string | { text: string; values?: unknown[] }, values?: unknown[]): Promise<QueryResult<any>> => {
          const sql = (typeof text === 'string' ? text : text.text).trim();
          const sqlValues = typeof text === 'string' ? values || [] : text.values || [];

          if (sql.toUpperCase().startsWith('SET LOCAL APP.CURRENT_TENANT_ID')) {
            const m = sql.match(/'(\d+)'/);
            sessionTenantId = m ? parseInt(m[1], 10) : null;
            return { rows: [], rowCount: 0, command: 'SET', oid: 0, fields: [] };
          }

          if (sql.includes('channel_connections')) {
            if (sql.toUpperCase().startsWith('SELECT')) {
              let rows = channelConnections;
              if (sessionTenantId !== null) {
                rows = rows.filter((r) => r.tenant_id === sessionTenantId);
              }
              if (sql.includes('status <> \'inactive\'')) {
                rows = rows.filter((r) => r.status !== 'inactive');
              }
              if (sql.includes('account_id = $') || sql.includes('account_id =')) {
                const targetAccount = String(sqlValues[0]);
                rows = rows.filter((r) => r.account_id === targetAccount);
              } else if (sql.includes('WHERE id = $') || sql.includes('id = $')) {
                const targetId = String(sqlValues[0]);
                rows = rows.filter((r) => r.id === targetId);
              }
              return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] };
            }
          }

          if (sql.includes('channel_capabilities_snapshots')) {
            if (sql.toUpperCase().startsWith('INSERT')) {
              const parsedMatrix = typeof sqlValues[3] === 'string' ? JSON.parse(sqlValues[3]) : sqlValues[3];
              const existingIdx = capabilitySnapshots.findIndex(
                (s) => s.tenant_id === Number(sqlValues[0]) && s.connection_id === String(sqlValues[1])
              );
              if (existingIdx >= 0) {
                capabilitySnapshots[existingIdx] = {
                  tenant_id: Number(sqlValues[0]),
                  connection_id: String(sqlValues[1]),
                  matrix: parsedMatrix,
                };
              } else {
                capabilitySnapshots.push({
                  tenant_id: Number(sqlValues[0]),
                  connection_id: String(sqlValues[1]),
                  matrix: parsedMatrix,
                });
              }
              return { rows: [], rowCount: 1, command: 'INSERT', oid: 0, fields: [] };
            }
            if (sql.toUpperCase().startsWith('SELECT')) {
              const targetConn = String(sqlValues[1]);
              const found = capabilitySnapshots.filter((r) => r.connection_id === targetConn);
              return { rows: found, rowCount: found.length, command: 'SELECT', oid: 0, fields: [] };
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

const baseWaMatrix: ChannelCapabilityMatrix = {
  connectionId: 'conn-wa-01',
  tenantId: '1',
  channel: 'whatsapp-cloud',
  features: {
    text: true,
    image: true,
    audio: true,
    video: true,
    document: true,
    template: true,
    interactive: true,
    reactions: true,
    typing: true,
    readReceipt: true,
  },
  scopes: ['whatsapp_business_messaging'],
  policies: {
    sessionWindowHours: 24,
    requiresHsmTemplateOutsideWindow: true,
    rateLimitPerMinute: 300,
    requiresOptIn: false,
  },
  health: {
    status: 'healthy',
    lastCheckedAt: new Date().toISOString(),
    latencyMs: 50,
  },
  budget: {
    tier: 'standard',
    costPerMessageCents: 5,
    monthlyBudgetLimitCents: 50000,
    currentMonthSpendCents: 1000,
  },
  regional: {
    blacklistedCountries: ['KP', 'SY', 'IR'],
  },
  updatedAt: new Date().toISOString(),
};

describe('Empirical Adversarial Stress Harness: MetaCloudAdapter', () => {
  const APP_SECRET = 'super-secret-key-123';
  let mockPool: any;
  let adapter: any;
  let uow: any;
  let registry: any;

  beforeEach(async () => {
    mockPool = createAdversarialMockPool();
    uow = new TenantScopedUoW(mockPool as unknown as Pool);
    registry = new CapabilityRegistry(uow);
    await registry.saveSnapshot(1, baseWaMatrix);

    adapter = new MetaCloudAdapter({
      kind: 'whatsapp-cloud',
      pool: mockPool,
      capabilityRegistry: registry,
      appSecret: APP_SECRET,
      webhookVerifyToken: 'verify-token-xyz',
    });
  });

  // ---------------------------------------------------------------------------
  // 1. Webhook Replay & Timestamp Drift Boundary & Extreme Attacks
  // ---------------------------------------------------------------------------
  describe('Suite 1: Webhook Replay & Timestamp Drift Boundary & Extreme Attacks', () => {
    const rawBody = Buffer.from('{"test":"payload"}');
    const validHmac = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(rawBody).digest('hex');

    test('1.1 Boundary: drift = +299s (in the past, within 300s window) is ACCEPTED', async () => {
      const tsPast299 = Math.floor(Date.now() / 1000) - 299;
      const valid = await adapter.verifyInbound('conn-wa-01', rawBody, {
        'x-hub-signature-256': validHmac,
        'x-timestamp': String(tsPast299),
      });
      assert.strictEqual(valid, true);
    });

    test('1.2 Boundary: drift = +300s exact window edge (now - 300 * 1000) is ACCEPTED', async () => {
      const now = Date.now();
      const res = verifyAntiReplayTimestamp(now - 300 * 1000, 300);
      assert.strictEqual(res.valid, true);
    });

    test('1.3 Boundary: drift = +301s (past expired window) is REJECTED', async () => {
      const tsPast301 = Math.floor(Date.now() / 1000) - 301;
      const valid = await adapter.verifyInbound('conn-wa-01', rawBody, {
        'x-hub-signature-256': validHmac,
        'x-timestamp': String(tsPast301),
      });
      assert.strictEqual(valid, false);
    });

    test('1.4 Boundary: drift = -299s (in the future, within 300s clock skew) is ACCEPTED', async () => {
      const tsFuture299 = Math.floor(Date.now() / 1000) + 299;
      const valid = await adapter.verifyInbound('conn-wa-01', rawBody, {
        'x-hub-signature-256': validHmac,
        'x-timestamp': String(tsFuture299),
      });
      assert.strictEqual(valid, true);
    });

    test('1.5 Boundary: drift = -301s (future outside allowable skew) is REJECTED', async () => {
      const tsFuture301 = Math.floor(Date.now() / 1000) + 301;
      const valid = await adapter.verifyInbound('conn-wa-01', rawBody, {
        'x-hub-signature-256': validHmac,
        'x-timestamp': String(tsFuture301),
      });
      assert.strictEqual(valid, false);
    });

    test('1.6 Extreme: Far past timestamp (unix epoch 0, 1970) is REJECTED', async () => {
      const valid = await adapter.verifyInbound('conn-wa-01', rawBody, {
        'x-hub-signature-256': validHmac,
        'x-timestamp': '0',
      });
      assert.strictEqual(valid, false);
    });

    test('1.7 Extreme: Far future timestamp (year 2050, 2524608000) is REJECTED', async () => {
      const valid = await adapter.verifyInbound('conn-wa-01', rawBody, {
        'x-hub-signature-256': validHmac,
        'x-timestamp': '2524608000',
      });
      assert.strictEqual(valid, false);
    });

    test('1.8 Extreme: Negative timestamp (-50000) is REJECTED', async () => {
      const valid = await adapter.verifyInbound('conn-wa-01', rawBody, {
        'x-hub-signature-256': validHmac,
        'x-timestamp': '-50000',
      });
      assert.strictEqual(valid, false);
    });

    test('1.9 Extreme: Non-numeric strings (NaN, undefined, null, DROP TABLE) are REJECTED', async () => {
      const attackStrings = ['NaN', 'undefined', 'null', 'not_a_date', "'; DROP TABLE channel_connections; --", 'abc123xyz'];
      for (const atk of attackStrings) {
        const valid = await adapter.verifyInbound('conn-wa-01', rawBody, {
          'x-hub-signature-256': validHmac,
          'x-timestamp': atk,
        });
        assert.strictEqual(valid, false, `Expected rejection for malicious timestamp: ${atk}`);
      }
    });

    test('1.10 Format: Milliseconds format within window is ACCEPTED, outside is REJECTED', async () => {
      const nowMs = Date.now();
      const validMs = await adapter.verifyInbound('conn-wa-01', rawBody, {
        'x-hub-signature-256': validHmac,
        'x-timestamp': String(nowMs - 5000), // 5 seconds ago in ms
      });
      assert.strictEqual(validMs, true);

      const invalidMs = await adapter.verifyInbound('conn-wa-01', rawBody, {
        'x-hub-signature-256': validHmac,
        'x-timestamp': String(nowMs - 500000), // 500 seconds ago in ms
      });
      assert.strictEqual(invalidMs, false);
    });

    test('1.11 Format: ISO 8601 strings within window are ACCEPTED, outside are REJECTED', async () => {
      const freshIso = new Date(Date.now() - 30 * 1000).toISOString();
      const validIso = await adapter.verifyInbound('conn-wa-01', rawBody, {
        'x-hub-signature-256': validHmac,
        'x-timestamp': freshIso,
      });
      assert.strictEqual(validIso, true);

      const staleIso = new Date(Date.now() - 600 * 1000).toISOString();
      const invalidIso = await adapter.verifyInbound('conn-wa-01', rawBody, {
        'x-hub-signature-256': validHmac,
        'x-timestamp': staleIso,
      });
      assert.strictEqual(invalidIso, false);
    });

    test('1.12 Header alias: x-hub-timestamp is supported interchangeably with x-timestamp', async () => {
      const tsPast350 = Math.floor(Date.now() / 1000) - 350;
      const valid = await adapter.verifyInbound('conn-wa-01', rawBody, {
        'x-hub-signature-256': validHmac,
        'x-hub-timestamp': String(tsPast350),
      });
      assert.strictEqual(valid, false);
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Bit-Flipped HMAC Signatures & Cryptographic Attacks
  // ---------------------------------------------------------------------------
  describe('Suite 2: Bit-Flipped HMAC Signatures & Cryptographic Attacks', () => {
    const rawBody = Buffer.from('{"entry":[{"changes":[{"value":{"messages":[{"text":{"body":"Adversarial test"}}]}}]}]}');
    const genuineDigest = crypto.createHmac('sha256', APP_SECRET).update(rawBody).digest('hex');

    test('2.1 Bit-flip attack: 1-bit flip in first byte is REJECTED', async () => {
      const firstChar = genuineDigest[0];
      const flippedChar = firstChar === '0' ? '1' : '0';
      const bitFlippedSig = 'sha256=' + flippedChar + genuineDigest.slice(1);

      const valid = await adapter.verifyInbound('conn-wa-01', rawBody, {
        'x-hub-signature-256': bitFlippedSig,
      });
      assert.strictEqual(valid, false);
    });

    test('2.2 Bit-flip attack: 1-bit flip in middle byte (index 32) is REJECTED', async () => {
      const midChar = genuineDigest[32];
      const flippedChar = midChar === '0' ? '1' : '0';
      const bitFlippedSig = 'sha256=' + genuineDigest.slice(0, 32) + flippedChar + genuineDigest.slice(33);

      const valid = await adapter.verifyInbound('conn-wa-01', rawBody, {
        'x-hub-signature-256': bitFlippedSig,
      });
      assert.strictEqual(valid, false);
    });

    test('2.3 Bit-flip attack: 1-bit flip in last byte (index 63) is REJECTED', async () => {
      const lastChar = genuineDigest[63];
      const flippedChar = lastChar === '0' ? '1' : '0';
      const bitFlippedSig = 'sha256=' + genuineDigest.slice(0, 63) + flippedChar;

      const valid = await adapter.verifyInbound('conn-wa-01', rawBody, {
        'x-hub-signature-256': bitFlippedSig,
      });
      assert.strictEqual(valid, false);
    });

    test('2.4 Length attack: Truncated signatures (63, 32, 16, 0 hex chars) are REJECTED', async () => {
      const truncatedLengths = [63, 32, 16, 8, 1, 0];
      for (const len of truncatedLengths) {
        const truncSig = 'sha256=' + genuineDigest.slice(0, len);
        const valid = await adapter.verifyInbound('conn-wa-01', rawBody, {
          'x-hub-signature-256': truncSig,
        });
        assert.strictEqual(valid, false, `Expected rejection for truncated length ${len}`);
      }
    });

    test('2.5 Length attack: Lengthened signatures (65, 128 chars) are REJECTED', async () => {
      const lengthenedLengths = [65, 128];
      for (const len of lengthenedLengths) {
        const extendedSig = 'sha256=' + genuineDigest.padEnd(len, '0');
        const valid = await adapter.verifyInbound('conn-wa-01', rawBody, {
          'x-hub-signature-256': extendedSig,
        });
        assert.strictEqual(valid, false, `Expected rejection for extended length ${len}`);
      }
    });

    test('2.6 Character set attack: Non-hex characters (g-z, punctuation, spaces) are REJECTED', async () => {
      const corruptedSigs = [
        'sha256=' + genuineDigest.slice(0, 60) + 'zzzz',
        'sha256=' + genuineDigest.slice(0, 60) + 'gggg',
        'sha256=' + genuineDigest.slice(0, 60) + '!!!!',
        'sha256=' + genuineDigest.slice(0, 60) + '    ',
        'sha256=null',
        'sha256=undefined',
      ];
      for (const sig of corruptedSigs) {
        const valid = await adapter.verifyInbound('conn-wa-01', rawBody, {
          'x-hub-signature-256': sig,
        });
        assert.strictEqual(valid, false, `Expected rejection for non-hex signature: ${sig}`);
      }
    });

    test('2.7 Case insensitivity: Uppercase hex characters in signature are ACCEPTED', async () => {
      const upperSig = 'sha256=' + genuineDigest.toUpperCase();
      const valid = await adapter.verifyInbound('conn-wa-01', rawBody, {
        'x-hub-signature-256': upperSig,
      });
      assert.strictEqual(valid, true);
    });

    test('2.8 Whitespace handling: Leading/trailing whitespace in signature header is handled', async () => {
      const paddedSig = '  sha256=' + genuineDigest + '  \t';
      const valid = await adapter.verifyInbound('conn-wa-01', rawBody, {
        'x-hub-signature-256': paddedSig,
      });
      assert.strictEqual(valid, true);
    });

    test('2.9 Header injection: Null bytes or newline characters in signature are REJECTED', async () => {
      const injectedSigs = [
        'sha256=' + genuineDigest.slice(0, 30) + '\0' + genuineDigest.slice(31),
        'sha256=' + genuineDigest + '\r\nSet-Cookie: evil=true',
      ];
      for (const sig of injectedSigs) {
        const valid = await adapter.verifyInbound('conn-wa-01', rawBody, {
          'x-hub-signature-256': sig,
        });
        assert.strictEqual(valid, false);
      }
    });

    test('2.10 Empty payload: Zero-byte buffer with correct empty HMAC is ACCEPTED', async () => {
      const emptyBuf = Buffer.from('');
      const emptyHmac = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(emptyBuf).digest('hex');
      const valid = await adapter.verifyInbound('conn-wa-01', emptyBuf, {
        'x-hub-signature-256': emptyHmac,
      });
      assert.strictEqual(valid, true);
    });

    test('2.11 Large payload: 1MB payload HMAC verification executes without error', async () => {
      const largeBuf = Buffer.alloc(1024 * 1024, 'x');
      const largeHmac = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(largeBuf).digest('hex');
      const valid = await adapter.verifyInbound('conn-wa-01', largeBuf, {
        'x-hub-signature-256': largeHmac,
      });
      assert.strictEqual(valid, true);
    });

    test('2.12 Resilience: verifyInbound returns false on undefined rawBody', async () => {
      const valid = await adapter.verifyInbound('conn-wa-01', undefined as any, { 'x-hub-signature-256': 'sha256=123' });
      assert.strictEqual(valid, false);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Malformed & Edge-Case Payload Ingestion (Crash Resilience)
  // ---------------------------------------------------------------------------
  describe('Suite 3: Malformed & Edge-Case Payload Ingestion (Crash Resilience)', () => {
    test('3.1 Truncated JSON string degrades cleanly to empty array', async () => {
      const truncated = '{"object":"whatsapp_business_account","entry":[{"changes":[';
      const events = await adapter.normalizeInbound('conn-wa-01', truncated);
      assert.deepStrictEqual(events, []);
    });

    test('3.2 Non-JSON binary data degrades cleanly to empty array', async () => {
      const garbage = Buffer.from([0x00, 0xff, 0xfe, 0x12, 0x89, 0xaa]);
      const events = await adapter.normalizeInbound('conn-wa-01', garbage);
      assert.deepStrictEqual(events, []);
    });

    test('3.3 HTML error page payload degrades cleanly to empty array', async () => {
      const html502 = '<html><body>502 Bad Gateway</body></html>';
      const events = await adapter.normalizeInbound('conn-wa-01', html502);
      assert.deepStrictEqual(events, []);
    });

    test('3.4 Primitive inputs (null, undefined, number, boolean, array) degrade cleanly to empty array', async () => {
      const primitives = [null, undefined, 12345, true, false, [], [1, 2, 3]];
      for (const p of primitives) {
        const events = await adapter.normalizeInbound('conn-wa-01', p);
        assert.deepStrictEqual(events, [], `Expected empty array for input: ${JSON.stringify(p)}`);
      }
    });

    test('3.5 Empty objects and missing entry/changes degrade cleanly', async () => {
      const edgeObjects = [
        {},
        { object: 'whatsapp_business_account' },
        { object: 'whatsapp_business_account', entry: [] },
        { object: 'whatsapp_business_account', entry: [{}] },
        { object: 'whatsapp_business_account', entry: [{ changes: [] }] },
        { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'other_field' }] }] },
        { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages' }] }] },
        { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: null }] }] },
        { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: {} }] }] },
        { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { messages: [] } }] }] },
        { object: 'instagram' },
        { object: 'instagram', entry: [] },
        { object: 'instagram', entry: [{}] },
        { object: 'instagram', entry: [{ messaging: [] }] },
        { object: 'instagram', entry: [{ changes: [] }] },
      ];

      for (const obj of edgeObjects) {
        const events = await adapter.normalizeInbound('conn-wa-01', obj);
        assert.deepStrictEqual(events, [], `Expected empty array for object: ${JSON.stringify(obj)}`);
      }
    });

    test('3.6 WhatsApp unexpected message types (reaction, location, contacts, order, sticker)', async () => {
      const payloadWithDiverseTypes = {
        object: 'whatsapp_business_account',
        entry: [
          {
            changes: [
              {
                field: 'messages',
                value: {
                  messages: [
                    {
                      id: 'wamid_sticker_1',
                      from: '573001234567',
                      timestamp: '1700000000',
                      type: 'sticker',
                      sticker: { id: 'stk_1', mime_type: 'image/webp' },
                    },
                    {
                      id: 'wamid_location_2',
                      from: '573001234567',
                      timestamp: '1700000000',
                      type: 'location',
                      location: { latitude: 4.6097, longitude: -74.0817 },
                    },
                    {
                      id: 'wamid_reaction_3',
                      from: '573001234567',
                      timestamp: '1700000000',
                      type: 'reaction',
                      reaction: { message_id: 'target_msg', emoji: '👍' },
                    },
                    {
                      id: 'wamid_unknown_4',
                      from: '573001234567',
                      timestamp: '1700000000',
                      type: 'something_unforeseen_in_future_api',
                    },
                  ],
                },
              },
            ],
          },
        ],
      };

      const events = await adapter.normalizeInbound('conn-wa-01', payloadWithDiverseTypes);
      assert.strictEqual(events.length, 4);
      assert.strictEqual(events[0].payload.kind, 'message');
      assert.strictEqual((events[0].payload.data as any).kind, 'media');
      assert.strictEqual((events[0].payload.data as any).media.mimeType, 'image/webp');

      for (const ev of events) {
        const parsed = channelEventV1Schema.safeParse(ev);
        assert.strictEqual(parsed.success, true, `Event validation failed: ${JSON.stringify(parsed)}`);
      }
    });

    test('3.7 WhatsApp status receipt edge cases (missing errors, empty strings)', async () => {
      const payloadStatuses = {
        object: 'whatsapp_business_account',
        entry: [
          {
            changes: [
              {
                field: 'messages',
                value: {
                  statuses: [
                    {
                      id: 'wamid_st_1',
                      recipient_id: '573001234567',
                      status: 'failed',
                      timestamp: '1700000000',
                      errors: [],
                    },
                    {
                      id: 'wamid_st_2',
                      recipient_id: '573001234567',
                      status: 'sent',
                      timestamp: '1700000000',
                      errors: undefined,
                    },
                  ],
                },
              },
            ],
          },
        ],
      };

      const events = await adapter.normalizeInbound('conn-wa-01', payloadStatuses);
      assert.strictEqual(events.length, 2);
      assert.strictEqual(channelEventV1Schema.safeParse(events[0]).success, true);
      assert.strictEqual(channelEventV1Schema.safeParse(events[1]).success, true);
    });

    test('3.8 Instagram DM with missing message text and attachments degrades cleanly', async () => {
      const igPayload = {
        object: 'instagram',
        entry: [
          {
            id: 'ig-account-200',
            messaging: [
              {
                sender: { id: 'ig-user-1' },
                recipient: { id: 'ig-account-200' },
                timestamp: 1700000000000,
                message: {
                  mid: 'mid_empty_msg',
                },
              },
            ],
          },
        ],
      };

      const igAdapter = new MetaCloudAdapter({ kind: 'instagram', pool: mockPool, appSecret: APP_SECRET });
      const events = await igAdapter.normalizeInbound('conn-ig-01', igPayload);
      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0].payload.kind, 'message');
      assert.strictEqual(channelEventV1Schema.safeParse(events[0]).success, true);
    });

    // -------------------------------------------------------------------------
    // EMPIRICALLY CONFIRMED CRASH VECTORS IN NORMALIZEINBOUND
    // -------------------------------------------------------------------------
    test('3.9 Resilience: Null elements in WhatsApp entry array degrades cleanly to empty array', async () => {
      const maliciousPayload = { object: 'whatsapp_business_account', entry: [null] };
      const events = await adapter.normalizeInbound('conn-wa-01', maliciousPayload);
      assert.deepStrictEqual(events, []);
    });

    test('3.10 Resilience: Null elements in changes array degrades cleanly to empty array', async () => {
      const maliciousPayload = { object: 'whatsapp_business_account', entry: [{ changes: [null] }] };
      const events = await adapter.normalizeInbound('conn-wa-01', maliciousPayload);
      assert.deepStrictEqual(events, []);
    });

    test('3.11 Resilience: Null elements in messages array degrades cleanly to empty array', async () => {
      const maliciousPayload = {
        object: 'whatsapp_business_account',
        entry: [{ changes: [{ field: 'messages', value: { messages: [null] } }] }],
      };
      const events = await adapter.normalizeInbound('conn-wa-01', maliciousPayload);
      assert.deepStrictEqual(events, []);
    });

    test('3.12 Resilience: Malformed non-numeric timestamp string falls back to valid ISO timestamp', async () => {
      const maliciousPayload = {
        object: 'whatsapp_business_account',
        entry: [
          {
            changes: [
              {
                field: 'messages',
                value: {
                  messages: [
                    {
                      id: 'wamid_bad_ts',
                      from: '573001234567',
                      type: 'text',
                      timestamp: 'invalid-date-string',
                      text: { body: 'hello' },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };
      const events = await adapter.normalizeInbound('conn-wa-01', maliciousPayload);
      assert.strictEqual(events.length, 1);
      assert.strictEqual(typeof events[0].occurredAt, 'string');
      assert.doesNotThrow(() => channelEventV1Schema.parse(events[0]));
    });

    test('3.13 Resilience: Null elements in Instagram entry / messaging degrades cleanly to empty array', async () => {
      const igAdapter = new MetaCloudAdapter({ kind: 'instagram', pool: mockPool, appSecret: APP_SECRET });
      const maliciousPayload = {
        object: 'instagram',
        entry: [null],
      };
      const events = await igAdapter.normalizeInbound('conn-ig-01', maliciousPayload);
      assert.deepStrictEqual(events, []);
    });

    test('3.14 Resilience: Malformed watermark in Instagram delivery/read falls back cleanly', async () => {
      const igAdapter = new MetaCloudAdapter({ kind: 'instagram', pool: mockPool, appSecret: APP_SECRET });
      const maliciousPayload = {
        object: 'instagram',
        entry: [
          {
            id: 'ig-account-200',
            messaging: [
              {
                sender: { id: 'ig-user-1' },
                recipient: { id: 'ig-account-200' },
                delivery: { watermark: 'not-a-number' },
              },
            ],
          },
        ],
      };
      const events = await igAdapter.normalizeInbound('conn-ig-01', maliciousPayload);
      assert.strictEqual(events.length, 1);
      assert.doesNotThrow(() => channelEventV1Schema.parse(events[0]));
    });

    test('3.15 Resilience: Malformed created_time in Instagram comments falls back cleanly', async () => {
      const igAdapter = new MetaCloudAdapter({ kind: 'instagram', pool: mockPool, appSecret: APP_SECRET });
      const maliciousPayload = {
        object: 'instagram',
        entry: [
          {
            id: 'ig-account-200',
            changes: [
              {
                field: 'comments',
                value: {
                  id: 'comment-123',
                  created_time: 'invalid-timestamp',
                },
              },
            ],
          },
        ],
      };
      const events = await igAdapter.normalizeInbound('conn-ig-01', maliciousPayload);
      assert.strictEqual(events.length, 1);
      assert.doesNotThrow(() => channelEventV1Schema.parse(events[0]));
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Tenancy Resolution & Fail-Closed Boundaries (MSG-05)
  // ---------------------------------------------------------------------------
  describe('Suite 4: Tenancy Resolution & Fail-Closed Boundaries (MSG-05)', () => {
    test('4.1 Unmapped WhatsApp phone_number_id fails closed (returns null)', async () => {
      const req: InboundConnectionResolutionRequest = {
        path: '/webhook',
        headers: {},
        rawBody: Buffer.from(
          JSON.stringify({
            object: 'whatsapp_business_account',
            entry: [{ changes: [{ value: { metadata: { phone_number_id: 'wa-unknown-99999' } } }] }],
          })
        ),
      };
      const res = await adapter.resolveInboundConnection(req);
      assert.strictEqual(res, null);
    });

    test('4.2 Inactive connection in database fails closed (returns null)', async () => {
      const req: InboundConnectionResolutionRequest = {
        path: '/webhook',
        headers: {},
        rawBody: Buffer.from(
          JSON.stringify({
            object: 'whatsapp_business_account',
            entry: [{ changes: [{ value: { metadata: { phone_number_id: 'wa-phone-inactive' } } }] }],
          })
        ),
      };
      const res = await adapter.resolveInboundConnection(req);
      assert.strictEqual(res, null);
    });

    test('4.3 SQL Injection in pathKey fails closed', async () => {
      const sqlInjectionKeys = [
        "' OR '1'='1",
        "conn-wa-01'; DROP TABLE channel_connections; --",
        "1 UNION SELECT 'evil', 99, 1, 'whatsapp-cloud', 'fake', 'hacked', 'active', NULL, '{}' --",
      ];

      for (const atk of sqlInjectionKeys) {
        const req: InboundConnectionResolutionRequest = {
          path: `/webhook/${encodeURIComponent(atk)}`,
          headers: {},
          pathKey: atk,
          rawBody: new Uint8Array(),
        };
        const res = await adapter.resolveInboundConnection(req);
        assert.strictEqual(res, null, `Expected null resolution for SQL injection key: ${atk}`);
      }
    });

    test('4.4 Corrupted header resolution: Only x-connection-id without x-tenant-id falls through safely', async () => {
      const req: InboundConnectionResolutionRequest = {
        path: '/webhook',
        headers: {
          'x-connection-id': 'conn-wa-01',
        },
        rawBody: new Uint8Array(),
      };
      const res = await adapter.resolveInboundConnection(req);
      assert.strictEqual(res, null);
    });
  });

  // ---------------------------------------------------------------------------
  // 5. CapabilityRegistry & 24h Window Boundary Attacks
  // ---------------------------------------------------------------------------
  describe('Suite 5: CapabilityRegistry & 24h Window Boundary Attacks', () => {
    test('5.1 Exact 24h boundary: 23 hours, 59 minutes, 59 seconds is PERMITTED', async () => {
      const inside24h = new Date(Date.now() - (24 * 3600 - 1) * 1000).toISOString();
      const res = await registry.evaluatePublish(1, 'conn-wa-01', {
        messageKind: 'text',
        isTemplate: false,
        correlationId: 'test-24h-in',
        lastCustomerInteractionAt: inside24h,
      });
      assert.strictEqual(res.permitted, true);
    });

    test('5.2 Exact 24h boundary: 24 hours + 1 second is BLOCKED with CH_WA_WINDOW_CLOSED', async () => {
      const outside24h = new Date(Date.now() - (24 * 3600 + 1) * 1000).toISOString();
      const res = await registry.evaluatePublish(1, 'conn-wa-01', {
        messageKind: 'text',
        isTemplate: false,
        correlationId: 'test-24h-out',
        lastCustomerInteractionAt: outside24h,
      });
      assert.strictEqual(res.permitted, false);
      if (!res.permitted) {
        assert.strictEqual(res.reasonCode, 'CH_WA_WINDOW_CLOSED');
      }
    });

    test('5.3 Fail-closed: Malformed interaction date string is blocked with CH_WA_WINDOW_CLOSED', () => {
      const intentWithBadDate = {
        messageKind: 'text' as const,
        isTemplate: false,
        correlationId: 'corr-bypass',
        lastCustomerInteractionAt: 'invalid-date-string',
      };
      const gateResult = evaluatePublishGate(baseWaMatrix, intentWithBadDate);
      assert.strictEqual(gateResult.permitted, false);
      if (!gateResult.permitted) {
        assert.strictEqual(gateResult.reasonCode, 'CH_WA_WINDOW_CLOSED');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Outbound Dispatch Graph API Adversarial Network Responses
  // ---------------------------------------------------------------------------
  describe('Suite 6: Outbound Dispatch Graph API Adversarial Network Responses', () => {
    test('6.1 Network error (ECONNREFUSED / fetch throws) returns accepted: false and deliveryState: failed', async () => {
      const mockFetch = async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:443');
      };

      const faultyAdapter = new MetaCloudAdapter({
        kind: 'whatsapp-cloud',
        pool: mockPool,
        appSecret: APP_SECRET,
        fetchFn: mockFetch as any,
      });

      const cmd: SendMessageCommandV1 = {
        tenantId: '1',
        connectionId: 'conn-wa-01',
        conversationId: '573001234567',
        effectKey: 'eff-net-err-1',
        expectedConversationVersion: 1,
        causedBy: { type: 'agent', id: 'agent-1' },
        message: {
          kind: 'text',
          text: 'Should fail gracefully',
        },
      };

      const result = await faultyAdapter.send(cmd);
      assert.strictEqual(result.accepted, false);
      assert.strictEqual(result.deliveryState, 'failed');
      assert.ok(result.rawStatus.includes('ECONNREFUSED'));
    });

    test('6.2 Meta Graph API returns HTTP 502 Bad Gateway (HTML body) without crashing', async () => {
      const mockFetch = async () => {
        return {
          ok: false,
          status: 502,
          json: async () => {
            throw new Error('Unexpected token < in JSON at position 0');
          },
        };
      };

      const faultyAdapter = new MetaCloudAdapter({
        kind: 'whatsapp-cloud',
        pool: mockPool,
        appSecret: APP_SECRET,
        fetchFn: mockFetch as any,
      });

      const cmd: SendMessageCommandV1 = {
        tenantId: '1',
        connectionId: 'conn-wa-01',
        conversationId: '573001234567',
        effectKey: 'eff-502-1',
        expectedConversationVersion: 1,
        causedBy: { type: 'agent', id: 'agent-1' },
        message: { kind: 'text', text: '502 test' },
      };

      const result = await faultyAdapter.send(cmd);
      assert.strictEqual(result.accepted, false);
      assert.strictEqual(result.deliveryState, 'failed');
      assert.strictEqual(result.rawStatus, 'HTTP 502');
    });

    test('6.3 Meta Graph API returns HTTP 429 Rate Limit problem details', async () => {
      const mockFetch = async () => {
        return {
          ok: false,
          status: 429,
          json: async () => ({
            error: {
              message: 'Rate limit hit for phone_number_id',
              code: 80007,
            },
          }),
        };
      };

      const faultyAdapter = new MetaCloudAdapter({
        kind: 'whatsapp-cloud',
        pool: mockPool,
        appSecret: APP_SECRET,
        fetchFn: mockFetch as any,
      });

      const cmd: SendMessageCommandV1 = {
        tenantId: '1',
        connectionId: 'conn-wa-01',
        conversationId: '573001234567',
        effectKey: 'eff-429-1',
        expectedConversationVersion: 1,
        causedBy: { type: 'agent', id: 'agent-1' },
        message: { kind: 'text', text: '429 test' },
      };

      const result = await faultyAdapter.send(cmd);
      assert.strictEqual(result.accepted, false);
      assert.strictEqual(result.deliveryState, 'failed');
      assert.ok(result.rawStatus.includes('Rate limit hit'));
    });
  });
});
