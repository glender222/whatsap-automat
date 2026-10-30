export type MessageDirection = 'inbound' | 'outbound';

export interface Message {
  id: number;
  companyId: number;
  conversationId: number | null;
  direction: MessageDirection;
  channel: string;
  providerMessageId: string | null;
  clientRequestId: string | null;
  body: string | null;
  messageType: string | null;
  status: string | null;
  occurredAt: Date;
  rawPayloadJson: Record<string, unknown> | null;
  createdAt: Date;
}
