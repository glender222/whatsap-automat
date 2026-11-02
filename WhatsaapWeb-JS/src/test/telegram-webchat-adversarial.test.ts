// Invariants before config load
process.env.JWT_SECRET = 'test-only-jwt-secret-with-at-least-32-characters-for-testing';
process.env.DB_PASSWORD = 'test-only-database-password';

import assert from 'node:assert/strict';
import { describe, test, beforeEach } from 'node:test';
import crypto from 'node:crypto';
import type { Pool, QueryResult } from 'pg';

import {
  channelEventV1Schema,
  SendMessageCommandV1,
  InboundConnectionResolutionRequest,
} from '@whatsap-automat/contracts';

const { TelegramBotAdapter } = require('../services/channels/TelegramBotAdapter') as typeof import('../services/channels/TelegramBotAdapter');
const { WebchatAdapter } = require('../services/channels/WebchatAdapter') as typeof import('../services/channels/WebchatAdapter');

// -----------------------------------------------------------------------------
// Adversarial In-Memory Database Engine & Mock Pool
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

function createAdversarialMockPool() {
  const channelConnections: MockChannelConnectionRow[] = [
    {
      id: 'conn-tg-t1',
      tenant_id: 1,
      workspace_id: 1,
      channel: 'telegram',
      account_id: 'bot_alpha_t1',
      name: 'Telegram Tenant 1',
      status: 'active',
      credentials_encrypted: {
        botToken: 'bot123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11',
        secretToken: 'secret-token-t1-constant-length-123',
      },
      metadata_json: { botUsername: 'AlphaBot' },
    },
    {
      id: 'conn-tg-t2',
      tenant_id: 2,
      workspace_id: 2,
      channel: 'telegram',
      account_id: 'bot_beta_t2',
      name: 'Telegram Tenant 2',
      status: 'active',
      credentials_encrypted: {
        botToken: 'bot987654:XYZ-TENANT2-TOKEN',
        secretToken: 'secret-token-t2-different-length-99999',
      },
      metadata_json: { botUsername: 'BetaBot' },
    },
    {
      id: 'conn-tg-unicode',
      tenant_id: 1,
      workspace_id: 1,
      channel: 'telegram',
      account_id: 'bot_unicode',
      name: 'Telegram Unicode Secret',
      status: 'active',
      credentials_encrypted: {
        botToken: 'bot_unicode_token',
        secretToken: 'secret-with-emojis-🎉-and-kanji-日本語-🔒',
      },
      metadata_json: {},
    },
    {
      id: 'conn-tg-inactive',
      tenant_id: 1,
      workspace_id: 1,
      channel: 'telegram',
      account_id: 'bot_inactive',
      name: 'Telegram Inactive',
      status: 'inactive',
      credentials_encrypted: {
        botToken: 'bot_inactive_token',
        secretToken: 'inactive-secret-token',
      },
      metadata_json: {},
    },
    {
      id: 'conn-tg-non-string-secret',
      tenant_id: 1,
      workspace_id: 1,
      channel: 'telegram',
      account_id: 'bot_numeric_secret',
      name: 'Telegram Non-String Secret in DB',
      status: 'active',
      credentials_encrypted: {
        botToken: 'bot_token_num',
        secretToken: 123456789 as any,
      },
      metadata_json: {},
    },
    {
      id: 'conn-webchat-t1',
      tenant_id: 1,
      workspace_id: 1,
      channel: 'webchat',
      account_id: 'webchat-widget-t1',
      name: 'Webchat Tenant 1',
      status: 'active',
      credentials_encrypted: {
        visitorJwtSecret: 'webchat-tenant1-secret-key-at-least-32-chars-long!',
      },
      metadata_json: {},
    },
    {
      id: 'conn-webchat-t2',
      tenant_id: 2,
      workspace_id: 2,
      channel: 'webchat',
      account_id: 'webchat-widget-t2',
      name: 'Webchat Tenant 2',
      status: 'active',
      credentials_encrypted: {
        visitorJwtSecret: 'webchat-tenant2-secret-key-at-least-32-chars-long!',
      },
      metadata_json: {},
    },
    {
      id: 'conn-webchat-inactive',
      tenant_id: 1,
      workspace_id: 1,
      channel: 'webchat',
      account_id: 'webchat-inactive',
      name: 'Webchat Inactive',
      status: 'inactive',
      credentials_encrypted: {
        visitorJwtSecret: 'webchat-inactive-secret-key-at-least-32-chars!',
      },
      metadata_json: {},
    },
  ];

  return {
    async query(textOrConfig: string | { text: string; values?: unknown[] }, values?: unknown[]): Promise<QueryResult<any>> {
      const sql = typeof textOrConfig === 'string' ? textOrConfig : textOrConfig.text;
      const params = typeof textOrConfig === 'string' ? (values || []) : (textOrConfig.values || []);

      // 1. SELECT by id
      if (sql.includes('WHERE id = $1')) {
        const id = String(params[0]);
        let filtered = channelConnections.filter((c) => c.id === id);

        if (sql.includes("channel = 'telegram'")) {
          filtered = filtered.filter((c) => c.channel === 'telegram');
        } else if (sql.includes("channel = 'webchat'")) {
          filtered = filtered.filter((c) => c.channel === 'webchat');
        }

        if (sql.includes("status <> 'inactive'")) {
          filtered = filtered.filter((c) => c.status !== 'inactive');
        }

        return {
          rows: filtered,
          rowCount: filtered.length,
          command: 'SELECT',
          oid: 0,
          fields: [],
        };
      }

      // 2. SELECT by secretToken
      if (sql.includes("credentials_encrypted->>'secretToken' = $1") || sql.includes("credentials_encrypted->>'secret_token' = $1")) {
        const secret = params[0];
        const rows = channelConnections.filter(
          (c) =>
            c.channel === 'telegram' &&
            c.status !== 'inactive' &&
            c.credentials_encrypted &&
            (String(c.credentials_encrypted.secretToken) === String(secret) ||
             String(c.credentials_encrypted.secret_token) === String(secret))
        );
        return {
          rows,
          rowCount: rows.length,
          command: 'SELECT',
          oid: 0,
          fields: [],
        };
      }

      // 3. Fallback tenant_id lookup
      if (sql.includes('SELECT tenant_id FROM channel_connections WHERE id = $1')) {
        const id = String(params[0]);
        const found = channelConnections.find((c) => c.id === id);
        return {
          rows: found ? [{ tenant_id: found.tenant_id }] : [],
          rowCount: found ? 1 : 0,
          command: 'SELECT',
          oid: 0,
          fields: [],
        };
      }

      return { rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] };
    },
  };
}

describe('Empirical Adversarial Challenges: TelegramBotAdapter & WebchatAdapter', () => {
  let dbPool: ReturnType<typeof createAdversarialMockPool>;
  let telegramAdapter: InstanceType<typeof TelegramBotAdapter>;
  let webchatAdapter: InstanceType<typeof WebchatAdapter>;

  beforeEach(() => {
    dbPool = createAdversarialMockPool();
    telegramAdapter = new TelegramBotAdapter({
      pool: dbPool as unknown as Pool,
      secretToken: 'fallback-telegram-secret-token',
      botToken: 'fallback-telegram-bot-token',
    });
    webchatAdapter = new WebchatAdapter({
      pool: dbPool as unknown as Pool,
      jwtSecret: 'fallback-webchat-jwt-secret-at-least-32-chars!',
    });
  });

  // ===========================================================================
  // SECTION 1: Timing Attacks & Secret Token Spoofing
  // ===========================================================================
  describe('Vector 1: Timing Attacks & Secret Token Spoofing', () => {
    test('1.1 Different token lengths: 1 char, short, long (10KB) return false without throwing', async () => {
      const connId = 'conn-tg-t1';
      const emptyRaw = new Uint8Array();

      const tokensToTest = [
        's',
        'se',
        'sec',
        'secret-token-t1-constant-length-12', // 1 char shorter
        'secret-token-t1-constant-length-1234', // 1 char longer
        'a'.repeat(256),
        'a'.repeat(1024),
        'a'.repeat(10000), // 10KB
      ];

      for (const token of tokensToTest) {
        const valid = await telegramAdapter.verifyInbound(connId, emptyRaw, {
          'x-telegram-bot-api-secret-token': token,
        });
        assert.equal(valid, false, `Expected token of length ${token.length} to be rejected`);
      }
    });

    test('1.2 Empty, whitespace-only, null, and undefined secret headers return false safely', async () => {
      const connId = 'conn-tg-t1';
      const emptyRaw = new Uint8Array();

      assert.equal(await telegramAdapter.verifyInbound(connId, emptyRaw, {}), false);
      assert.equal(await telegramAdapter.verifyInbound(connId, emptyRaw, { 'x-telegram-bot-api-secret-token': '' }), false);
      assert.equal(await telegramAdapter.verifyInbound(connId, emptyRaw, { 'x-telegram-bot-api-secret-token': '   ' }), false);
      assert.equal(await telegramAdapter.verifyInbound(connId, emptyRaw, { 'x-telegram-bot-api-secret-token': undefined }), false);
      assert.equal(await telegramAdapter.verifyInbound(connId, emptyRaw, null as any), false);
      assert.equal(await telegramAdapter.verifyInbound(connId, emptyRaw, undefined as any), false);
      assert.equal(await telegramAdapter.verifyInbound(connId, emptyRaw, 'invalid-headers-type' as any), false);
    });

    test('1.3 Multiple duplicate headers (string[]) do not crash verifyInbound', async () => {
      const connId = 'conn-tg-t1';
      const emptyRaw = new Uint8Array();

      // In Node.js http, duplicate headers are parsed as string[]
      const multiHeaders = {
        'x-telegram-bot-api-secret-token': ['secret-token-t1-constant-length-123', 'second-token'] as any,
      };

      const valid = await telegramAdapter.verifyInbound(connId, emptyRaw, multiHeaders);
      assert.equal(valid, false, 'Array of headers must be rejected safely');
    });

    test('1.4 Unicode and Multi-byte UTF-8 secrets: correctly validated or rejected based on exact bytes', async () => {
      const connId = 'conn-tg-unicode';
      const emptyRaw = new Uint8Array();
      const validUnicodeSecret = 'secret-with-emojis-🎉-and-kanji-日本語-🔒';

      // Authentic unicode token matches
      const valid = await telegramAdapter.verifyInbound(connId, emptyRaw, {
        'x-telegram-bot-api-secret-token': validUnicodeSecret,
      });
      assert.equal(valid, true, 'Authentic multi-byte unicode secret must pass');

      // Tampered emoji or kanji
      const tamperedEmoji = 'secret-with-emojis-🎊-and-kanji-日本語-🔒';
      assert.equal(await telegramAdapter.verifyInbound(connId, emptyRaw, {
        'x-telegram-bot-api-secret-token': tamperedEmoji,
      }), false);

      // Null byte injection attempt
      const nullByteSecret = validUnicodeSecret + '\0';
      assert.equal(await telegramAdapter.verifyInbound(connId, emptyRaw, {
        'x-telegram-bot-api-secret-token': nullByteSecret,
      }), false);
    });

    test('1.5 Timing safe equal execution does not throw RangeError on mismatched buffer lengths', async () => {
      const connId = 'conn-tg-t1';
      const emptyRaw = new Uint8Array();

      assert.doesNotThrow(async () => {
        const result = await telegramAdapter.verifyInbound(connId, emptyRaw, {
          'x-telegram-bot-api-secret-token': 'different-length',
        });
        assert.equal(result, false);
      });
    });

    test('1.6 Fallback to adapter configuration when connection has no secret in DB', async () => {
      const adapterWithSecret = new TelegramBotAdapter({
        pool: dbPool as unknown as Pool,
        secretToken: 'custom-adapter-fallback-secret',
      });

      const valid = await adapterWithSecret.verifyInbound('conn-nonexistent', new Uint8Array(), {
        'x-telegram-bot-api-secret-token': 'custom-adapter-fallback-secret',
      });
      assert.equal(valid, true, 'Should match adapter secretToken when DB yields no credentials');

      const invalid = await adapterWithSecret.verifyInbound('conn-nonexistent', new Uint8Array(), {
        'x-telegram-bot-api-secret-token': 'wrong-secret',
      });
      assert.equal(invalid, false);
    });
  });

  // ===========================================================================
  // SECTION 2: Tenancy Resolution & Fail-Closed Boundaries (MSG-05)
  // ===========================================================================
  describe('Vector 2: Tenancy Resolution (MSG-05 Fail-Closed)', () => {
    test('2.1 Requests targeting nonexistent pathKey return null strictly (never default company)', async () => {
      const maliciousPaths = [
        'nonexistent-conn-id',
        '../etc/passwd',
        "' OR 1=1 --",
        'conn-tg-t1; DROP TABLE channel_connections;',
        'undefined',
        'null',
      ];

      for (const pathKey of maliciousPaths) {
        const req: InboundConnectionResolutionRequest = {
          headers: {},
          pathKey,
          rawBody: new Uint8Array(),
        };
        const resolved = await telegramAdapter.resolveInboundConnection(req);
        assert.equal(resolved, null, `pathKey "${pathKey}" must resolve to null`);
      }
    });

    test('2.2 Requests targeting inactive connections return null fail-closed', async () => {
      // By pathKey
      const reqPath: InboundConnectionResolutionRequest = {
        headers: {},
        pathKey: 'conn-tg-inactive',
        rawBody: new Uint8Array(),
      };
      assert.equal(await telegramAdapter.resolveInboundConnection(reqPath), null);

      // By secret token
      const reqSecret: InboundConnectionResolutionRequest = {
        headers: {
          'x-telegram-bot-api-secret-token': 'inactive-secret-token',
        },
        pathKey: null,
        rawBody: new Uint8Array(),
      };
      assert.equal(await telegramAdapter.resolveInboundConnection(reqSecret), null);
    });

    test('2.3 Secret token belonging to Tenant 2 strictly resolves to Tenant 2 and NEVER Tenant 1', async () => {
      const reqT2: InboundConnectionResolutionRequest = {
        headers: {
          'x-telegram-bot-api-secret-token': 'secret-token-t2-different-length-99999',
        },
        pathKey: null,
        rawBody: new Uint8Array(),
      };

      const resolved = await telegramAdapter.resolveInboundConnection(reqT2);
      assert.ok(resolved !== null, 'Tenant 2 secret must resolve');
      assert.equal(resolved.tenantId, '2');
      assert.equal(resolved.connectionId, 'conn-tg-t2');
      assert.notEqual(resolved.tenantId, '1', 'Must NEVER resolve to default company 1');
    });

    test('2.4 Cross-tenant attack: pathKey for Tenant 1 with secret token for Tenant 2', async () => {
      const req: InboundConnectionResolutionRequest = {
        headers: {
          'x-telegram-bot-api-secret-token': 'secret-token-t2-different-length-99999', // Tenant 2 secret
        },
        pathKey: 'conn-tg-t1', // Tenant 1 pathKey
        rawBody: new Uint8Array(),
      };

      // Step 1: Resolution resolves to conn-tg-t1 based on pathKey
      const resolved = await telegramAdapter.resolveInboundConnection(req);
      assert.ok(resolved !== null);
      assert.equal(resolved.connectionId, 'conn-tg-t1');
      assert.equal(resolved.tenantId, '1');

      // Step 2: Verification with Tenant 2 secret against conn-tg-t1 MUST FAIL (403 MSG-04)
      const verify = await telegramAdapter.verifyInbound(resolved.connectionId, new Uint8Array(), req.headers);
      assert.equal(verify, false, 'Tenant 2 secret token against Tenant 1 connection MUST fail verification');
    });

    test('2.5 Inbound requests without credentials or pathKey NEVER resolve to default tenant', async () => {
      const emptyReqs: InboundConnectionResolutionRequest[] = [
        { headers: {}, pathKey: null, rawBody: new Uint8Array() },
        { headers: { 'user-agent': 'TelegramBot (like TwitterBot)' }, pathKey: null, rawBody: new Uint8Array() },
        { headers: { 'content-type': 'application/json' }, pathKey: null, rawBody: new Uint8Array() },
        { headers: { 'x-forwarded-for': '149.154.167.220' }, pathKey: null, rawBody: new Uint8Array() },
      ];

      for (const req of emptyReqs) {
        const resolved = await telegramAdapter.resolveInboundConnection(req);
        assert.equal(resolved, null, 'Must fail closed and return null');
      }
    });

    test('2.6 Webchat tenancy fail-closed: forged token, expired token, or cross-tenant token returns null', async () => {
      // 1. Forged token signed with wrong secret
      const forgedToken = webchatAdapter.mintVisitorToken(
        { tenantId: '1', connectionId: 'conn-webchat-t1', visitorId: 'vis-1' },
        'attacker-controlled-secret-key-at-least-32-chars!'
      );
      assert.equal(
        await webchatAdapter.resolveInboundConnection({
          headers: { 'x-visitor-token': forgedToken },
          pathKey: null,
          rawBody: new Uint8Array(),
        }),
        null,
        'Forged token must return null'
      );

      // 2. Expired token (expiresIn: -10s)
      const expiredToken = webchatAdapter.mintVisitorToken(
        { tenantId: '1', connectionId: 'conn-webchat-t1', visitorId: 'vis-1', expiresInSeconds: -10 },
        'webchat-tenant1-secret-key-at-least-32-chars-long!'
      );
      assert.equal(
        await webchatAdapter.resolveInboundConnection({
          headers: { 'x-visitor-token': expiredToken },
          pathKey: null,
          rawBody: new Uint8Array(),
        }),
        null,
        'Expired token must return null'
      );

      // 3. Cross-tenant token: Claims claim tenantId: 2, but connection is conn-webchat-t1 (tenant 1)
      const crossTenantToken = webchatAdapter.mintVisitorToken(
        { tenantId: '2', connectionId: 'conn-webchat-t1', visitorId: 'vis-attacker' },
        'webchat-tenant1-secret-key-at-least-32-chars-long!'
      );
      assert.equal(
        await webchatAdapter.resolveInboundConnection({
          headers: { 'x-visitor-token': crossTenantToken },
          pathKey: null,
          rawBody: new Uint8Array(),
        }),
        null,
        'Cross-tenant claims mismatch must return null'
      );
    });
  });

  // ===========================================================================
  // SECTION 3: Malformed Payloads & Update Fuzzing
  // ===========================================================================
  describe('Vector 3: Malformed Payloads & Update Fuzzing', () => {
    test('3.1 Corrupted JSON buffers and non-JSON strings return empty array without crashing', async () => {
      const connId = 'conn-tg-t1';

      const corruptedInputs = [
        Buffer.from('not json at all'),
        Buffer.from('{ "update_id": 123, "truncated": '),
        Buffer.from([0xff, 0xfe, 0x00, 0x01]), // Binary garbage
        'syntax error json string',
        '',
        null,
        undefined,
        12345,
        true,
        {},
        [],
      ];

      for (const input of corruptedInputs) {
        const events = await telegramAdapter.normalizeInbound(connId, input);
        assert.ok(Array.isArray(events), 'Must always return an array');
        assert.equal(events.length, 0, 'Malformed input must result in 0 events');
      }
    });

    test('3.2 Updates with missing message, empty text, or unsupported events return empty array safely', async () => {
      const connId = 'conn-tg-t1';

      const unsupportedUpdates = [
        { update_id: 100 }, // No message
        { update_id: 101, message: {} }, // Empty message
        { update_id: 102, message: { text: '' } }, // Empty text string
        { update_id: 103, message: { new_chat_members: [{ id: 123 }] } }, // Service message
        { update_id: 104, message: { left_chat_member: { id: 123 } } }, // Service message
        { update_id: 105, message: { poll: { id: 'poll-1' } } }, // Poll
        { update_id: 106, message: { location: { latitude: 0, longitude: 0 } } }, // Location
      ];

      for (const update of unsupportedUpdates) {
        const events = await telegramAdapter.normalizeInbound(connId, update);
        assert.equal(events.length, 0, `Update ${JSON.stringify(update)} should yield 0 events`);
      }
    });

    test('3.3 Non-array or empty photo updates safely produce 0 events', async () => {
      const connId = 'conn-tg-t1';

      const updates = [
        { update_id: 201, message: { chat: { id: 123 }, photo: [] } }, // Empty array
        { update_id: 202, message: { chat: { id: 123 }, photo: null } }, // Null photo
        { update_id: 203, message: { chat: { id: 123 }, photo: 'not-an-array' } }, // String instead of array
      ];

      for (const update of updates) {
        const events = await telegramAdapter.normalizeInbound(connId, update);
        assert.equal(events.length, 0, 'Empty or invalid photo array must produce 0 events');
      }
    });

    test('3.4 Empty callback query or callback query missing message/from handled safely', async () => {
      const connId = 'conn-tg-t1';

      const malformedCallbackQueries = [
        { update_id: 301, callback_query: {} }, // Empty callback query
        { update_id: 302, callback_query: { id: 'cb-1' } }, // Missing chat/from and data
        { update_id: 303, callback_query: { id: 'cb-2', data: '' } }, // Empty data (schema requires min(1))
        { update_id: 304, callback_query: { id: '', data: 'some-data' } }, // Empty ID
      ];

      for (const update of malformedCallbackQueries) {
        const events = await telegramAdapter.normalizeInbound(connId, update);
        assert.equal(events.length, 0, 'Malformed callback query must produce 0 events');
      }
    });

    test('3.5 Timestamp fuzzing: negative, zero, string, ISO, and millisecond timestamps normalize safely', async () => {
      const connId = 'conn-tg-t1';

      const timestamps = [
        -100, // Negative unix timestamp
        0, // Zero
        1730000000, // Unix seconds
        1730000000000, // Unix milliseconds
        '1730000000', // String seconds
        '2026-11-02T03:00:00.000Z', // ISO string
        'invalid-date-string', // Junk string
        null, // Null
        undefined, // Undefined
      ];

      for (const ts of timestamps) {
        const payload = {
          update_id: 400,
          message: {
            message_id: 10,
            chat: { id: 9999 },
            from: { id: 8888 },
            date: ts,
            text: 'Valid test message',
          },
        };

        const events = await telegramAdapter.normalizeInbound(connId, payload);
        assert.equal(events.length, 1, `Timestamp ${ts} should yield 1 valid event`);

        const parse = channelEventV1Schema.safeParse(events[0]);
        assert.ok(parse.success, `Normalized event must satisfy schema: ${JSON.stringify(parse.error)}`);
        assert.ok(events[0].occurredAt.endsWith('Z'), 'occurredAt must be ISO UTC timestamp');
      }
    });

    test('3.6 Batch update array with mixed valid and corrupted entries filters gracefully', async () => {
      const connId = 'conn-tg-t1';

      const batch = [
        { update_id: 501, message: { message_id: 1, chat: { id: 100 }, text: 'Message 1' } },
        { corrupted: 'garbage payload' },
        null,
        { update_id: 502, message: { message_id: 2, chat: { id: 100 }, text: 'Message 2' } },
        { update_id: 503, message: { text: '' } }, // Empty text skipped
        { update_id: 504, callback_query: { id: 'cb504', from: { id: 200 }, data: 'btn_confirm' } },
      ];

      const events = await telegramAdapter.normalizeInbound(connId, batch);
      assert.equal(events.length, 3, 'Should normalize exactly 3 valid events (2 messages + 1 callback)');
      assert.equal(events[0].eventType, 'message.received');
      assert.equal(events[1].eventType, 'message.received');
      assert.equal(events[2].eventType, 'interaction.received');
    });
  });

  // ===========================================================================
  // SECTION 4: Error Mapping & Health Check Edge Cases
  // ===========================================================================
  describe('Vector 4: Error Mapping & Health Check Edge Cases', () => {
    test('4.1 Outbound HTTP 403 Forbidden (bot blocked by user) maps to failed state', async () => {
      const blockedFetch: typeof fetch = async () => {
        return {
          ok: false,
          status: 403,
          json: async () => ({
            ok: false,
            error_code: 403,
            description: 'Forbidden: bot was blocked by the user',
          }),
        } as any;
      };

      const adapter = new TelegramBotAdapter({
        pool: dbPool as unknown as Pool,
        fetchFn: blockedFetch,
      });

      const cmd: SendMessageCommandV1 = {
        schemaVersion: 1,
        tenantId: '1',
        connectionId: 'conn-tg-t1',
        conversationId: 'chat_user_123',
        effectKey: 'eff_block_403',
        expectedConversationVersion: 1,
        causedBy: { type: 'agent', id: 'agent-1' },
        message: { kind: 'text', text: 'Hello blocked user' },
      };

      const result = await adapter.send(cmd);
      assert.equal(result.accepted, false);
      assert.equal(result.deliveryState, 'failed');
      assert.equal(result.rawStatus, 'Forbidden: bot was blocked by the user');
    });

    test('4.2 Outbound HTTP 429 Rate Limit maps to failed delivery state', async () => {
      const rateLimitFetch: typeof fetch = async () => {
        return {
          ok: false,
          status: 429,
          json: async () => ({
            ok: false,
            error_code: 429,
            description: 'Too Many Requests: retry after 30',
            parameters: { retry_after: 30 },
          }),
        } as any;
      };

      const adapter = new TelegramBotAdapter({
        pool: dbPool as unknown as Pool,
        fetchFn: rateLimitFetch,
      });

      const cmd: SendMessageCommandV1 = {
        schemaVersion: 1,
        tenantId: '1',
        connectionId: 'conn-tg-t1',
        conversationId: 'chat_user_123',
        effectKey: 'eff_rate_429',
        expectedConversationVersion: 1,
        causedBy: { type: 'system', id: 'sys-1' },
        message: { kind: 'text', text: 'High throughput test' },
      };

      const result = await adapter.send(cmd);
      assert.equal(result.accepted, false);
      assert.equal(result.deliveryState, 'failed');
      assert.ok(result.rawStatus.includes('Too Many Requests'));
    });

    test('4.3 Outbound network timeout (AbortError / ETIMEDOUT) does not throw unhandled rejection', async () => {
      const timeoutFetch: typeof fetch = async () => {
        const err: any = new Error('The operation was aborted');
        err.name = 'AbortError';
        err.code = 'ETIMEDOUT';
        throw err;
      };

      const adapter = new TelegramBotAdapter({
        pool: dbPool as unknown as Pool,
        fetchFn: timeoutFetch,
      });

      const cmd: SendMessageCommandV1 = {
        schemaVersion: 1,
        tenantId: '1',
        connectionId: 'conn-tg-t1',
        conversationId: 'chat_user_timeout',
        effectKey: 'eff_timeout',
        expectedConversationVersion: 1,
        causedBy: { type: 'human', id: 'agent-1' },
        message: { kind: 'text', text: 'Timeout test' },
      };

      const result = await adapter.send(cmd);
      assert.equal(result.accepted, false);
      assert.equal(result.deliveryState, 'failed');
      assert.equal(result.rawStatus, 'The operation was aborted');
    });

    test('4.4 Outbound non-JSON / HTML 502 Bad Gateway response handled gracefully', async () => {
      const html502Fetch: typeof fetch = async () => {
        return {
          ok: false,
          status: 502,
          json: async () => {
            throw new SyntaxError('Unexpected token < in JSON at position 0');
          },
        } as any;
      };

      const adapter = new TelegramBotAdapter({
        pool: dbPool as unknown as Pool,
        fetchFn: html502Fetch,
      });

      const cmd: SendMessageCommandV1 = {
        schemaVersion: 1,
        tenantId: '1',
        connectionId: 'conn-tg-t1',
        conversationId: 'chat_user_123',
        effectKey: 'eff_502',
        expectedConversationVersion: 1,
        causedBy: { type: 'human', id: 'agent-1' },
        message: { kind: 'text', text: '502 test' },
      };

      const result = await adapter.send(cmd);
      assert.equal(result.accepted, false);
      assert.equal(result.deliveryState, 'failed');
      assert.equal(result.rawStatus, 'HTTP_502');
    });

    test('4.5 Health check HTTP 401 Unauthorized maps to authorized: false, lastErrorCode: TOKEN_EXPIRED (CH-02)', async () => {
      const unauthFetch: typeof fetch = async () => {
        return {
          ok: false,
          status: 401,
          json: async () => ({
            ok: false,
            error_code: 401,
            description: 'Unauthorized',
          }),
        } as any;
      };

      const adapter = new TelegramBotAdapter({
        pool: dbPool as unknown as Pool,
        fetchFn: unauthFetch,
      });

      const health = await adapter.health('conn-tg-t1');
      assert.equal(health.configured, true);
      assert.equal(health.authorized, false);
      assert.equal(health.lastErrorCode, 'TOKEN_EXPIRED');
      assert.ok(health.lastCheckedAt.endsWith('Z'));
    });

    test('4.6 Health check network outage maps to lastErrorCode: NETWORK_ERROR or error code', async () => {
      const networkDownFetch: typeof fetch = async () => {
        const err: any = new Error('connect ECONNREFUSED 149.154.167.220:443');
        err.code = 'ECONNREFUSED';
        throw err;
      };

      const adapter = new TelegramBotAdapter({
        pool: dbPool as unknown as Pool,
        fetchFn: networkDownFetch,
      });

      const health = await adapter.health('conn-tg-t1');
      assert.equal(health.configured, true);
      assert.equal(health.authorized, false);
      assert.equal(health.lastErrorCode, 'ECONNREFUSED');
    });

    test('4.7 Health check HTTP 500 maps to structured API_ERROR_500 code', async () => {
      const error500Fetch: typeof fetch = async () => {
        return {
          ok: false,
          status: 500,
          json: async () => ({ ok: false, error_code: 500, description: 'Internal Server Error' }),
        } as any;
      };

      const adapter = new TelegramBotAdapter({
        pool: dbPool as unknown as Pool,
        fetchFn: error500Fetch,
      });

      const health = await adapter.health('conn-tg-t1');
      assert.equal(health.configured, true);
      assert.equal(health.authorized, false);
      assert.equal(health.lastErrorCode, 'API_ERROR_500');
    });
  });

  // ===========================================================================
  // SECTION 5: Hardened Invariant Verification & Crash Vector Remediations
  // ===========================================================================
  describe('Vector 5: Hardened Invariant Verification & Crash Vector Remediations', () => {
    test('BUG-1: Malformed photo array [null] normalizes safely without throwing', async () => {
      const connId = 'conn-tg-t1';
      const malformedPayload = {
        update_id: 9991,
        message: {
          chat: { id: 123 },
          photo: [null], // Corrupted array element
        },
      };

      const events = await telegramAdapter.normalizeInbound(connId, malformedPayload);
      assert.deepEqual(events, []);
    });

    test('BUG-2: Non-string secretToken in DB returns false fail-closed without throwing', async () => {
      const connId = 'conn-tg-non-string-secret'; // credentials_encrypted: { secretToken: 123456789 }

      const valid = await telegramAdapter.verifyInbound(connId, new Uint8Array(), {
        'x-telegram-bot-api-secret-token': '123456789',
      });
      assert.equal(valid, false);
    });

    test('BUG-3: Integer overflow timestamp falls back safely without throwing RangeError', async () => {
      const connId = 'conn-tg-t1';
      const overflowPayload = {
        update_id: 9993,
        message: {
          chat: { id: 123 },
          text: 'Message with overflow date',
          date: 1e16, // > 8.64e15 ms max date limit
        },
      };

      const events = await telegramAdapter.normalizeInbound(connId, overflowPayload);
      assert.ok(Array.isArray(events));
      assert.equal(events.length, 1);
      assert.ok(events[0].occurredAt);
    });

    test('BUG-4: Missing req.headers resolves safely without throwing TypeError', async () => {
      // 1. TelegramBotAdapter with missing headers resolves pathKey
      const tgRequestWithoutHeaders = {
        pathKey: 'conn-tg-t1',
        rawBody: new Uint8Array(),
      } as unknown as InboundConnectionResolutionRequest;

      const tgResolved = await telegramAdapter.resolveInboundConnection(tgRequestWithoutHeaders);
      assert.ok(tgResolved);
      assert.equal(tgResolved.connectionId, 'conn-tg-t1');
      assert.equal(tgResolved.tenantId, '1');

      // 2. WebchatAdapter with missing headers resolves pathKey
      const wcRequestWithoutHeaders = {
        pathKey: 'conn-webchat-t1',
        rawBody: new Uint8Array(),
      } as unknown as InboundConnectionResolutionRequest;

      const wcResolved = await webchatAdapter.resolveInboundConnection(wcRequestWithoutHeaders);
      assert.ok(wcResolved);
      assert.equal(wcResolved.connectionId, 'conn-webchat-t1');
      assert.equal(wcResolved.tenantId, '1');

      // 3. Request without headers or pathKey fails closed returning null
      const nullResolved = await telegramAdapter.resolveInboundConnection({} as unknown as InboundConnectionResolutionRequest);
      assert.equal(nullResolved, null);
    });
  });
});
