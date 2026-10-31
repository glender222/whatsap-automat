import { ChannelEventType, ChannelKind, DeliveryState } from './types';

export interface InboundMessageMediaV1 {
  readonly url?: string;
  readonly mimeType: string;
  readonly filename?: string;
  readonly sizeBytes?: number;
  readonly providerMediaId?: string;
}

export interface InboundInteractiveV1 {
  readonly type: 'button_reply' | 'list_reply' | 'quick_reply';
  readonly id: string;
  readonly title: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface InboundMessagePayloadV1 {
  readonly messageId: string;
  readonly kind: 'text' | 'media' | 'interactive';
  readonly text?: string;
  readonly media?: InboundMessageMediaV1;
  readonly interactive?: InboundInteractiveV1;
}

export interface MessageStatusPayloadV1 {
  readonly providerMessageId: string;
  readonly status: DeliveryState;
  readonly rawStatus: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly occurredAt: string;
}

export interface ConnectionStatusPayloadV1 {
  readonly status: 'connected' | 'disconnected' | 'needs_reauthorization' | 'degraded';
  readonly reason?: string;
  readonly errorCode?: string;
}

export type ChannelEventPayloadV1 =
  | { readonly kind: 'message'; readonly data: InboundMessagePayloadV1 }
  | { readonly kind: 'status'; readonly data: MessageStatusPayloadV1 }
  | { readonly kind: 'connection'; readonly data: ConnectionStatusPayloadV1 }
  | { readonly kind: 'raw'; readonly data: Readonly<Record<string, unknown>> };

/**
 * Canonical Channel Event V1 contract
 * Blueprint Section 5.1
 */
export interface ChannelEventV1 {
  readonly schemaVersion: 1;
  readonly eventId: string; // internal UUID
  readonly tenantId: string; // resolved server-side from session or connection
  readonly connectionId: string; // internal connection UUID
  readonly channel: ChannelKind;
  readonly externalEventId: string; // unique within connection
  readonly externalConversationId: string;
  readonly externalIdentityId: string | null;
  readonly eventType: ChannelEventType;
  readonly occurredAt: string; // provider clock (ISO 8601)
  readonly receivedAt: string; // server clock (ISO 8601)
  readonly correlationId: string;
  readonly payloadRef: string; // tenant-authorized DB/object reference
  readonly payload?: ChannelEventPayloadV1;
}
