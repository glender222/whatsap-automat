// Invariants before config load
process.env.JWT_SECRET = 'test-only-jwt-secret-with-at-least-32-characters-for-testing';
process.env.DB_PASSWORD = 'test-only-database-password';

import assert from 'node:assert/strict';
import { describe, test, beforeEach } from 'node:test';
import crypto from 'node:crypto';
import type { Pool, PoolClient, QueryResult } from 'pg';

import {
  ChannelCapabilityMatrix,
  channelCapabilityMatrixSchema,
  channelEventV1Schema,
  sendMessageResultV1Schema,
  SendMessageCommandV1,
  InboundConnectionResolutionRequest,
} from '@whatsap-automat/contracts';

const { TenantScopedUoW } = require('../db/TenantScopedUoW') as typeof import('../db/TenantScopedUoW');
const { CapabilityRegistry, PublishGateError } = require('../services/channels/CapabilityRegistry') as typeof import('../services/channels/CapabilityRegistry');
const { verifyAntiReplayTimestamp } = require('../middleware/webhookIdempotency') as typeof import('../middleware/webhookIdempotency');
const { MetaCloudAdapter } = require('../services/channels/MetaCloudAdapter') as typeof import('../services/channels/MetaCloudAdapter');

// -----------------------------------------------------------------------------
// In-Memory Database Engine & Mock Pool
// -----------------------------------------------------------------------------
interface MockChannelConnectionRow {
  id: string;
  tenant_id: number;
  workspace_id: number | null;
  channel: string;
  account_id: string;
  name: string;
  status: string;
  credentials_encrypted: Record<string, unknown> | null;
  metadata_json: Record<string, unknown>;
}

function createMockAdapterPool() {
  const channelConnections: MockChannelConnectionRow[] = [
    {
      id: 'conn-wa-prod-01',
      tenant_id: 1,
      workspace_id: 1,
      channel: 'whatsapp-cloud',
      account_id: 'wa-phone-100', // phone_number_id
      name: 'WhatsApp Production',
      status: 'active',
      credentials_encrypted: { accessToken: 'test-wa-token', appSecret: 'test-meta-app-secret' },
      metadata_json: { wabaId: 'waba-100', displayPhoneNumber: '+573001234567' },
    },
    {
      id: 'conn-ig-prod-01',
      tenant_id: 1,
      workspace_id: 1,
      channel: 'instagram',
      account_id: 'ig-account-200', // recipient.id / page_id
      name: 'Instagram Production',
      status: 'active',
      credentials_encrypted: { accessToken: 'test-ig-token', appSecret: 'test-meta-app-secret' },
      metadata_json: { igUserId: 'ig-account-200', pageId: 'page-200' },
    },
    {
      id: 'conn-wa-tenant2',
      tenant_id: 2, // Tenant 2 isolation
      workspace_id: 2,
      channel: 'whatsapp-cloud',
      account_id: 'wa-phone-200',
      name: 'WhatsApp Tenant 2',
      status: 'active',
      credentials_encrypted: { accessToken: 'test-wa-token-t2', appSecret: 'test-t2-secret' },
      metadata_json: { wabaId: 'waba-200' },
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

// -----------------------------------------------------------------------------
// Capability Matrix Fixtures
// -----------------------------------------------------------------------------
const baseWaMatrix: ChannelCapabilityMatrix = {
  connectionId: 'conn-wa-prod-01',
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

const baseIgMatrix: ChannelCapabilityMatrix = {
  connectionId: 'conn-ig-prod-01',
  tenantId: '1',
  channel: 'instagram',
  features: {
    text: true,
    image: true,
    audio: true,
    video: true,
    document: false, // Disallowed on Instagram
    template: false, // Disallowed on Instagram
    interactive: true,
    reactions: true,
    typing: true,
    readReceipt: true,
  },
  scopes: ['instagram_basic', 'instagram_manage_messages'],
  policies: {
    sessionWindowHours: 24,
    requiresHsmTemplateOutsideWindow: true,
    rateLimitPerMinute: 300,
    requiresOptIn: false,
  },
  health: {
    status: 'healthy',
    lastCheckedAt: new Date().toISOString(),
    latencyMs: 65,
  },
  budget: {
    tier: 'standard',
    costPerMessageCents: 0,
    monthlyBudgetLimitCents: 50000,
    currentMonthSpendCents: 500,
  },
  regional: {
    blacklistedCountries: ['KP', 'SY', 'IR'],
  },
  updatedAt: new Date().toISOString(),
};

// =============================================================================
// PR-F3-02 TEST SUITES
// =============================================================================
describe('PR-F3-02: Unified Meta Cloud Adapter & Instagram Social Triggers (WAA-009, PROD-002, ADR-019)', () => {
  let mockPool: ReturnType<typeof createMockAdapterPool>;
  let uow: TenantScopedUoW;
  let registry: CapabilityRegistry;
  let waAdapter: MetaCloudAdapter;
  let igAdapter: MetaCloudAdapter;
  let fetchHistory: { url: string; options?: RequestInit }[];
  let mockFetch: typeof fetch;

  beforeEach(async () => {
    mockPool = createMockAdapterPool();
    uow = new TenantScopedUoW(mockPool as unknown as Pool);
    registry = new CapabilityRegistry(uow);

    await registry.saveSnapshot(1, baseWaMatrix);
    await registry.saveSnapshot(1, baseIgMatrix);

    fetchHistory = [];
    mockFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      fetchHistory.push({ url, options: init });

      if (url.includes('/messages')) {
        return new Response(
          JSON.stringify({
            messages: [{ id: 'wamid.out.mock.001' }],
            message_id: 'ig_mid_out_mock_001',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (url.includes('/me') || url.includes('verified_name')) {
        return new Response(
          JSON.stringify({
            id: 'meta_account_id',
            name: 'Test Business',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      return new Response(
        JSON.stringify({ error: { message: 'Not Found', code: 404 } }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch;

    waAdapter = new MetaCloudAdapter({
      kind: 'whatsapp-cloud',
      pool: mockPool,
      capabilityRegistry: registry,
      appSecret: 'test-meta-app-secret',
      webhookVerifyToken: 'test-verify-token-12345',
      fetchFn: mockFetch,
    });

    igAdapter = new MetaCloudAdapter({
      kind: 'instagram',
      pool: mockPool,
      capabilityRegistry: registry,
      appSecret: 'test-meta-app-secret',
      webhookVerifyToken: 'test-verify-token-12345',
      fetchFn: mockFetch,
    });
  });

  // ---------------------------------------------------------------------------
  // Suite 1: Webhook Challenge Verification (GET)
  // ---------------------------------------------------------------------------
  describe('Suite 1: Webhook Challenge Verification (GET)', () => {
    test('1.1: Valid verify token and mode subscribe returns challenge', () => {
      const query = {
        'hub.mode': 'subscribe',
        'hub.verify_token': 'test-verify-token-12345',
        'hub.challenge': '1158201444',
      };
      const result = waAdapter.verifyChallenge(query);
      assert.strictEqual(result, '1158201444');
    });

    test('1.2: Invalid verify token returns null', () => {
      const query = {
        'hub.mode': 'subscribe',
        'hub.verify_token': 'wrong-token',
        'hub.challenge': '1158201444',
      };
      const result = waAdapter.verifyChallenge(query);
      assert.strictEqual(result, null);
    });

    test('1.3: Missing verify token returns null', () => {
      const query = {
        'hub.mode': 'subscribe',
        'hub.challenge': '1158201444',
      };
      const result = waAdapter.verifyChallenge(query);
      assert.strictEqual(result, null);
    });

    test('1.4: Invalid mode returns null', () => {
      const query = {
        'hub.mode': 'unsubscribe',
        'hub.verify_token': 'test-verify-token-12345',
        'hub.challenge': '1158201444',
      };
      const result = waAdapter.verifyChallenge(query);
      assert.strictEqual(result, null);
    });
  });

  // ---------------------------------------------------------------------------
  // Suite 2: Cryptographic HMAC SHA-256 Signature Verification (Inbound POST)
  // ---------------------------------------------------------------------------
  describe('Suite 2: Cryptographic HMAC SHA-256 Signature Verification', () => {
    const rawPayload = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account' }));

    test('2.1: Valid HMAC signature matches using crypto.timingSafeEqual', async () => {
      const hmac = crypto.createHmac('sha256', 'test-meta-app-secret');
      hmac.update(rawPayload);
      const signature = `sha256=${hmac.digest('hex')}`;

      const valid = await waAdapter.verifyInbound('conn-wa-prod-01', rawPayload, {
        'x-hub-signature-256': signature,
      });
      assert.strictEqual(valid, true);
    });

    test('2.2: Tampered payload with original signature is rejected', async () => {
      const hmac = crypto.createHmac('sha256', 'test-meta-app-secret');
      hmac.update(rawPayload);
      const signature = `sha256=${hmac.digest('hex')}`;

      const tamperedPayload = Buffer.from(JSON.stringify({ object: 'tampered_account' }));
      const valid = await waAdapter.verifyInbound('conn-wa-prod-01', tamperedPayload, {
        'x-hub-signature-256': signature,
      });
      assert.strictEqual(valid, false);
    });

    test('2.3: Missing signature header returns false', async () => {
      const valid = await waAdapter.verifyInbound('conn-wa-prod-01', rawPayload, {});
      assert.strictEqual(valid, false);
    });

    test('2.4: Malformed hex signature returns false', async () => {
      const valid = await waAdapter.verifyInbound('conn-wa-prod-01', rawPayload, {
        'x-hub-signature-256': 'sha256=invalid_hex_payload_non_hex',
      });
      assert.strictEqual(valid, false);
    });

    test('2.5: Signed with wrong app secret returns false', async () => {
      const wrongHmac = crypto.createHmac('sha256', 'wrong-secret-key-123456');
      wrongHmac.update(rawPayload);
      const signature = `sha256=${wrongHmac.digest('hex')}`;

      const valid = await waAdapter.verifyInbound('conn-wa-prod-01', rawPayload, {
        'x-hub-signature-256': signature,
      });
      assert.strictEqual(valid, false);
    });

    test('2.6: Signature verification resolves connection-specific credentials if adapter secret omitted', async () => {
      const adapterWithoutSecret = new MetaCloudAdapter({
        kind: 'whatsapp-cloud',
        pool: mockPool,
        appSecret: '', // blank, forces lookup in conn-wa-prod-01 credentials_encrypted
      });

      const hmac = crypto.createHmac('sha256', 'test-meta-app-secret');
      hmac.update(rawPayload);
      const signature = `sha256=${hmac.digest('hex')}`;

      const valid = await adapterWithoutSecret.verifyInbound('conn-wa-prod-01', rawPayload, {
        'x-hub-signature-256': signature,
      });
      assert.strictEqual(valid, true);
    });
  });

  // ---------------------------------------------------------------------------
  // Suite 3: Anti-Replay Timestamp Defense (+/- 300s window)
  // ---------------------------------------------------------------------------
  describe('Suite 3: Anti-Replay Timestamp Defense (+/- 300s window)', () => {
    test('3.1: Fresh timestamp within seconds passes verification', () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const result = verifyAntiReplayTimestamp(nowSec, 300);
      assert.strictEqual(result.valid, true);
    });

    test('3.2: Acceptable clock drift (150s in past) passes verification', () => {
      const pastTime = Date.now() - 150_000;
      const result = verifyAntiReplayTimestamp(pastTime, 300);
      assert.strictEqual(result.valid, true);
      assert.ok(result.skewSeconds !== undefined && result.skewSeconds <= 160);
    });

    test('3.3: Stale timestamp (350s in past) is rejected as replay attack', () => {
      const staleTime = Date.now() - 350_000;
      const result = verifyAntiReplayTimestamp(staleTime, 300);
      assert.strictEqual(result.valid, false);
      assert.ok(result.reason?.includes('outside allowable anti-replay window'));
    });

    test('3.4: Far future timestamp (400s in future) is rejected', () => {
      const futureTime = Date.now() + 400_000;
      const result = verifyAntiReplayTimestamp(futureTime, 300);
      assert.strictEqual(result.valid, false);
    });

    test('3.5: Malformed non-numeric timestamp string is rejected', () => {
      const result = verifyAntiReplayTimestamp('not-a-timestamp', 300);
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.reason, 'Invalid timestamp format');
    });
  });

  // ---------------------------------------------------------------------------
  // Suite 4: Inbound Connection & Tenancy Resolution (Fail-Closed, Zero Default Fallback - MSG-05)
  // ---------------------------------------------------------------------------
  describe('Suite 4: Inbound Connection & Tenancy Resolution (Fail-Closed, MSG-05)', () => {
    test('4.1: Resolves WhatsApp connectionId and tenantId from phone_number_id', async () => {
      const waPayload = {
        object: 'whatsapp_business_account',
        entry: [
          {
            changes: [
              {
                field: 'messages',
                value: {
                  metadata: { phone_number_id: 'wa-phone-100' },
                  messages: [{ id: 'wamid.test', from: '573001234567', type: 'text', text: { body: 'test' } }],
                },
              },
            ],
          },
        ],
      };

      const req: InboundConnectionResolutionRequest = {
        headers: {},
        pathKey: null,
        rawBody: Buffer.from(JSON.stringify(waPayload)),
      };

      const res = await waAdapter.resolveInboundConnection(req);
      assert.ok(res);
      assert.strictEqual(res.connectionId, 'conn-wa-prod-01');
      assert.strictEqual(res.tenantId, '1');
    });

    test('4.2: Resolves Instagram connectionId and tenantId from recipient.id', async () => {
      const igPayload = {
        object: 'instagram',
        entry: [
          {
            id: 'ig-account-200',
            messaging: [
              {
                recipient: { id: 'ig-account-200' },
                sender: { id: 'ig-customer-001' },
                message: { mid: 'mid.001', text: 'Hola IG' },
              },
            ],
          },
        ],
      };

      const req: InboundConnectionResolutionRequest = {
        headers: {},
        pathKey: null,
        rawBody: Buffer.from(JSON.stringify(igPayload)),
      };

      const res = await igAdapter.resolveInboundConnection(req);
      assert.ok(res);
      assert.strictEqual(res.connectionId, 'conn-ig-prod-01');
      assert.strictEqual(res.tenantId, '1');
    });

    test('4.3: Resolves Instagram comment trigger from entry[0].id', async () => {
      const igCommentPayload = {
        object: 'instagram',
        entry: [
          {
            id: 'ig-account-200',
            changes: [
              {
                field: 'comments',
                value: { id: 'comment-99', text: 'Info' },
              },
            ],
          },
        ],
      };

      const req: InboundConnectionResolutionRequest = {
        headers: {},
        pathKey: null,
        rawBody: Buffer.from(JSON.stringify(igCommentPayload)),
      };

      const res = await igAdapter.resolveInboundConnection(req);
      assert.ok(res);
      assert.strictEqual(res.connectionId, 'conn-ig-prod-01');
      assert.strictEqual(res.tenantId, '1');
    });

    test('4.4: Unknown WhatsApp phone_number_id returns null (fail-closed, MSG-05)', async () => {
      const unknownPayload = {
        object: 'whatsapp_business_account',
        entry: [
          {
            changes: [
              {
                field: 'messages',
                value: {
                  metadata: { phone_number_id: 'unknown-phone-999' },
                },
              },
            ],
          },
        ],
      };

      const req: InboundConnectionResolutionRequest = {
        headers: {},
        pathKey: null,
        rawBody: Buffer.from(JSON.stringify(unknownPayload)),
      };

      const res = await waAdapter.resolveInboundConnection(req);
      assert.strictEqual(res, null);
    });

    test('4.5: Unknown Instagram account returns null (fail-closed, MSG-05)', async () => {
      const unknownIgPayload = {
        object: 'instagram',
        entry: [{ id: 'unknown-ig-999' }],
      };

      const req: InboundConnectionResolutionRequest = {
        headers: {},
        pathKey: null,
        rawBody: Buffer.from(JSON.stringify(unknownIgPayload)),
      };

      const res = await igAdapter.resolveInboundConnection(req);
      assert.strictEqual(res, null);
    });

    test('4.6: Tenant isolation boundary: queries scoped to Tenant 1 cannot access Tenant 2 accounts', async () => {
      const client = await mockPool.connect();
      try {
        await client.query("SET LOCAL app.current_tenant_id = '1'");
        const queryReq: InboundConnectionResolutionRequest = {
          headers: {},
          pathKey: null,
          rawBody: Buffer.from(
            JSON.stringify({
              object: 'whatsapp_business_account',
              entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'wa-phone-200' } } }] }],
            })
          ),
        };

        const res = await waAdapter.resolveInboundConnection(queryReq, client);
        assert.strictEqual(res, null);
      } finally {
        client.release();
      }
    });

    test('4.7: Direct header overrides (x-connection-id and x-tenant-id) resolve immediately', async () => {
      const headerReq: InboundConnectionResolutionRequest = {
        headers: {
          'x-connection-id': 'conn-override-99',
          'x-tenant-id': '99',
        },
        pathKey: null,
        rawBody: null,
      };

      const res = await waAdapter.resolveInboundConnection(headerReq);
      assert.ok(res);
      assert.strictEqual(res.connectionId, 'conn-override-99');
      assert.strictEqual(res.tenantId, '99');
    });

    test('4.8: Path key resolves connectionId and tenantId directly from database', async () => {
      const pathReq: InboundConnectionResolutionRequest = {
        headers: {},
        pathKey: 'conn-wa-prod-01',
        rawBody: null,
      };

      const res = await waAdapter.resolveInboundConnection(pathReq);
      assert.ok(res);
      assert.strictEqual(res.connectionId, 'conn-wa-prod-01');
      assert.strictEqual(res.tenantId, '1');
    });
  });

  // ---------------------------------------------------------------------------
  // Suite 5: Inbound Message Normalization (WhatsApp & Instagram)
  // ---------------------------------------------------------------------------
  describe('Suite 5: Inbound Message Normalization (WhatsApp & Instagram)', () => {
    test('5.1: WhatsApp inbound text normalized to ChannelEventV1', async () => {
      const payload = {
        object: 'whatsapp_business_account',
        entry: [
          {
            changes: [
              {
                field: 'messages',
                value: {
                  messages: [
                    {
                      id: 'wamid.001',
                      from: '573001234567',
                      type: 'text',
                      text: { body: 'Hola mundo' },
                      timestamp: '1710000000',
                    },
                  ],
                },
              },
            ],
          },
        ],
      };

      const events = await waAdapter.normalizeInbound('conn-wa-prod-01', payload);
      assert.strictEqual(events.length, 1);
      const ev = events[0];

      assert.strictEqual(ev.channel, 'whatsapp-cloud');
      assert.strictEqual(ev.eventType, 'message.received');
      assert.strictEqual(ev.externalEventId, 'wamid.001');
      assert.strictEqual(ev.externalConversationId, '573001234567');
      assert.strictEqual(ev.externalIdentityId, '573001234567@s.whatsapp.net');
      assert.strictEqual(ev.payload?.kind, 'message');
      if (ev.payload?.kind === 'message') {
        assert.strictEqual(ev.payload.data.kind, 'text');
        assert.strictEqual(ev.payload.data.text, 'Hola mundo');
      }

      assert.doesNotThrow(() => channelEventV1Schema.parse(ev));
    });

    test('5.2: WhatsApp inbound media normalized to ChannelEventV1', async () => {
      const payload = {
        object: 'whatsapp_business_account',
        entry: [
          {
            changes: [
              {
                field: 'messages',
                value: {
                  messages: [
                    {
                      id: 'wamid.002',
                      from: '573001234567',
                      type: 'image',
                      image: {
                        id: 'media_123',
                        mime_type: 'image/jpeg',
                        file_size: 10240,
                      },
                      timestamp: '1710000000',
                    },
                  ],
                },
              },
            ],
          },
        ],
      };

      const events = await waAdapter.normalizeInbound('conn-wa-prod-01', payload);
      assert.strictEqual(events.length, 1);
      const ev = events[0];

      assert.strictEqual(ev.payload?.kind, 'message');
      if (ev.payload?.kind === 'message') {
        assert.strictEqual(ev.payload.data.kind, 'media');
        assert.strictEqual(ev.payload.data.media?.providerMediaId, 'media_123');
        assert.strictEqual(ev.payload.data.media?.mimeType, 'image/jpeg');
      }
      assert.doesNotThrow(() => channelEventV1Schema.parse(ev));
    });

    test('5.3: WhatsApp inbound interactive button reply normalized to interaction.received', async () => {
      const payload = {
        object: 'whatsapp_business_account',
        entry: [
          {
            changes: [
              {
                field: 'messages',
                value: {
                  messages: [
                    {
                      id: 'wamid.003',
                      from: '573001234567',
                      type: 'interactive',
                      interactive: {
                        type: 'button_reply',
                        button_reply: { id: 'btn_yes', title: 'Si, confirmar' },
                      },
                      timestamp: '1710000000',
                    },
                  ],
                },
              },
            ],
          },
        ],
      };

      const events = await waAdapter.normalizeInbound('conn-wa-prod-01', payload);
      assert.strictEqual(events.length, 1);
      const ev = events[0];

      assert.strictEqual(ev.eventType, 'interaction.received');
      assert.strictEqual(ev.payload?.kind, 'message');
      if (ev.payload?.kind === 'message') {
        assert.strictEqual(ev.payload.data.kind, 'interactive');
        assert.strictEqual(ev.payload.data.interactive?.id, 'btn_yes');
        assert.strictEqual(ev.payload.data.interactive?.title, 'Si, confirmar');
      }
      assert.doesNotThrow(() => channelEventV1Schema.parse(ev));
    });

    test('5.4: WhatsApp delivery status receipts normalized to message.status', async () => {
      const payload = {
        object: 'whatsapp_business_account',
        entry: [
          {
            changes: [
              {
                field: 'messages',
                value: {
                  statuses: [
                    {
                      id: 'wamid.001',
                      recipient_id: '573001234567',
                      status: 'delivered',
                      timestamp: '1710000000',
                    },
                    {
                      id: 'wamid.002',
                      recipient_id: '573001234567',
                      status: 'failed',
                      timestamp: '1710000000',
                      errors: [{ code: 131026, title: 'Window closed' }],
                    },
                  ],
                },
              },
            ],
          },
        ],
      };

      const events = await waAdapter.normalizeInbound('conn-wa-prod-01', payload);
      assert.strictEqual(events.length, 2);

      assert.strictEqual(events[0].eventType, 'message.status');
      if (events[0].payload?.kind === 'status') {
        assert.strictEqual(events[0].payload.data.status, 'delivered');
      }

      assert.strictEqual(events[1].eventType, 'message.status');
      if (events[1].payload?.kind === 'status') {
        assert.strictEqual(events[1].payload.data.status, 'failed');
        assert.strictEqual(events[1].payload.data.errorCode, '131026');
      }

      assert.doesNotThrow(() => channelEventV1Schema.parse(events[0]));
      assert.doesNotThrow(() => channelEventV1Schema.parse(events[1]));
    });

    test('5.5: Instagram DM normalized to ChannelEventV1', async () => {
      const igPayload = {
        object: 'instagram',
        entry: [
          {
            id: 'ig-account-200',
            messaging: [
              {
                sender: { id: 'ig_user_1' },
                recipient: { id: 'ig-account-200' },
                timestamp: 1710000000000,
                message: {
                  mid: 'ig_mid_1',
                  text: 'Informacion de producto',
                },
              },
            ],
          },
        ],
      };

      const events = await igAdapter.normalizeInbound('conn-ig-prod-01', igPayload);
      assert.strictEqual(events.length, 1);
      const ev = events[0];

      assert.strictEqual(ev.channel, 'instagram');
      assert.strictEqual(ev.eventType, 'message.received');
      assert.strictEqual(ev.externalIdentityId, 'ig_user_1');
      if (ev.payload?.kind === 'message') {
        assert.strictEqual(ev.payload.data.text, 'Informacion de producto');
      }
      assert.doesNotThrow(() => channelEventV1Schema.parse(ev));
    });

    test('5.6: Instagram public comments social trigger normalized to interaction.received', async () => {
      const igCommentPayload = {
        object: 'instagram',
        entry: [
          {
            id: 'ig-account-200',
            changes: [
              {
                field: 'comments',
                value: {
                  id: 'comment_99',
                  text: 'Precio?',
                  from: { id: 'user_99', username: 'cliente' },
                  media: { id: 'post_88' },
                  created_time: 1710000000,
                },
              },
            ],
          },
        ],
      };

      const events = await igAdapter.normalizeInbound('conn-ig-prod-01', igCommentPayload);
      assert.strictEqual(events.length, 1);
      const ev = events[0];

      assert.strictEqual(ev.channel, 'instagram');
      assert.strictEqual(ev.eventType, 'interaction.received');
      assert.strictEqual(ev.externalEventId, 'comment_99');
      if (ev.payload?.kind === 'raw') {
        assert.strictEqual(ev.payload.data.commentId, 'comment_99');
        assert.strictEqual(ev.payload.data.text, 'Precio?');
      }
      assert.doesNotThrow(() => channelEventV1Schema.parse(ev));
    });

    test('5.7: Instagram mentions social trigger normalized to interaction.received', async () => {
      const igMentionPayload = {
        object: 'instagram',
        entry: [
          {
            id: 'ig-account-200',
            changes: [
              {
                field: 'mentions',
                value: {
                  media_id: 'post_77',
                  comment_id: 'mention_c_1',
                },
              },
            ],
          },
        ],
      };

      const events = await igAdapter.normalizeInbound('conn-ig-prod-01', igMentionPayload);
      assert.strictEqual(events.length, 1);
      const ev = events[0];

      assert.strictEqual(ev.channel, 'instagram');
      assert.strictEqual(ev.eventType, 'interaction.received');
      assert.strictEqual(ev.externalEventId, 'mention_c_1');
      assert.doesNotThrow(() => channelEventV1Schema.parse(ev));
    });

    test('5.8: Malformed or unknown webhook payload degrades gracefully to empty array', async () => {
      const unknownPayload = { object: 'unknown_service', entry: [] };
      const events = await waAdapter.normalizeInbound('conn-wa-prod-01', unknownPayload);
      assert.deepStrictEqual(events, []);

      const nonJsonEvents = await waAdapter.normalizeInbound('conn-wa-prod-01', 'not-valid-json');
      assert.deepStrictEqual(nonJsonEvents, []);
    });

    test('5.9: WhatsApp inbound interactive list_reply normalized to interaction.received', async () => {
      const payload = {
        object: 'whatsapp_business_account',
        entry: [
          {
            changes: [
              {
                field: 'messages',
                value: {
                  messages: [
                    {
                      id: 'wamid.list.001',
                      from: '573001234567',
                      type: 'interactive',
                      interactive: {
                        type: 'list_reply',
                        list_reply: { id: 'item_plan_pro', title: 'Plan Profesional' },
                      },
                      timestamp: '1710000000',
                    },
                  ],
                },
              },
            ],
          },
        ],
      };

      const events = await waAdapter.normalizeInbound('conn-wa-prod-01', payload);
      assert.strictEqual(events.length, 1);
      const ev = events[0];

      assert.strictEqual(ev.eventType, 'interaction.received');
      assert.strictEqual(ev.payload?.kind, 'message');
      if (ev.payload?.kind === 'message') {
        assert.strictEqual(ev.payload.data.kind, 'interactive');
        assert.strictEqual(ev.payload.data.interactive?.id, 'item_plan_pro');
        assert.strictEqual(ev.payload.data.interactive?.title, 'Plan Profesional');
      }
      assert.doesNotThrow(() => channelEventV1Schema.parse(ev));
    });

    test('5.10: WhatsApp inbound document media normalized properly', async () => {
      const docPayload = {
        object: 'whatsapp_business_account',
        entry: [
          {
            changes: [
              {
                field: 'messages',
                value: {
                  messages: [
                    {
                      id: 'wamid.doc.001',
                      from: '573001234567',
                      type: 'document',
                      document: {
                        id: 'doc_123',
                        filename: 'catalogo.pdf',
                        mime_type: 'application/pdf',
                      },
                      timestamp: '1710000000',
                    },
                  ],
                },
              },
            ],
          },
        ],
      };

      const events = await waAdapter.normalizeInbound('conn-wa-prod-01', docPayload);
      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0].payload?.kind, 'message');
      if (events[0].payload?.kind === 'message') {
        assert.strictEqual(events[0].payload.data.kind, 'media');
        assert.strictEqual(events[0].payload.data.media?.filename, 'catalogo.pdf');
        assert.strictEqual(events[0].payload.data.media?.mimeType, 'application/pdf');
      }
      assert.doesNotThrow(() => channelEventV1Schema.parse(events[0]));
    });
  });

  // ---------------------------------------------------------------------------
  // Suite 6: CapabilityRegistry Publish Gate & 24h Window Enforcement
  // ---------------------------------------------------------------------------
  describe('Suite 6: CapabilityRegistry Publish Gate & 24h Window Enforcement', () => {
    test('6.1: WhatsApp text inside 24h window is permitted', async () => {
      const result = await registry.evaluatePublish(1, 'conn-wa-prod-01', {
        messageKind: 'text',
        correlationId: 'corr-01',
        lastCustomerInteractionAt: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
      });
      assert.strictEqual(result.permitted, true);
    });

    test('6.2: WhatsApp free-form text outside 24h window is blocked with CH_WA_WINDOW_CLOSED', async () => {
      const result = await registry.evaluatePublish(1, 'conn-wa-prod-01', {
        messageKind: 'text',
        correlationId: 'corr-02',
        lastCustomerInteractionAt: new Date(Date.now() - 25 * 3600 * 1000).toISOString(),
      });
      assert.strictEqual(result.permitted, false);
      if (!result.permitted) {
        assert.strictEqual(result.reasonCode, 'CH_WA_WINDOW_CLOSED');
        assert.strictEqual(result.problemDetails.status, 403);
      }
    });

    test('6.3: WhatsApp free-form text with no customer interaction history is blocked', async () => {
      const result = await registry.evaluatePublish(1, 'conn-wa-prod-01', {
        messageKind: 'text',
        correlationId: 'corr-03',
        lastCustomerInteractionAt: undefined,
      });
      assert.strictEqual(result.permitted, false);
      if (!result.permitted) {
        assert.strictEqual(result.reasonCode, 'CH_WA_WINDOW_CLOSED');
      }
    });

    test('6.4: WhatsApp approved HSM template outside 24h window bypasses the window check', async () => {
      const result = await registry.evaluatePublish(1, 'conn-wa-prod-01', {
        messageKind: 'template',
        isTemplate: true,
        correlationId: 'corr-04',
        lastCustomerInteractionAt: new Date(Date.now() - 72 * 3600 * 1000).toISOString(),
      });
      assert.strictEqual(result.permitted, true);
    });

    test('6.5: Instagram document payload is rejected with CAPABILITY_UNSUPPORTED', async () => {
      const result = await registry.evaluatePublish(1, 'conn-ig-prod-01', {
        messageKind: 'document',
        correlationId: 'corr-05',
        lastCustomerInteractionAt: new Date(Date.now() - 1 * 3600 * 1000).toISOString(),
      });
      assert.strictEqual(result.permitted, false);
      if (!result.permitted) {
        assert.strictEqual(result.reasonCode, 'CAPABILITY_UNSUPPORTED');
      }
    });

    test('6.6: Instagram template payload is rejected with CAPABILITY_UNSUPPORTED', async () => {
      const result = await registry.evaluatePublish(1, 'conn-ig-prod-01', {
        messageKind: 'template',
        isTemplate: true,
        correlationId: 'corr-06',
      });
      assert.strictEqual(result.permitted, false);
      if (!result.permitted) {
        assert.strictEqual(result.reasonCode, 'CAPABILITY_UNSUPPORTED');
      }
    });

    test('6.7: Instagram text outside 24h window is blocked with CH_WA_WINDOW_CLOSED', async () => {
      const result = await registry.evaluatePublish(1, 'conn-ig-prod-01', {
        messageKind: 'text',
        correlationId: 'corr-07',
        lastCustomerInteractionAt: new Date(Date.now() - 30 * 3600 * 1000).toISOString(),
      });
      assert.strictEqual(result.permitted, false);
      if (!result.permitted) {
        assert.strictEqual(result.reasonCode, 'CH_WA_WINDOW_CLOSED');
      }
    });

    test('6.8: Unhealthy connection and regionally restricted country are blocked', async () => {
      const unhealthyMatrix: ChannelCapabilityMatrix = {
        ...baseWaMatrix,
        connectionId: 'conn-unhealthy',
        health: { status: 'needs_reauthorization', lastCheckedAt: new Date().toISOString() },
      };
      await registry.saveSnapshot(1, unhealthyMatrix);

      const unhealthResult = await registry.evaluatePublish(1, 'conn-unhealthy', {
        messageKind: 'text',
        correlationId: 'corr-08',
      });
      assert.strictEqual(unhealthResult.permitted, false);
      if (!unhealthResult.permitted) {
        assert.strictEqual(unhealthResult.reasonCode, 'CHANNEL_UNHEALTHY');
      }

      const regionResult = await registry.evaluatePublish(1, 'conn-wa-prod-01', {
        messageKind: 'text',
        correlationId: 'corr-09',
        recipientCountry: 'KP', // Blacklisted
        lastCustomerInteractionAt: new Date().toISOString(),
      });
      assert.strictEqual(regionResult.permitted, false);
      if (!regionResult.permitted) {
        assert.strictEqual(regionResult.reasonCode, 'REGION_RESTRICTED');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Suite 7: Outbound Dispatch via Meta Graph API (Mocked Transport)
  // ---------------------------------------------------------------------------
  describe('Suite 7: Outbound Dispatch via Meta Graph API', () => {
    test('7.1: Dispatches WhatsApp text message to Graph API successfully', async () => {
      const cmd: SendMessageCommandV1 = {
        schemaVersion: 1,
        tenantId: '1',
        connectionId: 'conn-wa-prod-01',
        conversationId: '573001234567',
        effectKey: 'eff-001',
        message: {
          kind: 'text',
          text: 'Hola cliente!',
          parameters: {
            lastCustomerInteractionAt: new Date(Date.now() - 3600 * 1000).toISOString(),
          },
        },
        expectedConversationVersion: 1,
        causedBy: { type: 'human', id: 'usr-1' },
      };

      const result = await waAdapter.send(cmd);
      assert.strictEqual(result.accepted, true);
      assert.strictEqual(result.providerMessageId, 'wamid.out.mock.001');
      assert.strictEqual(result.deliveryState, 'dispatched');
      assert.strictEqual(fetchHistory.length, 1);
      assert.ok(fetchHistory[0].url.includes('/messages'));

      assert.doesNotThrow(() => sendMessageResultV1Schema.parse(result));
    });

    test('7.2: Dispatches WhatsApp HSM template message outside 24h window', async () => {
      const cmd: SendMessageCommandV1 = {
        schemaVersion: 1,
        tenantId: '1',
        connectionId: 'conn-wa-prod-01',
        conversationId: '573001234567',
        effectKey: 'eff-002',
        message: {
          kind: 'template',
          templateId: 'order_update',
          parameters: {
            languageCode: 'es_CO',
            lastCustomerInteractionAt: new Date(Date.now() - 72 * 3600 * 1000).toISOString(),
          },
        },
        expectedConversationVersion: 2,
        causedBy: { type: 'agent', id: 'ai-1' },
      };

      const result = await waAdapter.send(cmd);
      assert.strictEqual(result.accepted, true);
      assert.ok(fetchHistory.length > 0);
      const lastCall = fetchHistory[fetchHistory.length - 1];
      const body = JSON.parse(String(lastCall.options?.body));
      assert.strictEqual(body.type, 'template');
      assert.strictEqual(body.template?.name, 'order_update');
    });

    test('7.3: Dispatches Instagram direct message to Graph API successfully', async () => {
      const cmd: SendMessageCommandV1 = {
        schemaVersion: 1,
        tenantId: '1',
        connectionId: 'conn-ig-prod-01',
        conversationId: 'ig_customer_01',
        effectKey: 'eff-003',
        message: {
          kind: 'text',
          text: 'Respuesta en DM',
          parameters: {
            lastCustomerInteractionAt: new Date(Date.now() - 1000).toISOString(),
          },
        },
        expectedConversationVersion: 1,
        causedBy: { type: 'human', id: 'usr-2' },
      };

      const result = await igAdapter.send(cmd);
      assert.strictEqual(result.accepted, true);
      const lastCall = fetchHistory[fetchHistory.length - 1];
      const body = JSON.parse(String(lastCall.options?.body));
      assert.strictEqual(body.recipient?.id, 'ig_customer_01');
    });

    test('7.4: Dispatches Instagram Comment-to-DM (Private Reply)', async () => {
      const cmd: SendMessageCommandV1 = {
        schemaVersion: 1,
        tenantId: '1',
        connectionId: 'conn-ig-prod-01',
        conversationId: 'post_88',
        effectKey: 'eff-004',
        message: {
          kind: 'text',
          text: 'Hola, te enviamos la informacion solicitada',
          parameters: {
            commentId: 'comment_99',
            lastCustomerInteractionAt: new Date(Date.now() - 1000).toISOString(),
          },
        },
        expectedConversationVersion: 1,
        causedBy: { type: 'agent', id: 'ai-2' },
      };

      const result = await igAdapter.send(cmd);
      assert.strictEqual(result.accepted, true);
      const lastCall = fetchHistory[fetchHistory.length - 1];
      const body = JSON.parse(String(lastCall.options?.body));
      assert.strictEqual(body.recipient?.comment_id, 'comment_99');
    });

    test('7.5: Publish gate denial aborts before making any external HTTP call', async () => {
      const callCountBefore = fetchHistory.length;

      const cmdBlocked: SendMessageCommandV1 = {
        schemaVersion: 1,
        tenantId: '1',
        connectionId: 'conn-wa-prod-01',
        conversationId: '573001234567',
        effectKey: 'eff-blocked',
        message: {
          kind: 'text',
          text: 'Mensaje fuera de ventana',
          parameters: {
            lastCustomerInteractionAt: new Date(Date.now() - 48 * 3600 * 1000).toISOString(),
          },
        },
        expectedConversationVersion: 1,
        causedBy: { type: 'agent', id: 'ai-1' },
      };

      await assert.rejects(
        () => waAdapter.send(cmdBlocked),
        (err: any) => {
          assert.ok(err instanceof PublishGateError);
          assert.strictEqual(err.code, 'CH_WA_WINDOW_CLOSED');
          return true;
        }
      );

      assert.strictEqual(fetchHistory.length, callCountBefore);
    });

    test('7.6: Graph API provider error response is mapped cleanly', async () => {
      const failingFetch: typeof fetch = (async () => {
        return new Response(
          JSON.stringify({
            error: { message: 'Invalid recipient', code: 100, error_subcode: 2018001 },
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }) as typeof fetch;

      const failingAdapter = new MetaCloudAdapter({
        kind: 'whatsapp-cloud',
        pool: mockPool,
        capabilityRegistry: registry,
        fetchFn: failingFetch,
      });

      const cmd: SendMessageCommandV1 = {
        schemaVersion: 1,
        tenantId: '1',
        connectionId: 'conn-wa-prod-01',
        conversationId: '573001234567',
        effectKey: 'eff-err',
        message: {
          kind: 'text',
          text: 'Prueba error',
          parameters: {
            lastCustomerInteractionAt: new Date().toISOString(),
          },
        },
        expectedConversationVersion: 1,
        causedBy: { type: 'human', id: 'usr-1' },
      };

      const result = await failingAdapter.send(cmd);
      assert.strictEqual(result.accepted, false);
      assert.strictEqual(result.deliveryState, 'failed');
      assert.strictEqual(result.rawStatus, 'Invalid recipient');
    });

    test('7.7: Dispatches WhatsApp media message (image/link) correctly', async () => {
      const cmd: SendMessageCommandV1 = {
        schemaVersion: 1,
        tenantId: '1',
        connectionId: 'conn-wa-prod-01',
        conversationId: '573001234567',
        effectKey: 'eff-media-001',
        message: {
          kind: 'media',
          mediaRef: 'media_obj_999',
          parameters: {
            mediaType: 'image',
            url: 'https://example.com/photo.jpg',
            lastCustomerInteractionAt: new Date().toISOString(),
          },
        },
        expectedConversationVersion: 1,
        causedBy: { type: 'human', id: 'usr-1' },
      };

      const result = await waAdapter.send(cmd);
      assert.strictEqual(result.accepted, true);
      const lastCall = fetchHistory[fetchHistory.length - 1];
      const body = JSON.parse(String(lastCall.options?.body));
      assert.strictEqual(body.type, 'image');
      assert.strictEqual(body.image?.id, 'media_obj_999');
      assert.strictEqual(body.image?.link, 'https://example.com/photo.jpg');
    });

    test('7.8: Dispatches WhatsApp interactive message correctly', async () => {
      const cmd: SendMessageCommandV1 = {
        schemaVersion: 1,
        tenantId: '1',
        connectionId: 'conn-wa-prod-01',
        conversationId: '573001234567',
        effectKey: 'eff-interactive-001',
        message: {
          kind: 'interactive',
          parameters: {
            interactive: {
              type: 'button',
              body: { text: '¿Deseas confirmar tu cita?' },
              action: {
                buttons: [
                  { type: 'reply', reply: { id: 'btn_yes', title: 'Sí' } },
                  { type: 'reply', reply: { id: 'btn_no', title: 'No' } },
                ],
              },
            },
            lastCustomerInteractionAt: new Date().toISOString(),
          },
        },
        expectedConversationVersion: 1,
        causedBy: { type: 'human', id: 'usr-1' },
      };

      const result = await waAdapter.send(cmd);
      assert.strictEqual(result.accepted, true);
      const lastCall = fetchHistory[fetchHistory.length - 1];
      const body = JSON.parse(String(lastCall.options?.body));
      assert.strictEqual(body.type, 'interactive');
      assert.strictEqual(body.interactive?.type, 'button');
    });
  });

  // ---------------------------------------------------------------------------
  // Suite 8: Zero Regression & Contracts Integrity Guarantee
  // ---------------------------------------------------------------------------
  describe('Suite 8: Zero Regression & Contracts Integrity Guarantee', () => {
    test('8.1: Returns technical capabilities correctly for WhatsApp and Instagram', async () => {
      const waCaps = await waAdapter.getCapabilities('conn-wa-prod-01');
      assert.ok(waCaps.has('text'));
      assert.ok(waCaps.has('template'));
      assert.ok(waCaps.has('document'));
      assert.strictEqual(waCaps.size, 9);

      const igCaps = await igAdapter.getCapabilities('conn-ig-prod-01');
      assert.ok(igCaps.has('text'));
      assert.strictEqual(igCaps.has('template'), false);
      assert.strictEqual(igCaps.has('document'), false);
      assert.strictEqual(igCaps.size, 6);
    });

    test('8.2: Health check verifies token validity against Meta Graph API', async () => {
      const health = await waAdapter.health('conn-wa-prod-01');
      assert.strictEqual(health.configured, true);
      assert.strictEqual(health.authorized, true);
      assert.strictEqual(health.lastErrorCode, null);

      const unauthorizedFetch: typeof fetch = (async () => {
        return new Response(JSON.stringify({ error: { code: 190, message: 'Invalid OAuth' } }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as typeof fetch;

      const brokenAdapter = new MetaCloudAdapter({
        kind: 'whatsapp-cloud',
        pool: mockPool,
        fetchFn: unauthorizedFetch,
      });

      const badHealth = await brokenAdapter.health('conn-wa-prod-01');
      assert.strictEqual(badHealth.configured, true);
      assert.strictEqual(badHealth.authorized, false);
      assert.strictEqual(badHealth.lastErrorCode, 'TOKEN_EXPIRED');
    });

    test('8.3: Health check maps 500 error from Meta Graph API to API_ERROR_500', async () => {
      const serverErrorFetch: typeof fetch = (async () => {
        return new Response(JSON.stringify({ error: { code: 2, message: 'Service error' } }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as typeof fetch;

      const errorAdapter = new MetaCloudAdapter({
        kind: 'whatsapp-cloud',
        pool: mockPool,
        fetchFn: serverErrorFetch,
      });

      const health = await errorAdapter.health('conn-wa-prod-01');
      assert.strictEqual(health.configured, true);
      assert.strictEqual(health.authorized, false);
      assert.strictEqual(health.lastErrorCode, 'API_ERROR_500');
    });
  });
});
