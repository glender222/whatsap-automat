export interface ContactDTO {
  companyId: number;
  channel: string;
  externalContactId: string;
  name: string | null;
  phone: string | null;
  rawProfile?: Record<string, unknown>;
}

export interface ConversationDTO {
  companyId: number;
  channel: string;
  externalConversationId: string;
  contactId: number | null;
  type: string | null;
  title: string | null;
}

export interface AttachmentDTO {
  filename: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  externalUrl: string | null;
  internalPath: string | null;
  metadata?: Record<string, unknown>;
}

export interface InboundMessageDTO {
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
  attachments?: AttachmentDTO[];
}

export interface OutboundMessageRequestDTO {
  companyId: number;
  channel: string;
  externalConversationId: string;
  externalContactId: string;
  clientRequestId: string;
  body: string;
  messageType: string;
  attachments?: AttachmentDTO[];
}

export interface MessageStatusDTO {
  companyId: number;
  channel: string;
  providerMessageId: string;
  status: string;
  source: string | null;
  occurredAt: Date;
  metadata?: Record<string, unknown>;
}
