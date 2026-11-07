import assert from 'node:assert/strict';
import { describe, test, beforeEach } from 'node:test';
import crypto from 'node:crypto';
import {
  channelEventV1Schema,
  SendMessageCommandV1,
} from '@whatsap-automat/contracts';

import { LineAdapter } from '../services/channels/LineAdapter';

describe('PR-F9-01: LINE Official Account Adapter Unit Suite', () => {
  const mockChannelSecret = 'line_channel_secret_secret_456';
  const mockAccessToken = 'line_channel_access_token_token_789';
  const testConnId = 'conn_line_unit_01';

  let mockDb: any;
  let adapter: LineAdapter;

  beforeEach(() => {
    mockDb = {
      query: async (queryText: any, params: any[]) => {
        const sql = typeof queryText === 'string' ? queryText : queryText.text;
        if (sql.includes('SELECT id, tenant_id') && sql.includes("channel = 'line'")) {
          const accountArg = params?.[0];
          if (accountArg === testConnId || accountArg === 'U_line_bot_destination') {
            return {
              rows: [
                {
                  id: testConnId,
                  tenant_id: 1,
                  channel: 'line',
                  account_id: 'U_line_bot_destination',
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
                  channelSecret: mockChannelSecret,
                  channelAccessToken: mockAccessToken,
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

    adapter = new LineAdapter({
      pool: mockDb,
      channelSecret: mockChannelSecret,
      channelAccessToken: mockAccessToken,
    });
  });

  describe('1. Base64 HMAC-SHA256 Signature Verification (MSG-04)', () => {
    test('accepts valid Base64 X-Line-Signature', async () => {
      const rawPayload = Buffer.from(JSON.stringify({ events: [] }), 'utf8');
      const signature = crypto.createHmac('sha256', mockChannelSecret).update(rawPayload).digest('base64');

      const verified = await adapter.verifyInbound(testConnId, rawPayload, {
        'x-line-signature': signature,
      });
      assert.strictEqual(verified, true);
    });

    test('rejects forged Base64 signature', async () => {
      const rawPayload = Buffer.from(JSON.stringify({ events: [] }), 'utf8');
      const forgedSig = crypto.createHmac('sha256', 'wrong_secret').update(rawPayload).digest('base64');

      const verified = await adapter.verifyInbound(testConnId, rawPayload, {
        'x-line-signature': forgedSig,
      });
      assert.strictEqual(verified, false);
    });

    test('rejects missing signature header', async () => {
      const rawPayload = Buffer.from(JSON.stringify({ events: [] }), 'utf8');
      assert.strictEqual(await adapter.verifyInbound(testConnId, rawPayload, {}), false);
    });
  });

  describe('2. Tenancy Resolution via Destination (MSG-05)', () => {
    test('resolves connection by LINE destination user ID', async () => {
      const payload = Buffer.from(JSON.stringify({ destination: 'U_line_bot_destination', events: [] }));
      const res = await adapter.resolveInboundConnection({
        headers: {},
        pathKey: null,
        rawBody: payload,
      });
      assert.ok(res);
      assert.strictEqual(res.connectionId, testConnId);
      assert.strictEqual(res.tenantId, '1');
    });

    test('fails closed when destination is unmapped', async () => {
      const payload = Buffer.from(JSON.stringify({ destination: 'U_unknown_destination', events: [] }));
      const res = await adapter.resolveInboundConnection({
        headers: {},
        pathKey: null,
        rawBody: payload,
      });
      assert.strictEqual(res, null);
    });
  });

  describe('3. Inbound LINE Event Normalization (CH-01)', () => {
    test('normalizes LINE text event with replyToken', async () => {
      const payload = {
        destination: 'U_line_bot_destination',
        events: [
          {
            type: 'message',
            message: {
              type: 'text',
              id: 'line_msg_101',
              text: 'Hello from LINE client',
            },
            timestamp: 1625641600000,
            source: { type: 'user', userId: 'U12345678' },
            replyToken: 'token_reply_abc123',
            webhookEventId: 'ev_line_001',
          },
        ],
      };

      const events = await adapter.normalizeInbound(testConnId, payload);
      assert.strictEqual(events.length, 1);
      const ev = events[0];

      assert.strictEqual(ev.channel, 'line');
      assert.strictEqual(ev.eventType, 'message.received');
      assert.strictEqual(ev.externalConversationId, 'U12345678');
      assert.strictEqual(ev.correlationId, 'corr_reply_token_reply_abc123');
      assert.ok(channelEventV1Schema.safeParse(ev).success);
    });

    test('normalizes LINE sticker event', async () => {
      const payload = {
        events: [
          {
            type: 'message',
            message: {
              type: 'sticker',
              id: 'line_msg_102',
              packageId: '446',
              stickerId: '1988',
            },
            timestamp: 1625641600000,
            source: { type: 'user', userId: 'U12345678' },
            webhookEventId: 'ev_line_002',
          },
        ],
      };

      const events = await adapter.normalizeInbound(testConnId, payload);
      assert.strictEqual(events.length, 1);
      const ev = events[0];
      assert.strictEqual(ev.payload?.kind, 'message');
      if (ev.payload?.kind === 'message') {
        assert.strictEqual(ev.payload.data.kind, 'media');
        assert.strictEqual(ev.payload.data.media?.providerMediaId, '446:1988');
      }
    });

    test('normalizes follow / unfollow events', async () => {
      const payload = {
        events: [
          {
            type: 'follow',
            timestamp: 1625641600000,
            source: { type: 'user', userId: 'U12345678' },
            webhookEventId: 'ev_line_003',
          },
        ],
      };

      const events = await adapter.normalizeInbound(testConnId, payload);
      assert.strictEqual(events.length, 1);
      const ev = events[0];
      assert.strictEqual(ev.eventType, 'connection.status');
    });
  });

  describe('4. Outbound Dispatch: Reply vs Push', () => {
    test('uses reply endpoint when replyToken is present', async () => {
      let calledUrl = '';
      let calledBody: any;

      const replyAdapter = new LineAdapter({
        pool: mockDb,
        channelAccessToken: mockAccessToken,
        fetchFn: async (url: any, init: any) => {
          calledUrl = String(url);
          calledBody = JSON.parse(init.body);
          return { ok: true, status: 200, json: async () => ({}) } as any;
        },
      });

      const cmd: SendMessageCommandV1 = {
        schemaVersion: 1,
        tenantId: '1',
        connectionId: testConnId,
        conversationId: 'U12345678',
        effectKey: 'eff_002',
        expectedConversationVersion: 1,
        causedBy: { type: 'human', id: 'agent_1' },
        message: {
          kind: 'text',
          text: 'Replying to your message',
          parameters: { replyToken: 'reply_token_fast_999' },
        },
      };

      const result = await replyAdapter.send(cmd);
      assert.strictEqual(result.accepted, true);
      assert.ok(calledUrl.endsWith('/message/reply'));
      assert.strictEqual(calledBody.replyToken, 'reply_token_fast_999');
    });

    test('uses push endpoint when replyToken is absent', async () => {
      let calledUrl = '';
      let calledBody: any;

      const pushAdapter = new LineAdapter({
        pool: mockDb,
        channelAccessToken: mockAccessToken,
        fetchFn: async (url: any, init: any) => {
          calledUrl = String(url);
          calledBody = JSON.parse(init.body);
          return { ok: true, status: 200, json: async () => ({}) } as any;
        },
      });

      const cmd: SendMessageCommandV1 = {
        schemaVersion: 1,
        tenantId: '1',
        connectionId: testConnId,
        conversationId: 'U12345678',
        effectKey: 'eff_003',
        expectedConversationVersion: 1,
        causedBy: { type: 'human', id: 'agent_1' },
        message: { kind: 'text', text: 'Proactive Push Message' },
      };

      const result = await pushAdapter.send(cmd);
      assert.strictEqual(result.accepted, true);
      assert.ok(calledUrl.endsWith('/message/push'));
      assert.strictEqual(calledBody.to, 'U12345678');
    });
  });
});
