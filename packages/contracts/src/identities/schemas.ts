import { z } from 'zod';
import { channelKindSchema } from '../channels/schemas';
import { MEMORY_RECORD_KINDS, MEMORY_VERIFICATION_STATES } from './types';

export const memoryRecordKindSchema = z.enum(MEMORY_RECORD_KINDS);
export const memoryVerificationStateSchema = z.enum(MEMORY_VERIFICATION_STATES);

export const channelIdentityV1Schema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  connectionId: z.string().min(1),
  channel: channelKindSchema,
  externalUserId: z.string().min(1),
  displayName: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const memoryRecordV1Schema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  channelIdentityId: z.string().min(1),
  kind: memoryRecordKindSchema,
  valueRef: z.string().min(1),
  sourceMessageId: z.string().nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  consentBasis: z.string().nullable(),
  expiresAt: z.string().datetime().nullable(),
  verificationState: memoryVerificationStateSchema,
  createdAt: z.string().datetime(),
});
