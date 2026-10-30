import { Queryable } from '../../../../shared/UnitOfWorkPort';
import { MessageRepositoryPort } from '../../../application/ports/messageRepository.port';
import { Message } from '../../../domain/message.entity';
import { MessageMapper } from '../mappers/message.mapper';

export class MessageRepository implements MessageRepositoryPort {
  constructor(private readonly pool: Queryable) {}

  async insert(message: Omit<Message, 'id' | 'createdAt'>): Promise<Message> {
    const result = await this.pool.query(
      `INSERT INTO messages (
         company_id, conversation_id, direction, channel,
         provider_message_id, client_request_id, body,
         message_type, status, occurred_at, raw_payload_json
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [
        message.companyId,
        message.conversationId,
        message.direction,
        message.channel,
        message.providerMessageId,
        message.clientRequestId,
        message.body,
        message.messageType,
        message.status,
        message.occurredAt,
        message.rawPayloadJson ?? null,
      ]
    );

    if (result.rows.length === 0) {
      if (message.providerMessageId) {
        const existing = await this.pool.query(
          'SELECT * FROM messages WHERE company_id = $1 AND channel = $2 AND provider_message_id = $3',
          [message.companyId, message.channel, message.providerMessageId]
        );
        if (existing.rows.length > 0) {
          return MessageMapper.toDomain(existing.rows[0]);
        }
      }
      if (message.clientRequestId) {
        const existingByClient = await this.pool.query(
          'SELECT * FROM messages WHERE company_id = $1 AND client_request_id = $2',
          [message.companyId, message.clientRequestId]
        );
        if (existingByClient.rows.length > 0) {
          return MessageMapper.toDomain(existingByClient.rows[0]);
        }
      }
    }

    return MessageMapper.toDomain(result.rows[0]);
  }

  async updateProviderId(id: number, providerMessageId: string): Promise<Message | null> {
    const result = await this.pool.query(
      'UPDATE messages SET provider_message_id = $1 WHERE id = $2 RETURNING *',
      [providerMessageId, id]
    );
    return result.rows.length > 0 ? MessageMapper.toDomain(result.rows[0]) : null;
  }

  async updateStatus(id: number, status: string): Promise<Message | null> {
    const result = await this.pool.query(
      'UPDATE messages SET status = $1 WHERE id = $2 RETURNING *',
      [status, id]
    );
    return result.rows.length > 0 ? MessageMapper.toDomain(result.rows[0]) : null;
  }

  async findByConversation(conversationId: number, limit = 50, offset = 0): Promise<Message[]> {
    const result = await this.pool.query(
      `SELECT * FROM messages
       WHERE conversation_id = $1
       ORDER BY occurred_at DESC
       LIMIT $2 OFFSET $3`,
      [conversationId, limit, offset]
    );
    return result.rows.map(MessageMapper.toDomain);
  }

  async findByProviderId(companyId: number, channel: string, providerMessageId: string): Promise<Message | null> {
    const result = await this.pool.query(
      'SELECT * FROM messages WHERE company_id = $1 AND channel = $2 AND provider_message_id = $3',
      [companyId, channel, providerMessageId]
    );
    return result.rows.length > 0 ? MessageMapper.toDomain(result.rows[0]) : null;
  }
}
