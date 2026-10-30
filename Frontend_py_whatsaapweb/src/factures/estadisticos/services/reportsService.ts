import { api } from '../../../shared/axios/http';

export interface ReportFilters {
  startDate: string;
  endDate: string;
  timezone?: string;
  tagId?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

export interface ReportMetrics {
  totalChats: number;
  totalMessages: number;
  totalUnread: number;
  averageResponseTime: number;
  chatsByTag: { tagName: string; count: number; color?: string | null }[];
  messagesByDay: { date: string; count: number }[];
  topChats: { chatId: string; name: string; messageCount: number }[];
  messagesByType: { type: string; count: number }[];
}

export interface OperationalReportRow {
  orderId: number;
  occurredAt: string;
  customerName: string;
  phone: string | null;
  chatId: string | null;
  title: string;
  serviceType: string;
  orderType?: string;
  status: string;
  employeeName: string | null;
  actionCount: number;
  notes: string | null;
  products?: string;
  itemTypes?: string;
  totalQuantity?: number;
  reservedQuantity?: number;
}

export interface OperationalReportPage {
  rows: OperationalReportRow[];
  total: number;
  limit: number;
  offset: number;
}

export interface HeatmapMatrix {
  days: Array<{ day: number; label: string; hours: number[]; total: number }>;
  maxCount: number;
  totalMessages: number;
}

export interface ChatHistoryExport {
  chatId: string;
  chatName: string;
  messages: Array<{
    id: string;
    timestamp: number;
    sender: string;
    body: string;
    type: string;
    fromMe: boolean;
    hasMedia: boolean;
  }>;
  exportDate: string;
}

function requestParams(filters: ReportFilters) {
  return {
    startDate: filters.startDate,
    endDate: filters.endDate,
    timezone: filters.timezone || 'America/Lima',
    tagId: filters.tagId || undefined,
    status: filters.status || undefined,
    limit: filters.limit,
    offset: filters.offset,
  };
}

export async function getMetrics(filters: ReportFilters): Promise<ReportMetrics> {
  const response = await api.get('/reports/metrics', { params: requestParams(filters) });
  return response.data.data;
}

export async function getOperationalReport(filters: ReportFilters): Promise<OperationalReportPage> {
  const response = await api.get('/reports/operations', { params: requestParams(filters) });
  return response.data.data;
}

export async function getHeatmap(filters: ReportFilters): Promise<HeatmapMatrix> {
  const response = await api.get('/reports/heatmap', { params: requestParams(filters) });
  return response.data.data;
}

export async function downloadOperationalReport(filters: ReportFilters, format: 'csv' | 'xls'): Promise<void> {
  const response = await api.get('/reports/operations/export', {
    params: { ...requestParams(filters), format },
    responseType: 'blob',
  });
  const contentDisposition = String(response.headers['content-disposition'] || '');
  const filename = contentDisposition.match(/filename="([^"]+)"/)?.[1]
    || `reporte-operativo-${filters.startDate}-${filters.endDate}.${format}`;
  downloadBlob(response.data, filename);
}

export async function getChatHistory(chatId: string): Promise<ChatHistoryExport> {
  const response = await api.get(`/reports/chat/${encodeURIComponent(chatId)}/history`);
  return response.data.data;
}

export async function getStatsByDateRange(startDate: string, endDate: string) {
  const response = await api.get('/reports/stats', { params: { startDate, endDate } });
  return response.data.data;
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
