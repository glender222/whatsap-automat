import { ChannelKind } from '../channels/types';

/**
 * Channel Identity V1 contract
 * Blueprint Section 5.4
 * NO globalPersonId in v1 to guarantee channel identity separation without unauthorized cross-merges.
 */
export interface ChannelIdentityV1 {
  readonly id: string;
  readonly tenantId: string;
  readonly connectionId: string;
  readonly channel: ChannelKind;
  readonly externalUserId: string; // phone number, username, or provider user ID
  readonly displayName: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const MEMORY_RECORD_KINDS = [
  'summary',
  'preference',
  'business_fact',
] as const;

export type MemoryRecordKind = (typeof MEMORY_RECORD_KINDS)[number];

export const MEMORY_VERIFICATION_STATES = [
  'unverified',
  'verified',
  'rejected',
] as const;

export type MemoryVerificationState = (typeof MEMORY_VERIFICATION_STATES)[number];

/**
 * Memory Record V1 contract
 * Blueprint Section 5.4
 * Strictly isolated per channel identity and tenant.
 */
export interface MemoryRecordV1 {
  readonly id: string;
  readonly tenantId: string;
  readonly channelIdentityId: string; // no mixing across providers
  readonly kind: MemoryRecordKind;
  readonly valueRef: string;
  readonly sourceMessageId: string | null;
  readonly confidence: number | null;
  readonly consentBasis: string | null;
  readonly expiresAt: string | null;
  readonly verificationState: MemoryVerificationState;
  readonly createdAt: string;
}
