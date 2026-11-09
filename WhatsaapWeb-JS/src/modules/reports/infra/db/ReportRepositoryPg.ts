import { Pool } from 'pg';
import { withTenantTransaction } from '../../../../db/TenantScopedUoW';
import { Queryable } from '../../../../shared/UnitOfWorkPort';
import { ReportRepositoryPort } from '../../application/ports/ReportRepositoryPort';
import {
  ChatHistoryExport,
  HeatmapPoint,
  OperationalReportPage,
  OperationalReportRow,
  ReportFilters,
  ReportMetrics,
} from '../../domain/report.types';

type Row = Record<string, any>;

export class ReportRepositoryPg implements ReportRepositoryPort {
  constructor(private readonly pool: Pool) {}

  private withSnapshot<T>(companyId: number, work: (db: Queryable) => Promise<T>): Promise<T> {
    return withTenantTransaction(companyId, async (db) => {
      await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      return work(db);
    }, this.pool);
  }

  getMetrics(companyId: number, filters: ReportFilters): Promise<ReportMetrics> {
    return this.withSnapshot(companyId, (db) => this.readMetrics(db, companyId, filters));
  }

  private async readMetrics(db: Queryable, companyId: number, filters: ReportFilters): Promise<ReportMetrics> {
    const messageScope = this.buildMessageScope(companyId, filters, 'm', 'c');
    const conversationScope = this.buildConversationScope(companyId, filters, 'c');

    const chatResult = await db.query(
      `SELECT COUNT(DISTINCT c.id)::int AS count
       FROM conversations c
       WHERE ${conversationScope.sql}`,
      conversationScope.params
    );
    const messageResult = await db.query(
      `SELECT COUNT(*)::int AS count
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       WHERE ${messageScope.sql}`,
      messageScope.params
    );
    const unreadResult = await db.query(
      `SELECT COALESCE(SUM(c.unread_count), 0)::int AS count
       FROM conversations c
       WHERE ${conversationScope.sql}`,
      conversationScope.params
    );
    const responseResult = await db.query(
      `WITH inbound AS (
         SELECT m.conversation_id, m.occurred_at
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
         WHERE ${messageScope.sql} AND m.direction = 'inbound'
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
           AND m2.company_id = $1
           AND m2.direction = 'outbound'
           AND m2.occurred_at >= inbound.occurred_at
         ORDER BY m2.occurred_at ASC, m2.id ASC
         LIMIT 1
       ) response ON TRUE`,
      messageScope.params
    );
    const tagResult = await db.query(
      `SELECT t.name AS tag_name, t.color,
              COUNT(DISTINCT c.id)::int AS count
       FROM tags t
       LEFT JOIN conversations c
         ON c.company_id = t.company_id
        AND c.channel = 'whatsapp'
        AND c.archived_at IS NULL
        AND (
          t.is_default
          OR EXISTS (
            SELECT 1 FROM tag_chats tc
            WHERE tc.company_id = c.company_id
              AND tc.tag_id = t.id
              AND (tc.conversation_id = c.id OR (tc.conversation_id IS NULL AND tc.chat_id = c.external_conversation_id))
          )
        )
        AND EXISTS (
          SELECT 1 FROM messages m
          WHERE m.conversation_id = c.id
            AND m.company_id = $1
            AND m.occurred_at >= ($2::date::timestamp AT TIME ZONE $4)
            AND m.occurred_at < (($3::date + 1)::timestamp AT TIME ZONE $4)
        )
       WHERE t.company_id = $1
       GROUP BY t.id
       ORDER BY t.is_default DESC, LOWER(t.name) ASC`,
      [companyId, filters.startDate, filters.endDate, filters.timezone]
    );
    const dayResult = await db.query(
      `SELECT TO_CHAR(m.occurred_at AT TIME ZONE $4, 'YYYY-MM-DD') AS date,
              COUNT(*)::int AS count
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       WHERE ${messageScope.sql}
       GROUP BY 1
       ORDER BY 1 ASC`,
      messageScope.params
    );
    const topChatResult = await db.query(
      `SELECT c.external_conversation_id AS chat_id,
              COALESCE(c.title, ct.display_name, ct.name, ct.phone, c.external_conversation_id) AS name,
              COUNT(m.id)::int AS message_count
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       LEFT JOIN contacts ct ON ct.id = c.contact_id AND ct.company_id = c.company_id
       WHERE ${messageScope.sql}
       GROUP BY c.id, ct.id
       ORDER BY message_count DESC, c.last_message_at DESC NULLS LAST
       LIMIT 10`,
      messageScope.params
    );
    const typeResult = await db.query(
      `SELECT COALESCE(m.message_type, 'text') AS type, COUNT(*)::int AS count
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       WHERE ${messageScope.sql}
       GROUP BY COALESCE(m.message_type, 'text')
       ORDER BY count DESC, type ASC`,
      messageScope.params
    );

    return {
      totalChats: Number(chatResult.rows[0]?.count || 0),
      totalMessages: Number(messageResult.rows[0]?.count || 0),
      totalUnread: Number(unreadResult.rows[0]?.count || 0),
      averageResponseTime: Number(responseResult.rows[0]?.minutes || 0),
      chatsByTag: tagResult.rows.map((row) => ({
        tagName: row.tag_name,
        count: Number(row.count || 0),
        color: row.color || null,
      })),
      messagesByDay: dayResult.rows.map((row) => ({
        date: row.date,
        count: Number(row.count || 0),
      })),
      topChats: topChatResult.rows.map((row) => ({
        chatId: row.chat_id,
        name: row.name,
        messageCount: Number(row.message_count || 0),
      })),
      messagesByType: typeResult.rows.map((row) => ({
        type: row.type,
        count: Number(row.count || 0),
      })),
    };
  }

  getOperationalReport(companyId: number, filters: ReportFilters): Promise<OperationalReportPage> {
    return this.withSnapshot(companyId, (db) => this.readOperationalReport(db, companyId, filters));
  }

  private async readOperationalReport(db: Queryable, companyId: number, filters: ReportFilters): Promise<OperationalReportPage> {
    const scope = this.buildOrderScope(companyId, filters, 'o');
    const countResult = await db.query(
      `SELECT COUNT(*)::int AS count
       FROM customer_orders o
       LEFT JOIN conversations c ON c.id = o.conversation_id AND c.company_id = o.company_id
       WHERE ${scope.sql}`,
      scope.params
    );

    const params = [...scope.params, filters.limit, filters.offset];
    const rowsResult = await db.query(
      `SELECT o.id, o.occurred_at, o.title, o.service_type, COALESCE(o.order_type, 'service') AS order_type,
              o.status, o.notes,
              COALESCE(ct.display_name, ct.name, ct.profile_name, ct.phone, c.title, c.external_conversation_id, 'Sin contacto') AS customer_name,
              ct.phone,
              c.external_conversation_id AS chat_id,
              u.nombre AS employee_name,
              COALESCE(items.products, '') AS products,
              COALESCE(items.item_types, '') AS item_types,
              COALESCE(items.total_quantity, 0)::int AS total_quantity,
              COALESCE(items.reserved_quantity, 0)::int AS reserved_quantity,
              (
                SELECT COUNT(*)::int
                FROM operational_actions a
                WHERE a.company_id = o.company_id AND a.order_id = o.id
              ) AS action_count
       FROM customer_orders o
       LEFT JOIN contacts ct ON ct.id = o.contact_id AND ct.company_id = o.company_id
       LEFT JOIN conversations c ON c.id = o.conversation_id AND c.company_id = o.company_id
       LEFT JOIN usuarios u ON u.id = o.created_by AND u.company_id = o.company_id
       LEFT JOIN LATERAL (
         SELECT string_agg(CONCAT(oi.quantity, ' x ', oi.product_name), '; ' ORDER BY oi.id) AS products,
                string_agg(DISTINCT COALESCE(oi.item_type_snapshot, 'physical_product'), ', ' ORDER BY COALESCE(oi.item_type_snapshot, 'physical_product')) AS item_types,
                SUM(oi.quantity) AS total_quantity,
                SUM(CASE WHEN oi.status IN ('confirmed', 'reserved') THEN oi.quantity ELSE 0 END) AS reserved_quantity
         FROM order_items oi
         WHERE oi.company_id = o.company_id AND oi.order_id = o.id
       ) items ON true
       WHERE ${scope.sql}
       ORDER BY o.occurred_at DESC, o.id DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    return {
      rows: rowsResult.rows.map((row) => this.mapOperationalRow(row)),
      total: Number(countResult.rows[0]?.count || 0),
      limit: filters.limit,
      offset: filters.offset,
    };
  }

  getHeatmapPoints(companyId: number, filters: ReportFilters): Promise<HeatmapPoint[]> {
    return this.withSnapshot(companyId, (db) => this.readHeatmapPoints(db, companyId, filters));
  }

  private async readHeatmapPoints(db: Queryable, companyId: number, filters: ReportFilters): Promise<HeatmapPoint[]> {
    const scope = this.buildMessageScope(companyId, filters, 'm', 'c');
    const result = await db.query(
      `SELECT EXTRACT(DOW FROM m.occurred_at AT TIME ZONE $4)::int AS day,
              EXTRACT(HOUR FROM m.occurred_at AT TIME ZONE $4)::int AS hour,
              COUNT(*)::int AS count
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       WHERE ${scope.sql}
         AND m.direction = 'inbound'
       GROUP BY 1, 2
       ORDER BY 1, 2`,
      scope.params
    );

    return result.rows.map((row) => ({
      day: Number(row.day),
      hour: Number(row.hour),
      count: Number(row.count || 0),
    }));
  }

  getChatHistory(companyId: number, chatId: string, limit: number): Promise<ChatHistoryExport | null> {
    return this.withSnapshot(companyId, (db) => this.readChatHistory(db, companyId, chatId, limit));
  }

  private async readChatHistory(db: Queryable, companyId: number, chatId: string, limit: number): Promise<ChatHistoryExport | null> {
    const values = this.buildChatLookupValues(chatId);
    const conversationResult = await db.query(
      `SELECT c.id, c.external_conversation_id,
              COALESCE(c.title, ct.display_name, ct.name, ct.phone, c.external_conversation_id) AS name
       FROM conversations c
       LEFT JOIN contacts ct ON ct.id = c.contact_id AND ct.company_id = c.company_id
       WHERE c.company_id = $1
         AND c.channel = 'whatsapp'
         AND c.external_conversation_id = ANY($2::varchar[])
       ORDER BY (c.external_conversation_id = ($2::varchar[])[1]) DESC, c.last_message_at DESC NULLS LAST, c.id DESC
       LIMIT 1`,
      [companyId, values]
    );
    const conversation = conversationResult.rows[0];
    if (!conversation) return null;

    const messageResult = await db.query(
      `SELECT m.id, m.provider_message_id, m.occurred_at, m.direction,
              m.external_contact_id, m.body, m.message_type,
              EXISTS (SELECT 1 FROM message_attachments a WHERE a.message_id = m.id) AS has_media
       FROM messages m
       WHERE m.company_id = $1 AND m.conversation_id = $2
       ORDER BY m.occurred_at ASC, m.id ASC
       LIMIT $3`,
      [companyId, conversation.id, limit]
    );

    return {
      chatId: conversation.external_conversation_id,
      chatName: conversation.name,
      exportDate: new Date().toISOString(),
      messages: messageResult.rows.map((row) => ({
        id: row.provider_message_id || String(row.id),
        timestamp: new Date(row.occurred_at).getTime(),
        sender: row.direction === 'outbound' ? 'me' : (row.external_contact_id || conversation.external_conversation_id),
        body: row.body || '',
        type: row.message_type || 'text',
        fromMe: row.direction === 'outbound',
        hasMedia: Boolean(row.has_media),
      })),
    };
  }

  private buildMessageScope(companyId: number, filters: ReportFilters, messageAlias: string, conversationAlias: string) {
    const params: unknown[] = [companyId, filters.startDate, filters.endDate, filters.timezone];
    const clauses = [
      `${messageAlias}.company_id = $1`,
      `${conversationAlias}.company_id = $1`,
      `${conversationAlias}.channel = 'whatsapp'`,
      `${messageAlias}.occurred_at >= ($2::date::timestamp AT TIME ZONE $4)`,
      `${messageAlias}.occurred_at < (($3::date + 1)::timestamp AT TIME ZONE $4)`,
    ];
    this.addTagClause(clauses, params, filters.tagId, conversationAlias);
    return { sql: clauses.join('\n         AND '), params };
  }

  private buildConversationScope(companyId: number, filters: ReportFilters, conversationAlias: string) {
    const params: unknown[] = [companyId, filters.startDate, filters.endDate, filters.timezone];
    const clauses = [
      `${conversationAlias}.company_id = $1`,
      `${conversationAlias}.channel = 'whatsapp'`,
      `${conversationAlias}.archived_at IS NULL`,
      `EXISTS (
         SELECT 1 FROM messages scoped_message
         WHERE scoped_message.conversation_id = ${conversationAlias}.id
           AND scoped_message.company_id = $1
           AND scoped_message.occurred_at >= ($2::date::timestamp AT TIME ZONE $4)
           AND scoped_message.occurred_at < (($3::date + 1)::timestamp AT TIME ZONE $4)
       )`,
    ];
    this.addTagClause(clauses, params, filters.tagId, conversationAlias);
    return { sql: clauses.join('\n         AND '), params };
  }

  private buildOrderScope(companyId: number, filters: ReportFilters, orderAlias: string) {
    const params: unknown[] = [companyId, filters.startDate, filters.endDate, filters.timezone];
    const clauses = [
      `${orderAlias}.company_id = $1`,
      `${orderAlias}.occurred_at >= ($2::date::timestamp AT TIME ZONE $4)`,
      `${orderAlias}.occurred_at < (($3::date + 1)::timestamp AT TIME ZONE $4)`,
    ];

    if (filters.status) {
      params.push(filters.status);
      clauses.push(`${orderAlias}.status = $${params.length}`);
    }
    if (filters.actorUserId) {
      params.push(filters.actorUserId);
      clauses.push(`${orderAlias}.created_by = $${params.length}`);
    }
    if (filters.tagId) {
      params.push(filters.tagId);
      clauses.push(`EXISTS (
        SELECT 1 FROM tag_chats scoped_tag_chat
        WHERE scoped_tag_chat.company_id = ${orderAlias}.company_id
          AND scoped_tag_chat.tag_id = $${params.length}
          AND (
            scoped_tag_chat.conversation_id = ${orderAlias}.conversation_id
            OR (scoped_tag_chat.conversation_id IS NULL AND scoped_tag_chat.chat_id = c.external_conversation_id)
          )
      )`);
    }
    return { sql: clauses.join('\n         AND '), params };
  }

  private addTagClause(clauses: string[], params: unknown[], tagId: number | undefined, conversationAlias: string): void {
    if (!tagId) return;
    params.push(tagId);
    clauses.push(`EXISTS (
      SELECT 1 FROM tag_chats scoped_tag_chat
      WHERE scoped_tag_chat.company_id = ${conversationAlias}.company_id
        AND scoped_tag_chat.tag_id = $${params.length}
        AND (
          scoped_tag_chat.conversation_id = ${conversationAlias}.id
          OR (scoped_tag_chat.conversation_id IS NULL AND scoped_tag_chat.chat_id = ${conversationAlias}.external_conversation_id)
        )
    )`);
  }

  private buildChatLookupValues(value: string): string[] {
    const raw = String(value || '').trim();
    const phone = /^\+?([\d ()-]+)(?:@c\.us|@s\.whatsapp\.net)?$/.exec(raw);
    const normalized = phone?.[1].replace(/\D/g, '');
    return normalized ? [...new Set([raw, normalized, `${normalized}@c.us`, `${normalized}@s.whatsapp.net`])] : [raw];
  }

  private mapOperationalRow(row: Row): OperationalReportRow {
    return {
      orderId: Number(row.id),
      occurredAt: row.occurred_at,
      customerName: row.customer_name,
      phone: row.phone || null,
      chatId: row.chat_id || null,
      title: row.title,
      serviceType: row.service_type,
      orderType: row.order_type || 'service',
      status: row.status,
      employeeName: row.employee_name || null,
      actionCount: Number(row.action_count || 0),
      notes: row.notes || null,
      products: row.products || '',
      itemTypes: row.item_types || '',
      totalQuantity: Number(row.total_quantity || 0),
      reservedQuantity: Number(row.reserved_quantity || 0),
    };
  }
}
