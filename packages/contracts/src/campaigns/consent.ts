import { z } from 'zod';
import { CHANNEL_KINDS } from '../channels/types';

export const CONSENT_STATUSES = [
  'opted_in',
  'opted_out',
  'suppressed',
  'revoked',
] as const;

export type ConsentStatus = (typeof CONSENT_STATUSES)[number];

export const CONSENT_PURPOSES = [
  'marketing',
  'transactional',
  'support',
  'broadcast',
  'all',
] as const;

export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];

export const CONSENT_EVIDENCE_TYPES = [
  'web_form',
  'chat_inbound',
  'contract',
  'import',
  'right_to_be_forgotten',
  'unsubscribe_link',
  'keyword',
  'manual',
] as const;

export type ConsentEvidenceType = (typeof CONSENT_EVIDENCE_TYPES)[number];

export const consentStatusSchema = z.enum(CONSENT_STATUSES);
export const consentPurposeSchema = z.enum(CONSENT_PURPOSES);
export const consentEvidenceTypeSchema = z.enum(CONSENT_EVIDENCE_TYPES);

export const consentRecordV1Schema = z.object({
  id: z.string().min(1),
  tenantId: z.union([z.number().int().positive(), z.string().min(1)]),
  contactId: z.number().int().positive().nullable().optional(),
  channelType: z.enum(CHANNEL_KINDS),
  destination: z.string().min(1),
  purpose: consentPurposeSchema.default('marketing'),
  status: consentStatusSchema.default('opted_in'),
  evidenceType: consentEvidenceTypeSchema.default('manual'),
  evidenceProof: z.record(z.unknown()).default({}),
  optedInAt: z.string().datetime().default(() => new Date().toISOString()),
  revokedAt: z.string().datetime().nullable().optional(),
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
});

export type ConsentRecordV1 = z.infer<typeof consentRecordV1Schema>;

export const recordConsentInputV1Schema = z.object({
  contactId: z.number().int().positive().nullable().optional(),
  channelType: z.enum(CHANNEL_KINDS),
  destination: z.string().min(1),
  purpose: consentPurposeSchema.default('marketing'),
  status: consentStatusSchema.default('opted_in'),
  evidenceType: consentEvidenceTypeSchema.default('manual'),
  evidenceProof: z.record(z.unknown()).default({}),
});

export type RecordConsentInputV1 = z.infer<typeof recordConsentInputV1Schema>;

export const consentVerificationResultV1Schema = z.object({
  permitted: z.boolean(),
  status: z.union([consentStatusSchema, z.literal('not_found')]),
  reason: z.enum(['NO_OPT_IN_RECORD', 'SUPPRESSED', 'REVOKED', 'PURPOSE_MISMATCH', 'CONSENT_GRANTED']).optional(),
  recordId: z.string().optional(),
});

export type ConsentVerificationResultV1 = z.infer<typeof consentVerificationResultV1Schema>;

export const rightToBeForgottenCommandV1Schema = z.object({
  customerId: z.string().min(1),
  destination: z.string().optional(),
  reason: z.string().optional().default('GDPR Article 17 Right to be Forgotten'),
});

export type RightToBeForgottenCommandV1 = z.infer<typeof rightToBeForgottenCommandV1Schema>;

export const rightToBeForgottenResultV1Schema = z.object({
  success: z.boolean(),
  purgedConsentCount: z.number().int().nonnegative(),
  purgedChunksCount: z.number().int().nonnegative(),
  anonymizedContact: z.boolean(),
  executedAt: z.string().datetime(),
});

export type RightToBeForgottenResultV1 = z.infer<typeof rightToBeForgottenResultV1Schema>;
