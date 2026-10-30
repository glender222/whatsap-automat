import { Message, MessageDirection } from '../../../domain/message.entity';

export class MessageMapper {
  static toDomain(row: Record<string, unknown>): Message {
    return {
      id: row.id as number,
      companyId: row.company_id as number,
      conversationId: (row.conversation_id as number | null) ?? null,
      direction: (row.direction as MessageDirection) ?? 'inbound',
      channel: row.channel as string,
      providerMessageId: (row.provider_message_id as string | null) ?? null,
      clientRequestId: (row.client_request_id as string | null) ?? null,
      body: (row.body as string | null) ?? null,
      messageType: (row.message_type as string | null) ?? null,
      status: (row.status as string | null) ?? null,
      occurredAt: row.occurred_at as Date,
      rawPayloadJson: (row.raw_payload_json as Record<string, unknown> | null) ?? null,
      createdAt: row.created_at as Date,
    };
  }
}
