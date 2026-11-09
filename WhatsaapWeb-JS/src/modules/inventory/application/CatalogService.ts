import { CatalogInput, CatalogSectionInput } from '../domain/inventory.types';
import { CatalogRepositoryPg } from '../infra/db/CatalogRepositoryPg';

const CATALOG_STATUSES = ['active', 'inactive', 'archived'];

export class CatalogService {
  constructor(private readonly repository: CatalogRepositoryPg) {}

  list(companyId: number) {
    return this.repository.list(companyId);
  }

  create(companyId: number, input: CatalogInput) {
    this.assertCatalogInput(input, true);
    return this.repository.create(companyId, this.normalizeCatalogInput(input));
  }

  update(companyId: number, catalogId: number, input: Partial<CatalogInput>) {
    this.assertCatalogId(catalogId);
    this.assertCatalogInput(input, false);
    return this.repository.update(companyId, catalogId, this.normalizeCatalogInput(input));
  }

  setStatus(companyId: number, catalogId: number, status: string) {
    this.assertCatalogId(catalogId);
    if (!CATALOG_STATUSES.includes(status)) throw this.validationError('Estado de catalogo invalido');
    return this.repository.update(companyId, catalogId, { status: status as CatalogInput['status'] });
  }

  addItem(companyId: number, catalogId: number, commercialItemId: number, sectionId: number | null = null) {
    this.assertCatalogId(catalogId);
    this.assertItemId(commercialItemId);
    if (sectionId !== null) this.assertCatalogId(sectionId);
    return this.repository.addItem(companyId, catalogId, commercialItemId, sectionId);
  }

  listSections(companyId: number, catalogId: number) {
    this.assertCatalogId(catalogId);
    return this.repository.listSections(companyId, catalogId);
  }

  createSection(companyId: number, catalogId: number, input: CatalogSectionInput) {
    this.assertCatalogId(catalogId);
    this.assertSectionInput(input, true);
    return this.repository.createSection(companyId, catalogId, this.normalizeSectionInput(input));
  }

  updateSection(companyId: number, sectionId: number, input: Partial<CatalogSectionInput>) {
    this.assertCatalogId(sectionId);
    this.assertSectionInput(input, false);
    return this.repository.updateSection(companyId, sectionId, this.normalizeSectionInput(input));
  }

  setSectionStatus(companyId: number, sectionId: number, status: string) {
    this.assertCatalogId(sectionId);
    if (!CATALOG_STATUSES.includes(status)) throw this.validationError('Estado de seccion invalido');
    return this.repository.updateSection(companyId, sectionId, { status: status as CatalogSectionInput['status'] });
  }

  removeItem(companyId: number, catalogId: number, commercialItemId: number) {
    this.assertCatalogId(catalogId);
    this.assertItemId(commercialItemId);
    return this.repository.removeItem(companyId, catalogId, commercialItemId);
  }

  private assertCatalogInput(input: Partial<CatalogInput>, requireName: boolean): void {
    if ((requireName || input.name !== undefined) &&
        (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 120)) {
      throw this.validationError('Nombre de catalogo invalido');
    }
    if (input.status && !CATALOG_STATUSES.includes(input.status)) throw this.validationError('Estado de catalogo invalido');
    if (input.sortOrder !== undefined && (!Number.isInteger(Number(input.sortOrder)) || Number(input.sortOrder) < 0)) {
      throw this.validationError('Orden de catalogo invalido');
    }
  }

  private assertSectionInput(input: Partial<CatalogSectionInput>, requireName: boolean): void {
    if ((requireName || input.name !== undefined) &&
        (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 140)) {
      throw this.validationError('Nombre de seccion invalido');
    }
    if (input.status && !CATALOG_STATUSES.includes(input.status)) throw this.validationError('Estado de seccion invalido');
    if (input.sortOrder !== undefined && (!Number.isInteger(Number(input.sortOrder)) || Number(input.sortOrder) < 0)) {
      throw this.validationError('Orden de seccion invalido');
    }
  }

  private normalizeCatalogInput<T extends Partial<CatalogInput>>(input: T): T {
    return {
      ...input,
      name: input.name?.trim(),
      description: input.description ? String(input.description).trim() : input.description,
      aiInstructions: input.aiInstructions ? String(input.aiInstructions).trim() : input.aiInstructions,
      salesPolicy: input.salesPolicy ? String(input.salesPolicy).trim() : input.salesPolicy,
      sortOrder: input.sortOrder === undefined ? input.sortOrder : Number(input.sortOrder),
    };
  }

  private normalizeSectionInput<T extends Partial<CatalogSectionInput>>(input: T): T {
    return {
      ...input,
      name: input.name?.trim(),
      description: input.description ? String(input.description).trim() : input.description,
      aiInstructions: input.aiInstructions ? String(input.aiInstructions).trim() : input.aiInstructions,
      sortOrder: input.sortOrder === undefined ? input.sortOrder : Number(input.sortOrder),
    };
  }

  private assertCatalogId(catalogId: number): void {
    if (!Number.isSafeInteger(catalogId) || catalogId <= 0) throw this.validationError('Catalogo invalido');
  }

  private assertItemId(commercialItemId: number): void {
    if (!Number.isSafeInteger(commercialItemId) || commercialItemId <= 0) throw this.validationError('Item de catalogo invalido');
  }

  private validationError(message: string): Error & { statusCode?: number; code?: string } {
    const error = new Error(message) as Error & { statusCode?: number; code?: string };
    error.statusCode = 400;
    error.code = 'VALIDATION_ERROR';
    return error;
  }
}
