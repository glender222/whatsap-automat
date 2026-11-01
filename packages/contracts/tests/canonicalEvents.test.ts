import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalEventSchema,
  toCanonicalEvent,
  fromCanonicalEvent,
  CanonicalEventV1,
  channelSyntheticFixturesMap,
} from '../src';

describe('EV-01: Canonical CloudEvents 1.0 Contracts & Converters', () => {
  it('validates a well-formed CloudEvents 1.0 canonical event', () => {
    const validEvent: CanonicalEventV1 = {
      specversion: '1.0',
      id: '550e8400-e29b-41d4-a716-446655440000',
      source: '/tenants/100/channels/whatsapp-cloud/conn-xyz-001',
      type: 'com.whatsapautomat.channel.message.received',
      time: '2026-11-01T20:00:00.000Z',
      datacontenttype: 'application/json',
      subject: '5491199998888@s.whatsapp.net',
      tenantid: '100',
      workspaceid: 'ws-default',
      connectionid: 'conn-xyz-001',
      correlationid: 'corr-uuid-1234',
      causationid: 'cause-uuid-0001',
      data: {
        kind: 'message',
        data: {
          messageId: 'wamid.HBgLMTIzNDU2Nzg5MA==',
          kind: 'text',
          text: 'Hola, necesito cotización del catálogo.',
        },
      },
    };

    const parsed = canonicalEventSchema.safeParse(validEvent);
    assert.ok(parsed.success, `Expected valid CloudEvent: ${JSON.stringify(parsed.error?.issues)}`);
    assert.equal(parsed.data.specversion, '1.0');
    assert.equal(parsed.data.tenantid, '100');
    assert.equal(parsed.data.correlationid, 'corr-uuid-1234');
  });

  it('rejects an event with invalid specversion or missing required attributes', () => {
    const invalidEvent = {
      specversion: '0.3', // Invalid specversion
      id: '',
      source: '',
      type: 'invalid',
      time: 'invalid-date',
      datacontenttype: 'text/plain', // Must be application/json
      tenantid: '',
      correlationid: '',
      data: {},
    };

    const parsed = canonicalEventSchema.safeParse(invalidEvent);
    assert.equal(parsed.success, false);
    assert.ok(parsed.error!.issues.length >= 3);
  });

  it('converts ChannelEventV1 inbound text fixture to CanonicalEventV1 faithfully', () => {
    const fixture = channelSyntheticFixturesMap['whatsapp-cloud'].inboundText;
    const canonical = toCanonicalEvent(fixture);

    assert.equal(canonical.specversion, '1.0');
    assert.equal(canonical.id, fixture.eventId);
    assert.equal(canonical.tenantid, String(fixture.tenantId));
    assert.equal(canonical.connectionid, fixture.connectionId);
    assert.equal(canonical.correlationid, fixture.correlationId);
    assert.equal(canonical.type, 'com.whatsapautomat.channel.message.received');
    assert.equal(canonical.subject, fixture.externalConversationId);
    assert.ok(canonical.source.includes('/channels/whatsapp-cloud/'));

    const parsed = canonicalEventSchema.safeParse(canonical);
    assert.ok(parsed.success);
  });

  it('round-trips CanonicalEventV1 back to ChannelEventV1 preserving essential identifiers', () => {
    const fixture = channelSyntheticFixturesMap['instagram'].inboundInteractive;
    const canonical = toCanonicalEvent(fixture);
    const convertedBack = fromCanonicalEvent(canonical);

    assert.equal(convertedBack.schemaVersion, 1);
    assert.equal(convertedBack.eventId, fixture.eventId);
    assert.equal(convertedBack.tenantId, fixture.tenantId);
    assert.equal(convertedBack.connectionId, fixture.connectionId);
    assert.equal(convertedBack.channel, 'instagram');
    assert.equal(convertedBack.eventType, 'interaction.received');
    assert.equal(convertedBack.externalConversationId, fixture.externalConversationId);
    assert.equal(convertedBack.correlationId, fixture.correlationId);
  });
});
