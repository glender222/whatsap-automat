import { AuditLog } from '../../domain/auditLog.entity';

export interface AuditLogRepositoryPort {
  log(auditLog: Omit<AuditLog, 'id' | 'createdAt'>): Promise<AuditLog>;
}
