import {
  ChatHistoryExport,
  HeatmapPoint,
  OperationalReportPage,
  ReportFilters,
  ReportMetrics,
} from '../../domain/report.types';

export interface ReportRepositoryPort {
  getMetrics(companyId: number, filters: ReportFilters): Promise<ReportMetrics>;
  getOperationalReport(companyId: number, filters: ReportFilters): Promise<OperationalReportPage>;
  getHeatmapPoints(companyId: number, filters: ReportFilters): Promise<HeatmapPoint[]>;
  getChatHistory(companyId: number, chatId: string, limit: number): Promise<ChatHistoryExport | null>;
}
