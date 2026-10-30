import { Queryable } from '../../../../shared/UnitOfWorkPort';
import { CompanyRepositoryPort } from '../../../application/ports/companyRepository.port';
import { Company } from '../../../domain/company.entity';
import { CompanyMapper } from '../mappers/company.mapper';

export class CompanyRepository implements CompanyRepositoryPort {
  constructor(private readonly pool: Queryable) {}

  async ensureDefault(companyId: number, name: string): Promise<Company> {
    const result = await this.pool.query(
      `INSERT INTO companies (id, name)
       VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name
       RETURNING *`,
      [companyId, name]
    );
    return CompanyMapper.toDomain(result.rows[0]);
  }

  async findById(id: number): Promise<Company | null> {
    const result = await this.pool.query(
      'SELECT * FROM companies WHERE id = $1',
      [id]
    );
    return result.rows.length > 0 ? CompanyMapper.toDomain(result.rows[0]) : null;
  }
}
