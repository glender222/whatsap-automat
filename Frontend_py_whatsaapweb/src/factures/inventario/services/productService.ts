import { api } from '../../../shared/axios/http';

export type CommercialItemType = 'physical_product' | 'digital_product' | 'service' | 'course' | 'subscription' | 'custom';
export type AvailabilityType = 'stock' | 'unlimited' | 'capacity' | 'manual' | 'schedule';
export type PriceMode = 'fixed' | 'from' | 'free' | 'consult';
export type CatalogStatus = 'active' | 'inactive' | 'archived';

export type CatalogSummary = {
  id: number;
  name: string;
  status: CatalogStatus;
  aiEnabled: boolean;
};

export type Catalog = CatalogSummary & {
  description: string | null;
  aiInstructions: string;
  salesPolicy: string;
  sortOrder: number;
  itemCount: number;
  sections: CatalogSection[];
};

export type CatalogSection = {
  id: number;
  catalogId: number;
  name: string;
  description: string | null;
  status: CatalogStatus;
  aiEnabled: boolean;
  aiInstructions: string;
  sortOrder: number;
  itemCount: number;
};

export type CatalogSectionSummary = {
  id: number;
  catalogId: number;
  catalogName: string;
  name: string;
  status: CatalogStatus;
  aiEnabled: boolean;
};

export type CatalogAssignmentInput = {
  catalogId: number;
  sectionId?: number | null;
};

export type Product = {
  id: number;
  name: string;
  description: string | null;
  sku: string | null;
  price: number | null;
  priceMode: PriceMode;
  currency: string;
  status: 'draft' | 'active' | 'inactive' | 'archived';
  itemType: CommercialItemType;
  unitLabel: string | null;
  aiEnabled: boolean;
  aiDescription: string | null;
  aiSalesInstructions: string | null;
  requiresHumanApproval: boolean;
  availabilityType: AvailabilityType;
  capacity: number | null;
  allowBackorder: boolean;
  reservationTtlMinutes: number | null;
  stockAvailable: number;
  stockReserved: number;
  catalogs: CatalogSummary[];
  sections: CatalogSectionSummary[];
  primaryImage: { url: string; altText: string | null } | null;
  images: ProductImage[];
  imageUrl: string | null;
  imageAltText: string | null;
  aiReadiness: 'ready' | 'missing_catalog' | 'missing_section' | 'missing_ai_context' | 'disabled' | 'inactive';
};

export type ProductImage = {
  id?: number;
  productId?: number;
  url: string;
  altText: string | null;
  sortOrder?: number;
  isPrimary?: boolean;
  mimeType?: string | null;
  sizeBytes?: number | null;
};

export type ProductImageInput = {
  imageUrl: string;
  imageAltText?: string | null;
  sortOrder?: number;
  isPrimary?: boolean;
  mimeType?: string | null;
  sizeBytes?: number | null;
};

export type ProductInput = {
  name: string;
  description?: string;
  sku?: string;
  price?: number | null;
  priceMode?: PriceMode;
  status?: Product['status'];
  itemType?: CommercialItemType;
  unitLabel?: string | null;
  aiEnabled?: boolean;
  aiDescription?: string | null;
  aiSalesInstructions?: string | null;
  requiresHumanApproval?: boolean;
  availabilityType?: AvailabilityType;
  capacity?: number | null;
  allowBackorder?: boolean;
  reservationTtlMinutes?: number | null;
  stockAvailable?: number;
  catalogIds?: number[];
  catalogAssignments?: CatalogAssignmentInput[];
  imageUrl?: string | null;
  imageAltText?: string | null;
  images?: ProductImageInput[];
};

export type CatalogInput = {
  name: string;
  description?: string | null;
  status?: CatalogStatus;
  aiEnabled?: boolean;
  aiInstructions?: string;
  salesPolicy?: string;
  sortOrder?: number;
};

export type CatalogSectionInput = {
  name: string;
  description?: string | null;
  status?: CatalogStatus;
  aiEnabled?: boolean;
  aiInstructions?: string;
  sortOrder?: number;
};

export type ProductListQuery = {
  q?: string;
  catalogId?: number | 'all';
  sectionId?: number | 'all';
  type?: CommercialItemType | 'all';
  status?: Product['status'] | 'all';
  aiEnabled?: boolean | 'all';
};

export async function listProducts(query: ProductListQuery | string = ''): Promise<Product[]> {
  const params = typeof query === 'string'
    ? (query ? { q: query } : undefined)
    : {
        ...(query.q ? { q: query.q } : {}),
        ...(query.catalogId && query.catalogId !== 'all' ? { catalogId: query.catalogId } : {}),
        ...(query.sectionId && query.sectionId !== 'all' ? { sectionId: query.sectionId } : {}),
        ...(query.type && query.type !== 'all' ? { type: query.type } : {}),
        ...(query.status && query.status !== 'all' ? { status: query.status } : {}),
        ...(query.aiEnabled !== undefined && query.aiEnabled !== 'all' ? { aiEnabled: String(query.aiEnabled) } : {}),
      };
  const response = await api.get<{ success: boolean; data: Product[] }>('/commercial-items', {
    params,
  });
  return response.data.data || [];
}

export async function createProduct(input: ProductInput): Promise<Product> {
  const response = await api.post<{ success: boolean; data: Product }>('/commercial-items', input);
  return response.data.data;
}

export async function updateProduct(productId: number, input: Partial<ProductInput>): Promise<Product> {
  const response = await api.patch<{ success: boolean; data: Product }>(`/commercial-items/${productId}`, input);
  return response.data.data;
}

export async function adjustStock(productId: number, delta: number, notes?: string): Promise<Product> {
  const response = await api.post<{ success: boolean; data: Product }>(
    `/commercial-items/${productId}/availability-movements`,
    { delta, notes }
  );
  return response.data.data;
}

export async function uploadCommercialItemImage(file: File, altText?: string): Promise<{
  imageUrl: string;
  imageAltText: string | null;
  filename: string;
  mimeType: string;
  size: number;
}> {
  const formData = new FormData();
  formData.append('file', file);
  if (altText) formData.append('altText', altText);

  const response = await api.post<{
    success: boolean;
    data: {
      imageUrl: string;
      imageAltText: string | null;
      filename: string;
      mimeType: string;
      size: number;
    };
  }>('/commercial-items/media', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return response.data.data;
}

export async function addProductImage(productId: number, input: ProductImageInput): Promise<ProductImage> {
  const response = await api.post<{ success: boolean; data: ProductImage }>(`/commercial-items/${productId}/images`, input);
  return response.data.data;
}

export async function updateProductImage(productId: number, imageId: number, input: Partial<ProductImageInput>): Promise<ProductImage> {
  const response = await api.patch<{ success: boolean; data: ProductImage }>(`/commercial-items/${productId}/images/${imageId}`, input);
  return response.data.data;
}

export async function deleteProductImage(productId: number, imageId: number): Promise<boolean> {
  const response = await api.delete<{ success: boolean; data: { removed: boolean } }>(`/commercial-items/${productId}/images/${imageId}`);
  return response.data.data.removed;
}

export async function listCatalogs(): Promise<Catalog[]> {
  const response = await api.get<{ success: boolean; data: Catalog[] }>('/catalogs');
  return response.data.data || [];
}

export async function createCatalog(input: CatalogInput): Promise<Catalog> {
  const response = await api.post<{ success: boolean; data: Catalog }>('/catalogs', input);
  return response.data.data;
}

export async function updateCatalog(catalogId: number, input: Partial<CatalogInput>): Promise<Catalog> {
  const response = await api.patch<{ success: boolean; data: Catalog }>(`/catalogs/${catalogId}`, input);
  return response.data.data;
}

export async function updateCatalogStatus(catalogId: number, status: CatalogStatus): Promise<Catalog> {
  const response = await api.patch<{ success: boolean; data: Catalog }>(`/catalogs/${catalogId}/status`, { status });
  return response.data.data;
}

export async function listCatalogSections(catalogId: number): Promise<CatalogSection[]> {
  const response = await api.get<{ success: boolean; data: CatalogSection[] }>(`/catalogs/${catalogId}/sections`);
  return response.data.data || [];
}

export async function createCatalogSection(catalogId: number, input: CatalogSectionInput): Promise<CatalogSection> {
  const response = await api.post<{ success: boolean; data: CatalogSection }>(`/catalogs/${catalogId}/sections`, input);
  return response.data.data;
}

export async function updateCatalogSection(sectionId: number, input: Partial<CatalogSectionInput>): Promise<CatalogSection> {
  const response = await api.patch<{ success: boolean; data: CatalogSection }>(`/catalogs/sections/${sectionId}`, input);
  return response.data.data;
}

export async function updateCatalogSectionStatus(sectionId: number, status: CatalogStatus): Promise<CatalogSection> {
  const response = await api.patch<{ success: boolean; data: CatalogSection }>(`/catalogs/sections/${sectionId}/status`, { status });
  return response.data.data;
}
