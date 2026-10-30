import { Queryable } from '../../../../shared/UnitOfWorkPort';
import type { AgentToolContext, ToolExecutorOutcome } from '../../domain/tool.types';
import { SYSTEM_TAGS } from '../../domain/tool.types';

type ApplyTagInput = {
  tag: string;
};

function findSystemTag(name: string): { name: string; color: string } | null {
  const lowered = String(name || '').trim().toLowerCase();
  return SYSTEM_TAGS.find((t) => t.name.toLowerCase() === lowered) || null;
}

export class SystemTagToolService {
  constructor(private readonly pool: Queryable) {}

  async apply(ctx: AgentToolContext, raw: ApplyTagInput): Promise<ToolExecutorOutcome> {
    const definition = findSystemTag(String(raw.tag || ''));
    if (!definition) {
      return { status: 'invalid_input', output: { applied: false, reason: 'tag_not_system' } };
    }
    if (!ctx.chatId) {
      return { status: 'invalid_input', output: { applied: false, reason: 'chat_id_required' } };
    }

    await this.pool.query(
      `INSERT INTO tags (company_id, name, color, is_default, is_system)
       VALUES ($1, $2, $3, FALSE, TRUE)
       ON CONFLICT (company_id, LOWER(name)) DO UPDATE SET is_system = TRUE, color = COALESCE(NULLIF(tags.color, ''), EXCLUDED.color)`,
      [ctx.companyId, definition.name, definition.color]
    );

    const tagResult = await this.pool.query(
      `SELECT id FROM tags WHERE company_id = $1 AND LOWER(name) = LOWER($2) LIMIT 1`,
      [ctx.companyId, definition.name]
    );
    const tagId = Number(tagResult.rows[0]?.id);
    if (!tagId) return { status: 'failed', output: { applied: false, reason: 'tag_resolve_failed' } };

    if (ctx.conversationId) {
      await this.pool.query(
        `INSERT INTO tag_chats (company_id, tag_id, conversation_id, chat_id, created_by)
         VALUES ($1, $2, $3, $4, NULL)
         ON CONFLICT (tag_id, chat_id)
         DO UPDATE SET conversation_id = COALESCE(EXCLUDED.conversation_id, tag_chats.conversation_id)`,
        [ctx.companyId, tagId, ctx.conversationId, ctx.chatId]
      );
    } else {
      await this.pool.query(
        `INSERT INTO tag_chats (company_id, tag_id, chat_id, created_by)
         VALUES ($1, $2, $3, NULL)
         ON CONFLICT (tag_id, chat_id) DO NOTHING`,
        [ctx.companyId, tagId, ctx.chatId]
      );
    }

    await this.pool.query(
      `INSERT INTO operational_actions (
         company_id, conversation_id, actor_user_id, action_type, status, description, metadata_json
       )
       VALUES ($1, $2, $3, 'system_tag_applied', 'completed', $4, $5::jsonb)`,
      [
        ctx.companyId,
        ctx.conversationId ?? null,
        ctx.actorUserId ?? null,
        `Etiqueta sistema aplicada: ${definition.name}`,
        JSON.stringify({ tag: definition.name, tagId, source: 'ai_tool' }),
      ]
    );

    return { status: 'ok', output: { applied: true, tag: definition.name, tagId } };
  }
}

let instance: SystemTagToolService | null = null;

export function getSystemTagToolService(pool: Queryable): SystemTagToolService {
  if (!instance) instance = new SystemTagToolService(pool);
  return instance;
}
