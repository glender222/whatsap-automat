import { Attachment } from '../../domain/attachment.entity';

export interface AttachmentRepositoryPort {
  insert(attachment: Omit<Attachment, 'id' | 'createdAt'>): Promise<Attachment>;
  findByMessageId(messageId: number): Promise<Attachment[]>;
}
