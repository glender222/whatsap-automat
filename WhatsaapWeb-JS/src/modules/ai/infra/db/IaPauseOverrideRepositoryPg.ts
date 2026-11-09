import type { Pool } from 'pg';
import { queryInTenantScope, withTenantTransaction } from '../../../../db/TenantScopedUoW';
import { Queryable } from '../../../../shared/UnitOfWorkPort';
import type { IaPauseOverride, IaPauseStatus } from '../../domain/runtime.types';

type Row = Record<string, any>;

function mapOverride(row: Row): IaPauseOverride {
  return {
    id: Number(row.id),
    companyId: Number(row.company_id),
    conversationId: Number(row.conversation_id),
    pausedBy: row.paused_by ? Number(row.paused_by) : null,
    reason: row.reason || null,
    expiresAt: row.expires_at || null,
    createdAt: row.created_at,
  };
}

function conversationNotFound() {
  return Object.assign(new Error('Conversacion no encontrada'), { statusCode: 404 });
}

export class IaPauseOverrideRepositoryPg {
  constructor(private readonly pool: Queryable) {}

  async pause(input: {
    companyId: number;
    conversationId: number;
    pausedBy?: number | null;
    reason?: string | null;
    expiresAt?: Date | null;
  }): Promise<IaPauseOverride> {
    return withTenantTransaction(input.companyId, async (client) => {
      const updated = await client.query(
        `UPDATE conversations
         SET ia_paused = true, ia_paused_by = $3, ia_paused_at = NOW(), ia_resume_at = $4,
             version = version + 1, updated_at = NOW()
         WHERE company_id = $1 AND id = $2`,
        [input.companyId, input.conversationId, input.pausedBy ?? null, input.expiresAt ?? null]
      );
      if (!updated.rowCount) throw conversationNotFound();
      const result = await client.query(
        `INSERT INTO ia_pause_overrides (company_id, conversation_id, paused_by, reason, expires_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (conversation_id)
         DO UPDATE SET paused_by = EXCLUDED.paused_by, reason = EXCLUDED.reason, expires_at = EXCLUDED.expires_at, created_at = NOW()
         RETURNING *`,
        [input.companyId, input.conversationId, input.pausedBy ?? null, input.reason ?? null, input.expiresAt ?? null]
      );
      return mapOverride(result.rows[0]);
    }, this.pool as Pool);
  }

  async resume(companyId: number, conversationId: number): Promise<void> {
    await withTenantTransaction(companyId, async (client) => {
      const updated = await client.query(
        `UPDATE conversations
         SET ia_paused = false, ia_paused_by = NULL, ia_paused_at = NULL, ia_resume_at = NULL,
             owner_type = 'ai_agent', owner_id = NULL, ownership_epoch = ownership_epoch + 1,
             version = version + 1, updated_at = NOW()
         WHERE company_id = $1 AND id = $2`,
        [companyId, conversationId]
      );
      if (!updated.rowCount) throw conversationNotFound();
      await client.query(
        `DELETE FROM ia_pause_overrides WHERE company_id = $1 AND conversation_id = $2`,
        [companyId, conversationId]
      );
    }, this.pool as Pool);
  }

  async getStatus(companyId: number, conversationId: number): Promise<IaPauseStatus> {
    const result = await queryInTenantScope(this.pool, companyId,
      `SELECT c.ia_paused, c.ia_paused_by, c.ia_paused_at, c.ia_resume_at,
              o.reason, (c.ia_resume_at IS NOT NULL AND c.ia_resume_at <= NOW()) AS expired
       FROM conversations c
       LEFT JOIN ia_pause_overrides o ON o.conversation_id = c.id AND o.company_id = c.company_id
         AND c.ia_paused AND o.expires_at IS NOT DISTINCT FROM c.ia_resume_at
       WHERE c.company_id = $1 AND c.id = $2`,
      [companyId, conversationId]
    );
    const row = result.rows[0];
    if (!row) throw conversationNotFound();
    return {
      paused: Boolean(row.ia_paused) && !(Boolean(row.expired)),
      pausedBy: row.ia_paused_by ? Number(row.ia_paused_by) : null,
      pausedAt: row.ia_paused_at || null,
      resumeAt: row.ia_resume_at || null,
      reason: row.reason || null,
      expired: Boolean(row.expired),
    };
  }

  async isPaused(companyId: number, chatId: string): Promise<boolean> {
    const normalized = String(chatId || '').replace('@c.us', '').replace('@s.whatsapp.net', '').replace(/[^\d]/g, '');
    if (!normalized) throw conversationNotFound();
    const result = await queryInTenantScope(this.pool, companyId,
      `SELECT c.ia_paused AND (c.ia_resume_at IS NULL OR c.ia_resume_at > NOW()) AS ia_paused
       FROM conversations c
       WHERE c.company_id = $1 AND c.channel = 'whatsapp'
         AND c.external_conversation_id = ANY($2::varchar[])
       ORDER BY c.last_message_at DESC NULLS LAST, c.id DESC
       LIMIT 1`,
      [companyId, [chatId, normalized, `${normalized}@c.us`, `${normalized}@s.whatsapp.net`].filter(Boolean)]
    );
    const row = result.rows[0];
    if (!row) throw conversationNotFound();
    return Boolean(row.ia_paused);
  }

  async purgeExpired(companyId: number): Promise<number> {
    const result = await queryInTenantScope(this.pool, companyId,
      `DELETE FROM ia_pause_overrides WHERE company_id = $1 AND expires_at <= NOW()`,
      [companyId]
    );
    return result.rowCount ?? 0;
  }
}
