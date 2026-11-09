import { api } from '../../../shared/axios/http';

export type QuickStats = {
  averageResponseTimeMin: number;
  activeChatsCount: number;
  ordersTodayCount: number;
};

export type ActionCardsStats = {
  pendingChatsCount: number;
  pendingPaymentsCount: number;
  lowStockCount: number;
};

export type HeatmapByDateDay = {
  date: string;
  label: string;
  hours: number[];
  total: number;
};

export type HeatmapByDateMatrix = {
  days: HeatmapByDateDay[];
  maxCount: number;
  totalMessages: number;
};

export type SlaStatusTag = 'unassigned' | 'payment_pending' | 'ai_ready' | 'attention';

export type SlaAlert = {
  chatId: string;
  conversationId: number | null;
  displayName: string;
  phone: string | null;
  lastPreview: string;
  waitingMin: number;
  statusTag: SlaStatusTag;
};

export type SlaAlertsResult = {
  thresholdMinutes: number;
  total: number;
  alerts: SlaAlert[];
};

export type LowStockItem = {
  id: number;
  name: string;
  sku: string | null;
  stockAvailable: number;
  stockReserved: number;
  minStock: number;
  shortage: number;
};

export type WhatsappStatusSummary = {
  connected: boolean;
  provider: string;
  accountStatus: string | null;
};

function unwrap<T>(response: { data: { success: boolean; data: T } }): T {
  if (response.data?.success !== true || response.data.data == null) {
    throw new Error('El servidor no confirmó los datos del resumen.');
  }
  return response.data.data;
}

export const dashboardService = {
  async getQuickStats(): Promise<QuickStats> {
    const response = await api.get('/dashboard/quick-stats');
    return unwrap<QuickStats>(response);
  },

  async getActionCards(): Promise<ActionCardsStats> {
    const response = await api.get('/dashboard/action-cards');
    return unwrap<ActionCardsStats>(response);
  },

  async getHeatmap(days = 7): Promise<HeatmapByDateMatrix> {
    const response = await api.get('/dashboard/heatmap', { params: { days } });
    return unwrap<HeatmapByDateMatrix>(response);
  },

  async getSlaAlerts(limit = 20): Promise<SlaAlertsResult> {
    const response = await api.get('/dashboard/sla-alerts', { params: { limit } });
    return unwrap<SlaAlertsResult>(response);
  },

  async getLowStock(limit = 50, offset = 0): Promise<{ rows: LowStockItem[]; total: number }> {
    const response = await api.get('/products/low-stock', { params: { limit, offset } });
    return unwrap<{ rows: LowStockItem[]; total: number }>(response);
  },

  async getWhatsappStatus(): Promise<WhatsappStatusSummary> {
    const response = await api.get('/whatsapp/status');
    const data = response.data?.data ?? response.data;
    const connected = data?.connected ?? data?.isReady ?? data?.isConnected;
    if (response.data?.success === false || typeof connected !== 'boolean') {
      throw new Error('El servidor no confirmó el estado de WhatsApp.');
    }
    return {
      connected,
      provider: data?.provider || 'unknown',
      accountStatus: data?.accountStatus ?? null,
    };
  },
};
