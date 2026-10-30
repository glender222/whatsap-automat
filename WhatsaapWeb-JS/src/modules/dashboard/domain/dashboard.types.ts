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
