/**
 * Interfaces representing the legacy WhatsapWeb-JS contracts and ports.
 * These match WhatsaapWeb-JS/src/core/application/ports/messageChannel.port.ts
 * and conversation.dtos.ts to allow zero-leak adaptation.
 */

export interface LegacySendResult {
  providerMessageId: string;
  status: string;
  raw?: Record<string, unknown>;
}

export interface LegacyMediaRef {
  externalUrl?: string;
  providerMediaId?: string;
  mimeType?: string;
}

export interface LegacyMediaResult {
  data: Uint8Array | Buffer;
  mimeType: string;
  filename?: string;
}

export interface LegacyStatusResult {
  connected: boolean;
  authenticated: boolean;
  details?: Record<string, unknown>;
}

export interface LegacyMessageChannelPort {
  sendMessage(dto: LegacyOutboundMessageRequestDTO): Promise<LegacySendResult>;
  downloadMedia?(ref: LegacyMediaRef): Promise<LegacyMediaResult>;
  markAsRead?(extConvId: string): Promise<void>;
  getStatus(): Promise<LegacyStatusResult>;
}

export interface LegacyAttachmentDTO {
  filename: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  externalUrl: string | null;
  internalPath: string | null;
  metadata?: Record<string, unknown>;
}

export interface LegacyInboundMessageDTO {
  companyId: number;
  channel: string;
  externalConversationId: string;
  externalContactId: string;
  contactName: string | null;
  contactPhone: string | null;
  providerMessageId: string;
  body: string | null;
  messageType: string;
  occurredAt: Date;
  rawPayload: Record<string, unknown>;
  attachments?: LegacyAttachmentDTO[];
}

export interface LegacyOutboundMessageRequestDTO {
  companyId: number;
  channel: string;
  externalConversationId: string;
  externalContactId: string;
  clientRequestId: string;
  body: string;
  messageType: string;
  attachments?: LegacyAttachmentDTO[];
}

export interface LegacyConversationDTO {
  companyId: number;
  channel: string;
  externalConversationId: string;
  contactId: number | null;
  type: string | null;
  title: string | null;
}

export interface LegacyContactDTO {
  companyId: number;
  channel: string;
  externalContactId: string;
  name: string | null;
  phone: string | null;
  rawProfile?: Record<string, unknown>;
}

export interface LegacyMessageStatusDTO {
  companyId: number;
  channel: string;
  providerMessageId: string;
  status: string;
  source: string | null;
  occurredAt: Date;
}
