import { z } from 'zod';
import { ChannelEventType, ChannelKind } from '../channels/types';
import { ChannelEventPayloadV1, ChannelEventV1 } from '../channels/events';

/**
 * CloudEvents 1.0 Universal Specification Type
 * Section 5.1 & WAA-005 / ADR-004
 */
export interface CanonicalEventV1<TData = ChannelEventPayloadV1> {
  readonly specversion: '1.0';
  readonly id: string; // UUID v4 or provider unique string
  readonly source: string; // URI-reference: e.g. /tenants/{tenantId}/channels/{channel}/{connectionId}
  readonly type: string; // Reverse-DNS format: e.g. com.whatsapautomat.channel.message.received
  readonly time: string; // RFC 3339 / ISO 8601 UTC timestamp
  readonly datacontenttype: 'application/json';
  readonly dataschema?: string;
  readonly subject?: string; // Target entity (e.g. conversationId, chatId)

  // CloudEvents 1.0 Extension Attributes
  readonly tenantid: string; // Tenant identifier
  readonly workspaceid?: string; // Optional workspace identifier
  readonly connectionid?: string; // Connection identifier
  readonly correlationid: string; // Distributed tracing correlation ID
  readonly causationid?: string; // Causation event ID

  // Event Data Payload
  readonly data: TData;
}

/**
 * Zod schema for validating CloudEvents 1.0 compliant events
 */
export const canonicalEventSchema = z.object({
  specversion: z.literal('1.0'),
  id: z.string().min(1),
  source: z.string().min(1),
  type: z.string().min(1),
  time: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)),
  datacontenttype: z.literal('application/json'),
  dataschema: z.string().url().optional(),
  subject: z.string().optional(),
  tenantid: z.string().min(1),
  workspaceid: z.string().optional(),
  connectionid: z.string().optional(),
  correlationid: z.string().min(1),
  causationid: z.string().optional(),
  data: z.unknown(),
});

/**
 * Converts a legacy ChannelEventV1 to a CloudEvents 1.0 CanonicalEventV1
 */
export function toCanonicalEvent(channelEvent: ChannelEventV1): CanonicalEventV1<ChannelEventPayloadV1> {
  const typeMapping: Record<ChannelEventType, string> = {
    'message.received': 'com.whatsapautomat.channel.message.received',
    'message.status': 'com.whatsapautomat.channel.message.status',
    'interaction.received': 'com.whatsapautomat.channel.interaction.received',
    'connection.status': 'com.whatsapautomat.channel.connection.status',
  };

  const payload: ChannelEventPayloadV1 = channelEvent.payload ?? {
    kind: 'raw',
    data: {
      externalEventId: channelEvent.externalEventId,
      payloadRef: channelEvent.payloadRef,
    },
  };

  return {
    specversion: '1.0',
    id: channelEvent.eventId,
    source: `/tenants/${channelEvent.tenantId}/channels/${channelEvent.channel}/${channelEvent.connectionId}`,
    type: typeMapping[channelEvent.eventType] ?? `com.whatsapautomat.channel.${channelEvent.eventType}`,
    time: channelEvent.receivedAt || new Date().toISOString(),
    datacontenttype: 'application/json',
    subject: channelEvent.externalConversationId,
    tenantid: String(channelEvent.tenantId),
    connectionid: channelEvent.connectionId,
    correlationid: channelEvent.correlationId,
    data: payload,
  };
}

/**
 * Converts a CloudEvents 1.0 CanonicalEventV1 back to a ChannelEventV1
 */
export function fromCanonicalEvent(canonical: CanonicalEventV1<ChannelEventPayloadV1>): ChannelEventV1 {
  // Parse channel from source URI: /tenants/{tenantId}/channels/{channel}/{connectionId}
  const sourceParts = canonical.source.split('/');
  const channelIndex = sourceParts.indexOf('channels');
  const channel = (channelIndex !== -1 && sourceParts[channelIndex + 1] ? sourceParts[channelIndex + 1] : 'whatsapp-cloud') as ChannelKind;

  const eventTypeMapping: Record<string, ChannelEventType> = {
    'com.whatsapautomat.channel.message.received': 'message.received',
    'com.whatsapautomat.channel.message.status': 'message.status',
    'com.whatsapautomat.channel.interaction.received': 'interaction.received',
    'com.whatsapautomat.channel.connection.status': 'connection.status',
  };

  const eventType = eventTypeMapping[canonical.type] || 'message.received';

  return {
    schemaVersion: 1,
    eventId: canonical.id,
    tenantId: canonical.tenantid,
    connectionId: canonical.connectionid || '',
    channel,
    externalEventId: canonical.id,
    externalConversationId: canonical.subject || '',
    externalIdentityId: null,
    eventType,
    occurredAt: canonical.time,
    receivedAt: canonical.time,
    correlationId: canonical.correlationid,
    payloadRef: `events/${canonical.id}`,
    payload: canonical.data,
  };
}
