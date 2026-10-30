/**
 * Configuración operativa vinculada a una compañía.
 */
export interface CompanySettings {
  readonly companyId: number;
  readonly planId: number;
  readonly timezone: string;
  readonly locale: string;
  readonly features: Record<string, boolean>;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
