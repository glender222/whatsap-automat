import { Conversation } from '../../../domain/conversation.entity';

export class ConversationMapper {
  static toDomain(row: Record<string, unknown>): Conversation {
    return {
      id: row.id as number,
      companyId: row.company_id as number,
      channel: row.channel as string,
      externalConversationId: row.external_conversation_id as string,
      contactId: (row.contact_id as number | null) ?? null,
      type: (row.type as string | null) ?? null,
      title: (row.title as string | null) ?? null,
      lastMessageAt: (row.last_message_at as Date | null) ?? null,
      unreadCount: (row.unread_count as number) ?? 0,
      createdAt: row.created_at as Date,
      updatedAt: row.updated_at as Date,
    };
  }
}
