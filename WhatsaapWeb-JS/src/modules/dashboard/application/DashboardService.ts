import {
  ActionCardsStats,
  HeatmapByDateMatrix,
  LowStockItem,
  QuickStats,
  SlaAlertsResult,
} from '../domain/dashboard.types';
import { DashboardRepositoryPg } from '../infra/db/DashboardRepositoryPg';

export class DashboardService {
  constructor(private readonly repository: DashboardRepositoryPg) {}

  async getQuickStats(companyId: number): Promise<QuickStats> {
    const timezone = await this.repository.getCompanyTimezone(companyId);
    return this.repository.getQuickStats(companyId, timezone);
  }

  async getActionCards(companyId: number): Promise<ActionCardsStats> {
    const timezone = await this.repository.getCompanyTimezone(companyId);
    return this.repository.getActionCards(companyId, timezone);
  }

  async getHeatmap(companyId: number, days: number): Promise<HeatmapByDateMatrix> {
    const timezone = await this.repository.getCompanyTimezone(companyId);
    return this.repository.getHeatmapByDate(companyId, timezone, days);
  }

  async getSlaAlerts(companyId: number, limit: number): Promise<SlaAlertsResult> {
    const thresholdMinutes = await this.repository.getSlaThreshold(companyId);
    return this.repository.getSlaAlerts(companyId, thresholdMinutes, limit);
  }

  async getLowStock(
    companyId: number,
    limit: number,
    offset: number
  ): Promise<{ rows: LowStockItem[]; total: number }> {
    return this.repository.getLowStock(companyId, limit, offset);
  }
}
