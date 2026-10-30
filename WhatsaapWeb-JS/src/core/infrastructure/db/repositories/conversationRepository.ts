import { Queryable } from '../../../../shared/UnitOfWorkPort';
import { ConversationRepositoryPort } from '../../../application/ports/conversationRepository.port';
import { Conversation } from '../../../domain/conversation.entity';
import { ConversationDTO } from '../../../application/dtos/conversation.dtos';
import { ConversationMapper } from '../mappers/conversation.mapper';

export class ConversationRepository implements ConversationRepositoryPort {
  constructor(private readonly pool: Queryable) {}

  async upsert(conversation: ConversationDTO): Promise<Conversation> {
    const result = await this.pool.query(
      `INSERT INTO conversations (company_id, channel, external_conversation_id, contact_id, type, title)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (company_id, channel, external_conversation_id)
       DO UPDATE SET
         contact_id = COALESCE(EXCLUDED.contact_id, conversations.contact_id),
         type = COALESCE(EXCLUDED.type, conversations.type),
         title = COALESCE(EXCLUDED.title, conversations.title),
         updated_at = NOW()
       RETURNING *`,
      [
        conversation.companyId,
        conversation.channel,
        conversation.externalConversationId,
        conversation.contactId,
        conversation.type,
        conversation.title,
      ]
    );
    return ConversationMapper.toDomain(result.rows[0]);
  }

  async findById(id: number): Promise<Conversation | null> {
    const result = await this.pool.query(
      'SELECT * FROM conversations WHERE id = $1',
      [id]
    );
    return result.rows.length > 0 ? ConversationMapper.toDomain(result.rows[0]) : null;
  }

  async findByExternal(companyId: number, channel: string, externalConversationId: string): Promise<Conversation | null> {
    const result = await this.pool.query(
      'SELECT * FROM conversations WHERE company_id = $1 AND channel = $2 AND external_conversation_id = $3',
      [companyId, channel, externalConversationId]
    );
    return result.rows.length > 0 ? ConversationMapper.toDomain(result.rows[0]) : null;
  }

  async findByCompany(companyId: number, limit = 50, offset = 0): Promise<Conversation[]> {
    const result = await this.pool.query(
      `SELECT * FROM conversations
       WHERE company_id = $1
       ORDER BY last_message_at DESC NULLS LAST, updated_at DESC
       LIMIT $2 OFFSET $3`,
      [companyId, limit, offset]
    );
    return result.rows.map(ConversationMapper.toDomain);
  }

  async updateLastMessage(id: number, lastMessageAt: Date, unreadCount?: number): Promise<Conversation | null> {
    const result = await this.pool.query(
      `UPDATE conversations
       SET last_message_at = $1,
           unread_count = COALESCE($2, unread_count),
           updated_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [lastMessageAt, unreadCount ?? null, id]
    );
    return result.rows.length > 0 ? ConversationMapper.toDomain(result.rows[0]) : null;
  }
}
