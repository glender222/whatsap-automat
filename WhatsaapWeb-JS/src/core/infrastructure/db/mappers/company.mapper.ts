import { Company } from '../../../domain/company.entity';

export class CompanyMapper {
  static toDomain(row: Record<string, unknown>): Company {
    return {
      id: row.id as number,
      name: row.name as string,
      createdAt: row.created_at as Date,
    };
  }
}
