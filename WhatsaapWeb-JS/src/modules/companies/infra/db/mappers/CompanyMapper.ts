import { Company } from '../../../domain/Company';

export class CompanyMapper {
  static toDomain(row: Record<string, unknown>): Company {
    return {
      id: row.id as number,
      name: row.name as string,
      createdAt: row.created_at as Date,
    };
  }
}
