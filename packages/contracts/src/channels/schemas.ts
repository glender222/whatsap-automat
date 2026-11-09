import { z } from 'zod';
import {
  CHANNEL_CAPABILITIES,
  CHANNEL_EVENT_TYPES,
  CHANNEL_KINDS,
  DELIVERY_STATES,
} from './types';
import { CONNECTION_STATUSES } from './connections';

export const channelKindSchema = z.enum(CHANNEL_KINDS);
export const channelCapabilitySchema = z.enum(CHANNEL_CAPABILITIES);
export const deliveryStateSchema = z.enum(DELIVERY_STATES);
export const channelEventTypeSchema = z.enum(CHANNEL_EVENT_TYPES);
export const connectionStatusSchema = z.enum(CONNECTION_STATUSES);

export const inboundMessageMediaSchema = z.object({
  url: z.string().url().optional(),
  mimeType: z.string().min(1),
  filename: z.string().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  providerMediaId: z.string().optional(),
});

export const inboundInteractiveSchema = z.object({
  type: z.enum(['button_reply', 'list_reply', 'quick_reply']),
  id: z.string().min(1),
  title: z.string().min(1),
  metadata: z.record(z.unknown()).optional(),
});

export const inboundMessagePayloadSchema = z.object({
  messageId: z.string().min(1),
  kind: z.enum(['text', 'media', 'interactive']),
  text: z.string().optional(),
  media: inboundMessageMediaSchema.optional(),
  interactive: inboundInteractiveSchema.optional(),
});

export const messageStatusPayloadSchema = z.object({
  providerMessageId: z.string().min(1),
  status: deliveryStateSchema,
  rawStatus: z.string().min(1),
  errorCode: z.string().optional(),
  errorMessage: z.string().optional(),
  occurredAt: z.string().datetime(),
});

export const connectionStatusPayloadSchema = z.object({
  status: z.enum(['connected', 'disconnected', 'needs_reauthorization', 'degraded']),
  reason: z.string().optional(),
  errorCode: z.string().optional(),
});

export const channelEventPayloadSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('message'), data: inboundMessagePayloadSchema }),
  z.object({ kind: z.literal('status'), data: messageStatusPayloadSchema }),
  z.object({ kind: z.literal('connection'), data: connectionStatusPayloadSchema }),
  z.object({ kind: z.literal('raw'), data: z.record(z.unknown()) }),
]);

export const channelEventV1Schema = z.object({
  schemaVersion: z.literal(1),
  eventId: z.string().min(1),
  tenantId: z.string().min(1),
  connectionId: z.string().min(1),
  channel: channelKindSchema,
  externalEventId: z.string().min(1),
  externalConversationId: z.string().min(1),
  externalIdentityId: z.string().nullable(),
  eventType: channelEventTypeSchema,
  occurredAt: z.string().datetime(),
  receivedAt: z.string().datetime(),
  correlationId: z.string().min(1),
  payloadRef: z.string().min(1),
  payload: channelEventPayloadSchema.optional(),
});

export const outboundMessageContentSchema = z.object({
  kind: z.enum(['text', 'media', 'template', 'interactive']),
  text: z.string().optional(),
  mediaRef: z.string().optional(),
  templateId: z.string().optional(),
  parameters: z.record(z.unknown()).optional(),
});

export const messageCausedBySchema = z.object({
  type: z.enum(['human', 'workflow', 'agent', 'system']),
  id: z.string().min(1),
});

export const sendMessageCommandV1Schema = z.object({
  schemaVersion: z.literal(1),
  tenantId: z.string().min(1),
  connectionId: z.string().min(1),
  conversationId: z.string().min(1),
  effectKey: z.string().min(1),
  message: outboundMessageContentSchema,
  expectedConversationVersion: z.number().int().nonnegative(),
  causedBy: messageCausedBySchema,
});

export const sendMessageResultV1Schema = z.object({
  providerMessageId: z.string().nullable(),
  accepted: z.boolean(),
  rawStatus: z.string().min(1),
  deliveryState: deliveryStateSchema,
});

export const channelConnectionHealthV1Schema = z.object({
  configured: z.boolean(),
  authorized: z.boolean(),
  lastErrorCode: z.string().nullable(),
  lastCheckedAt: z.string().datetime().nullable(),
});

export const channelConnectionV1Schema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  channel: channelKindSchema,
  name: z.string().min(1),
  externalAccountId: z.string().min(1),
  status: connectionStatusSchema,
  capabilities: z.array(channelCapabilitySchema),
  health: channelConnectionHealthV1Schema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
