import { tenantScopedUoW, TenantScopedUoW } from '../../../db/TenantScopedUoW';
import { TenantUsageSummaryV1 } from './types';
import { formatMicroUsdToUsd } from '@whatsap-automat/contracts';

export class QuotaManager {
  constructor(private readonly uow: TenantScopedUoW = tenantScopedUoW) {}

  /**
   * Asserts that the tenant is within their monthly AI spending quota.
   * Performs automatic month roll-over check and throws 429 RATE_LIMITED if breached.
   */
  async assertWithinQuota(tenantId: number): Promise<void> {
    await this.uow.run(tenantId, async (client) => {
      // 1. Ensure quota record exists
      await client.query(
        `INSERT INTO tenant_ai_quotas (tenant_id)
         VALUES ($1)
         ON CONFLICT (tenant_id) DO NOTHING`,
        [tenantId]
      );

      // 2. Fetch current quota
      const res = await client.query(
        `SELECT monthly_cost_limit_micro_usd, current_month_cost_micro_usd,
                monthly_token_limit, current_month_tokens_used,
                hard_limit_enabled, hard_limit_action, period_start
         FROM tenant_ai_quotas
         WHERE tenant_id = $1`,
        [tenantId]
      );

      const quota = res.rows[0];
      if (!quota) return;

      // 3. Check for month roll-over
      const now = new Date();
      const periodStart = new Date(quota.period_start);
      if (
        now.getFullYear() > periodStart.getFullYear() ||
        now.getMonth() > periodStart.getMonth()
      ) {
        await client.query(
          `UPDATE tenant_ai_quotas
           SET current_month_cost_micro_usd = 0,
               current_month_tokens_used = 0,
               period_start = date_trunc('month', NOW()),
               reset_at = (date_trunc('month', NOW()) + INTERVAL '1 month'),
               updated_at = NOW()
           WHERE tenant_id = $1`,
          [tenantId]
        );
        return; // Counters reset, request is within quota
      }

      // 4. Enforce hard limit
      const currentCost = Number(quota.current_month_cost_micro_usd);
      const costLimit = Number(quota.monthly_cost_limit_micro_usd);
      if (quota.hard_limit_enabled && currentCost >= costLimit) {
        const err = new Error(
          `QUOTA_EXCEEDED: Monthly AI spend limit reached (${currentCost} / ${costLimit} micro-USD)`
        ) as any;
        err.statusCode = 429;
        err.code = 'RATE_LIMITED';
        throw err;
      }
    });
  }

  /**
   * Atomically increments the tenant's monthly spend and token counters.
   */
  async consume(tenantId: number, costMicroUsd: number, tokensUsed: number): Promise<void> {
    if (costMicroUsd <= 0 && tokensUsed <= 0) return;

    await this.uow.run(tenantId, async (client) => {
      await client.query(
        `INSERT INTO tenant_ai_quotas (tenant_id)
         VALUES ($1)
         ON CONFLICT (tenant_id) DO NOTHING`,
        [tenantId]
      );

      await client.query(
        `UPDATE tenant_ai_quotas
         SET current_month_cost_micro_usd = current_month_cost_micro_usd + $1,
             current_month_tokens_used = current_month_tokens_used + $2,
             updated_at = NOW()
         WHERE tenant_id = $3`,
        [costMicroUsd, tokensUsed, tenantId]
      );
    });
  }

  /**
   * Retrieves usage summary for client dashboard consumption.
   */
  async getSummary(tenantId: number): Promise<TenantUsageSummaryV1> {
    return this.uow.run(tenantId, async (client) => {
      await client.query(
        `INSERT INTO tenant_ai_quotas (tenant_id)
         VALUES ($1)
         ON CONFLICT (tenant_id) DO NOTHING`,
        [tenantId]
      );

      const res = await client.query(
        `SELECT monthly_cost_limit_micro_usd, current_month_cost_micro_usd,
                monthly_token_limit, current_month_tokens_used,
                hard_limit_enabled, period_start
         FROM tenant_ai_quotas
         WHERE tenant_id = $1`,
        [tenantId]
      );

      const q = res.rows[0];
      const costLimit = Number(q.monthly_cost_limit_micro_usd);
      const currentCost = Number(q.current_month_cost_micro_usd);
      const tokenLimit = Number(q.monthly_token_limit);
      const currentTokens = Number(q.current_month_tokens_used);

      const percentageCostUsed = costLimit > 0
        ? Math.round((currentCost / costLimit) * 10000) / 100
        : 0;

      const percentageTokensUsed = tokenLimit > 0
        ? Math.round((currentTokens / tokenLimit) * 10000) / 100
        : 0;

      return {
        tenantId,
        monthlyCostLimitMicroUsd: costLimit,
        currentMonthCostMicroUsd: currentCost,
        currentMonthCostUsd: formatMicroUsdToUsd(currentCost),
        monthlyTokenLimit: tokenLimit,
        currentMonthTokensUsed: currentTokens,
        percentageCostUsed,
        percentageTokensUsed,
        percentageUsed: percentageCostUsed,
        hardLimitEnabled: Boolean(q.hard_limit_enabled),
        periodStart: new Date(q.period_start).toISOString(),
      };
    });
  }
}
