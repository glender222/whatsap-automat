import { z } from 'zod';
import { CHANNEL_KINDS } from '../channels/types';
import { consentPurposeSchema } from './consent';

export const CAMPAIGN_STATUSES = [
  'draft',
  'scheduled',
  'queued',
  'dispatching',
  'paused',
  'completed',
  'cancelled',
  'failed',
] as const;

export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];
export const campaignStatusSchema = z.enum(CAMPAIGN_STATUSES);

export const CAMPAIGN_DELIVERY_STATUSES = [
  'pending',
  'suppressed',
  'dispatched',
  'delivered',
  'failed',
  'cancelled',
] as const;

export type CampaignDeliveryStatus = (typeof CAMPAIGN_DELIVERY_STATUSES)[number];
export const campaignDeliveryStatusSchema = z.enum(CAMPAIGN_DELIVERY_STATUSES);

export const campaignDefinitionV1Schema = z.object({
  id: z.string().min(1),
  tenantId: z.union([z.number().int().positive(), z.string().min(1)]),
  workspaceId: z.union([z.number().int().positive(), z.string()]).nullable().optional(),
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  channel: z.enum(CHANNEL_KINDS),
  connectionId: z.string().nullable().optional(),
  segmentId: z.string().nullable().optional(),
  purpose: consentPurposeSchema.default('marketing'),
  templateId: z.string().nullable().optional(),
  templateVariables: z.record(z.unknown()).default({}),
  contentSubject: z.string().nullable().optional(),
  contentBody: z.string().nullable().optional(),
  status: campaignStatusSchema.default('draft'),
  rateLimitPerMinute: z.number().int().min(1).max(1000).default(50),
  failurePauseThresholdPercent: z.number().min(0).max(100).default(5),
  pauseReason: z.string().nullable().optional(),
  scheduledAt: z.string().datetime().nullable().optional(),
  startedAt: z.string().datetime().nullable().optional(),
  completedAt: z.string().datetime().nullable().optional(),
  statsTotal: z.number().int().nonnegative().default(0),
  statsDispatched: z.number().int().nonnegative().default(0),
  statsDelivered: z.number().int().nonnegative().default(0),
  statsFailed: z.number().int().nonnegative().default(0),
  statsSuppressed: z.number().int().nonnegative().default(0),
  metadata: z.record(z.unknown()).default({}),
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
});

export type CampaignDefinitionV1 = z.infer<typeof campaignDefinitionV1Schema>;

export const createCampaignCommandV1Schema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  channel: z.enum(CHANNEL_KINDS),
  connectionId: z.string().optional(),
  segmentId: z.string().optional(),
  purpose: consentPurposeSchema.default('marketing'),
  templateId: z.string().optional(),
  templateVariables: z.record(z.unknown()).default({}),
  contentSubject: z.string().optional(),
  contentBody: z.string().optional(),
  rateLimitPerMinute: z.number().int().min(1).max(1000).default(50),
  failurePauseThresholdPercent: z.number().min(0).max(100).default(5),
  scheduledAt: z.string().datetime().optional(),
  metadata: z.record(z.unknown()).default({}),
});

export type CreateCampaignCommandV1 = z.infer<typeof createCampaignCommandV1Schema>;

export const campaignDeliveryV1Schema = z.object({
  id: z.string().min(1),
  campaignId: z.string().min(1),
  tenantId: z.union([z.number().int().positive(), z.string().min(1)]),
  contactId: z.number().int().positive().nullable().optional(),
  destination: z.string().min(1),
  idempotencyKey: z.string().min(1),
  status: campaignDeliveryStatusSchema.default('pending'),
  suppressionReason: z.string().nullable().optional(),
  providerMessageId: z.string().nullable().optional(),
  errorCode: z.string().nullable().optional(),
  errorMessage: z.string().nullable().optional(),
  renderedPayload: z.record(z.unknown()).default({}),
  dispatchedAt: z.string().datetime().nullable().optional(),
  deliveredAt: z.string().datetime().nullable().optional(),
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
});

export type CampaignDeliveryV1 = z.infer<typeof campaignDeliveryV1Schema>;
