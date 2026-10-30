import { Queryable } from '../../../../shared/UnitOfWorkPort';
import { CompanyRepositoryPort } from '../../application/ports/CompanyRepositoryPort';
import { Company } from '../../domain/Company';
import { CompanySettings } from '../../domain/CompanySettings';
import { CompanyLimits } from '../../domain/CompanyLimits';
import { Plan } from '../../domain/Plan';
import { CompanyMapper } from './mappers/CompanyMapper';
import { PlanMapper } from './mappers/PlanMapper';
import { CompanySettingsMapper } from './mappers/CompanySettingsMapper';
import { CompanyLimitsMapper } from './mappers/CompanyLimitsMapper';

/**
 * Implementación PostgreSQL del repositorio de companies.
 * Recibe un Pool o PoolClient (Queryable) vía constructor para operar
 * dentro o fuera de una transacción.
 */
export class CompanyRepositoryPg implements CompanyRepositoryPort {
  constructor(private readonly pool: Queryable) {}

  async findById(id: number): Promise<Company | null> {
    const result = await this.pool.query(
      'SELECT id, name, created_at FROM companies WHERE id = $1',
      [id]
    );
    return result.rows.length > 0 ? CompanyMapper.toDomain(result.rows[0]) : null;
  }

  async findPlanById(id: number): Promise<Plan | null> {
    const result = await this.pool.query(
      'SELECT id, code, name, description, max_users, max_conversations, max_messages_per_month, created_at, updated_at FROM plans WHERE id = $1',
      [id]
    );
    return result.rows.length > 0 ? PlanMapper.toDomain(result.rows[0]) : null;
  }

  async findSettingsByCompanyId(companyId: number): Promise<CompanySettings | null> {
    const result = await this.pool.query(
      'SELECT company_id, plan_id, timezone, locale, features, created_at, updated_at FROM company_settings WHERE company_id = $1',
      [companyId]
    );
    return result.rows.length > 0 ? CompanySettingsMapper.toDomain(result.rows[0]) : null;
  }

  async findLimitsByCompanyId(companyId: number): Promise<CompanyLimits | null> {
    const result = await this.pool.query(
      'SELECT company_id, max_users, max_conversations, max_messages_per_month FROM company_limits WHERE company_id = $1',
      [companyId]
    );
    return result.rows.length > 0 ? CompanyLimitsMapper.toDomain(result.rows[0]) : null;
  }
}
