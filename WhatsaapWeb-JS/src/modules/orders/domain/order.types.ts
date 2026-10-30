import { Product } from '../../inventory';

export type CommercialOrderStatus =
  | 'draft'
  | 'quoted'
  | 'pending_handoff'
  | 'pending_approval'
  | 'confirmed'
  | 'reserved'
  | 'cancelled'
  | 'completed'
  | 'out_of_stock'
  | 'unavailable';

export type OrderItem = {
  id: number;
  orderId: number;
  companyId: number;
  productId: number | null;
  commercialItemId: number | null;
  productName?: string;
  itemNameSnapshot: string;
  itemTypeSnapshot: string;
  sku: string | null;
  quantity: number;
  unitPrice: number | null;
  currency: string;
  status: CommercialOrderStatus;
  availabilityStatus: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
};

export type CommercialOrder = {
  id: number;
  companyId: number;
  contactId: number | null;
  conversationId: number | null;
  sourceMessageId: number | null;
  createdBy: number | null;
  agentId: number | null;
  title: string;
  serviceType: string;
  orderType: string;
  status: CommercialOrderStatus | string;
  notes: string | null;
  metadata: Record<string, unknown>;
  occurredAt: Date;
  confirmedAt: Date | null;
  reservedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  items: OrderItem[];
};

export type DetectedOrderItemInput = {
  commercialItemId?: number | null;
  detectedName?: string;
  productName: string;
  quantity?: number;
  confidence?: number;
  ambiguous?: boolean;
};

export type CreateDetectedOrderInput = {
  companyId: number;
  chatId: string;
  agentId?: number | null;
  userId?: number | null;
  sourceMessageId?: number | null;
  items: DetectedOrderItemInput[];
  status?: CommercialOrderStatus;
  notes?: string | null;
  metadata?: Record<string, unknown>;
};

export type ProductMatch = {
  requestedName: string;
  quantity: number;
  product: Product | null;
  available: boolean;
  requiresApproval: boolean;
  availabilityStatus: 'available' | 'reserved' | 'manual_required' | 'unlimited' | 'unavailable';
  status: CommercialOrderStatus;
};
