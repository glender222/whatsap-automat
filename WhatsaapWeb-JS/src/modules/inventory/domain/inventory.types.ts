export type ProductStatus = 'draft' | 'active' | 'inactive' | 'archived';
export type CatalogStatus = 'active' | 'inactive' | 'archived';
export type CatalogSectionStatus = 'active' | 'inactive' | 'archived';
export type CommercialItemType = 'physical_product' | 'digital_product' | 'service' | 'course' | 'subscription' | 'custom';
export type AvailabilityType = 'stock' | 'unlimited' | 'capacity' | 'manual' | 'schedule';
export type PriceMode = 'fixed' | 'from' | 'free' | 'consult';
export type StockMovementType =
  | 'adjustment'
  | 'reservation'
  | 'release'
  | 'completion'
  | 'initial'
  | 'reserved'
  | 'reservation_released'
  | 'confirmed_consumed'
  | 'cancelled_restored'
  | 'capacity_reserved'
  | 'manual_override';

export type Product = {
  id: number;
  companyId: number;
  name: string;
  description: string | null;
  sku: string | null;
  price: number | null;
  priceMode: PriceMode;
  currency: string;
  status: ProductStatus;
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
  primaryImage: ProductImage | null;
  images: ProductImage[];
  imageUrl: string | null;
  imageAltText: string | null;
  aiReadiness: 'ready' | 'missing_catalog' | 'missing_section' | 'missing_ai_context' | 'disabled' | 'inactive';
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
};

export type Catalog = {
  id: number;
  companyId: number;
  name: string;
  description: string | null;
  status: CatalogStatus;
  aiEnabled: boolean;
  aiInstructions: string;
  salesPolicy: string;
  sortOrder: number;
  itemCount: number;
  sections: CatalogSection[];
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
};

export type CatalogSummary = {
  id: number;
  name: string;
  status: CatalogStatus;
  aiEnabled: boolean;
};

export type CatalogSection = {
  id: number;
  companyId: number;
  catalogId: number;
  name: string;
  description: string | null;
  status: CatalogSectionStatus;
  aiEnabled: boolean;
  aiInstructions: string;
  sortOrder: number;
  itemCount: number;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
};

export type CatalogSectionSummary = {
  id: number;
  catalogId: number;
  catalogName: string;
  name: string;
  status: CatalogSectionStatus;
  aiEnabled: boolean;
};

export type CatalogAssignmentInput = {
  catalogId: number;
  sectionId?: number | null;
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

export type StockMovement = {
  id: number;
  companyId: number;
  productId: number;
  commercialItemId: number | null;
  orderId: number | null;
  orderItemId: number | null;
  actorUserId: number | null;
  actorAgentId: number | null;
  movementType: StockMovementType;
  quantity: number;
  deltaAvailable: number | null;
  deltaReserved: number | null;
  stockAvailableAfter: number;
  stockReservedAfter: number;
  notes: string | null;
  metadata: Record<string, unknown>;
  occurredAt: Date;
};

export type ProductInput = {
  name: string;
  description?: string | null;
  sku?: string | null;
  price?: number | null;
  priceMode?: PriceMode;
  currency?: string;
  status?: ProductStatus;
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
  metadata?: Record<string, unknown>;
};

export type ProductImageInput = {
  imageUrl: string;
  imageAltText?: string | null;
  sortOrder?: number;
  isPrimary?: boolean;
  mimeType?: string | null;
  sizeBytes?: number | null;
};

export type ProductListFilters = {
  q?: string;
  catalogId?: number | null;
  type?: CommercialItemType | null;
  status?: ProductStatus | null;
  aiEnabled?: boolean | null;
  sectionId?: number | null;
};

export type CatalogInput = {
  name: string;
  description?: string | null;
  status?: CatalogStatus;
  aiEnabled?: boolean;
  aiInstructions?: string;
  salesPolicy?: string;
  sortOrder?: number;
  metadata?: Record<string, unknown>;
};

export type CatalogSectionInput = {
  name: string;
  description?: string | null;
  status?: CatalogSectionStatus;
  aiEnabled?: boolean;
  aiInstructions?: string;
  sortOrder?: number;
  metadata?: Record<string, unknown>;
};

export type StockAdjustmentInput = {
  delta: number;
  notes?: string | null;
  actorUserId?: number | null;
};
