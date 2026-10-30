export interface AuditLog {
  id: number;
  companyId: number | null;
  actor: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  metadataJson: Record<string, unknown> | null;
  createdAt: Date;
}
