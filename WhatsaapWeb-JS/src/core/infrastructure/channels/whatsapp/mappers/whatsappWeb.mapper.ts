import { InboundMessageDTO, AttachmentDTO, MessageStatusDTO } from '../../../../application/dtos/conversation.dtos';

export function mapInboundMessage(
  msg: Record<string, unknown>,
  chat: Record<string, unknown>,
  companyId: number,
  channel = 'whatsapp'
): InboundMessageDTO {
  const rawMsg = msg as any;
  const rawChat = chat as any;

  const providerMessageId = (rawMsg.id?._serialized as string) ?? String(rawMsg.id);
  const body = (rawMsg.body as string) ?? null;
  const messageType = rawMsg.type === 'ptt' ? 'audio' : (rawMsg.type as string) ?? 'chat';
  const timestamp = typeof rawMsg.timestamp === 'number' ? rawMsg.timestamp : Math.floor(Date.now() / 1000);
  const occurredAt = new Date(timestamp * 1000);

  const externalConversationId = (rawChat.id?._serialized as string) ?? String(rawChat.id);
  const externalContactId = (rawMsg.from as string) ?? externalConversationId;

  const contactName = (rawChat.name as string) ?? (rawMsg._data?.notifyName as string) ?? null;
  const contactPhone = (rawChat.id?.user as string) ?? null;

  const attachments: AttachmentDTO[] = [];
  if (rawMsg.hasMedia) {
    attachments.push({
      filename: (rawMsg._data?.filename as string) ?? null,
      mimeType: (rawMsg._data?.mimetype as string) ?? null,
      sizeBytes: null,
      externalUrl: null,
      internalPath: null,
      metadata: { messageId: providerMessageId, hasMedia: true },
    });
  }

  const rawPayload: Record<string, unknown> = rawMsg._data
    ? { ...rawMsg._data, fromMe: rawMsg.fromMe, id: rawMsg.id }
    : { fromMe: rawMsg.fromMe, id: rawMsg.id };

  return {
    companyId,
    channel,
    externalConversationId,
    externalContactId,
    contactName,
    contactPhone,
    providerMessageId,
    body,
    messageType,
    occurredAt,
    rawPayload,
    attachments,
  };
}

export function mapMessageStatus(
  msg: Record<string, unknown>,
  ack: number,
  companyId: number,
  channel = 'whatsapp'
): MessageStatusDTO | null {
  const rawMsg = msg as any;
  const providerMessageId = (rawMsg.id?._serialized as string) ?? String(rawMsg.id);
  if (!providerMessageId) return null;

  const statusMap: Record<number, string> = {
    0: 'pending',
    1: 'sent',
    2: 'delivered',
    3: 'read',
  };

  const status = statusMap[ack] ?? 'unknown';
  return {
    companyId,
    channel,
    providerMessageId,
    status,
    source: 'whatsapp',
    occurredAt: new Date(),
    metadata: { ack },
  };
}
