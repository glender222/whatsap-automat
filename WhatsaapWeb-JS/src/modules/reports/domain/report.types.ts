export type ReportFilters = {
  startDate: string;
  endDate: string;
  timezone: string;
  tagId?: number;
  actorUserId?: number;
  status?: string;
  limit: number;
  offset: number;
};

export type OperationalReportRow = {
  orderId: number;
  occurredAt: Date;
  customerName: string;
  phone: string | null;
  chatId: string | null;
  title: string;
  serviceType: string;
  orderType: string;
  status: string;
  employeeName: string | null;
  actionCount: number;
  notes: string | null;
  products: string;
  itemTypes: string;
  totalQuantity: number;
  reservedQuantity: number;
};

export type OperationalReportPage = {
  rows: OperationalReportRow[];
  total: number;
  limit: number;
  offset: number;
};

export type ReportMetrics = {
  totalChats: number;
  totalMessages: number;
  totalUnread: number;
  averageResponseTime: number;
  chatsByTag: Array<{ tagName: string; count: number; color: string | null }>;
  messagesByDay: Array<{ date: string; count: number }>;
  topChats: Array<{ chatId: string; name: string; messageCount: number }>;
  messagesByType: Array<{ type: string; count: number }>;
};

export type HeatmapPoint = {
  day: number;
  hour: number;
  count: number;
};

export type HeatmapMatrix = {
  days: Array<{ day: number; label: string; hours: number[]; total: number }>;
  maxCount: number;
  totalMessages: number;
};

export type ChatHistoryExport = {
  chatId: string;
  chatName: string;
  exportDate: string;
  messages: Array<{
    id: string;
    timestamp: number;
    sender: string;
    body: string;
    type: string;
    fromMe: boolean;
    hasMedia: boolean;
  }>;
};
