import { tenantScopedUoW, TenantScopedUoW, type TenantScopedOptions } from '../../../db/TenantScopedUoW';
import {
  TokenLedgerEntryV1,
  CreateTokenLedgerEntryCommandV1,
  TokenLedgerQueryV1,
} from './types';

export class TokenCostLedger {
  constructor(private readonly uow: TenantScopedUoW = tenantScopedUoW) {}

  /**
   * Records an immutable entry in the AI token and cost ledger.
   * Returns the database surrogate primary key.
   */
  async record(
    entry: CreateTokenLedgerEntryCommandV1 & { id?: string | number },
    options?: TenantScopedOptions
  ): Promise<number> {
    const tenantIdNum = Number(entry.tenantId);
    return this.uow.run(tenantIdNum, async (client) => {
      const res = await client.query(
        `INSERT INTO ai_token_cost_ledger
          (tenant_id, workspace_id, agent_id, agent_run_id, conversation_id,
           provider, model, operation, prompt_tokens, completion_tokens,
           total_tokens, cost_micro_usd, is_byok, latency_ms, status, metadata_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
         RETURNING id`,
        [
          tenantIdNum,
          entry.workspaceId ? Number(entry.workspaceId) : null,
          entry.agentId || null,
          entry.agentRunId || null,
          entry.conversationId ? Number(entry.conversationId) : null,
          entry.provider,
          entry.model,
          entry.operation || 'completion',
          entry.promptTokens,
          entry.completionTokens,
          entry.totalTokens,
          BigInt(entry.costMicroUsd),
          entry.isByok ?? false,
          entry.latencyMs ?? 0,
          entry.status || 'success',
          JSON.stringify(entry.metadataJson || {}),
        ]
      );
      return Number(res.rows[0].id);
    }, options);
  }

  /**
   * Retrieves cursor-paginated ledger entries for a tenant.
   */
  async query(
    tenantId: number,
    params: TokenLedgerQueryV1 = { limit: 50 }
  ): Promise<{ items: TokenLedgerEntryV1[]; nextCursor: string | null }> {
    const limit = Math.min(Math.max(1, params.limit || 50), 100);

    return this.uow.run(tenantId, async (client) => {
      const conditions: string[] = ['tenant_id = $1'];
      const values: unknown[] = [tenantId];
      let valIdx = 2;

      if (params.cursor) {
        conditions.push(`id < $${valIdx}`);
        values.push(Number(params.cursor));
        valIdx++;
      }

      if (params.agentRunId) {
        conditions.push(`agent_run_id = $${valIdx}`);
        values.push(params.agentRunId);
        valIdx++;
      }

      if (params.provider) {
        conditions.push(`provider = $${valIdx}`);
        values.push(params.provider);
        valIdx++;
      }

      if (params.model) {
        conditions.push(`model = $${valIdx}`);
        values.push(params.model);
        valIdx++;
      }

      if (params.startDate) {
        conditions.push(`created_at >= $${valIdx}`);
        values.push(params.startDate);
        valIdx++;
      }

      if (params.endDate) {
        conditions.push(`created_at <= $${valIdx}`);
        values.push(params.endDate);
        valIdx++;
      }

      const sql = `
        SELECT id, tenant_id, workspace_id, agent_id, agent_run_id, conversation_id,
               provider, model, operation, prompt_tokens, completion_tokens,
               total_tokens, cost_micro_usd, is_byok, latency_ms, status,
               metadata_json, created_at
        FROM ai_token_cost_ledger
        WHERE ${conditions.join(' AND ')}
        ORDER BY id DESC
        LIMIT ${limit + 1}
      `;

      const res = await client.query(sql, values);
      const rows = res.rows;
      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;

      const items: TokenLedgerEntryV1[] = pageRows.map((r: any) => ({
        id: Number(r.id),
        tenantId: Number(r.tenant_id),
        workspaceId: r.workspace_id ? Number(r.workspace_id) : null,
        agentId: r.agent_id || null,
        agentRunId: r.agent_run_id || null,
        conversationId: r.conversation_id ? Number(r.conversation_id) : null,
        provider: r.provider,
        model: r.model,
        operation: r.operation,
        promptTokens: Number(r.prompt_tokens),
        completionTokens: Number(r.completion_tokens),
        totalTokens: Number(r.total_tokens),
        costMicroUsd: Number(r.cost_micro_usd),
        isByok: Boolean(r.is_byok),
        latencyMs: Number(r.latency_ms),
        status: r.status,
        metadataJson: typeof r.metadata_json === 'string' ? JSON.parse(r.metadata_json) : (r.metadata_json || {}),
        createdAt: new Date(r.created_at).toISOString(),
      }));

      const nextCursor = hasMore && items.length > 0
        ? String(items[items.length - 1].id)
        : null;

      return { items, nextCursor };
    });
  }
}
