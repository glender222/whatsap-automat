import { ChannelCapability, ChannelKind } from './types';

export interface ChannelConnectionHealthV1 {
  readonly configured: boolean;
  readonly authorized: boolean;
  readonly lastErrorCode: string | null;
  readonly lastCheckedAt: string;
}

export const CONNECTION_STATUSES = [
  'active',
  'inactive',
  'needs_reauthorization',
  'error',
] as const;

export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

export interface ChannelConnectionV1 {
  readonly id: string;
  readonly tenantId: string;
  readonly channel: ChannelKind;
  readonly name: string;
  readonly externalAccountId: string;
  readonly status: ConnectionStatus;
  readonly capabilities: readonly ChannelCapability[];
  readonly health: ChannelConnectionHealthV1;
  readonly createdAt: string;
  readonly updatedAt: string;
}
