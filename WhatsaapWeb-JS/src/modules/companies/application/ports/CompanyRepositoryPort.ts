import { Company } from '../../domain/Company';
import { CompanySettings } from '../../domain/CompanySettings';
import { CompanyLimits } from '../../domain/CompanyLimits';
import { Plan } from '../../domain/Plan';

/**
 * Puerto de repositorio para el agregado companies.
 * No depende de PostgreSQL, Express ni WhatsApp.
 */
export interface CompanyRepositoryPort {
  findById(id: number): Promise<Company | null>;
  findPlanById(id: number): Promise<Plan | null>;
  findSettingsByCompanyId(companyId: number): Promise<CompanySettings | null>;
  findLimitsByCompanyId(companyId: number): Promise<CompanyLimits | null>;
}
