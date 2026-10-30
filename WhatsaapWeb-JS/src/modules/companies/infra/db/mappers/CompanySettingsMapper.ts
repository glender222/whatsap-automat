import { CompanySettings } from '../../../domain/CompanySettings';

export class CompanySettingsMapper {
  static toDomain(row: Record<string, unknown>): CompanySettings {
    return {
      companyId: row.company_id as number,
      planId: row.plan_id as number,
      timezone: row.timezone as string,
      locale: row.locale as string,
      features: (row.features as Record<string, boolean> | null) ?? {},
      createdAt: row.created_at as Date,
      updatedAt: row.updated_at as Date,
    };
  }
}
