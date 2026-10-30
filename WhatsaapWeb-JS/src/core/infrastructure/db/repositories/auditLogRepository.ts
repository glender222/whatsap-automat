import { Queryable } from '../../../../shared/UnitOfWorkPort';
import { AuditLogRepositoryPort } from '../../../application/ports/auditLogRepository.port';
import { AuditLog } from '../../../domain/auditLog.entity';
import { AuditLogMapper } from '../mappers/auditLog.mapper';

export class AuditLogRepository implements AuditLogRepositoryPort {
  constructor(private readonly pool: Queryable) {}

  async log(auditLog: Omit<AuditLog, 'id' | 'createdAt'>): Promise<AuditLog> {
    const result = await this.pool.query(
      `INSERT INTO audit_logs (company_id, actor, action, entity_type, entity_id, metadata_json)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        auditLog.companyId,
        auditLog.actor,
        auditLog.action,
        auditLog.entityType,
        auditLog.entityId,
        auditLog.metadataJson ?? null,
      ]
    );
    return AuditLogMapper.toDomain(result.rows[0]);
  }
}
