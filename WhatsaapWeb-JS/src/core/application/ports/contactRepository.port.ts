import { Contact } from '../../domain/contact.entity';
import { ContactDTO } from '../dtos/conversation.dtos';

export interface ContactRepositoryPort {
  upsert(contact: ContactDTO): Promise<Contact>;
  findByExternal(companyId: number, channel: string, externalId: string): Promise<Contact | null>;
  findOrCreate(contact: ContactDTO): Promise<Contact>;
}
