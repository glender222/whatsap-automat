import { Conversation } from '../../domain/conversation.entity';
import { ConversationDTO } from '../dtos/conversation.dtos';

export interface ConversationRepositoryPort {
  upsert(conversation: ConversationDTO): Promise<Conversation>;
  findById(id: number): Promise<Conversation | null>;
  findByExternal(companyId: number, channel: string, externalConversationId: string): Promise<Conversation | null>;
  findByCompany(companyId: number, limit?: number, offset?: number): Promise<Conversation[]>;
  updateLastMessage(id: number, lastMessageAt: Date, unreadCount?: number): Promise<Conversation | null>;
}
