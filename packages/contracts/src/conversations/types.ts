import { ChannelKind, DeliveryState } from '../channels/types';

export const COMMERCIAL_STAGES = [
  'new',
  'ai_assisting',
  'catalog',
  'preorder',
  'handoff',
  'payment',
  'closed',
] as const;

export type CommercialStage = (typeof COMMERCIAL_STAGES)[number];

export const CONVERSATION_STATUSES = [
  'open',
  'closed',
  'archived',
] as const;

export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

export interface MessageAttachmentV1 {
  readonly id?: string;
  readonly filename?: string;
  readonly mimeType: string;
  readonly sizeBytes?: number;
  readonly url?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ConversationMessageV1 {
  readonly id: string;
  readonly conversationId: string;
  readonly tenantId: string;
  readonly connectionId: string;
  readonly channel: ChannelKind;
  readonly direction: 'inbound' | 'outbound';
  readonly deliveryState: DeliveryState;
  readonly originEventId: string | null;
  readonly clientRequestId: string | null;
  readonly correlationId: string | null;
  readonly body: string | null;
  readonly attachments: readonly MessageAttachmentV1[];
  readonly causedBy: {
    readonly type: 'human' | 'workflow' | 'agent' | 'customer' | 'system';
    readonly id: string;
  };
  readonly createdAt: string;
}

export interface ConversationV1 {
  readonly id: string;
  readonly tenantId: string; // maps to company_id in legacy DB
  readonly connectionId: string;
  readonly channel: ChannelKind;
  readonly externalConversationId: string; // e.g. phone number or WhatsApp JID or Telegram chat id
  readonly contactIdentityId: string | null;
  readonly title: string | null;
  readonly status: ConversationStatus;
  readonly stage: CommercialStage;
  readonly stateVersion: number; // CAS counter for optimistic concurrency
  readonly hasUnresolvedDelivery?: boolean;
  readonly aiPaused: boolean;
  readonly aiPausedUntil: string | null;
  readonly assignedUserId: string | null;
  readonly assignedAgentId: string | null;
  readonly lastMessageAt: string | null;
  readonly serviceWindowExpiresAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}
