import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  channelEventV1Schema,
  channelSyntheticFixturesMap,
  sendMessageCommandV1Schema,
  channelConnectionHealthV1Schema,
  CHANNEL_KINDS,
  ChannelAdapterV1,
  InboundConnectionResolutionRequest,
  SendMessageCommandV1,
  SendMessageResultV1,
  ChannelCapability,
  ChannelEventV1,
} from '../src';

describe('CH-01: Four Channels Contract Tests', () => {
  for (const channelKind of CHANNEL_KINDS) {
    describe(`Channel: ${channelKind}`, () => {
      const fixture = channelSyntheticFixturesMap[channelKind];

      it('validates inbound text message fixture against ChannelEventV1 schema', () => {
        const parsed = channelEventV1Schema.safeParse(fixture.inboundText);
        assert.ok(parsed.success, `Inbound text validation failed: ${JSON.stringify(parsed.error?.issues)}`);
        assert.equal(parsed.data.channel, channelKind);
        assert.equal(parsed.data.eventType, 'message.received');
        assert.equal(parsed.data.schemaVersion, 1);
      });

      it('validates inbound media fixture against ChannelEventV1 schema', () => {
        const parsed = channelEventV1Schema.safeParse(fixture.inboundMedia);
        assert.ok(parsed.success, `Inbound media validation failed: ${JSON.stringify(parsed.error?.issues)}`);
        assert.equal(parsed.data.channel, channelKind);
        assert.equal(parsed.data.eventType, 'message.received');
        assert.ok(parsed.data.payload?.kind === 'message');
      });

      it('validates inbound interactive fixture against ChannelEventV1 schema', () => {
        const parsed = channelEventV1Schema.safeParse(fixture.inboundInteractive);
        assert.ok(parsed.success, `Inbound interactive validation failed: ${JSON.stringify(parsed.error?.issues)}`);
        assert.equal(parsed.data.channel, channelKind);
        assert.equal(parsed.data.eventType, 'interaction.received');
      });

      it('validates outbound command fixture against SendMessageCommandV1 schema', () => {
        const parsed = sendMessageCommandV1Schema.safeParse(fixture.outboundCommand);
        assert.ok(parsed.success, `Outbound command validation failed: ${JSON.stringify(parsed.error?.issues)}`);
        assert.equal(parsed.data.schemaVersion, 1);
        assert.ok(parsed.data.effectKey.length > 0);
      });

      it('validates status delivery receipt (delivered & read) against ChannelEventV1 schema', () => {
        const delivered = channelEventV1Schema.safeParse(fixture.statusDelivered);
        assert.ok(delivered.success);
        assert.equal(delivered.data.eventType, 'message.status');

        const read = channelEventV1Schema.safeParse(fixture.statusRead);
        assert.ok(read.success);
        assert.equal(read.data.eventType, 'message.status');
      });

      it('validates status failed receipt against ChannelEventV1 schema', () => {
        const failed = channelEventV1Schema.safeParse(fixture.statusFailed);
        assert.ok(failed.success);
        assert.equal(failed.data.eventType, 'message.status');
        assert.ok(failed.data.payload?.kind === 'status');
        if (failed.data.payload?.kind === 'status') {
          assert.equal(failed.data.payload.data.status, 'failed');
        }
      });

      it('validates credential error / authorization required event against ChannelEventV1 schema', () => {
        const credError = channelEventV1Schema.safeParse(fixture.credentialErrorEvent);
        assert.ok(credError.success);
        assert.equal(credError.data.eventType, 'connection.status');
        if (credError.data.payload?.kind === 'connection') {
          assert.equal(credError.data.payload.data.status, 'needs_reauthorization');
        }
      });

      it('validates connection health fixtures', () => {
        const ok = channelConnectionHealthV1Schema.safeParse(fixture.healthOk);
        assert.ok(ok.success);
        assert.equal(ok.data.authorized, true);

        const unauth = channelConnectionHealthV1Schema.safeParse(fixture.healthUnauthorized);
        assert.ok(unauth.success);
        assert.equal(unauth.data.authorized, false);
      });

      it('verifies non-empty channel capabilities', () => {
        assert.ok(fixture.capabilities.length >= 5);
        assert.ok(fixture.capabilities.includes('text'));
        assert.ok(fixture.capabilities.includes('image'));
      });
    });
  }

  it('implements ChannelAdapterV1 port and processes synthetic round-trip', async () => {
    class SyntheticTestAdapter implements ChannelAdapterV1 {
      public readonly kind = 'whatsapp-cloud' as const;

      async resolveInboundConnection(req: InboundConnectionResolutionRequest) {
        if (req.headers['x-connection-id'] && req.headers['x-tenant-id']) {
          return {
            connectionId: req.headers['x-connection-id'],
            tenantId: req.headers['x-tenant-id'],
          };
        }
        return null;
      }

      async verifyInbound(_connId: string, rawBody: Uint8Array): Promise<boolean> {
        return rawBody.length > 0;
      }

      async normalizeInbound(_connId: string, _raw: unknown): Promise<ChannelEventV1[]> {
        return [channelSyntheticFixturesMap['whatsapp-cloud'].inboundText];
      }

      async getCapabilities(): Promise<Set<ChannelCapability>> {
        return new Set(channelSyntheticFixturesMap['whatsapp-cloud'].capabilities);
      }

      async send(cmd: SendMessageCommandV1): Promise<SendMessageResultV1> {
        return {
          providerMessageId: `wa_msg_${Date.now()}`,
          accepted: true,
          rawStatus: 'sent',
          deliveryState: 'dispatched',
        };
      }

      async health() {
        return channelSyntheticFixturesMap['whatsapp-cloud'].healthOk;
      }
    }

    const adapter = new SyntheticTestAdapter();
    const resolution = await adapter.resolveInboundConnection({
      headers: { 'x-connection-id': 'conn_wa_123', 'x-tenant-id': 'tenant_abc' },
      pathKey: null,
      rawBody: new Uint8Array([1, 2, 3]),
    });

    assert.deepEqual(resolution, { connectionId: 'conn_wa_123', tenantId: 'tenant_abc' });
    const verified = await adapter.verifyInbound('conn_wa_123', new Uint8Array([1, 2, 3]), {});
    assert.equal(verified, true);

    const events = await adapter.normalizeInbound('conn_wa_123', {});
    assert.equal(events.length, 1);
    assert.equal(events[0]?.channel, 'whatsapp-cloud');

    const capabilities = await adapter.getCapabilities('conn_wa_123');
    assert.ok(capabilities.has('text'));
    assert.ok(capabilities.has('template'));

    const sendRes = await adapter.send(channelSyntheticFixturesMap['whatsapp-cloud'].outboundCommand);
    assert.equal(sendRes.accepted, true);
    assert.equal(sendRes.deliveryState, 'dispatched');

    const health = await adapter.health('conn_wa_123');
    assert.equal(health.authorized, true);
  });
});
