import { DeliveryState } from './types';

export interface OutboundMessageContentV1 {
  readonly kind: 'text' | 'media' | 'template' | 'interactive';
  readonly text?: string;
  readonly mediaRef?: string;
  readonly templateId?: string;
  readonly parameters?: Readonly<Record<string, unknown>>;
}

export interface MessageCausedByV1 {
  readonly type: 'human' | 'workflow' | 'agent' | 'system';
  readonly id: string;
}

/**
 * SendMessageCommandV1
 * Blueprint Section 5.1
 */
export interface SendMessageCommandV1 {
  readonly schemaVersion: 1;
  readonly tenantId: string; // injected server-side, never trusted from client
  readonly connectionId: string;
  readonly conversationId: string; // internal tenant-owned conversation UUID
  readonly effectKey: string; // idempotency / deduplication key
  readonly message: OutboundMessageContentV1;
  readonly expectedConversationVersion: number;
  readonly causedBy: MessageCausedByV1;
}

export interface SendMessageResultV1 {
  readonly providerMessageId: string | null;
  readonly accepted: boolean;
  readonly rawStatus: string;
  readonly deliveryState: DeliveryState;
}
