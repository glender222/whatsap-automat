import { AuditLog } from '../../../domain/auditLog.entity';

export class AuditLogMapper {
  static toDomain(row: Record<string, unknown>): AuditLog {
    return {
      id: row.id as number,
      companyId: (row.company_id as number | null) ?? null,
      actor: (row.actor as string | null) ?? null,
      action: row.action as string,
      entityType: (row.entity_type as string | null) ?? null,
      entityId: (row.entity_id as string | null) ?? null,
      metadataJson: (row.metadata_json as Record<string, unknown> | null) ?? null,
      createdAt: row.created_at as Date,
    };
  }
}
