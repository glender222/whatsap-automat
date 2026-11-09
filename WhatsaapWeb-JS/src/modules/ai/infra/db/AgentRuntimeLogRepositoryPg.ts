import { queryInTenantScope } from '../../../../db/TenantScopedUoW';
import { Queryable } from '../../../../shared/UnitOfWorkPort';
import type { AgentAction, AgentRuntimeLogEntry, AgentRuntimeLogInput } from '../../domain/runtime.types';

function json(value: unknown): string {
  return JSON.stringify(value || {});
}

export class AgentRuntimeLogRepositoryPg {
  constructor(private readonly pool: Queryable) {}

  async log(input: AgentRuntimeLogInput): Promise<void> {
    await queryInTenantScope(this.pool, input.companyId,
      `INSERT INTO agent_runtime_logs (
         company_id, agent_id, provider, chat_id,
         inbound_provider_message_id, outbound_provider_message_id,
         stage, level, status, summary, error_code, error_message, payload_json,
         confidence, action, actor_agent_id, tool_name, tool_result_status,
         related_order_id, related_handoff_id
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15, $16, $17, $18, $19, $20)`,
      [
        input.companyId,
        input.agentId ?? null,
        input.provider || 'meta-cloud',
        input.chatId ?? null,
        input.inboundProviderMessageId ?? null,
        input.outboundProviderMessageId ?? null,
        input.stage,
        input.level || 'info',
        input.status || 'ok',
        input.summary || '',
        input.errorCode ?? null,
        input.errorMessage ?? null,
        json(input.payload || {}),
        input.confidence ?? null,
        input.action ?? null,
        input.agentId ?? null,
        input.toolName ?? null,
        input.toolResultStatus ?? null,
        input.relatedOrderId ?? null,
        input.relatedHandoffId ?? null,
      ]
    );
  }

  async list(
    companyId: number,
    input: {
      chatId?: string | null;
      limit?: number;
      status?: string;
      action?: string;
      toolName?: string | null;
      toolResultStatus?: string | null;
      agentId?: number | null;
    }
  ): Promise<AgentRuntimeLogEntry[]> {
    const limit = input.limit && Number.isSafeInteger(input.limit) ? Math.max(1, Math.min(input.limit, 300)) : 100;
    const params: unknown[] = [companyId];
    const clauses: string[] = ['l.company_id = $1'];

    if (input.chatId) {
      const normalized = String(input.chatId).replace('@c.us', '').replace('@s.whatsapp.net', '').replace(/[^\d]/g, '');
      params.push(normalized);
      clauses.push(`l.chat_id = $${params.length}`);
    }
    if (input.status) {
      params.push(input.status);
      clauses.push(`l.status = $${params.length}`);
    }
    if (input.action) {
      params.push(input.action);
      clauses.push(`l.action = $${params.length}`);
    }
    if (input.toolName) {
      params.push(input.toolName);
      clauses.push(`l.tool_name = $${params.length}`);
    }
    if (input.toolResultStatus) {
      params.push(input.toolResultStatus);
      clauses.push(`l.tool_result_status = $${params.length}`);
    }
    if (input.agentId !== undefined && input.agentId !== null) {
      params.push(Number(input.agentId));
      clauses.push(`l.agent_id = $${params.length}`);
    }

    params.push(limit);
    const result = await queryInTenantScope(this.pool, companyId,
      `SELECT l.id, l.company_id, l.agent_id, a.name AS agent_name, l.provider,
              l.chat_id, l.inbound_provider_message_id, l.outbound_provider_message_id,
              l.stage, l.level, l.status, l.summary, l.error_code, l.error_message,
              l.payload_json, l.confidence, l.action, l.tool_name, l.tool_result_status,
              l.related_order_id, l.related_handoff_id, l.created_at
       FROM agent_runtime_logs l
       LEFT JOIN ai_agents a ON a.id = l.agent_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY l.created_at DESC
       LIMIT $${params.length}`,
      params
    );

    return result.rows.map((row) => ({
      id: Number(row.id),
      companyId: Number(row.company_id),
      agentId: row.agent_id ? Number(row.agent_id) : null,
      agentName: row.agent_name || null,
      provider: row.provider,
      chatId: row.chat_id,
      inboundProviderMessageId: row.inbound_provider_message_id,
      outboundProviderMessageId: row.outbound_provider_message_id,
      stage: row.stage,
      level: row.level,
      status: row.status,
      summary: row.summary,
      errorCode: row.error_code,
      errorMessage: row.error_message,
      payload: row.payload_json || {},
      confidence: row.confidence !== null && row.confidence !== undefined ? Number(row.confidence) : null,
      action: (row.action as AgentAction) || null,
      toolName: row.tool_name || null,
      toolResultStatus: row.tool_result_status || null,
      relatedOrderId: row.related_order_id ? Number(row.related_order_id) : null,
      relatedHandoffId: row.related_handoff_id ? Number(row.related_handoff_id) : null,
      createdAt: row.created_at,
    }));
  }
}
