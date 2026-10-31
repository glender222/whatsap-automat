import { ChannelEventV1 } from '../channels/events';
import { SendMessageCommandV1 } from '../channels/commands';
import { ChannelKind, DeliveryState } from '../channels/types';
import { ConversationV1 } from '../conversations/types';
import { ChannelIdentityV1 } from '../identities/types';
import {
  LegacyContactDTO,
  LegacyConversationDTO,
  LegacyInboundMessageDTO,
  LegacyMessageStatusDTO,
  LegacyOutboundMessageRequestDTO,
} from './legacyContracts.types';

/**
 * Normalizes legacy channel names to canonical ChannelKind
 */
export function normalizeLegacyChannelKind(channel: string): ChannelKind {
  const normalized = channel.toLowerCase();
  if (normalized === 'whatsapp' || normalized === 'whatsapp-cloud' || normalized === 'whatsapp-web') {
    return 'whatsapp-cloud';
  }
  if (normalized === 'instagram') return 'instagram';
  if (normalized === 'messenger') return 'messenger';
  if (normalized === 'telegram') return 'telegram';
  return 'whatsapp-cloud';
}

/**
 * Normalizes legacy delivery status string to canonical DeliveryState
 */
export function toCanonicalDeliveryState(status: string): DeliveryState {
  const s = status.toLowerCase();
  if (s === 'delivered') return 'delivered';
  if (s === 'read') return 'read';
  if (s === 'sent' || s === 'dispatched') return 'dispatched';
  if (s === 'pending') return 'pending';
  if (s === 'accepted' || s === 'provider_accepted') return 'provider_accepted';
  if (s === 'failed' || s === 'error') return 'failed';
  if (s === 'cancelled') return 'cancelled';
  return 'unknown_delivery';
}

/**
 * Normalizes canonical DeliveryState to legacy status string
 */
export function toLegacyStatus(state: DeliveryState): string {
  switch (state) {
    case 'dispatched':
      return 'sent';
    case 'provider_accepted':
      return 'accepted';
    case 'delivered':
      return 'delivered';
    case 'read':
      return 'read';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'pending':
    default:
      return 'pending';
  }
}

export interface InboundMappingOptions {
  readonly connectionId: string;
  readonly eventId?: string;
  readonly correlationId?: string;
  readonly payloadRef?: string;
}

/**
 * Maps legacy InboundMessageDTO to canonical ChannelEventV1
 */
export function mapLegacyInboundToCanonicalEvent(
  dto: LegacyInboundMessageDTO,
  options: InboundMappingOptions
): ChannelEventV1 {
  const occurredAtIso = dto.occurredAt instanceof Date ? dto.occurredAt.toISOString() : new Date().toISOString();
  const receivedAtIso = new Date().toISOString();
  const eventId = options.eventId ?? `evt_${dto.providerMessageId || Date.now()}`;
  const correlationId = options.correlationId ?? `corr_${dto.companyId}_${dto.externalConversationId}`;
  const payloadRef = options.payloadRef ?? `ref:legacy:inbound:${dto.providerMessageId}`;

  const channelKind = normalizeLegacyChannelKind(dto.channel);

  return {
    schemaVersion: 1,
    eventId,
    tenantId: String(dto.companyId),
    connectionId: options.connectionId,
    channel: channelKind,
    externalEventId: dto.providerMessageId,
    externalConversationId: dto.externalConversationId,
    externalIdentityId: dto.externalContactId,
    eventType: 'message.received',
    occurredAt: occurredAtIso,
    receivedAt: receivedAtIso,
    correlationId,
    payloadRef,
    payload: {
      kind: 'message',
      data: {
        messageId: dto.providerMessageId,
        kind: dto.attachments && dto.attachments.length > 0 ? 'media' : 'text',
        ...(dto.body ? { text: dto.body } : {}),
        ...(dto.attachments && dto.attachments.length > 0 && dto.attachments[0]
          ? {
              media: {
                url: dto.attachments[0].externalUrl || undefined,
                mimeType: dto.attachments[0].mimeType || 'application/octet-stream',
                filename: dto.attachments[0].filename || undefined,
                sizeBytes: dto.attachments[0].sizeBytes || undefined,
              },
            }
          : {}),
      },
    },
  };
}

export interface OutboundMappingOptions {
  readonly externalContactId: string;
  readonly externalConversationId: string;
  readonly companyIdNumber?: number;
}

/**
 * Maps canonical SendMessageCommandV1 to legacy OutboundMessageRequestDTO
 */
export function mapCanonicalCommandToLegacyOutbound(
  cmd: SendMessageCommandV1,
  options: OutboundMappingOptions
): LegacyOutboundMessageRequestDTO {
  const parsedTenant = parseInt(cmd.tenantId, 10);
  const companyId = options.companyIdNumber ?? (Number.isInteger(parsedTenant) && parsedTenant > 0 ? parsedTenant : 1);

  let body = cmd.message.text || '';
  if (cmd.message.kind === 'template' && cmd.message.templateId) {
    body = `[Template: ${cmd.message.templateId}]`;
  }

  return {
    companyId,
    channel: 'whatsapp',
    externalConversationId: options.externalConversationId,
    externalContactId: options.externalContactId,
    clientRequestId: cmd.effectKey,
    body,
    messageType: cmd.message.kind === 'media' ? 'media' : 'chat',
  };
}

/**
 * Maps legacy MessageStatusDTO to canonical ChannelEventV1
 */
export function mapLegacyStatusToCanonicalEvent(
  dto: LegacyMessageStatusDTO,
  options: {
    readonly connectionId: string;
    readonly externalConversationId: string;
    readonly eventId?: string;
    readonly correlationId?: string;
  }
): ChannelEventV1 {
  const occurredAtIso = dto.occurredAt instanceof Date ? dto.occurredAt.toISOString() : new Date().toISOString();
  const eventId = options.eventId ?? `evt_status_${dto.providerMessageId}`;
  const correlationId = options.correlationId ?? `corr_status_${dto.providerMessageId}`;
  const canonicalDeliveryState = toCanonicalDeliveryState(dto.status);

  return {
    schemaVersion: 1,
    eventId,
    tenantId: String(dto.companyId),
    connectionId: options.connectionId,
    channel: normalizeLegacyChannelKind(dto.channel),
    externalEventId: `${dto.providerMessageId}:${dto.status}`,
    externalConversationId: options.externalConversationId,
    externalIdentityId: null,
    eventType: 'message.status',
    occurredAt: occurredAtIso,
    receivedAt: new Date().toISOString(),
    correlationId,
    payloadRef: `ref:legacy:status:${dto.providerMessageId}`,
    payload: {
      kind: 'status',
      data: {
        providerMessageId: dto.providerMessageId,
        status: canonicalDeliveryState,
        rawStatus: dto.status,
        occurredAt: occurredAtIso,
      },
    },
  };
}

/**
 * Maps legacy ConversationDTO to canonical ConversationV1
 */
export function mapLegacyConversationToCanonical(
  dto: LegacyConversationDTO,
  options: {
    readonly conversationId: string;
    readonly connectionId: string;
    readonly stateVersion?: number;
    readonly stage?: 'new' | 'ai_assisting' | 'catalog' | 'preorder' | 'handoff' | 'payment' | 'closed';
  }
): ConversationV1 {
  const now = new Date().toISOString();
  return {
    id: options.conversationId,
    tenantId: String(dto.companyId),
    connectionId: options.connectionId,
    channel: normalizeLegacyChannelKind(dto.channel),
    externalConversationId: dto.externalConversationId,
    contactIdentityId: dto.contactId ? String(dto.contactId) : null,
    title: dto.title,
    status: 'open',
    stage: options.stage ?? 'new',
    stateVersion: options.stateVersion ?? 1,
    aiPaused: false,
    aiPausedUntil: null,
    assignedUserId: null,
    assignedAgentId: null,
    lastMessageAt: now,
    serviceWindowExpiresAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Maps legacy ContactDTO to canonical ChannelIdentityV1
 */
export function mapLegacyContactToCanonicalIdentity(
  dto: LegacyContactDTO,
  options: {
    readonly identityId: string;
    readonly connectionId: string;
  }
): ChannelIdentityV1 {
  const now = new Date().toISOString();
  return {
    id: options.identityId,
    tenantId: String(dto.companyId),
    connectionId: options.connectionId,
    channel: normalizeLegacyChannelKind(dto.channel),
    externalUserId: dto.externalContactId,
    displayName: dto.name,
    createdAt: now,
    updatedAt: now,
  };
}
