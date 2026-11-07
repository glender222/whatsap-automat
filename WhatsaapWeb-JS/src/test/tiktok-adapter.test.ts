import assert from 'node:assert/strict';
import { describe, test, beforeEach } from 'node:test';
import crypto from 'node:crypto';
import {
  ChannelEventV1,
  channelEventV1Schema,
  SendMessageCommandV1,
} from '@whatsap-automat/contracts';

import { TikTokAdapter } from '../services/channels/TikTokAdapter';

describe('PR-F9-01: TikTok Business Messaging Adapter Unit Suite', () => {
  const mockClientSecret = 'test_tiktok_client_secret_xyz123';
  const mockAccessToken = 'test_tiktok_access_token_abc456';
  const testConnId = 'conn_tt_unit_01';

  let mockDb: any;
  let adapter: TikTokAdapter;

  beforeEach(() => {
    mockDb = {
      query: async (queryText: any, params: any[]) => {
        const sql = typeof queryText === 'string' ? queryText : queryText.text;
        if (sql.includes('SELECT id, tenant_id') && sql.includes("channel = 'tiktok'")) {
          const accountArg = params?.[0];
          if (accountArg === testConnId || accountArg === 'tt_biz_account_99') {
            return {
              rows: [
                {
                  id: testConnId,
                  tenant_id: 1,
                  channel: 'tiktok',
                  account_id: 'tt_biz_account_99',
                  status: 'active',
                },
              ],
            };
          }
          return { rows: [] };
        }
        if (sql.includes('SELECT credentials_encrypted')) {
          return {
            rows: [
              {
                credentials_encrypted: {
                  clientKey: 'tt_client_key_99',
                  clientSecret: mockClientSecret,
                  accessToken: mockAccessToken,
                },
              },
            ],
          };
        }
        if (sql.includes('SELECT tenant_id FROM channel_connections')) {
          return { rows: [{ tenant_id: 1 }] };
        }
        return { rows: [] };
      },
    };

    adapter = new TikTokAdapter({
      pool: mockDb,
      clientSecret: mockClientSecret,
      accessToken: mockAccessToken,
    });
  });

  describe('1. Webhook HMAC-SHA256 Verification (MSG-04)', () => {
    test('accepts valid HMAC-SHA256 signature', async () => {
      const rawPayload = Buffer.from(JSON.stringify({ event: 'message', from_user_id: 'user_123' }), 'utf8');
      const signature = crypto.createHmac('sha256', mockClientSecret).update(rawPayload).digest('hex');

      const verified = await adapter.verifyInbound(testConnId, rawPayload, {
        'x-tiktok-signature': signature,
      });
      assert.strictEqual(verified, true);
    });

    test('accepts signature with sha256= prefix', async () => {
      const rawPayload = Buffer.from('{"test":"payload"}', 'utf8');
      const signature = crypto.createHmac('sha256', mockClientSecret).update(rawPayload).digest('hex');

      const verified = await adapter.verifyInbound(testConnId, rawPayload, {
        'x-tiktok-signature': `sha256=${signature}`,
      });
      assert.strictEqual(verified, true);
    });

    test('rejects forged or altered HMAC signature', async () => {
      const rawPayload = Buffer.from('{"test":"payload"}', 'utf8');
      const forgedSig = crypto.createHmac('sha256', 'wrong_secret').update(rawPayload).digest('hex');

      const verified = await adapter.verifyInbound(testConnId, rawPayload, {
        'x-tiktok-signature': forgedSig,
      });
      assert.strictEqual(verified, false);
    });

    test('rejects missing or empty signature header (fail-closed)', async () => {
      const rawPayload = Buffer.from('{"test":"payload"}', 'utf8');
      assert.strictEqual(await adapter.verifyInbound(testConnId, rawPayload, {}), false);
      assert.strictEqual(await adapter.verifyInbound(testConnId, rawPayload, { 'x-tiktok-signature': '' }), false);
    });
  });

  describe('2. Inbound Connection & Tenancy Resolution (MSG-05)', () => {
    test('resolves connection via pathKey', async () => {
      const res = await adapter.resolveInboundConnection({
        headers: {},
        pathKey: testConnId,
        rawBody: new Uint8Array(),
      });
      assert.ok(res);
      assert.strictEqual(res.connectionId, testConnId);
      assert.strictEqual(res.tenantId, '1');
    });

    test('resolves connection via payload account_id', async () => {
      const payload = Buffer.from(JSON.stringify({ business_id: 'tt_biz_account_99' }));
      const res = await adapter.resolveInboundConnection({
        headers: {},
        pathKey: null,
        rawBody: payload,
      });
      assert.ok(res);
      assert.strictEqual(res.connectionId, testConnId);
    });

    test('returns null when account is unmapped (fail-closed, never fallback)', async () => {
      const payload = Buffer.from(JSON.stringify({ business_id: 'unknown_account_xyz' }));
      const res = await adapter.resolveInboundConnection({
        headers: {},
        pathKey: null,
        rawBody: payload,
      });
      assert.strictEqual(res, null);
    });
  });

  describe('3. Inbound Event Normalization (CH-01)', () => {
    test('normalizes inbound text message to canonical ChannelEventV1', async () => {
      const rawPayload = {
        event_id: 'tt_event_001',
        from_user_id: 'tt_user_99',
        create_time: 1730764800,
        message: {
          message_id: 'tt_m_001',
          message_type: 'text',
          text: 'Hello from TikTok User',
        },
      };

      const events = await adapter.normalizeInbound(testConnId, rawPayload);
      assert.strictEqual(events.length, 1);
      const ev = events[0];

      assert.strictEqual(ev.channel, 'tiktok');
      assert.strictEqual(ev.eventType, 'message.received');
      assert.strictEqual(ev.externalConversationId, 'tt_user_99');
      assert.strictEqual(ev.payload?.kind, 'message');
      if (ev.payload?.kind === 'message') {
        assert.strictEqual(ev.payload.data.kind, 'text');
        assert.strictEqual(ev.payload.data.text, 'Hello from TikTok User');
      }

      // Assert Zod schema conformity
      const schemaCheck = channelEventV1Schema.safeParse(ev);
      assert.ok(schemaCheck.success);
    });

    test('normalizes inbound video media message', async () => {
      const rawPayload = {
        event_id: 'tt_event_002',
        from_user_id: 'tt_user_99',
        create_time: 1730764800,
        message: {
          message_id: 'tt_m_002',
          message_type: 'video',
          video: {
            url: 'https://v16.tiktok.com/vid.mp4',
            media_id: 'vid_tiktok_002',
            size: 5000000,
          },
        },
      };

      const events = await adapter.normalizeInbound(testConnId, rawPayload);
      assert.strictEqual(events.length, 1);
      const ev = events[0];
      assert.strictEqual(ev.payload?.kind, 'message');
      if (ev.payload?.kind === 'message') {
        assert.strictEqual(ev.payload.data.kind, 'media');
        assert.strictEqual(ev.payload.data.media?.mimeType, 'video/mp4');
      }
    });
  });

  describe('4. Outbound Sending & Health Check (CH-02)', () => {
    test('sends text message via TikTok API', async () => {
      let interceptedBody: any;
      const customAdapter = new TikTokAdapter({
        pool: mockDb,
        accessToken: mockAccessToken,
        fetchFn: async (_url: any, init: any) => {
          interceptedBody = JSON.parse(init.body);
          return {
            ok: true,
            status: 200,
            json: async () => ({ code: 0, message: 'success', data: { message_id: 'tt_sent_100' } }),
          } as any;
        },
      });

      const cmd: SendMessageCommandV1 = {
        schemaVersion: 1,
        tenantId: '1',
        connectionId: testConnId,
        conversationId: 'tt_user_99',
        effectKey: 'eff_001',
        expectedConversationVersion: 1,
        causedBy: { type: 'human', id: 'agent_1' },
        message: { kind: 'text', text: 'TikTok reply text' },
      };

      const result = await customAdapter.send(cmd);
      assert.strictEqual(result.accepted, true);
      assert.strictEqual(result.deliveryState, 'dispatched');
      assert.strictEqual(result.providerMessageId, 'tt_sent_100');
      assert.strictEqual(interceptedBody.text, 'TikTok reply text');
    });

    test('health check maps 401 Unauthorized to TOKEN_EXPIRED (CH-02)', async () => {
      const expiringAdapter = new TikTokAdapter({
        pool: mockDb,
        accessToken: 'expired_token',
        fetchFn: async () => ({
          ok: false,
          status: 401,
          json: async () => ({ code: 40102, message: 'Token expired' }),
        } as any),
      });

      const health = await expiringAdapter.health(testConnId);
      assert.strictEqual(health.configured, true);
      assert.strictEqual(health.authorized, false);
      assert.strictEqual(health.lastErrorCode, 'TOKEN_EXPIRED');
    });
  });
});
