import { ProductImageInput, ProductInput, ProductListFilters, StockAdjustmentInput } from '../domain/inventory.types';
import { ProductRepositoryPg } from '../infra/db/ProductRepositoryPg';

const ITEM_TYPES = ['physical_product', 'digital_product', 'service', 'course', 'subscription', 'custom'];
const AVAILABILITY_TYPES = ['stock', 'unlimited', 'capacity', 'manual', 'schedule'];
const PRICE_MODES = ['fixed', 'from', 'free', 'consult'];
const STATUSES = ['draft', 'active', 'inactive', 'archived'];

export class ProductService {
  constructor(private readonly repository: ProductRepositoryPg) {}

  list(companyId: number, filters: ProductListFilters | string = '') {
    return this.repository.list(companyId, typeof filters === 'string' ? filters : this.normalizeListFilters(filters));
  }

  get(companyId: number, productId: number) {
    if (!Number.isSafeInteger(productId) || productId <= 0) throw this.validationError('Item de catalogo invalido');
    return this.repository.get(companyId, productId);
  }

  create(companyId: number, input: ProductInput) {
    this.assertProductInput(input, true);
    return this.repository.create(companyId, this.normalizeProductInput(input));
  }

  update(companyId: number, productId: number, input: Partial<ProductInput>, actorUserId: number | null = null) {
    if (!Number.isSafeInteger(productId) || productId <= 0) throw this.validationError('Producto invalido');
    this.assertProductInput(input, false);
    return this.repository.update(companyId, productId, this.normalizeProductInput(input), actorUserId);
  }

  adjustStock(companyId: number, productId: number, input: StockAdjustmentInput) {
    if (!Number.isSafeInteger(productId) || productId <= 0) throw this.validationError('Producto invalido');
    if (!Number.isInteger(input.delta) || input.delta === 0 || Math.abs(input.delta) > 2_147_483_647) throw this.validationError('El ajuste debe ser entero y distinto de cero');
    return this.repository.adjustStock(companyId, productId, input);
  }

  addImage(companyId: number, productId: number, input: ProductImageInput) {
    if (!Number.isSafeInteger(productId) || productId <= 0) throw this.validationError('Producto invalido');
    const normalized = this.normalizeImageInput(input);
    return this.repository.addImage(companyId, productId, normalized);
  }

  updateImage(companyId: number, productId: number, imageId: number, input: Partial<ProductImageInput>) {
    if (!Number.isSafeInteger(productId) || productId <= 0 || !Number.isSafeInteger(imageId) || imageId <= 0) throw this.validationError('Imagen invalida');
    return this.repository.updateImage(companyId, productId, imageId, this.normalizeImageInput(input, false));
  }

  deleteImage(companyId: number, productId: number, imageId: number) {
    if (!Number.isSafeInteger(productId) || productId <= 0 || !Number.isSafeInteger(imageId) || imageId <= 0) throw this.validationError('Imagen invalida');
    return this.repository.deleteImage(companyId, productId, imageId);
  }

  private assertProductInput(input: Partial<ProductInput>, requireName: boolean): void {
    if ((requireName || input.name !== undefined) &&
        (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 180)) {
      throw this.validationError('Nombre de producto invalido');
    }
    if (input.price !== undefined && input.price !== null && (!Number.isFinite(Number(input.price)) || Number(input.price) < 0)) {
      throw this.validationError('Precio invalido');
    }
    if (input.stockAvailable !== undefined && (!Number.isInteger(Number(input.stockAvailable)) || Number(input.stockAvailable) < 0 || Number(input.stockAvailable) > 2_147_483_647)) {
      throw this.validationError('Disponibilidad invalida');
    }
    if (input.capacity !== undefined && input.capacity !== null && (!Number.isInteger(Number(input.capacity)) || Number(input.capacity) < 0)) {
      throw this.validationError('Capacidad invalida');
    }
    if (input.reservationTtlMinutes !== undefined && input.reservationTtlMinutes !== null && (!Number.isInteger(Number(input.reservationTtlMinutes)) || Number(input.reservationTtlMinutes) <= 0)) {
      throw this.validationError('Tiempo de reserva invalido');
    }
    if (input.catalogIds !== undefined && (!Array.isArray(input.catalogIds) || input.catalogIds.some((id) => !Number.isSafeInteger(Number(id)) || Number(id) <= 0))) {
      throw this.validationError('Catalogo invalido');
    }
    if (input.catalogAssignments !== undefined && (!Array.isArray(input.catalogAssignments) || input.catalogAssignments.some((item) => {
      const catalogId = Number(item?.catalogId);
      const sectionId = item?.sectionId === null || item?.sectionId === undefined ? null : Number(item.sectionId);
      return !Number.isSafeInteger(catalogId) || catalogId <= 0 || (sectionId !== null && (!Number.isSafeInteger(sectionId) || sectionId <= 0));
    }))) {
      throw this.validationError('Catalogo o seccion invalida');
    }
    if (input.images !== undefined) {
      if (!Array.isArray(input.images) || input.images.length > 8) throw this.validationError('El item permite hasta 8 imagenes');
      if (input.images.some((image) => !image || typeof image !== 'object')) {
        throw this.validationError('Imagen invalida');
      }
    }
    if (input.status && !STATUSES.includes(input.status)) throw this.validationError('Estado de catalogo invalido');
    if (input.itemType && !ITEM_TYPES.includes(input.itemType)) throw this.validationError('Tipo de item invalido');
    if (input.availabilityType && !AVAILABILITY_TYPES.includes(input.availabilityType)) {
      throw this.validationError('Tipo de disponibilidad invalido');
    }
    if (input.priceMode && !PRICE_MODES.includes(input.priceMode)) throw this.validationError('Modo de precio invalido');
  }

  private normalizeProductInput<T extends Partial<ProductInput>>(input: T): T {
    return {
      ...input,
      name: input.name?.trim(),
      sku: input.sku ? String(input.sku).trim() : input.sku,
      price: input.price === undefined || input.price === null ? input.price : Number(input.price),
      priceMode: input.priceMode || (input.price === null ? 'consult' : input.priceMode),
      stockAvailable: input.stockAvailable === undefined ? input.stockAvailable : Number(input.stockAvailable),
      capacity: input.capacity === undefined || input.capacity === null ? input.capacity : Number(input.capacity),
      reservationTtlMinutes: input.reservationTtlMinutes === undefined || input.reservationTtlMinutes === null ? input.reservationTtlMinutes : Number(input.reservationTtlMinutes),
      catalogIds: input.catalogIds?.map(Number),
      currency: input.currency ? String(input.currency).trim().toUpperCase().slice(0, 3) : input.currency,
      unitLabel: input.unitLabel ? String(input.unitLabel).trim().slice(0, 40) : input.unitLabel,
      aiDescription: input.aiDescription ? String(input.aiDescription).trim() : input.aiDescription,
      aiSalesInstructions: input.aiSalesInstructions ? String(input.aiSalesInstructions).trim() : input.aiSalesInstructions,
      imageUrl: input.imageUrl ? String(input.imageUrl).trim() : input.imageUrl,
      imageAltText: input.imageAltText ? String(input.imageAltText).trim().slice(0, 180) : input.imageAltText,
      images: input.images?.map((image, index) => this.normalizeImageInput({
        ...image,
        sortOrder: image.sortOrder ?? index,
        isPrimary: image.isPrimary === true,
      })),
      catalogAssignments: input.catalogAssignments?.map((item) => ({
        catalogId: Number(item.catalogId),
        sectionId: item.sectionId ? Number(item.sectionId) : null,
      })),
    };
  }

  private normalizeListFilters(filters: ProductListFilters): ProductListFilters {
    return {
      q: filters.q ? String(filters.q) : '',
      catalogId: filters.catalogId ? Number(filters.catalogId) : null,
      type: filters.type || null,
      status: filters.status || null,
      aiEnabled: typeof filters.aiEnabled === 'boolean' ? filters.aiEnabled : null,
      sectionId: filters.sectionId ? Number(filters.sectionId) : null,
    };
  }

  private normalizeImageInput<T extends Partial<ProductImageInput>>(input: T, requireUrl = true): T {
    if ((requireUrl || input.imageUrl !== undefined) && (typeof input.imageUrl !== 'string' || !input.imageUrl.trim())) {
      throw this.validationError('URL de imagen requerida');
    }
    if (input.sortOrder !== undefined && (!Number.isInteger(Number(input.sortOrder)) || Math.abs(Number(input.sortOrder)) > 2_147_483_647)) {
      throw this.validationError('Orden de imagen invalido');
    }
    if (input.sizeBytes != null && (!Number.isInteger(Number(input.sizeBytes)) || Number(input.sizeBytes) < 0 || Number(input.sizeBytes) > 2_147_483_647)) {
      throw this.validationError('Tamano de imagen invalido');
    }
    return {
      ...input,
      imageUrl: input.imageUrl ? String(input.imageUrl).trim() : input.imageUrl,
      imageAltText: input.imageAltText ? String(input.imageAltText).trim().slice(0, 180) : input.imageAltText,
      sortOrder: input.sortOrder === undefined ? input.sortOrder : Number(input.sortOrder),
      mimeType: input.mimeType ? String(input.mimeType).slice(0, 120) : input.mimeType,
      sizeBytes: input.sizeBytes === undefined || input.sizeBytes === null ? input.sizeBytes : Number(input.sizeBytes),
    };
  }

  private validationError(message: string): Error & { statusCode?: number; code?: string } {
    const error = new Error(message) as Error & { statusCode?: number; code?: string };
    error.statusCode = 400;
    error.code = 'VALIDATION_ERROR';
    return error;
  }
}
