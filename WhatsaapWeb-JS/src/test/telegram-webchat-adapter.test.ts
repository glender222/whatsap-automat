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
const { TelegramBotAdapter } = require('../services/channels/TelegramBotAdapter') as typeof import('../services/channels/TelegramBotAdapter');
const { WebchatAdapter } = require('../services/channels/WebchatAdapter') as typeof import('../services/channels/WebchatAdapter');

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
      id: 'conn-tg-prod-01',
      tenant_id: 1,
      workspace_id: 1,
      channel: 'telegram',
      account_id: 'bot_telegram_alpha',
      name: 'Telegram Production',
      status: 'active',
      credentials_encrypted: {
        botToken: 'test-tg-bot-token-123',
        secretToken: 'super-secret-tg-token-xyz',
      },
      metadata_json: { botUsername: 'AlphaBot' },
    },
    {
      id: 'conn-tg-tenant2',
      tenant_id: 2,
      workspace_id: 2,
      channel: 'telegram',
      account_id: 'bot_telegram_beta',
      name: 'Telegram Tenant 2',
      status: 'active',
      credentials_encrypted: {
        botToken: 'test-tg-bot-token-tenant2',
        secretToken: 'secret-token-t2-abc',
      },
      metadata_json: { botUsername: 'BetaBot' },
    },
    {
      id: 'conn-tg-inactive',
      tenant_id: 1,
      workspace_id: 1,
      channel: 'telegram',
      account_id: 'bot_telegram_inactive',
      name: 'Telegram Inactive',
      status: 'inactive',
      credentials_encrypted: {
        botToken: 'test-tg-bot-token-inact',
        secretToken: 'secret-inactive-token',
      },
      metadata_json: {},
    },
    {
      id: 'conn-tg-expired',
      tenant_id: 1,
      workspace_id: 1,
      channel: 'telegram',
      account_id: 'bot_telegram_expired',
      name: 'Telegram Expired',
      status: 'active',
      credentials_encrypted: {
        botToken: 'invalid-token-expired',
        secretToken: 'secret-expired-token',
      },
      metadata_json: {},
    },
    {
      id: 'conn-tg-no-secret',
      tenant_id: 1,
      workspace_id: 1,
      channel: 'telegram',
      account_id: 'bot_telegram_no_secret',
      name: 'Telegram Without Secret',
      status: 'active',
      credentials_encrypted: {},
      metadata_json: {},
    },
    {
      id: 'conn-wc-prod-01',
      tenant_id: 1,
      workspace_id: 1,
      channel: 'webchat',
      account_id: 'webchat-site-main',
      name: 'Webchat Main Site',
      status: 'active',
      credentials_encrypted: {
        visitorJwtSecret: 'webchat-jwt-secret-key-32-chars-long-minimum!',
      },
      metadata_json: { allowedOrigins: ['https://example.com'] },
    },
    {
      id: 'conn-wc-tenant2',
      tenant_id: 2,
      workspace_id: 2,
      channel: 'webchat',
      account_id: 'webchat-site-t2',
      name: 'Webchat Tenant 2',
      status: 'active',
      credentials_encrypted: {
        visitorJwtSecret: 'webchat-jwt-secret-tenant-2-super-secure!',
      },
      metadata_json: {},
    },
    {
      id: 'conn-wc-inactive',
      tenant_id: 1,
      workspace_id: 1,
      channel: 'webchat',
      account_id: 'webchat-inactive',
      name: 'Webchat Inactive',
      status: 'inactive',
      credentials_encrypted: {
        visitorJwtSecret: 'inactive-secret-key-32-chars-long',
      },
      metadata_json: {},
    },
    {
      id: 'conn-wc-needs-reauth',
      tenant_id: 1,
      workspace_id: 1,
      channel: 'webchat',
      account_id: 'webchat-expired',
      name: 'Webchat Expired',
      status: 'needs_reauthorization',
      credentials_encrypted: {
        visitorJwtSecret: 'secret-key-needs-reauth',
      },
      metadata_json: {},
    },
    {
      id: 'conn-wc-no-secret',
      tenant_id: 1,
      workspace_id: 1,
      channel: 'webchat',
      account_id: 'webchat-no-secret',
      name: 'Webchat Without Secret',
      status: 'active',
      credentials_encrypted: {},
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

              if (sql.includes("status <> 'inactive'")) {
                rows = rows.filter((r) => r.status !== 'inactive');
              }

              if (sql.includes("channel = 'telegram'") || sql.includes('channel = $') && sqlValues.includes('telegram')) {
                rows = rows.filter((r) => r.channel === 'telegram');
              } else if (sql.includes("channel = 'webchat'") || sql.includes('channel = $') && sqlValues.includes('webchat')) {
                rows = rows.filter((r) => r.channel === 'webchat');
              }

              if (sql.includes("credentials_encrypted->>'secretToken' = $1") || sql.includes('secretToken')) {
                const targetSecret = String(sqlValues[0]);
                rows = rows.filter((r) => {
                  const creds = r.credentials_encrypted;
                  return creds && (creds.secretToken === targetSecret || creds.secret_token === targetSecret);
                });
              } else if (sql.includes('WHERE id = $') || sql.includes('id = $1') || sql.includes('WHERE id = $1')) {
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
const baseTgMatrix: ChannelCapabilityMatrix = {
  connectionId: 'conn-tg-prod-01',
  tenantId: '1',
  channel: 'telegram',
  features: {
    text: true,
    image: true,
    audio: true,
    video: true,
    document: true,
    template: false,
    interactive: true,
    reactions: false,
    typing: true,
    readReceipt: false,
  },
  scopes: ['telegram_bot_messaging'],
  policies: {
    sessionWindowHours: undefined, // Telegram has no 24h Meta restriction!
    requiresHsmTemplateOutsideWindow: false,
    rateLimitPerMinute: 60,
    requiresOptIn: false,
  },
  health: {
    status: 'healthy',
    lastCheckedAt: new Date().toISOString(),
  },
  budget: {
    tier: 'free',
  },
  regional: {
    blacklistedCountries: [],
  },
  updatedAt: new Date().toISOString(),
};

const baseWcMatrix: ChannelCapabilityMatrix = {
  connectionId: 'conn-wc-prod-01',
  tenantId: '1',
  channel: 'webchat',
  features: {
    text: true,
    image: true,
    audio: false,
    video: false,
    document: true,
    template: false,
    interactive: true,
    reactions: false,
    typing: true,
    readReceipt: true,
  },
  scopes: ['webchat_client'],
  policies: {
    sessionWindowHours: undefined, // Webchat has no 24h Meta restriction!
    requiresHsmTemplateOutsideWindow: false,
    requiresOptIn: false,
  },
  health: {
    status: 'healthy',
    lastCheckedAt: new Date().toISOString(),
  },
  budget: {
    tier: 'free',
  },
  regional: {
    blacklistedCountries: [],
  },
  updatedAt: new Date().toISOString(),
};

// =============================================================================
// PR-F3-03 TEST SUITES: Telegram Bot & Webchat Adapters
// =============================================================================
describe('PR-F3-03: Telegram Bot API & Self-Hosted Webchat Adapters (WAA-010, CH-01, CH-02, MSG-04, MSG-05)', () => {
  let mockPool: ReturnType<typeof createMockAdapterPool>;
  let uow: TenantScopedUoW;
  let registry: CapabilityRegistry;
  let tgAdapter: InstanceType<typeof TelegramBotAdapter>;
  let wcAdapter: InstanceType<typeof WebchatAdapter>;

  // Spies for socket and fetch
  let emittedSocketEvents: { room?: string; tenantId?: any; conversationId?: string; event: string; payload: any }[] = [];
  let fetchedHttpRequests: { url: string; method?: string; headers?: any; body?: any }[] = [];

  const mockFetchFn: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const urlStr = typeof input === 'string' ? input : input.toString();
    const parsedBody = init?.body ? JSON.parse(String(init.body)) : undefined;

    fetchedHttpRequests.push({
      url: urlStr,
      method: init?.method,
      headers: init?.headers,
      body: parsedBody,
    });

    // Telegram Bot API getMe mock
    if (urlStr.includes('/getMe')) {
      if (urlStr.includes('invalid-token') || urlStr.includes('expired')) {
        return new Response(JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ok: true, result: { id: 123456789, is_bot: true, username: 'AlphaBot' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Telegram Bot API sendMessage / sendPhoto / etc.
    if (urlStr.includes('/sendMessage') || urlStr.includes('/sendPhoto') || urlStr.includes('/sendDocument')) {
      if (parsedBody?.chat_id === 'blocked-user-chat') {
        return new Response(JSON.stringify({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: 887766 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  const mockSocketEmitter = {
    emitConversation: (tenantId: number | string, conversationId: string, event: string, payload: unknown) => {
      emittedSocketEvents.push({ tenantId, conversationId, event, payload });
    },
    emitToTenant: (tenantId: number | string, event: string, payload: unknown) => {
      emittedSocketEvents.push({ tenantId, event, payload });
    },
    emitToRoom: (room: string, event: string, payload: unknown) => {
      emittedSocketEvents.push({ room, event, payload });
    },
  };

  beforeEach(async () => {
    mockPool = createMockAdapterPool();
    uow = new TenantScopedUoW(mockPool as any);
    registry = new CapabilityRegistry(uow);
    emittedSocketEvents = [];
    fetchedHttpRequests = [];

    await registry.saveSnapshot(1, baseTgMatrix);
    await registry.saveSnapshot(1, baseWcMatrix);
    await registry.saveSnapshot(2, {
      ...baseWcMatrix,
      tenantId: '2',
      connectionId: 'conn-wc-tenant2',
    });

    tgAdapter = new TelegramBotAdapter({
      pool: mockPool,
      capabilityRegistry: registry,
      fetchFn: mockFetchFn,
      botToken: 'default-tg-token',
      secretToken: 'super-secret-tg-token-xyz',
    });

    wcAdapter = new WebchatAdapter({
      pool: mockPool,
      capabilityRegistry: registry,
      jwtSecret: 'webchat-jwt-secret-key-32-chars-long-minimum!',
      socketEmitter: mockSocketEmitter,
    });
  });

  // ===========================================================================
  // SUITE 1: Telegram Tenancy Resolution & Fail-Closed Boundaries (MSG-05)
  // ===========================================================================
  describe('Suite 1: Telegram Tenancy Resolution & Fail-Closed Boundaries (MSG-05)', () => {
    test('1.1: Resolves connection via pathKey matching active Telegram connection', async () => {
      const req: InboundConnectionResolutionRequest = {
        pathKey: 'conn-tg-prod-01',
        headers: {},
        rawBody: new Uint8Array(),
      };
      const res = await tgAdapter.resolveInboundConnection(req);
      assert.ok(res);
      assert.equal(res.connectionId, 'conn-tg-prod-01');
      assert.equal(res.tenantId, '1');
    });

    test('1.2: Resolves connection via X-Telegram-Bot-Api-Secret-Token matching DB credentials', async () => {
      const req: InboundConnectionResolutionRequest = {
        pathKey: null,
        headers: {
          'x-telegram-bot-api-secret-token': 'super-secret-tg-token-xyz',
        },
        rawBody: new Uint8Array(),
      };
      const res = await tgAdapter.resolveInboundConnection(req);
      assert.ok(res);
      assert.equal(res.connectionId, 'conn-tg-prod-01');
      assert.equal(res.tenantId, '1');
    });

    test('1.3: Resolves connection via direct headers x-connection-id and x-tenant-id', async () => {
      const req: InboundConnectionResolutionRequest = {
        pathKey: null,
        headers: {
          'x-connection-id': 'conn-tg-custom',
          'x-tenant-id': '99',
        },
        rawBody: new Uint8Array(),
      };
      const res = await tgAdapter.resolveInboundConnection(req);
      assert.ok(res);
      assert.equal(res.connectionId, 'conn-tg-custom');
      assert.equal(res.tenantId, '99');
    });

    test('1.4: Invariant MSG-05: Unknown secret or pathKey returns null (never default company)', async () => {
      const req: InboundConnectionResolutionRequest = {
        pathKey: 'unknown-conn-id',
        headers: {
          'x-telegram-bot-api-secret-token': 'wrong-unmapped-secret',
        },
        rawBody: new Uint8Array(),
      };
      const res = await tgAdapter.resolveInboundConnection(req);
      assert.equal(res, null, 'Unmapped Telegram request must return null fail-closed');
    });

    test('1.5: Invariant MSG-05: Inactive connection (status = inactive) returns null fail-closed', async () => {
      const req: InboundConnectionResolutionRequest = {
        pathKey: 'conn-tg-inactive',
        headers: {},
        rawBody: new Uint8Array(),
      };
      const res = await tgAdapter.resolveInboundConnection(req);
      assert.equal(res, null, 'Inactive connection must be rejected fail-closed');
    });

    test('1.6: Multi-tenant isolation: Tenant 2 secret token strictly resolves to Tenant 2', async () => {
      const req: InboundConnectionResolutionRequest = {
        pathKey: null,
        headers: {
          'x-telegram-bot-api-secret-token': 'secret-token-t2-abc',
        },
        rawBody: new Uint8Array(),
      };
      const res = await tgAdapter.resolveInboundConnection(req);
      assert.ok(res);
      assert.equal(res.connectionId, 'conn-tg-tenant2');
      assert.equal(res.tenantId, '2');
    });
  });

  // ===========================================================================
  // SUITE 2: Telegram Secret Token Cryptographic Verification (MSG-04)
  // ===========================================================================
  describe('Suite 2: Telegram Secret Token Cryptographic Verification (MSG-04)', () => {
    test('2.1: Valid X-Telegram-Bot-Api-Secret-Token returns true', async () => {
      const valid = await tgAdapter.verifyInbound(
        'conn-tg-prod-01',
        new Uint8Array(),
        { 'x-telegram-bot-api-secret-token': 'super-secret-tg-token-xyz' }
      );
      assert.equal(valid, true);
    });

    test('2.2: Case-insensitive header lookup returns true', async () => {
      const valid = await tgAdapter.verifyInbound(
        'conn-tg-prod-01',
        new Uint8Array(),
        { 'X-Telegram-Bot-Api-Secret-Token': 'super-secret-tg-token-xyz' }
      );
      assert.equal(valid, true);
    });

    test('2.3: Invariant MSG-04: Missing secret token header returns false', async () => {
      const valid = await tgAdapter.verifyInbound(
        'conn-tg-prod-01',
        new Uint8Array(),
        {}
      );
      assert.equal(valid, false, 'Missing secret token must be rejected with false');
    });

    test('2.4: Invariant MSG-04: Mismatched secret token returns false', async () => {
      const valid = await tgAdapter.verifyInbound(
        'conn-tg-prod-01',
        new Uint8Array(),
        { 'x-telegram-bot-api-secret-token': 'tampered-secret-token' }
      );
      assert.equal(valid, false);
    });

    test('2.5: Invariant MSG-04: Empty string secret token returns false', async () => {
      const valid = await tgAdapter.verifyInbound(
        'conn-tg-prod-01',
        new Uint8Array(),
        { 'x-telegram-bot-api-secret-token': '   ' }
      );
      assert.equal(valid, false);
    });

    test('2.6: Constant-time comparison handles different string lengths safely', async () => {
      const valid = await tgAdapter.verifyInbound(
        'conn-tg-prod-01',
        new Uint8Array(),
        { 'x-telegram-bot-api-secret-token': 'short' }
      );
      assert.equal(valid, false);
    });

    test('2.7: Missing credentials in DB falls back to adapter constructor secretToken', async () => {
      const adapterWithFallback = new TelegramBotAdapter({
        pool: mockPool,
        secretToken: 'constructor-fallback-secret',
      });

      const valid = await adapterWithFallback.verifyInbound(
        'conn-tg-no-secret',
        new Uint8Array(),
        { 'x-telegram-bot-api-secret-token': 'constructor-fallback-secret' }
      );
      assert.equal(valid, true);
    });
  });

  // ===========================================================================
  // SUITE 3: Telegram Inbound Message Normalization
  // ===========================================================================
  describe('Suite 3: Telegram Inbound Message Normalization (CH-01)', () => {
    test('3.1: Normalizes text message into ChannelEventV1 strictly conforming to schema', async () => {
      const rawUpdate = {
        update_id: 1001,
        message: {
          message_id: 5544,
          from: { id: 778899, is_bot: false, first_name: 'Juan' },
          chat: { id: 778899, type: 'private' },
          date: 1730505600,
          text: 'Buenas tardes, deseo información de los planes.',
        },
      };

      const events = await tgAdapter.normalizeInbound('conn-tg-prod-01', rawUpdate);
      assert.equal(events.length, 1);
      const ev = events[0];

      const validation = channelEventV1Schema.safeParse(ev);
      assert.ok(validation.success);
      assert.equal(ev.channel, 'telegram');
      assert.equal(ev.eventType, 'message.received');
      assert.equal(ev.externalConversationId, '778899');
      assert.equal(ev.externalIdentityId, '778899');
      assert.equal(ev.payload?.kind, 'message');
      if (ev.payload?.kind === 'message') {
        assert.equal(ev.payload.data.kind, 'text');
        assert.equal(ev.payload.data.text, 'Buenas tardes, deseo información de los planes.');
      }
    });

    test('3.2: Normalizes photo message selecting highest resolution photo', async () => {
      const rawUpdate = {
        update_id: 1002,
        message: {
          message_id: 5545,
          chat: { id: 12345 },
          from: { id: 67890 },
          date: 1730505600,
          photo: [
            { file_id: 'thumb_id', file_size: 1024, width: 100, height: 100 },
            { file_id: 'highest_res_id', file_size: 512000, width: 1920, height: 1080 },
          ],
        },
      };

      const events = await tgAdapter.normalizeInbound('conn-tg-prod-01', rawUpdate);
      assert.equal(events.length, 1);
      const ev = events[0];
      assert.ok(channelEventV1Schema.safeParse(ev).success);
      if (ev.payload?.kind === 'message') {
        assert.equal(ev.payload.data.kind, 'media');
        assert.equal(ev.payload.data.media?.providerMediaId, 'highest_res_id');
        assert.equal(ev.payload.data.media?.mimeType, 'image/jpeg');
        assert.equal(ev.payload.data.media?.sizeBytes, 512000);
      }
    });

    test('3.3: Normalizes voice message with mimeType audio/ogg', async () => {
      const rawUpdate = {
        update_id: 1003,
        message: {
          message_id: 5546,
          chat: { id: 12345 },
          date: 1730505600,
          voice: { file_id: 'voice_file_id_xyz', file_size: 24000, mime_type: 'audio/ogg' },
        },
      };

      const events = await tgAdapter.normalizeInbound('conn-tg-prod-01', rawUpdate);
      assert.equal(events.length, 1);
      if (events[0].payload?.kind === 'message') {
        assert.equal(events[0].payload.data.kind, 'media');
        assert.equal(events[0].payload.data.media?.mimeType, 'audio/ogg');
        assert.equal(events[0].payload.data.media?.providerMediaId, 'voice_file_id_xyz');
      }
    });

    test('3.4: Normalizes audio message with mimeType audio/mpeg', async () => {
      const rawUpdate = {
        update_id: 1004,
        message: {
          message_id: 5547,
          chat: { id: 12345 },
          date: 1730505600,
          audio: { file_id: 'audio_file_id_abc', file_name: 'podcast.mp3', file_size: 1048576, mime_type: 'audio/mpeg' },
        },
      };

      const events = await tgAdapter.normalizeInbound('conn-tg-prod-01', rawUpdate);
      assert.equal(events.length, 1);
      if (events[0].payload?.kind === 'message') {
        assert.equal(events[0].payload.data.media?.filename, 'podcast.mp3');
        assert.equal(events[0].payload.data.media?.mimeType, 'audio/mpeg');
      }
    });

    test('3.5: Normalizes video message with mimeType video/mp4', async () => {
      const rawUpdate = {
        update_id: 1005,
        message: {
          message_id: 5548,
          chat: { id: 12345 },
          date: 1730505600,
          video: { file_id: 'video_file_id_789', file_size: 5242880, mime_type: 'video/mp4' },
        },
      };

      const events = await tgAdapter.normalizeInbound('conn-tg-prod-01', rawUpdate);
      assert.equal(events.length, 1);
      if (events[0].payload?.kind === 'message') {
        assert.equal(events[0].payload.data.media?.mimeType, 'video/mp4');
      }
    });

    test('3.6: Normalizes document message with filename and mimeType', async () => {
      const rawUpdate = {
        update_id: 1006,
        message: {
          message_id: 5549,
          chat: { id: 12345 },
          date: 1730505600,
          document: { file_id: 'doc_file_id_pdf', file_name: 'factura_1042.pdf', mime_type: 'application/pdf', file_size: 98000 },
        },
      };

      const events = await tgAdapter.normalizeInbound('conn-tg-prod-01', rawUpdate);
      assert.equal(events.length, 1);
      if (events[0].payload?.kind === 'message') {
        assert.equal(events[0].payload.data.media?.filename, 'factura_1042.pdf');
        assert.equal(events[0].payload.data.media?.mimeType, 'application/pdf');
      }
    });

    test('3.7: Normalizes inline keyboard callback query into interaction.received', async () => {
      const rawUpdate = {
        update_id: 1007,
        callback_query: {
          id: 'cb_query_999',
          from: { id: 778899 },
          message: { chat: { id: 778899 }, message_id: 5540 },
          data: 'btn_select_plan_pro',
        },
      };

      const events = await tgAdapter.normalizeInbound('conn-tg-prod-01', rawUpdate);
      assert.equal(events.length, 1);
      const ev = events[0];
      assert.ok(channelEventV1Schema.safeParse(ev).success);
      assert.equal(ev.eventType, 'interaction.received');
      if (ev.payload?.kind === 'message') {
        assert.equal(ev.payload.data.kind, 'interactive');
        assert.equal(ev.payload.data.interactive?.type, 'button_reply');
        assert.equal(ev.payload.data.interactive?.id, 'btn_select_plan_pro');
      }
    });

    test('3.8: Malformed raw payload returns empty array fail-safely', async () => {
      const events = await tgAdapter.normalizeInbound('conn-tg-prod-01', 'not-valid-json{');
      assert.deepEqual(events, []);
    });
  });

  // ===========================================================================
  // SUITE 4: Telegram Outbound Dispatch & API Response Mapping
  // ===========================================================================
  describe('Suite 4: Telegram Outbound Dispatch & API Response Mapping', () => {
    test('4.1: Outbound text message dispatches to sendMessage endpoint and returns dispatched result', async () => {
      const cmd: SendMessageCommandV1 = {
        schemaVersion: 1,
        tenantId: '1',
        connectionId: 'conn-tg-prod-01',
        conversationId: 'chat_12345',
        effectKey: 'eff_tg_001',
        message: {
          kind: 'text',
          text: 'Hola, este es un mensaje de prueba para Telegram.',
        },
      };

      const res = await tgAdapter.send(cmd);
      assert.ok(sendMessageResultV1Schema.safeParse(res).success);
      assert.equal(res.accepted, true);
      assert.equal(res.deliveryState, 'dispatched');
      assert.equal(res.providerMessageId, '887766');

      const req = fetchedHttpRequests.find((r) => r.url.includes('/sendMessage'));
      assert.ok(req);
      assert.equal(req.body.chat_id, 'chat_12345');
      assert.equal(req.body.text, 'Hola, este es un mensaje de prueba para Telegram.');
    });

    test('4.2: Outbound photo media dispatches to sendPhoto with caption', async () => {
      const cmd: SendMessageCommandV1 = {
        schemaVersion: 1,
        tenantId: '1',
        connectionId: 'conn-tg-prod-01',
        conversationId: 'chat_12345',
        effectKey: 'eff_tg_002',
        message: {
          kind: 'media',
          mediaRef: 'https://cdn.example.com/images/catalog.jpg',
          parameters: {
            mediaType: 'image',
            caption: 'Catálogo de Productos Noviembre 2026',
          },
        },
      };

      const res = await tgAdapter.send(cmd);
      assert.equal(res.accepted, true);

      const req = fetchedHttpRequests.find((r) => r.url.includes('/sendPhoto'));
      assert.ok(req);
      assert.equal(req.body.photo, 'https://cdn.example.com/images/catalog.jpg');
      assert.equal(req.body.caption, 'Catálogo de Productos Noviembre 2026');
    });

    test('4.3: Outbound document media dispatches to sendDocument', async () => {
      const cmd: SendMessageCommandV1 = {
        schemaVersion: 1,
        tenantId: '1',
        connectionId: 'conn-tg-prod-01',
        conversationId: 'chat_12345',
        effectKey: 'eff_tg_003',
        message: {
          kind: 'media',
          mediaRef: 'https://cdn.example.com/docs/factura.pdf',
          parameters: {
            mediaType: 'document',
            caption: 'Su factura',
          },
        },
      };

      const res = await tgAdapter.send(cmd);
      assert.equal(res.accepted, true);
      const req = fetchedHttpRequests.find((r) => r.url.includes('/sendDocument'));
      assert.ok(req);
      assert.equal(req.body.document, 'https://cdn.example.com/docs/factura.pdf');
    });

    test('4.4: Outbound interactive message formats inline keyboard markup', async () => {
      const cmd: SendMessageCommandV1 = {
        schemaVersion: 1,
        tenantId: '1',
        connectionId: 'conn-tg-prod-01',
        conversationId: 'chat_12345',
        effectKey: 'eff_tg_004',
        message: {
          kind: 'interactive',
          text: 'Seleccione una opción:',
          parameters: {
            buttons: [
              [{ text: 'Opción 1', callback_data: 'opt_1' }],
              [{ text: 'Opción 2', callback_data: 'opt_2' }],
            ],
          },
        },
      };

      const res = await tgAdapter.send(cmd);
      assert.equal(res.accepted, true);
      const req = fetchedHttpRequests.find((r) => r.url.includes('/sendMessage') && r.body.reply_markup);
      assert.ok(req);
      assert.ok(req.body.reply_markup.inline_keyboard);
    });

    test('4.5: Outbound error mapping: Telegram 403 Forbidden (bot blocked by user) maps to failed state', async () => {
      const cmd: SendMessageCommandV1 = {
        schemaVersion: 1,
        tenantId: '1',
        connectionId: 'conn-tg-prod-01',
        conversationId: 'blocked-user-chat',
        effectKey: 'eff_tg_blocked',
        message: { kind: 'text', text: 'Hello blocked user' },
      };

      const res = await tgAdapter.send(cmd);
      assert.equal(res.accepted, false);
      assert.equal(res.deliveryState, 'failed');
      assert.equal(res.providerMessageId, null);
      assert.match(res.rawStatus, /bot was blocked by the user/);
    });

    test('4.6: Outbound network error returns failed delivery state', async () => {
      const failingAdapter = new TelegramBotAdapter({
        pool: mockPool,
        fetchFn: async () => {
          throw new Error('ECONNRESET');
        },
      });

      const cmd: SendMessageCommandV1 = {
        schemaVersion: 1,
        tenantId: '1',
        connectionId: 'conn-tg-prod-01',
        conversationId: 'chat_123',
        effectKey: 'eff_net_fail',
        message: { kind: 'text', text: 'Hello' },
      };

      const res = await failingAdapter.send(cmd);
      assert.equal(res.accepted, false);
      assert.equal(res.deliveryState, 'failed');
      assert.equal(res.rawStatus, 'ECONNRESET');
    });
  });

  // ===========================================================================
  // SUITE 5: Telegram Connection Health & Authorization Check (CH-02)
  // ===========================================================================
  describe('Suite 5: Telegram Connection Health & Authorization Check (CH-02)', () => {
    test('5.1: Health check when getMe returns 200 returns configured: true, authorized: true', async () => {
      const health = await tgAdapter.health('conn-tg-prod-01');
      assert.equal(health.configured, true);
      assert.equal(health.authorized, true);
      assert.equal(health.lastErrorCode, null);
    });

    test('5.2: Gate CH-02: Health check when getMe returns 401 returns authorized: false with TOKEN_EXPIRED', async () => {
      const health = await tgAdapter.health('conn-tg-expired');
      assert.equal(health.configured, true);
      assert.equal(health.authorized, false);
      assert.equal(health.lastErrorCode, 'TOKEN_EXPIRED');
    });

    test('5.3: Health check when network fails returns lastErrorCode: NETWORK_ERROR', async () => {
      const netFailAdapter = new TelegramBotAdapter({
        pool: mockPool,
        botToken: 'token-ok',
        fetchFn: async () => {
          throw new Error('ETIMEDOUT');
        },
      });

      const health = await netFailAdapter.health('conn-tg-prod-01');
      assert.equal(health.configured, true);
      assert.equal(health.authorized, false);
      assert.equal(health.lastErrorCode, 'NETWORK_ERROR');
    });

    test('5.4: Health check with missing botToken returns configured: false with MISSING_CREDENTIALS', async () => {
      const noTokenAdapter = new TelegramBotAdapter({
        pool: mockPool,
        botToken: '',
      });

      const health = await noTokenAdapter.health('conn-tg-missing-all');
      assert.equal(health.configured, false);
      assert.equal(health.authorized, false);
      assert.equal(health.lastErrorCode, 'MISSING_CREDENTIALS');
    });
  });

  // ===========================================================================
  // SUITE 6: Webchat Visitor JWT Token Minting & Validation
  // ===========================================================================
  describe('Suite 6: Webchat Visitor JWT Token Minting & Cryptographic HMAC Validation', () => {
    test('6.1: mintVisitorToken produces valid JWT signed with HMAC-SHA256 (HS256)', () => {
      const token = wcAdapter.mintVisitorToken({
        tenantId: 1,
        connectionId: 'conn-wc-prod-01',
        visitorId: 'vis-12345',
        conversationId: 'conv-abc',
      });

      assert.ok(typeof token === 'string' && token.split('.').length === 3);
    });

    test('6.2: verifyVisitorToken verifies authentic token and extracts valid claims', () => {
      const token = wcAdapter.mintVisitorToken({
        tenantId: 1,
        connectionId: 'conn-wc-prod-01',
        visitorId: 'vis-12345',
        conversationId: 'conv-abc',
      });

      const claims = wcAdapter.verifyVisitorToken(token);
      assert.ok(claims);
      assert.equal(claims.sub, 'vis-12345');
      assert.equal(claims.tenantId, '1');
      assert.equal(claims.connectionId, 'conn-wc-prod-01');
      assert.equal(claims.conversationId, 'conv-abc');
      assert.equal(claims.role, 'visitor');
    });

    test('6.3: Tampered token returns null', () => {
      const token = wcAdapter.mintVisitorToken({
        tenantId: 1,
        connectionId: 'conn-wc-prod-01',
        visitorId: 'vis-12345',
      });

      const tampered = token.slice(0, -5) + 'AAAAA';
      const claims = wcAdapter.verifyVisitorToken(tampered);
      assert.equal(claims, null);
    });

    test('6.4: Expired token returns null', () => {
      const expiredToken = wcAdapter.mintVisitorToken({
        tenantId: 1,
        connectionId: 'conn-wc-prod-01',
        visitorId: 'vis-12345',
        expiresInSeconds: -10, // already expired
      });

      const claims = wcAdapter.verifyVisitorToken(expiredToken);
      assert.equal(claims, null);
    });

    test('6.5: Token signed with different secret returns null', () => {
      const tokenDiffSecret = wcAdapter.mintVisitorToken(
        {
          tenantId: 1,
          connectionId: 'conn-wc-prod-01',
          visitorId: 'vis-12345',
        },
        'completely-different-signing-secret-key-xyz'
      );

      const claims = wcAdapter.verifyVisitorToken(tokenDiffSecret);
      assert.equal(claims, null);
    });

    test('6.6: Token missing required role claim returns null', () => {
      const jwtLib = require('jsonwebtoken');
      const badToken = jwtLib.sign(
        { sub: 'vis-123', tenantId: '1', connectionId: 'conn-wc-prod-01', role: 'admin' },
        'webchat-jwt-secret-key-32-chars-long-minimum!'
      );

      const claims = wcAdapter.verifyVisitorToken(badToken);
      assert.equal(claims, null);
    });
  });

  // ===========================================================================
  // SUITE 7: Webchat Tenancy Resolution & Inbound Verification (MSG-05)
  // ===========================================================================
  describe('Suite 7: Webchat Tenancy Resolution & Inbound Verification (Fail-Closed, MSG-05)', () => {
    test('7.1: Resolves connection via valid x-visitor-token header', async () => {
      const token = wcAdapter.mintVisitorToken({
        tenantId: 1,
        connectionId: 'conn-wc-prod-01',
        visitorId: 'vis-9988',
      });

      const req: InboundConnectionResolutionRequest = {
        pathKey: null,
        headers: {
          'x-visitor-token': token,
        },
        rawBody: new Uint8Array(),
      };

      const res = await wcAdapter.resolveInboundConnection(req);
      assert.ok(res);
      assert.equal(res.connectionId, 'conn-wc-prod-01');
      assert.equal(res.tenantId, '1');
    });

    test('7.2: Resolves connection via valid Authorization: Bearer <token>', async () => {
      const token = wcAdapter.mintVisitorToken({
        tenantId: 1,
        connectionId: 'conn-wc-prod-01',
        visitorId: 'vis-9988',
      });

      const req: InboundConnectionResolutionRequest = {
        pathKey: null,
        headers: {
          authorization: `Bearer ${token}`,
        },
        rawBody: new Uint8Array(),
      };

      const res = await wcAdapter.resolveInboundConnection(req);
      assert.ok(res);
      assert.equal(res.connectionId, 'conn-wc-prod-01');
      assert.equal(res.tenantId, '1');
    });

    test('7.3: Resolves connection via pathKey matching active webchat connection', async () => {
      const req: InboundConnectionResolutionRequest = {
        pathKey: 'conn-wc-prod-01',
        headers: {},
        rawBody: new Uint8Array(),
      };

      const res = await wcAdapter.resolveInboundConnection(req);
      assert.ok(res);
      assert.equal(res.connectionId, 'conn-wc-prod-01');
      assert.equal(res.tenantId, '1');
    });

    test('7.4: Invariant MSG-05: Missing, invalid or tampered token returns null fail-closed', async () => {
      const req: InboundConnectionResolutionRequest = {
        pathKey: null,
        headers: {
          'x-visitor-token': 'invalid.jwt.token',
        },
        rawBody: new Uint8Array(),
      };

      const res = await wcAdapter.resolveInboundConnection(req);
      assert.equal(res, null, 'Invalid token must fail closed with null');
    });

    test('7.5: Invariant MSG-05: Inactive webchat connection returns null fail-closed', async () => {
      const req: InboundConnectionResolutionRequest = {
        pathKey: 'conn-wc-inactive',
        headers: {},
        rawBody: new Uint8Array(),
      };

      const res = await wcAdapter.resolveInboundConnection(req);
      assert.equal(res, null);
    });

    test('7.6: verifyInbound: authentic token matching connectionId returns true', async () => {
      const token = wcAdapter.mintVisitorToken({
        tenantId: 1,
        connectionId: 'conn-wc-prod-01',
        visitorId: 'vis-1',
      });

      const valid = await wcAdapter.verifyInbound(
        'conn-wc-prod-01',
        new Uint8Array(),
        { 'x-visitor-token': token }
      );
      assert.equal(valid, true);
    });

    test('7.7: verifyInbound: token for connection A used against connection B returns false', async () => {
      const token = wcAdapter.mintVisitorToken({
        tenantId: 1,
        connectionId: 'conn-wc-prod-01',
        visitorId: 'vis-1',
      });

      const valid = await wcAdapter.verifyInbound(
        'conn-wc-tenant2',
        new Uint8Array(),
        { 'x-visitor-token': token }
      );
      assert.equal(valid, false);
    });
  });

  // ===========================================================================
  // SUITE 8: Webchat Inbound Normalization & Outbound Dispatch
  // ===========================================================================
  describe('Suite 8: Webchat Inbound Normalization & Outbound Dispatch (No 24h restriction)', () => {
    test('8.1: Normalizes visitor text message into ChannelEventV1 with channel: webchat', async () => {
      const payload = {
        messageId: 'wc_client_msg_100',
        conversationId: 'wc_conv_42',
        visitorId: 'visitor_anon_55',
        text: 'Hola, tengo una pregunta técnica sobre la integración.',
      };

      const events = await wcAdapter.normalizeInbound('conn-wc-prod-01', payload);
      assert.equal(events.length, 1);
      const ev = events[0];

      assert.ok(channelEventV1Schema.safeParse(ev).success);
      assert.equal(ev.channel, 'webchat');
      assert.equal(ev.eventType, 'message.received');
      assert.equal(ev.externalConversationId, 'wc_conv_42');
      assert.equal(ev.externalIdentityId, 'visitor_anon_55');
      if (ev.payload?.kind === 'message') {
        assert.equal(ev.payload.data.kind, 'text');
        assert.equal(ev.payload.data.text, 'Hola, tengo una pregunta técnica sobre la integración.');
      }
    });

    test('8.2: Normalizes visitor media payload', async () => {
      const payload = {
        messageId: 'wc_client_msg_101',
        conversationId: 'wc_conv_42',
        visitorId: 'visitor_anon_55',
        media: {
          mimeType: 'image/png',
          providerMediaId: 'wc_upload_777',
          sizeBytes: 85000,
        },
      };

      const events = await wcAdapter.normalizeInbound('conn-wc-prod-01', payload);
      assert.equal(events.length, 1);
      if (events[0].payload?.kind === 'message') {
        assert.equal(events[0].payload.data.kind, 'media');
        assert.equal(events[0].payload.data.media?.providerMediaId, 'wc_upload_777');
      }
    });

    test('8.3: Normalizes visitor interactive button click into interaction.received', async () => {
      const payload = {
        messageId: 'wc_client_msg_102',
        conversationId: 'wc_conv_42',
        visitorId: 'visitor_anon_55',
        interactive: {
          type: 'button_reply',
          id: 'btn_consultar_saldo',
          title: 'Consultar Saldo',
        },
      };

      const events = await wcAdapter.normalizeInbound('conn-wc-prod-01', payload);
      assert.equal(events.length, 1);
      assert.equal(events[0].eventType, 'interaction.received');
      if (events[0].payload?.kind === 'message') {
        assert.equal(events[0].payload.data.kind, 'interactive');
        assert.equal(events[0].payload.data.interactive?.id, 'btn_consultar_saldo');
      }
    });

    test('8.4: Send command dispatches to realtime socket room and returns dispatched result', async () => {
      const cmd: SendMessageCommandV1 = {
        schemaVersion: 1,
        tenantId: '1',
        connectionId: 'conn-wc-prod-01',
        conversationId: 'wc_conv_42',
        effectKey: 'eff_wc_send_01',
        message: {
          kind: 'text',
          text: 'Estimado usuario, con gusto le colaboramos con su solicitud.',
        },
      };

      const res = await wcAdapter.send(cmd);
      assert.ok(sendMessageResultV1Schema.safeParse(res).success);
      assert.equal(res.accepted, true);
      assert.equal(res.deliveryState, 'dispatched');
      assert.equal(res.rawStatus, 'dispatched_realtime');
      assert.ok(res.providerMessageId && res.providerMessageId.startsWith('wc_msg_'));
    });

    test('8.5: Free-form text message succeeds without 24-hour window restriction', async () => {
      // In Meta Cloud, lastCustomerInteractionAt older than 24h triggers CH_WA_WINDOW_CLOSED.
      // In Webchat, no 24h window restriction exists!
      const cmd: SendMessageCommandV1 = {
        schemaVersion: 1,
        tenantId: '1',
        connectionId: 'conn-wc-prod-01',
        conversationId: 'wc_conv_42',
        effectKey: 'eff_wc_no_window',
        message: {
          kind: 'text',
          text: 'Mensaje libre después de semanas de inactividad.',
          parameters: {
            lastCustomerInteractionAt: new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString(), // 30 days ago!
          },
        },
      };

      const res = await wcAdapter.send(cmd);
      assert.equal(res.accepted, true);
      assert.equal(res.deliveryState, 'dispatched');
    });

    test('8.6: getCapabilities returns exact Webchat capability set', async () => {
      const caps = await wcAdapter.getCapabilities('conn-wc-prod-01');
      assert.equal(caps.has('text'), true);
      assert.equal(caps.has('image'), true);
      assert.equal(caps.has('document'), true);
      assert.equal(caps.has('interactive'), true);
      assert.equal(caps.has('read-receipt'), true);
      assert.equal(caps.has('typing'), true);
      assert.equal(caps.has('template'), false, 'Webchat does not require HSM templates');
    });
  });

  // ===========================================================================
  // SUITE 9: Webchat Real-time Transport & Room Isolation
  // ===========================================================================
  describe('Suite 9: Webchat Real-time Transport & Room Isolation', () => {
    test('9.1: Emits strictly to conversation room via socketEmitter.emitConversation', async () => {
      const cmd: SendMessageCommandV1 = {
        schemaVersion: 1,
        tenantId: '1',
        connectionId: 'conn-wc-prod-01',
        conversationId: 'conv_alpha_77',
        effectKey: 'eff_rt_01',
        message: { kind: 'text', text: 'Realtime socket test' },
      };

      await wcAdapter.send(cmd);
      assert.equal(emittedSocketEvents.length, 1);
      const em = emittedSocketEvents[0];
      assert.equal(em.tenantId, '1');
      assert.equal(em.conversationId, 'conv_alpha_77');
      assert.equal(em.event, 'webchat.agent_message');
    });

    test('9.2: Emission payload contains message, conversationId, tenantId and connectionId', async () => {
      const cmd: SendMessageCommandV1 = {
        schemaVersion: 1,
        tenantId: '1',
        connectionId: 'conn-wc-prod-01',
        conversationId: 'conv_alpha_77',
        effectKey: 'eff_rt_02',
        message: { kind: 'text', text: 'Payload audit' },
        causedBy: { type: 'agent', id: 'agent_007' },
      };

      await wcAdapter.send(cmd);
      const payload = emittedSocketEvents[0].payload;
      assert.equal(payload.conversationId, 'conv_alpha_77');
      assert.equal(payload.tenantId, '1');
      assert.equal(payload.connectionId, 'conn-wc-prod-01');
      assert.equal(payload.causedBy?.id, 'agent_007');
      assert.equal(payload.message.text, 'Payload audit');
    });

    test('9.3: Multi-tenant room isolation: Tenant 1 and Tenant 2 emit strictly to distinct tenant rooms', async () => {
      await wcAdapter.send({
        schemaVersion: 1,
        tenantId: '1',
        connectionId: 'conn-wc-prod-01',
        conversationId: 'conv_t1',
        effectKey: 'eff_t1',
        message: { kind: 'text', text: 'Message for Tenant 1' },
      });

      await wcAdapter.send({
        schemaVersion: 1,
        tenantId: '2',
        connectionId: 'conn-wc-tenant2',
        conversationId: 'conv_t2',
        effectKey: 'eff_t2',
        message: { kind: 'text', text: 'Message for Tenant 2' },
      });

      assert.equal(emittedSocketEvents.length, 2);
      assert.equal(emittedSocketEvents[0].tenantId, '1');
      assert.equal(emittedSocketEvents[0].conversationId, 'conv_t1');

      assert.equal(emittedSocketEvents[1].tenantId, '2');
      assert.equal(emittedSocketEvents[1].conversationId, 'conv_t2');
    });
  });

  // ===========================================================================
  // SUITE 10: Webchat Connection Health & Diagnostic Lifecycle
  // ===========================================================================
  describe('Suite 10: Webchat Connection Health & Diagnostic Lifecycle', () => {
    test('10.1: Active connection with secret configured returns configured: true, authorized: true', async () => {
      const health = await wcAdapter.health('conn-wc-prod-01');
      assert.equal(health.configured, true);
      assert.equal(health.authorized, true);
      assert.equal(health.lastErrorCode, null);
    });

    test('10.2: Connection with status needs_reauthorization returns authorized: false with SECRET_EXPIRED', async () => {
      const health = await wcAdapter.health('conn-wc-needs-reauth');
      assert.equal(health.configured, true);
      assert.equal(health.authorized, false);
      assert.equal(health.lastErrorCode, 'SECRET_EXPIRED');
    });

    test('10.3: Inactive connection returns authorized: false with CONNECTION_INACTIVE', async () => {
      const health = await wcAdapter.health('conn-wc-inactive');
      assert.equal(health.configured, true);
      assert.equal(health.authorized, false);
      assert.equal(health.lastErrorCode, 'CONNECTION_INACTIVE');
    });

    test('10.4: Connection without secret configured returns configured: false with MISSING_SECRET', async () => {
      const noSecretAdapter = new WebchatAdapter({
        pool: mockPool,
        jwtSecret: '', // no fallback secret
      });

      const health = await noSecretAdapter.health('conn-wc-no-secret');
      assert.equal(health.configured, false);
      assert.equal(health.authorized, false);
      assert.equal(health.lastErrorCode, 'MISSING_SECRET');
    });

    test('10.5: Non-existent connection returns configured: false with CONNECTION_NOT_FOUND', async () => {
      const health = await wcAdapter.health('conn-wc-non-existent');
      assert.equal(health.configured, false);
      assert.equal(health.authorized, false);
      assert.equal(health.lastErrorCode, 'CONNECTION_NOT_FOUND');
    });
  });
});
