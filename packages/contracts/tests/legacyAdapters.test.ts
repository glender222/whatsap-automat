import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  LegacyChannelAdapterBridge,
  mapLegacyInboundToCanonicalEvent,
  mapCanonicalCommandToLegacyOutbound,
  mapLegacyStatusToCanonicalEvent,
  mapLegacyConversationToCanonical,
  mapLegacyContactToCanonicalIdentity,
  toCanonicalDeliveryState,
  toLegacyStatus,
  channelEventV1Schema,
  conversationV1Schema,
  channelIdentityV1Schema,
  SendMessageCommandV1,
  LegacyMessageChannelPort,
  LegacyOutboundMessageRequestDTO,
  LegacySendResult,
  LegacyStatusResult,
} from '../src';

describe('Legacy Adapters & Bi-directional Mappers', () => {
  it('maps legacy InboundMessageDTO to canonical ChannelEventV1 and validates schema', () => {
    const legacyInbound = {
      companyId: 2,
      channel: 'whatsapp',
      externalConversationId: '573109876543',
      externalContactId: '573109876543@c.us',
      contactName: 'Carlos Gómez',
      contactPhone: '573109876543',
      providerMessageId: 'legacy_wamid_123',
      body: 'Consulta de catálogo',
      messageType: 'chat',
      occurredAt: new Date('2026-10-31T01:30:00.000Z'),
      rawPayload: { id: 'legacy_wamid_123' },
    };

    const canonicalEvent = mapLegacyInboundToCanonicalEvent(legacyInbound, {
      connectionId: 'conn_wa_legacy_bridge',
    });

    const parsed = channelEventV1Schema.safeParse(canonicalEvent);
    assert.ok(parsed.success, `Mapping failed schema: ${JSON.stringify(parsed.error?.issues)}`);
    assert.equal(canonicalEvent.tenantId, '2');
    assert.equal(canonicalEvent.channel, 'whatsapp-cloud');
    assert.equal(canonicalEvent.externalEventId, 'legacy_wamid_123');
    assert.equal(canonicalEvent.externalConversationId, '573109876543');
    assert.equal(canonicalEvent.eventType, 'message.received');
  });

  it('maps canonical SendMessageCommandV1 to legacy OutboundMessageRequestDTO', () => {
    const canonicalCmd: SendMessageCommandV1 = {
      schemaVersion: 1,
      tenantId: '5',
      connectionId: 'conn_wa_001',
      conversationId: 'conv_internal_55',
      effectKey: 'eff_test_outbound_1',
      message: {
        kind: 'text',
        text: 'Respuesta automática desde core',
      },
      expectedConversationVersion: 2,
      causedBy: {
        type: 'agent',
        id: 'agent_support',
      },
    };

    const legacyDto = mapCanonicalCommandToLegacyOutbound(canonicalCmd, {
      externalContactId: '573009998877@s.whatsapp.net',
      externalConversationId: '573009998877',
    });

    assert.equal(legacyDto.companyId, 5);
    assert.equal(legacyDto.externalConversationId, '573009998877');
    assert.equal(legacyDto.body, 'Respuesta automática desde core');
    assert.equal(legacyDto.clientRequestId, 'eff_test_outbound_1');
  });

  it('maps legacy MessageStatusDTO to canonical status event', () => {
    const legacyStatus = {
      companyId: 2,
      channel: 'whatsapp',
      providerMessageId: 'legacy_wamid_123',
      status: 'delivered',
      source: 'webhook',
      occurredAt: new Date('2026-10-31T01:35:00.000Z'),
    };

    const canonicalStatusEvent = mapLegacyStatusToCanonicalEvent(legacyStatus, {
      connectionId: 'conn_wa_001',
      externalConversationId: '573109876543',
    });

    const parsed = channelEventV1Schema.safeParse(canonicalStatusEvent);
    assert.ok(parsed.success);
    assert.equal(canonicalStatusEvent.eventType, 'message.status');
    if (canonicalStatusEvent.payload?.kind === 'status') {
      assert.equal(canonicalStatusEvent.payload.data.status, 'delivered');
    }
  });

  it('maps legacy ConversationDTO to canonical ConversationV1 and validates schema', () => {
    const legacyConv = {
      companyId: 1,
      channel: 'whatsapp',
      externalConversationId: '573001112233',
      contactId: 44,
      type: 'direct',
      title: 'Cliente Preferencial',
    };

    const canonicalConv = mapLegacyConversationToCanonical(legacyConv, {
      conversationId: 'conv_uuid_44',
      connectionId: 'conn_wa_001',
      stateVersion: 1,
      stage: 'new',
    });

    const parsed = conversationV1Schema.safeParse(canonicalConv);
    assert.ok(parsed.success);
    assert.equal(canonicalConv.tenantId, '1');
    assert.equal(canonicalConv.channel, 'whatsapp-cloud');
    assert.equal(canonicalConv.contactIdentityId, '44');
  });

  it('maps legacy ContactDTO to canonical ChannelIdentityV1 and validates schema', () => {
    const legacyContact = {
      companyId: 1,
      channel: 'whatsapp',
      externalContactId: '573001112233@s.whatsapp.net',
      name: 'Maria Casas',
      phone: '573001112233',
    };

    const canonicalIdentity = mapLegacyContactToCanonicalIdentity(legacyContact, {
      identityId: 'ident_uuid_maria',
      connectionId: 'conn_wa_001',
    });

    const parsed = channelIdentityV1Schema.safeParse(canonicalIdentity);
    assert.ok(parsed.success);
    assert.equal(canonicalIdentity.displayName, 'Maria Casas');
    assert.equal(canonicalIdentity.externalUserId, '573001112233@s.whatsapp.net');
  });

  it('preserves status mapping roundtrip', () => {
    assert.equal(toCanonicalDeliveryState('delivered'), 'delivered');
    assert.equal(toCanonicalDeliveryState('read'), 'read');
    assert.equal(toCanonicalDeliveryState('sent'), 'dispatched');
    assert.equal(toCanonicalDeliveryState('failed'), 'failed');

    assert.equal(toLegacyStatus('dispatched'), 'sent');
    assert.equal(toLegacyStatus('delivered'), 'delivered');
    assert.equal(toLegacyStatus('read'), 'read');
    assert.equal(toLegacyStatus('failed'), 'failed');
  });

  it('LegacyChannelAdapterBridge executes Send and Health using underlying legacy port', async () => {
    let capturedLegacyDto: LegacyOutboundMessageRequestDTO | null = null;

    const mockLegacyPort: LegacyMessageChannelPort = {
      async sendMessage(dto: LegacyOutboundMessageRequestDTO): Promise<LegacySendResult> {
        capturedLegacyDto = dto;
        return {
          providerMessageId: 'legacy_out_wamid_999',
          status: 'sent',
        };
      },
      async getStatus(): Promise<LegacyStatusResult> {
        return {
          connected: true,
          authenticated: true,
        };
      },
    };

    const bridge = new LegacyChannelAdapterBridge(mockLegacyPort, {
      kind: 'whatsapp-cloud',
      defaultTenantId: '3',
      defaultConnectionId: 'conn_bridge_01',
    });

    const cmd: SendMessageCommandV1 = {
      schemaVersion: 1,
      tenantId: '3',
      connectionId: 'conn_bridge_01',
      conversationId: '573008887766',
      effectKey: 'eff_bridge_001',
      message: {
        kind: 'text',
        text: 'Mensaje puente',
      },
      expectedConversationVersion: 1,
      causedBy: {
        type: 'human',
        id: 'user_agent_1',
      },
    };

    const sendResult = await bridge.send(cmd);
    assert.equal(sendResult.accepted, true);
    assert.equal(sendResult.deliveryState, 'dispatched');
    assert.equal(sendResult.providerMessageId, 'legacy_out_wamid_999');

    assert.ok(capturedLegacyDto);
    assert.equal(capturedLegacyDto?.body, 'Mensaje puente');
    assert.equal(capturedLegacyDto?.companyId, 3);

    const health = await bridge.health('conn_bridge_01');
    assert.equal(health.configured, true);
    assert.equal(health.authorized, true);
    assert.equal(health.lastErrorCode, null);
  });
});
