import { z } from 'zod';
import { COMMERCIAL_STAGES, CONVERSATION_STATUSES } from './types';
import { channelKindSchema, deliveryStateSchema } from '../channels/schemas';
import { agentRunStateSchema } from '../agents/schemas';

export const commercialStageSchema = z.enum(COMMERCIAL_STAGES);
export const conversationStatusSchema = z.enum(CONVERSATION_STATUSES);

export const messageAttachmentV1Schema = z.object({
  id: z.string().optional(),
  filename: z.string().optional(),
  mimeType: z.string().min(1),
  sizeBytes: z.number().int().nonnegative().optional(),
  url: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const conversationMessageV1Schema = z.object({
  id: z.string().min(1),
  conversationId: z.string().min(1),
  tenantId: z.string().min(1),
  connectionId: z.string().min(1),
  channel: channelKindSchema,
  direction: z.enum(['inbound', 'outbound']),
  deliveryState: deliveryStateSchema,
  originEventId: z.string().nullable(),
  clientRequestId: z.string().nullable(),
  correlationId: z.string().nullable(),
  body: z.string().nullable(),
  attachments: z.array(messageAttachmentV1Schema),
  causedBy: z.object({
    type: z.enum(['human', 'workflow', 'agent', 'customer', 'system']),
    id: z.string().min(1),
  }),
  createdAt: z.string().datetime(),
});

export const conversationV1Schema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  connectionId: z.string().min(1),
  channel: channelKindSchema,
  externalConversationId: z.string().min(1),
  contactIdentityId: z.string().nullable(),
  title: z.string().nullable(),
  status: conversationStatusSchema,
  stage: commercialStageSchema,
  stateVersion: z.number().int().nonnegative(),
  aiPaused: z.boolean(),
  aiPausedUntil: z.string().datetime().nullable(),
  assignedUserId: z.string().nullable(),
  assignedAgentId: z.string().nullable(),
  lastMessageAt: z.string().datetime().nullable(),
  serviceWindowExpiresAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const takeoverCommandV1Schema = z.object({
  schemaVersion: z.literal(1),
  tenantId: z.string().min(1),
  conversationId: z.string().min(1),
  expectedVersion: z.number().int().nonnegative(),
  userId: z.string().min(1),
  reason: z.string().optional(),
});

export const pauseAiCommandV1Schema = z.object({
  schemaVersion: z.literal(1),
  tenantId: z.string().min(1),
  conversationId: z.string().min(1),
  expectedVersion: z.number().int().nonnegative(),
  durationSeconds: z.number().int().positive().optional(),
  reason: z.string().optional(),
});

export const resumeAiCommandV1Schema = z.object({
  schemaVersion: z.literal(1),
  tenantId: z.string().min(1),
  conversationId: z.string().min(1),
  expectedVersion: z.number().int().nonnegative(),
  reason: z.string().optional(),
});

export const serverEventV1Schema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('conversation.updated'),
    tenantId: z.string().min(1),
    conversationId: z.string().min(1),
    version: z.number().int().nonnegative(),
    eventId: z.string().min(1),
  }),
  z.object({
    type: z.literal('message.created'),
    tenantId: z.string().min(1),
    conversationId: z.string().min(1),
    messageId: z.string().min(1),
    eventId: z.string().min(1),
  }),
  z.object({
    type: z.literal('agent.run.updated'),
    tenantId: z.string().min(1),
    runId: z.string().min(1),
    state: agentRunStateSchema,
    eventId: z.string().min(1),
  }),
  z.object({
    type: z.literal('approval.created'),
    tenantId: z.string().min(1),
    approvalId: z.string().min(1),
    eventId: z.string().min(1),
  }),
]);
