import { MessageStatus } from '../../domain/messageStatus.entity';

export interface StatusRepositoryPort {
  insert(status: Omit<MessageStatus, 'id' | 'createdAt'>): Promise<MessageStatus>;
  findByMessageId(messageId: number): Promise<MessageStatus[]>;
}
