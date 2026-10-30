import { Queryable } from '../../../../shared/UnitOfWorkPort';
import { ContactRepositoryPort } from '../../../application/ports/contactRepository.port';
import { Contact } from '../../../domain/contact.entity';
import { ContactDTO } from '../../../application/dtos/conversation.dtos';
import { ContactMapper } from '../mappers/contact.mapper';

export class ContactRepository implements ContactRepositoryPort {
  constructor(private readonly pool: Queryable) {}

  async upsert(contact: ContactDTO): Promise<Contact> {
    const result = await this.pool.query(
      `INSERT INTO contacts (company_id, channel, external_contact_id, name, phone, raw_profile_json)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (company_id, channel, external_contact_id)
       DO UPDATE SET
         name = COALESCE(EXCLUDED.name, contacts.name),
         phone = COALESCE(EXCLUDED.phone, contacts.phone),
         raw_profile_json = COALESCE(EXCLUDED.raw_profile_json, contacts.raw_profile_json),
         updated_at = NOW()
       RETURNING *`,
      [
        contact.companyId,
        contact.channel,
        contact.externalContactId,
        contact.name,
        contact.phone,
        contact.rawProfile ?? null,
      ]
    );
    return ContactMapper.toDomain(result.rows[0]);
  }

  async findByExternal(companyId: number, channel: string, externalId: string): Promise<Contact | null> {
    const result = await this.pool.query(
      'SELECT * FROM contacts WHERE company_id = $1 AND channel = $2 AND external_contact_id = $3',
      [companyId, channel, externalId]
    );
    return result.rows.length > 0 ? ContactMapper.toDomain(result.rows[0]) : null;
  }

  async findOrCreate(contact: ContactDTO): Promise<Contact> {
    const existing = await this.findByExternal(contact.companyId, contact.channel, contact.externalContactId);
    if (existing) return existing;
    return this.upsert(contact);
  }
}
