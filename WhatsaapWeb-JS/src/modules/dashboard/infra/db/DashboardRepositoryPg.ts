import type { Pool } from 'pg';
import { queryInTenantScope, withTenantTransaction } from '../../../../db/TenantScopedUoW';
import {
  ActionCardsStats,
  HeatmapByDateDay,
  HeatmapByDateMatrix,
  LowStockItem,
  QuickStats,
  SlaAlert,
  SlaAlertsResult,
  SlaStatusTag,
} from '../../domain/dashboard.types';

type Row = Record<string, any>;

export class DashboardRepositoryPg {
  constructor(private readonly pool: Pool) {}

  async getCompanyTimezone(companyId: number): Promise<string> {
    const result = await queryInTenantScope(this.pool, companyId,
      `SELECT s.timezone FROM company_settings s
       WHERE s.company_id = $1 AND EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = s.timezone)`,
      [companyId]
    );
    return result.rows[0]?.timezone || 'America/Lima';
  }

  async getSlaThreshold(companyId: number): Promise<number> {
    const result = await queryInTenantScope(this.pool, companyId,
      `SELECT sla_threshold_minutes FROM company_settings WHERE company_id = $1`,
      [companyId]
    );
    const value = Number(result.rows[0]?.sla_threshold_minutes || 5);
    return Number.isFinite(value) && value > 0 ? value : 5;
  }

  async getQuickStats(companyId: number, timezone: string): Promise<QuickStats> {
    return withTenantTransaction(companyId, async (client) => {
      const [active, orders, response] = await Promise.all([
        client.query(
          `SELECT COUNT(*)::int AS count
           FROM conversations
           WHERE company_id = $1
             AND channel = 'whatsapp'
             AND status = 'open'
             AND archived_at IS NULL
             AND last_message_at >= (((NOW() AT TIME ZONE $2)::date)::timestamp AT TIME ZONE $2)
             AND last_message_at < (((NOW() AT TIME ZONE $2)::date + 1)::timestamp AT TIME ZONE $2)`,
          [companyId, timezone]
        ),
        client.query(
          `SELECT COUNT(*)::int AS count
           FROM customer_orders
           WHERE company_id = $1
             AND occurred_at >= (((NOW() AT TIME ZONE $2)::date)::timestamp AT TIME ZONE $2)
             AND occurred_at < (((NOW() AT TIME ZONE $2)::date + 1)::timestamp AT TIME ZONE $2)`,
          [companyId, timezone]
        ),
        client.query(
          `WITH inbound AS (
             SELECT m.conversation_id, m.occurred_at
             FROM messages m
             JOIN conversations c ON c.id = m.conversation_id AND c.company_id = m.company_id
             WHERE m.company_id = $1
               AND c.channel = 'whatsapp'
               AND m.direction = 'inbound'
               AND m.occurred_at >= (((NOW() AT TIME ZONE $2)::date)::timestamp AT TIME ZONE $2)
               AND m.occurred_at < (((NOW() AT TIME ZONE $2)::date + 1)::timestamp AT TIME ZONE $2)
           )
           SELECT COALESCE(
             ROUND(AVG(EXTRACT(EPOCH FROM (response.occurred_at - inbound.occurred_at)) / 60)::numeric, 2),
             0
           ) AS minutes
           FROM inbound
           JOIN LATERAL (
             SELECT m2.occurred_at
             FROM messages m2
             WHERE m2.conversation_id = inbound.conversation_id
               AND m2.company_id = $1 AND m2.direction = 'outbound'
               AND m2.status IN ('accepted', 'provider_accepted', 'sent', 'delivered', 'read')
               AND m2.occurred_at >= inbound.occurred_at
             ORDER BY m2.occurred_at ASC, m2.id ASC
             LIMIT 1
           ) response ON TRUE`,
          [companyId, timezone]
        ),
      ]);

      return {
        activeChatsCount: Number(active.rows[0]?.count || 0),
        ordersTodayCount: Number(orders.rows[0]?.count || 0),
        averageResponseTimeMin: Number(response.rows[0]?.minutes || 0),
      };
    }, this.pool);
  }

  async getActionCards(companyId: number): Promise<ActionCardsStats> {
    return withTenantTransaction(companyId, async (client) => {
      const [pending, payments, lowStock] = await Promise.all([
        client.query(
          `SELECT COUNT(*)::int AS count
           FROM conversations c
           WHERE c.company_id = $1
             AND c.channel = 'whatsapp'
             AND c.status = 'open'
             AND c.archived_at IS NULL
             AND c.unread_count > 0
             AND c.assigned_user_id IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM tag_chats tc
               JOIN tags t ON t.id = tc.tag_id
               JOIN tag_users tu ON tu.tag_id = t.id
               WHERE tc.company_id = c.company_id
                 AND (tc.conversation_id = c.id OR tc.chat_id = c.external_conversation_id)
             )`,
          [companyId]
        ),
        client.query(
          `WITH payable_orders AS (
             SELECT o.id
             FROM customer_orders o
             WHERE o.company_id = $1
               AND o.order_type = 'commercial'
               AND o.status IN ('draft','quoted','pending_handoff','pending_approval','confirmed')
               AND EXISTS (
                 SELECT 1 FROM order_items oi
                 WHERE oi.company_id = o.company_id AND oi.order_id = o.id
               )
               AND NOT EXISTS (
                 SELECT 1 FROM payment_vouchers pv
                 WHERE pv.company_id = o.company_id
                   AND pv.order_id = o.id
                   AND pv.status = 'validated'
               )
           ),
           orphan_pending_vouchers AS (
             SELECT pv.id
             FROM payment_vouchers pv
             WHERE pv.company_id = $1
               AND pv.order_id IS NULL
               AND pv.status = 'pending'
           )
           SELECT (
             (SELECT COUNT(*) FROM payable_orders) +
             (SELECT COUNT(*) FROM orphan_pending_vouchers)
           )::int AS count`,
          [companyId]
        ),
        client.query(
          `SELECT COUNT(*)::int AS count
           FROM products
           WHERE company_id = $1
             AND status = 'active'
             AND min_stock > 0
             AND stock_available <= min_stock`,
          [companyId]
        ),
      ]);

      return {
        pendingChatsCount: Number(pending.rows[0]?.count || 0),
        pendingPaymentsCount: Number(payments.rows[0]?.count || 0),
        lowStockCount: Number(lowStock.rows[0]?.count || 0),
      };
    }, this.pool);
  }

  async getHeatmapByDate(companyId: number, timezone: string, days: number): Promise<HeatmapByDateMatrix> {
    const safeDays = Math.min(Math.max(days, 1), 30);
    const result = await queryInTenantScope(this.pool, companyId,
      `WITH local_day AS (
         SELECT (NOW() AT TIME ZONE $3)::date AS today
       ), days AS (
         SELECT generate_series((today - ($2::int - 1))::timestamp, today::timestamp, interval '1 day')::date AS day
         FROM local_day
       ), inbound AS (
         SELECT (m.occurred_at AT TIME ZONE $3)::date AS day,
                EXTRACT(HOUR FROM m.occurred_at AT TIME ZONE $3)::int AS hour,
                COUNT(*)::int AS count
         FROM messages m JOIN conversations c ON c.id = m.conversation_id AND c.company_id = m.company_id
         CROSS JOIN local_day
         WHERE m.company_id = $1 AND c.channel = 'whatsapp' AND c.archived_at IS NULL AND m.direction = 'inbound'
           AND m.occurred_at >= ((today - ($2::int - 1))::timestamp AT TIME ZONE $3)
           AND m.occurred_at < ((today + 1)::timestamp AT TIME ZONE $3)
         GROUP BY 1, 2
       )
       SELECT TO_CHAR(days.day, 'YYYY-MM-DD') AS date, inbound.hour, COALESCE(inbound.count, 0) AS count
       FROM days LEFT JOIN inbound ON inbound.day = days.day
       ORDER BY days.day, inbound.hour`,
      [companyId, safeDays, timezone]
    );

    const byDate = new Map<string, number[]>();
    let maxCount = 0;
    let totalMessages = 0;

    for (const row of result.rows) {
      const date = row.date;
      if (!byDate.has(date)) byDate.set(date, new Array(24).fill(0));
      const hours = byDate.get(date)!;
      const hour = row.hour === null ? -1 : Number(row.hour);
      const count = Number(row.count || 0);
      if (hour >= 0 && hour < 24) hours[hour] = count;
      maxCount = Math.max(maxCount, count);
      totalMessages += count;
    }

    const daysList: HeatmapByDateDay[] = Array.from(byDate.entries()).map(([date, hours]) => ({
      date,
      label: this.formatDayLabel(date, timezone),
      hours,
      total: hours.reduce((sum, value) => sum + value, 0),
    }));

    return { days: daysList, maxCount, totalMessages };
  }

  async getSlaAlerts(companyId: number, thresholdMinutes: number, limit: number): Promise<SlaAlertsResult> {
    const safeLimit = Math.min(Math.max(limit, 1), 50);
    const result = await queryInTenantScope(this.pool, companyId,
      `SELECT c.id, c.external_conversation_id, c.unread_count, c.last_message_at,
              COALESCE(NULLIF(c.last_message_preview, ''), NULLIF(c.title, '')) AS last_preview,
              COALESCE(ct.display_name, ct.name, ct.profile_name, ct.phone, c.title, c.external_conversation_id) AS display_name,
              ct.phone,
              EXISTS (
                SELECT 1 FROM payment_vouchers pv
                WHERE pv.company_id = c.company_id
                  AND (pv.conversation_id = c.id OR pv.chat_id = c.external_conversation_id)
                  AND pv.status = 'pending'
              ) AS has_pending_payment,
              (c.assigned_user_id IS NOT NULL OR EXISTS (
                SELECT 1 FROM tag_chats tc
                JOIN tags t ON t.id = tc.tag_id
                JOIN tag_users tu ON tu.tag_id = t.id
                WHERE tc.company_id = c.company_id
                  AND (tc.conversation_id = c.id OR tc.chat_id = c.external_conversation_id)
              )) AS has_assigned_user,
              EXISTS (
                SELECT 1 FROM ai_agents ai
                WHERE ai.company_id = c.company_id
                  AND ai.status = 'active'
                  AND ai.mode <> 'disabled'
              ) AS has_active_agent,
              EXTRACT(EPOCH FROM (NOW() - c.last_message_at)) / 60 AS waiting_min
       FROM conversations c
       LEFT JOIN contacts ct ON ct.id = c.contact_id AND ct.company_id = c.company_id
       WHERE c.company_id = $1
         AND c.channel = 'whatsapp'
         AND c.status = 'open'
         AND c.archived_at IS NULL
         AND c.unread_count > 0
         AND c.last_message_at IS NOT NULL
         AND EXTRACT(EPOCH FROM (NOW() - c.last_message_at)) / 60 >= $2
       ORDER BY waiting_min DESC, c.last_message_at DESC
       LIMIT $3`,
      [companyId, thresholdMinutes, safeLimit]
    );

    const alerts: SlaAlert[] = result.rows
      .map((row: Row) => {
        const statusTag = this.resolveStatusTag({
          hasAssignedUser: Boolean(row.has_assigned_user),
          hasPendingPayment: Boolean(row.has_pending_payment),
          hasActiveAgent: Boolean(row.has_active_agent),
          unreadCount: Number(row.unread_count || 0),
        });
        if (statusTag === 'ai_ready') return null;
        return {
          chatId: row.external_conversation_id,
          conversationId: row.id ? Number(row.id) : null,
          displayName: row.display_name || row.external_conversation_id,
          phone: row.phone || null,
          lastPreview: row.last_preview || '',
          waitingMin: Math.round(Number(row.waiting_min || 0)),
          statusTag,
        } as SlaAlert;
      })
      .filter((alert: SlaAlert | null): alert is SlaAlert => alert !== null);

    return { thresholdMinutes, total: alerts.length, alerts };
  }

  async getLowStock(companyId: number, limit: number, offset: number): Promise<{ rows: LowStockItem[]; total: number }> {
    const safeLimit = Math.min(Math.max(limit, 1), 200);
    const safeOffset = Math.max(offset, 0);
    const count = await queryInTenantScope(this.pool, companyId,
      `SELECT COUNT(*)::int AS count
       FROM products
       WHERE company_id = $1
         AND status = 'active'
         AND min_stock > 0
         AND stock_available <= min_stock`,
      [companyId]
    );
    const rows = await queryInTenantScope(this.pool, companyId,
      `SELECT id, name, sku, stock_available, stock_reserved, min_stock
       FROM products
       WHERE company_id = $1
         AND status = 'active'
         AND min_stock > 0
         AND stock_available <= min_stock
       ORDER BY (min_stock - stock_available) DESC, name ASC
       LIMIT $2 OFFSET $3`,
      [companyId, safeLimit, safeOffset]
    );
    return {
      rows: rows.rows.map((row: Row) => this.mapLowStock(row)),
      total: Number(count.rows[0]?.count || 0),
    };
  }

  private resolveStatusTag(input: {
    hasAssignedUser: boolean;
    hasPendingPayment: boolean;
    hasActiveAgent: boolean;
    unreadCount: number;
  }): SlaStatusTag {
    if (input.hasPendingPayment) return 'payment_pending';
    if (!input.hasAssignedUser) return 'unassigned';
    if (input.hasActiveAgent && input.unreadCount === 0) return 'ai_ready';
    return 'attention';
  }

  private formatDayLabel(dateIso: string, timezone: string): string {
    const today = this.todayIn(timezone);
    if (dateIso === today) return 'Hoy';
    if (dateIso === this.shiftDate(today, -1)) return 'Ayer';
    const date = new Date(`${dateIso}T00:00:00Z`);
    return new Intl.DateTimeFormat('es-PE', { weekday: 'short', timeZone: 'UTC' })
      .format(date)
      .replace(/^\w/, (c) => c.toUpperCase());
  }

  private todayIn(timezone: string): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  }

  private shiftDate(value: string, days: number): string {
    const date = new Date(`${value}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  }

  private mapLowStock(row: Row): LowStockItem {
    const stockAvailable = Number(row.stock_available || 0);
    const minStock = Number(row.min_stock || 0);
    return {
      id: Number(row.id),
      name: row.name,
      sku: row.sku || null,
      stockAvailable,
      stockReserved: Number(row.stock_reserved || 0),
      minStock,
      shortage: Math.max(0, minStock - stockAvailable),
    };
  }
}
