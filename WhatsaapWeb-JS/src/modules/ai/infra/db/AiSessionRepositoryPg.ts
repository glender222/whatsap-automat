import { queryInTenantScope } from '../../../../db/TenantScopedUoW';
import { Queryable } from '../../../../shared/UnitOfWorkPort';

export type AiSessionStatus = 'active' | 'paused' | 'handoff' | 'closed';
export type AiTurnStatus = 'running' | 'ok' | 'skipped' | 'failed';
export type AiEventKind = 'session' | 'tool' | 'state' | 'preorder' | 'handoff' | 'suggestion' | 'delivery' | 'error';
export type AiEventStatus = 'running' | 'ok' | 'skipped' | 'failed' | 'forbidden';

export type AiChatSessionRecord = {
  id: number;
  companyId: number;
  domainKey: string;
  conversationId: number;
  chatId: string;
  agentId: number | null;
  status: AiSessionStatus;
  lastInboundProviderMessageId: string | null;
  lastActivityAt: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type AiSessionTurnRecord = {
  id: number;
  companyId: number;
  sessionId: number;
  domainKey: string;
  conversationId: number;
  chatId: string;
  agentId: number | null;
  inboundProviderMessageId: string | null;
  mode: 'suggest' | 'auto';
  isTest: boolean;
  status: AiTurnStatus;
  finalAction: string | null;
  finalReplyPreview: string;
  commandCount: number;
  startedAt: string;
  completedAt: string | null;
};

export type CreateSessionEventInput = {
  companyId: number;
  sessionId: number;
  turnId?: number | null;
  domainKey: string;
  conversationId: number;
  chatId: string;
  agentId?: number | null;
  kind: AiEventKind;
  title: string;
  summary?: string;
  status?: AiEventStatus;
  toolName?: string | null;
  toolCallId?: string | null;
  durationMs?: number | null;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  relatedOrderId?: number | null;
  relatedHandoffId?: number | null;
  isTest?: boolean;
};

export type AiSessionEventRecord = {
  id: number;
  title: string;
  summary: string;
  toolName: string | null;
  status: AiEventStatus;
  durationMs: number | null;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  relatedOrderId: number | null;
  relatedHandoffId: number | null;
  createdAt: string;
};

function json(value: unknown): string {
  return JSON.stringify(value || {});
}

function normalizeSession(row: Record<string, any>): AiChatSessionRecord {
  return {
    id: Number(row.id),
    companyId: Number(row.company_id),
    domainKey: row.domain_key,
    conversationId: Number(row.conversation_id),
    chatId: row.chat_id,
    agentId: row.agent_id ? Number(row.agent_id) : null,
    status: row.status,
    lastInboundProviderMessageId: row.last_inbound_provider_message_id || null,
    lastActivityAt: row.last_activity_at,
    metadata: row.metadata_json || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeTurn(row: Record<string, any>): AiSessionTurnRecord {
  return {
    id: Number(row.id),
    companyId: Number(row.company_id),
    sessionId: Number(row.session_id),
    domainKey: row.domain_key,
    conversationId: Number(row.conversation_id),
    chatId: row.chat_id,
    agentId: row.agent_id ? Number(row.agent_id) : null,
    inboundProviderMessageId: row.inbound_provider_message_id || null,
    mode: row.mode,
    isTest: Boolean(row.is_test),
    status: row.status,
    finalAction: row.final_action || null,
    finalReplyPreview: row.final_reply_preview || '',
    commandCount: Number(row.command_count || 0),
    startedAt: row.started_at,
    completedAt: row.completed_at || null,
  };
}

export class AiSessionRepositoryPg {
  constructor(private readonly pool: Queryable) {}

  async resolveConversationId(companyId: number, chatId: string): Promise<number | null> {
    const normalized = String(chatId || '').replace('@c.us', '').replace('@s.whatsapp.net', '').replace(/[^\d]/g, '');
    if (!normalized) return null;
    const result = await queryInTenantScope(this.pool, companyId,
      `SELECT id FROM conversations
       WHERE company_id = $1 AND channel = 'whatsapp'
         AND external_conversation_id = ANY($2::varchar[])
       ORDER BY last_message_at DESC NULLS LAST, id DESC
       LIMIT 1`,
      [companyId, [chatId, normalized, `${normalized}@c.us`, `${normalized}@s.whatsapp.net`].filter(Boolean)]
    );
    return result.rows[0]?.id ? Number(result.rows[0].id) : null;
  }

  async resolveOrCreateSession(input: {
    companyId: number;
    domainKey: string;
    conversationId: number;
    chatId: string;
    agentId: number | null;
    inboundProviderMessageId?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<AiChatSessionRecord> {
    const result = await queryInTenantScope(this.pool, input.companyId,
      `INSERT INTO ai_chat_sessions (
         company_id, domain_key, conversation_id, chat_id, agent_id,
         status, last_inbound_provider_message_id, last_activity_at, metadata_json
       )
       VALUES ($1, $2, $3, $4, $5, 'active', $6, NOW(), $7::jsonb)
       ON CONFLICT (company_id, domain_key, conversation_id)
       DO UPDATE SET
         chat_id = EXCLUDED.chat_id,
         agent_id = EXCLUDED.agent_id,
         status = CASE
           WHEN ai_chat_sessions.status = 'closed' THEN 'active'
           ELSE ai_chat_sessions.status
         END,
         last_inbound_provider_message_id = COALESCE(EXCLUDED.last_inbound_provider_message_id, ai_chat_sessions.last_inbound_provider_message_id),
         last_activity_at = NOW(),
         metadata_json = ai_chat_sessions.metadata_json || EXCLUDED.metadata_json,
         updated_at = NOW()
       RETURNING *`,
      [
        input.companyId,
        input.domainKey,
        input.conversationId,
        input.chatId,
        input.agentId,
        input.inboundProviderMessageId || null,
        json(input.metadata || {}),
      ]
    );
    return normalizeSession(result.rows[0]);
  }

  async getSessionByChat(companyId: number, chatId: string, domainKey = 'gestion_web'): Promise<AiChatSessionRecord | null> {
    const normalized = String(chatId || '').replace('@c.us', '').replace('@s.whatsapp.net', '').replace(/[^\d]/g, '');
    const result = await queryInTenantScope(this.pool, companyId,
      `SELECT *
       FROM ai_chat_sessions
       WHERE company_id = $1 AND domain_key = $2
         AND chat_id = ANY($3::varchar[])
       ORDER BY last_activity_at DESC, id DESC
       LIMIT 1`,
      [companyId, domainKey, [chatId, normalized, `${normalized}@c.us`, `${normalized}@s.whatsapp.net`].filter(Boolean)]
    );
    return result.rows[0] ? normalizeSession(result.rows[0]) : null;
  }

  async listSessionsByDomain(companyId: number, domainKey: string, limit = 100): Promise<AiChatSessionRecord[]> {
    const result = await queryInTenantScope(this.pool, companyId,
      `SELECT *
       FROM ai_chat_sessions
       WHERE company_id = $1 AND domain_key = $2
       ORDER BY last_activity_at DESC, id DESC
       LIMIT $3`,
      [companyId, domainKey, Math.max(1, Math.min(Number(limit || 100), 300))]
    );
    return result.rows.map(normalizeSession);
  }

  async updateSessionStatus(companyId: number, sessionId: number, status: AiSessionStatus): Promise<void> {
    await queryInTenantScope(this.pool, companyId,
      `UPDATE ai_chat_sessions
       SET status = $3, last_activity_at = NOW(), updated_at = NOW()
       WHERE company_id = $1 AND id = $2`,
      [companyId, sessionId, status]
    );
  }

  async updateSessionsByConversation(companyId: number, conversationId: number, status: AiSessionStatus): Promise<AiChatSessionRecord[]> {
    const result = await queryInTenantScope(this.pool, companyId,
      `UPDATE ai_chat_sessions
       SET status = $3, last_activity_at = NOW(), updated_at = NOW()
       WHERE company_id = $1 AND conversation_id = $2
       RETURNING *`,
      [companyId, conversationId, status]
    );
    return result.rows.map(normalizeSession);
  }

  async createTurn(input: {
    companyId: number;
    sessionId: number;
    domainKey: string;
    conversationId: number;
    chatId: string;
    agentId: number | null;
    inboundProviderMessageId?: string | null;
    mode: 'suggest' | 'auto';
    isTest?: boolean;
  }): Promise<AiSessionTurnRecord> {
    const result = await queryInTenantScope(this.pool, input.companyId,
      `INSERT INTO ai_session_turns (
         company_id, session_id, domain_key, conversation_id, chat_id,
         agent_id, inbound_provider_message_id, mode, is_test, status
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'running')
       RETURNING *`,
      [
        input.companyId,
        input.sessionId,
        input.domainKey,
        input.conversationId,
        input.chatId,
        input.agentId,
        input.inboundProviderMessageId || null,
        input.mode,
        Boolean(input.isTest),
      ]
    );
    return normalizeTurn(result.rows[0]);
  }

  async completeTurn(input: {
    companyId: number;
    turnId: number;
    status: AiTurnStatus;
    finalAction?: string | null;
    finalReplyPreview?: string | null;
    commandCount?: number;
  }): Promise<void> {
    await queryInTenantScope(this.pool, input.companyId,
      `UPDATE ai_session_turns
       SET status = $3,
           final_action = $4,
           final_reply_preview = COALESCE($5, ''),
           command_count = COALESCE($6, command_count),
           completed_at = NOW()
       WHERE company_id = $1 AND id = $2`,
      [
        input.companyId,
        input.turnId,
        input.status,
        input.finalAction || null,
        input.finalReplyPreview ? input.finalReplyPreview.slice(0, 500) : '',
        input.commandCount ?? null,
      ]
    );
  }

  async createEvent(input: CreateSessionEventInput): Promise<AiSessionEventRecord> {
    const result = await queryInTenantScope(this.pool, input.companyId,
      `INSERT INTO ai_session_events (
         company_id, session_id, turn_id, domain_key, conversation_id, chat_id,
         agent_id, kind, title, summary, status, tool_name, tool_call_id,
         duration_ms, input_sanitized_json, output_sanitized_json,
         related_order_id, related_handoff_id
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16::jsonb, $17, $18)
       RETURNING id, title, summary, tool_name, status, duration_ms, input_sanitized_json,
                 output_sanitized_json, related_order_id, related_handoff_id, created_at`,
      [
        input.companyId,
        input.sessionId,
        input.turnId || null,
        input.domainKey,
        input.conversationId,
        input.chatId,
        input.agentId ?? null,
        input.kind,
        input.title.slice(0, 160),
        input.summary || '',
        input.status || 'ok',
        input.toolName || null,
        input.toolCallId || null,
        input.durationMs ?? null,
        json(input.input || {}),
        json(input.output || {}),
        input.relatedOrderId ?? null,
        input.relatedHandoffId ?? null,
      ]
    );
    const row = result.rows[0];
    return {
      id: Number(row.id),
      title: row.title,
      summary: row.summary || '',
      toolName: row.tool_name || null,
      status: row.status,
      durationMs: row.duration_ms !== null && row.duration_ms !== undefined ? Number(row.duration_ms) : null,
      input: row.input_sanitized_json || {},
      output: row.output_sanitized_json || {},
      relatedOrderId: row.related_order_id ? Number(row.related_order_id) : null,
      relatedHandoffId: row.related_handoff_id ? Number(row.related_handoff_id) : null,
      createdAt: row.created_at,
    };
  }

  async listActivityByChat(companyId: number, chatId: string, limit = 50): Promise<any[]> {
    const normalized = String(chatId || '').replace('@c.us', '').replace('@s.whatsapp.net', '').replace(/[^\d]/g, '');
    const safeLimit = Math.max(1, Math.min(Number(limit || 50), 100));
    const turns = await queryInTenantScope(this.pool, companyId,
      `SELECT t.*, a.name AS agent_name
       FROM ai_session_turns t
       LEFT JOIN ai_agents a ON a.id = t.agent_id
       WHERE t.company_id = $1
         AND t.chat_id = ANY($2::varchar[])
       ORDER BY t.started_at DESC, t.id DESC
       LIMIT $3`,
      [companyId, [chatId, normalized, `${normalized}@c.us`, `${normalized}@s.whatsapp.net`].filter(Boolean), safeLimit]
    );
    return this.attachEvents(companyId, turns.rows);
  }

  async listActivityByDomain(companyId: number, domainKey: string, filters: {
    agentId?: number | null;
    status?: string | null;
    tool?: string | null;
    chatId?: string | null;
    dateFrom?: string | null;
    dateTo?: string | null;
    limit?: number;
  } = {}): Promise<any[]> {
    const params: unknown[] = [companyId, domainKey];
    const clauses = ['t.company_id = $1', 't.domain_key = $2'];
    if (filters.agentId) {
      params.push(filters.agentId);
      clauses.push(`t.agent_id = $${params.length}`);
    }
    if (filters.status) {
      params.push(filters.status);
      clauses.push(`t.status = $${params.length}`);
    }
    if (filters.chatId) {
      const normalized = String(filters.chatId).replace('@c.us', '').replace('@s.whatsapp.net', '').replace(/[^\d]/g, '');
      params.push([filters.chatId, normalized, `${normalized}@c.us`, `${normalized}@s.whatsapp.net`].filter(Boolean));
      clauses.push(`t.chat_id = ANY($${params.length}::varchar[])`);
    }
    if (filters.tool) {
      params.push(filters.tool);
      clauses.push(`EXISTS (SELECT 1 FROM ai_session_events e WHERE e.turn_id = t.id AND e.tool_name = $${params.length})`);
    }
    if (filters.dateFrom) {
      params.push(filters.dateFrom);
      clauses.push(`t.started_at >= $${params.length}::timestamptz`);
    }
    if (filters.dateTo) {
      params.push(filters.dateTo);
      clauses.push(`t.started_at <= $${params.length}::timestamptz`);
    }
    params.push(Math.max(1, Math.min(Number(filters.limit || 100), 300)));
    const turns = await queryInTenantScope(this.pool, companyId,
      `SELECT t.*, a.name AS agent_name
       FROM ai_session_turns t
       LEFT JOIN ai_agents a ON a.id = t.agent_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY t.started_at DESC, t.id DESC
       LIMIT $${params.length}`,
      params
    );
    return this.attachEvents(companyId, turns.rows);
  }

  async getDomainMetrics(companyId: number, domainKey: string): Promise<Record<string, unknown>> {
    const result = await queryInTenantScope(this.pool, companyId,
      `SELECT
         (COUNT(DISTINCT s.id) FILTER (WHERE s.status = 'active'))::int AS active_sessions,
         COUNT(DISTINCT t.id)::int AS turns,
         COUNT(e.id)::int AS commands,
         (COUNT(DISTINCT t.id) FILTER (WHERE t.final_action = 'suggest'))::int AS suggestions,
         (COUNT(DISTINCT t.id) FILTER (WHERE t.final_action = 'auto_reply'))::int AS auto_replies,
         (COUNT(DISTINCT t.id) FILTER (WHERE t.final_action = 'handoff'))::int AS handoffs,
         (COUNT(DISTINCT t.id) FILTER (WHERE t.status = 'failed'))::int AS errors,
         (COUNT(DISTINCT t.id) FILTER (WHERE t.is_test = true))::int AS dry_runs
       FROM ai_chat_sessions s
       LEFT JOIN ai_session_turns t ON t.session_id = s.id
       LEFT JOIN ai_session_events e ON e.turn_id = t.id AND e.kind = 'tool'
       WHERE s.company_id = $1 AND s.domain_key = $2`,
      [companyId, domainKey]
    );
    const row = result.rows[0] || {};
    return {
      domainKey,
      activeSessions: Number(row.active_sessions || 0),
      turns: Number(row.turns || 0),
      commands: Number(row.commands || 0),
      suggestions: Number(row.suggestions || 0),
      autoReplies: Number(row.auto_replies || 0),
      handoffs: Number(row.handoffs || 0),
      errors: Number(row.errors || 0),
      dryRuns: Number(row.dry_runs || 0),
    };
  }

  private async attachEvents(companyId: number, turnRows: Record<string, any>[]): Promise<any[]> {
    if (turnRows.length === 0) return [];
    const turnIds = turnRows.map((row) => Number(row.id));
    const events = await queryInTenantScope(this.pool, companyId,
      `SELECT *
       FROM ai_session_events
       WHERE company_id = $1 AND turn_id = ANY($2::bigint[])
       ORDER BY created_at ASC, id ASC`,
      [companyId, turnIds]
    );
    const byTurn = new Map<number, any[]>();
    for (const row of events.rows) {
      const turnId = Number(row.turn_id);
      const list = byTurn.get(turnId) || [];
      list.push({
        id: Number(row.id),
        title: row.title,
        summary: row.summary,
        toolName: row.tool_name || null,
        status: row.status,
        durationMs: row.duration_ms !== null && row.duration_ms !== undefined ? Number(row.duration_ms) : null,
        input: row.input_sanitized_json || {},
        output: row.output_sanitized_json || {},
        relatedOrderId: row.related_order_id ? Number(row.related_order_id) : null,
        relatedHandoffId: row.related_handoff_id ? Number(row.related_handoff_id) : null,
        createdAt: row.created_at,
      });
      byTurn.set(turnId, list);
    }
    return turnRows.map((row) => ({
      id: Number(row.id),
      sessionId: Number(row.session_id),
      agentId: row.agent_id ? Number(row.agent_id) : null,
      agentName: row.agent_name || '',
      inboundProviderMessageId: row.inbound_provider_message_id || null,
      status: row.status,
      finalAction: row.final_action || 'none',
      finalReplyPreview: row.final_reply_preview || '',
      commandCount: Number(row.command_count || 0),
      startedAt: row.started_at,
      completedAt: row.completed_at || null,
      commands: byTurn.get(Number(row.id)) || [],
    }));
  }
}
