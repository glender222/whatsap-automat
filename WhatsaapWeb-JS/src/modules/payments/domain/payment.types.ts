export type PaymentMethod = 'yape' | 'plin' | 'bank_transfer' | 'cash' | 'other';
export type PaymentVoucherStatus = 'pending' | 'validated' | 'rejected';

export type PaymentVoucher = {
  id: number;
  companyId: number;
  orderId: number | null;
  chatId: string | null;
  contactId: number | null;
  conversationId: number | null;
  sourceMessageId: number | null;
  fileUrl: string;
  mimeType: string | null;
  fileSize: number | null;
  paymentMethod: PaymentMethod;
  amount: number | null;
  currency: string;
  senderReference: string | null;
  status: PaymentVoucherStatus;
  rejectionReason: string | null;
  orderReconciliationRequired: boolean;
  uploadedBy: number | null;
  validatedBy: number | null;
  validatedAt: Date | null;
  notes: string | null;
  metadata: Record<string, unknown>;
  uploadedAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type PaymentVoucherSummary = {
  id: number;
  status: PaymentVoucherStatus;
  paymentMethod: PaymentMethod;
  amount: number | null;
  currency: string;
  customerName: string;
  chatId: string | null;
  orderId: number | null;
  fileUrl: string;
  mimeType: string | null;
  uploadedAt: Date;
  validatedAt: Date | null;
};

export type PaymentProcessStatus = 'collect_payment' | 'voucher_pending' | 'validated' | 'rejected';

export type PaymentProcessItem = {
  id: number;
  productName: string;
  quantity: number;
  unitPrice: number | null;
  currency: string;
  status: string;
};

export type PaymentProcessSummary = {
  rowId: string;
  rowType: 'payment_process' | 'voucher';
  processStatus: PaymentProcessStatus;
  orderId: number | null;
  voucherId: number | null;
  orderStatus: string | null;
  voucherStatus: PaymentVoucherStatus | null;
  orderReconciliationRequired: boolean;
  paymentMethod: PaymentMethod | null;
  amount: number | null;
  orderTotal: number | null;
  currency: string;
  customerName: string;
  chatId: string | null;
  fileUrl: string | null;
  mimeType: string | null;
  uploadedAt: Date | null;
  validatedAt: Date | null;
  orderCreatedAt: Date | null;
  items: PaymentProcessItem[];
};

export type PaymentVoucherPage = {
  rows: PaymentProcessSummary[];
  total: number;
  limit: number;
  offset: number;
};

export type CreatePaymentVoucherInput = {
  companyId: number;
  orderId?: number | null;
  chatId?: string | null;
  contactId?: number | null;
  conversationId?: number | null;
  sourceMessageId?: number | null;
  fileUrl: string;
  mimeType?: string | null;
  fileSize?: number | null;
  paymentMethod: PaymentMethod;
  amount?: number | null;
  currency?: string;
  senderReference?: string | null;
  uploadedBy?: number | null;
  notes?: string | null;
  metadata?: Record<string, unknown>;
};

export type MarkFromMessageInput = {
  companyId: number;
  messageId: number;
  chatId?: string | null;
  orderId?: number | null;
  paymentMethod: PaymentMethod;
  amount?: number | null;
  currency?: string;
  senderReference?: string | null;
  uploadedBy?: number | null;
  notes?: string | null;
};

export type PaymentFilters = {
  status?: PaymentVoucherStatus;
  paymentMethod?: PaymentMethod;
  orderId?: number;
  chatId?: string;
  startDate?: string;
  endDate?: string;
  limit: number;
  offset: number;
};
