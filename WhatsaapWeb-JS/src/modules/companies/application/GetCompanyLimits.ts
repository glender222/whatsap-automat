import { Result, DomainError } from '../../../shared/types';
import { CompanyRepositoryPort } from './ports/CompanyRepositoryPort';
import { CompanyLimits } from '../domain/CompanyLimits';

/**
 * Caso de uso: obtener los límites operativos de una compañía.
 */
export class GetCompanyLimits {
  constructor(private readonly repository: CompanyRepositoryPort) {}

  async execute(companyId: number): Promise<Result<CompanyLimits>> {
    const limits = await this.repository.findLimitsByCompanyId(companyId);
    if (!limits) {
      return {
        ok: false,
        error: new DomainError(
          'COMPANY_LIMITS_NOT_FOUND',
          `No se encontraron límites para companyId=${companyId}`
        ),
      };
    }
    return { ok: true, value: limits };
  }
}
