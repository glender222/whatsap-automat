import { Company } from '../../domain/company.entity';

export interface CompanyRepositoryPort {
  ensureDefault(companyId: number, name: string): Promise<Company>;
  findById(id: number): Promise<Company | null>;
}
