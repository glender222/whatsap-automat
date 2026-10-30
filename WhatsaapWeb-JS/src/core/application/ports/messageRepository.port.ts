import { Message } from '../../domain/message.entity';

export interface MessageRepositoryPort {
  insert(message: Omit<Message, 'id' | 'createdAt'>): Promise<Message>;
  updateProviderId(id: number, providerMessageId: string): Promise<Message | null>;
  updateStatus(id: number, status: string): Promise<Message | null>;
  findByConversation(conversationId: number, limit?: number, offset?: number): Promise<Message[]>;
  findByProviderId(companyId: number, channel: string, providerMessageId: string): Promise<Message | null>;
}
