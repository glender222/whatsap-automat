import { Result, DomainError } from '../../../shared/types';
import { CompanyRepositoryPort } from './ports/CompanyRepositoryPort';
import { CompanySettings } from '../domain/CompanySettings';

/**
 * Caso de uso: obtener la configuración de una compañía.
 */
export class GetCompanySettings {
  constructor(private readonly repository: CompanyRepositoryPort) {}

  async execute(companyId: number): Promise<Result<CompanySettings>> {
    const settings = await this.repository.findSettingsByCompanyId(companyId);
    if (!settings) {
      return {
        ok: false,
        error: new DomainError(
          'COMPANY_SETTINGS_NOT_FOUND',
          `No se encontraron settings para companyId=${companyId}`
        ),
      };
    }
    return { ok: true, value: settings };
  }
}
