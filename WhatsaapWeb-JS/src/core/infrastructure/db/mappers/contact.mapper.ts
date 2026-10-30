import { Contact } from '../../../domain/contact.entity';

export class ContactMapper {
  static toDomain(row: Record<string, unknown>): Contact {
    return {
      id: row.id as number,
      companyId: row.company_id as number,
      channel: row.channel as string,
      externalContactId: row.external_contact_id as string,
      name: (row.name as string | null) ?? null,
      phone: (row.phone as string | null) ?? null,
      rawProfileJson: (row.raw_profile_json as Record<string, unknown> | null) ?? null,
      createdAt: row.created_at as Date,
      updatedAt: row.updated_at as Date,
    };
  }
}
