import { api } from '../../../shared/axios/http';

export type PaymentMethod = 'yape' | 'plin' | 'bank_transfer' | 'cash' | 'other';
export type PaymentVoucherStatus = 'pending' | 'validated' | 'rejected';
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
  orderReconciliationRequired?: boolean;
  paymentMethod: PaymentMethod | null;
  amount: number | null;
  orderTotal: number | null;
  currency: string;
  customerName: string;
  chatId: string | null;
  fileUrl: string | null;
  mimeType: string | null;
  uploadedAt: string | null;
  validatedAt: string | null;
  orderCreatedAt: string | null;
  items: PaymentProcessItem[];
};

export type PaymentVoucherPage = {
  rows: PaymentProcessSummary[];
  total: number;
  limit: number;
  offset: number;
};

export type MercadoPagoReconciliation = {
  orderId: string;
  providerOrderId: string | null;
  expectedAmount: string;
  amountPaid: string | null;
  currency: 'PEN';
  state: 'awaiting_observation' | 'unpaid' | 'pending' | 'failed' | 'partial' | 'settled' | 'review_required';
  observedAt: string | null;
  settledAt: string | null;
  reviewCode: string | null;
};

export type MercadoPagoReconciliationPage = {
  rows: MercadoPagoReconciliation[];
  nextBeforeOrderId: string | null;
};

export type PaymentListFilters = {
  status?: PaymentVoucherStatus;
  paymentMethod?: PaymentMethod;
  orderId?: number;
  chatId?: string;
  startDate?: string;
  endDate?: string;
  limit?: number;
  offset?: number;
};

function unwrap<T>(response: { data: { success: boolean; data: T } }): T {
  return response.data.data;
}

export const paymentsService = {
  async getVoucherFile(fileUrl: string, signal: AbortSignal): Promise<Blob> {
    const apiBase = new URL(api.defaults.baseURL ?? '/api', window.location.origin);
    const prefix = apiBase.pathname.replace(/\/api\/?$/, '').replace(/\/$/, '');
    const stored = new URL(fileUrl, apiBase.origin);
    const pathname = stored.pathname.startsWith(`${prefix}/`) ? stored.pathname.slice(prefix.length) : stored.pathname;
    if (stored.origin !== apiBase.origin || stored.username || stored.password || stored.search || stored.hash ||
        !/^\/(?:uploads\/payment-vouchers|api\/media)\/[^/]+$/.test(pathname) || /%(?:2f|5c)/i.test(pathname)) {
      throw new Error('La ruta del comprobante no es válida.');
    }

    const { data } = await api.get<Blob>(`${apiBase.origin}${prefix}${pathname}`, { responseType: 'blob', signal });
    const mimeType = data.type.split(';')[0];
    if (!data.size || !/^(?:image\/(?:jpeg|png|webp|gif)|application\/pdf|video\/mp4)$/i.test(mimeType)) {
      throw new Error('El archivo no tiene un formato de comprobante compatible.');
    }
    return data;
  },

  async list(filters: PaymentListFilters = {}): Promise<PaymentVoucherPage> {
    const response = await api.get('/payments', {
      params: {
        status: filters.status,
        paymentMethod: filters.paymentMethod,
        orderId: filters.orderId,
        chatId: filters.chatId,
        startDate: filters.startDate,
        endDate: filters.endDate,
        limit: filters.limit ?? 50,
        offset: filters.offset ?? 0,
      },
    });
    return unwrap<PaymentVoucherPage>(response);
  },

  async listMercadoPagoReconciliations(
    filters: { orderId: string; beforeOrderId: string | null }, signal: AbortSignal,
  ): Promise<MercadoPagoReconciliationPage> {
    const response = await api.get('/payments/mercadopago-reconciliations', {
      params: { orderId: filters.orderId || undefined, beforeOrderId: filters.beforeOrderId ?? undefined, limit: 15 },
      signal,
    });
    return unwrap<MercadoPagoReconciliationPage>(response);
  },

  async countPending(): Promise<number> {
    const response = await api.get('/payments/pending/count');
    return unwrap<{ count: number }>(response).count;
  },

  async validate(voucherId: number): Promise<void> {
    await api.post(`/payments/${voucherId}/validate`);
  },

  async reject(voucherId: number, rejectionReason: string): Promise<void> {
    await api.post(`/payments/${voucherId}/reject`, { rejectionReason });
  },

  async cancelOrder(orderId: number): Promise<void> {
    await api.post(`/orders/${orderId}/cancel`);
  },
};
