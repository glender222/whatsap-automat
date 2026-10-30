import { Queryable } from '../../../../shared/UnitOfWorkPort';
import type { HandoffTicket, HandoffTicketSummary } from '../../domain/runtime.types';

type Row = Record<string, any>;

function json(value: unknown): string {
  return JSON.stringify(value || {});
}

function mapTicket(row: Row): HandoffTicket {
  return {
    id: Number(row.id),
    companyId: Number(row.company_id),
    conversationId: Number(row.conversation_id),
    agentId: row.agent_id ? Number(row.agent_id) : null,
    orderId: row.order_id ? Number(row.order_id) : null,
    reason: row.reason,
    priority: row.priority || 'medium',
    status: row.status,
    takenBy: row.taken_by ? Number(row.taken_by) : null,
    takenAt: row.taken_at || null,
    closedAt: row.closed_at || null,
    closedBy: row.closed_by ? Number(row.closed_by) : null,
    outcome: row.outcome || null,
    notes: row.notes || null,
    metadata: row.metadata_json || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class HandoffTicketRepositoryPg {
  constructor(private readonly pool: Queryable) {}

  async findActiveByConversation(companyId: number, conversationId: number): Promise<HandoffTicket | null> {
    const result = await this.pool.query(
      `SELECT *
       FROM handoff_tickets
       WHERE company_id = $1
         AND conversation_id = $2
         AND status IN ('open', 'taken')
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [companyId, conversationId]
    );
    return result.rows[0] ? mapTicket(result.rows[0]) : null;
  }

  async create(input: {
    companyId: number;
    conversationId: number;
    agentId?: number | null;
    orderId?: number | null;
    reason: string;
    priority?: 'low' | 'medium' | 'high';
    metadata?: Record<string, unknown>;
  }): Promise<HandoffTicket> {
    const result = await this.pool.query(
      `INSERT INTO handoff_tickets (
         company_id, conversation_id, agent_id, order_id, reason, priority, status, metadata_json
       )
       VALUES ($1, $2, $3, $4, $5, $6, 'open', $7::jsonb)
       RETURNING *`,
      [
        input.companyId,
        input.conversationId,
        input.agentId ?? null,
        input.orderId ?? null,
        input.reason,
        input.priority || 'medium',
        json(input.metadata || {}),
      ]
    );
    return mapTicket(result.rows[0]);
  }

  async assignHandoffTag(companyId: number, conversationId: number, chatId: string | null): Promise<void> {
    if (!chatId) return;
    await this.pool.query(
      `INSERT INTO tags (company_id, name, color, is_default, is_system)
       VALUES ($1, 'handoff-pendiente', '#128C7E', FALSE, TRUE)
       ON CONFLICT (company_id, LOWER(name)) DO UPDATE SET is_system = TRUE, color = COALESCE(NULLIF(tags.color, ''), EXCLUDED.color)`,
      [companyId]
    );
    const tagResult = await this.pool.query(
      `SELECT id FROM tags WHERE company_id = $1 AND LOWER(name) = LOWER('handoff-pendiente') LIMIT 1`,
      [companyId]
    );
    const tagId = Number(tagResult.rows[0]?.id);
    if (!tagId) return;
    await this.pool.query(
      `INSERT INTO tag_chats (company_id, tag_id, conversation_id, chat_id, created_by)
       VALUES ($1, $2, $3, $4, NULL)
       ON CONFLICT (tag_id, chat_id)
       DO UPDATE SET conversation_id = COALESCE(EXCLUDED.conversation_id, tag_chats.conversation_id)`,
      [companyId, tagId, conversationId, chatId]
    );
  }

  async list(
    companyId: number,
    filters: { status?: string; conversationId?: number; takenBy?: number; limit?: number; offset?: number }
  ): Promise<{ rows: HandoffTicketSummary[]; total: number }> {
    const limit = Math.min(Math.max(Number(filters.limit || 50), 1), 200);
    const offset = Math.max(Number(filters.offset || 0), 0);
    const params: unknown[] = [companyId];
    const clauses: string[] = ['t.company_id = $1'];

    if (filters.status) {
      params.push(filters.status);
      clauses.push(`t.status = $${params.length}`);
    }
    if (filters.conversationId) {
      params.push(filters.conversationId);
      clauses.push(`t.conversation_id = $${params.length}`);
    }
    if (filters.takenBy) {
      params.push(filters.takenBy);
      clauses.push(`t.taken_by = $${params.length}`);
    }

    const countResult = await this.pool.query(
      `SELECT COUNT(*)::int AS count FROM handoff_tickets t WHERE ${clauses.join(' AND ')}`,
      params
    );

    const listParams = [...params, limit, offset];
    const result = await this.pool.query(
      `SELECT t.*,
              c.external_conversation_id AS chat_id,
              COALESCE(ct.display_name, ct.name, ct.profile_name, ct.phone, c.title, c.external_conversation_id) AS customer_name,
              EXTRACT(EPOCH FROM (NOW() - t.created_at))::int AS waiting_seconds
       FROM handoff_tickets t
       LEFT JOIN conversations c ON c.id = t.conversation_id
       LEFT JOIN contacts ct ON ct.id = c.contact_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY (CASE WHEN t.status = 'open' THEN 0 ELSE 1 END), t.created_at DESC
       LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
      listParams
    );

    return {
      rows: result.rows.map((row) => ({
        ...mapTicket(row),
        chatId: row.chat_id || null,
        customerName: row.customer_name || 'Sin contacto',
        waitingSeconds: Number(row.waiting_seconds || 0),
      })),
      total: Number(countResult.rows[0]?.count || 0),
    };
  }

  async get(companyId: number, ticketId: number): Promise<HandoffTicket | null> {
    const result = await this.pool.query(
      `SELECT * FROM handoff_tickets WHERE company_id = $1 AND id = $2 LIMIT 1`,
      [companyId, ticketId]
    );
    return result.rows[0] ? mapTicket(result.rows[0]) : null;
  }

  async take(companyId: number, ticketId: number, userId: number): Promise<HandoffTicket | null> {
    const result = await this.pool.query(
      `UPDATE handoff_tickets
       SET status = 'taken', taken_by = $3, taken_at = NOW(), updated_at = NOW()
       WHERE company_id = $1 AND id = $2 AND status = 'open'
       RETURNING *`,
      [companyId, ticketId, userId]
    );
    if (result.rows[0]) {
      const conversationId = Number(result.rows[0].conversation_id);
      await this.setCommercialState(companyId, conversationId, 'handoff', 'human_attending', userId);
      await this.clearHandoffPendingTagIfResolved(companyId, conversationId);
    }
    return result.rows[0] ? mapTicket(result.rows[0]) : null;
  }

  async close(companyId: number, ticketId: number, userId: number, input: { notes?: string | null; outcome: HandoffTicket['outcome'] }): Promise<HandoffTicket | null> {
    const result = await this.pool.query(
      `UPDATE handoff_tickets
       SET status = 'closed',
           closed_at = NOW(),
           closed_by = $3,
           outcome = $4,
           notes = COALESCE($5, notes),
           updated_at = NOW()
       WHERE company_id = $1 AND id = $2 AND status IN ('open','taken')
       RETURNING *`,
      [companyId, ticketId, userId, input.outcome, input.notes || null]
    );
    if (result.rows[0]) {
      const next = input.outcome === 'sale_confirmed'
        ? ['payment', 'sale_confirmed']
        : input.outcome === 'support_resolved'
          ? ['closed', 'completed']
          : ['closed', 'lost_cancelled'];
      await this.setCommercialState(companyId, Number(result.rows[0].conversation_id), next[0], next[1], userId);
      await this.clearHandoffPendingTagIfResolved(companyId, Number(result.rows[0].conversation_id));
    }
    return result.rows[0] ? mapTicket(result.rows[0]) : null;
  }

  async countOpen(companyId: number): Promise<number> {
    const result = await this.pool.query(
      `SELECT COUNT(*)::int AS count FROM handoff_tickets WHERE company_id = $1 AND status = 'open'`,
      [companyId]
    );
    return Number(result.rows[0]?.count || 0);
  }

  private async setCommercialState(companyId: number, conversationId: number, stage: string, substatus: string, actorUserId: number | null): Promise<void> {
    await this.pool.query(
      `UPDATE conversations
       SET commercial_stage = $3,
           commercial_substatus = $4,
           commercial_state_updated_at = NOW(),
           updated_at = NOW()
       WHERE company_id = $1 AND id = $2`,
      [companyId, conversationId, stage, substatus]
    );
    await this.pool.query(
      `INSERT INTO operational_actions (
         company_id, conversation_id, actor_user_id, action_type, status, description, metadata_json
       )
       VALUES ($1, $2, $3, 'conversation_state_changed', 'completed', $4, $5::jsonb)`,
      [
        companyId,
        conversationId,
        actorUserId,
        `Estado comercial actualizado a ${stage}/${substatus}`,
        json({ stage, substatus, source: 'handoff' }),
      ]
    );
  }

  private async clearHandoffPendingTagIfResolved(companyId: number, conversationId: number): Promise<void> {
    const openTickets = await this.pool.query(
      `SELECT 1
       FROM handoff_tickets
       WHERE company_id = $1 AND conversation_id = $2 AND status = 'open'
       LIMIT 1`,
      [companyId, conversationId]
    );
    if (openTickets.rows.length > 0) return;

    await this.pool.query(
      `DELETE FROM tag_chats tc
       USING tags t
       WHERE t.id = tc.tag_id
         AND t.company_id = tc.company_id
         AND tc.company_id = $1
         AND tc.conversation_id = $2
         AND LOWER(t.name) = LOWER('handoff-pendiente')`,
      [companyId, conversationId]
    );
  }
}
