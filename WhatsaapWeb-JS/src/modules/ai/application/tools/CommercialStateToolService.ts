import { Queryable } from '../../../../shared/UnitOfWorkPort';
import type { AgentToolContext, ToolExecutorOutcome } from '../../domain/tool.types';
import {
  AI_FORBIDDEN_SUBSTATUSES,
  COMMERCIAL_STAGES,
  COMMERCIAL_SUBSTATUSES,
  MAX_METADATA_BYTES,
} from '../../domain/tool.types';

type SetStateInput = {
  stage: string;
  substatus?: string;
  metadata?: Record<string, unknown>;
};

function json(value: unknown): string {
  return JSON.stringify(value || {});
}

export class CommercialStateToolService {
  constructor(private readonly pool: Queryable) {}

  async setState(ctx: AgentToolContext, raw: SetStateInput, options: { skipForbiddenCheck?: boolean } = {}): Promise<ToolExecutorOutcome> {
    const stage = String(raw.stage || '').trim();
    const substatus = String(raw.substatus || '').trim();
    if (!stage || !COMMERCIAL_STAGES.includes(stage)) {
      return { status: 'invalid_input', output: { stage: null, substatus: null, reason: 'invalid_stage' } };
    }
    if (substatus && !COMMERCIAL_SUBSTATUSES.includes(substatus)) {
      return { status: 'invalid_input', output: { stage: null, substatus: null, reason: 'invalid_substatus' } };
    }
    if (!options.skipForbiddenCheck && substatus && AI_FORBIDDEN_SUBSTATUSES.includes(substatus)) {
      return { status: 'forbidden', output: { stage: null, substatus: null, reason: 'substatus_reserved_for_human' } };
    }

    let metadata: Record<string, unknown> = {};
    if (raw.metadata !== undefined && raw.metadata !== null) {
      if (typeof raw.metadata !== 'object' || Array.isArray(raw.metadata) || raw.metadata === null) {
        return { status: 'invalid_input', output: { stage: null, substatus: null, reason: 'metadata_must_be_object' } };
      }
      metadata = raw.metadata as Record<string, unknown>;
      const serialized = JSON.stringify(metadata);
      if (serialized.length > MAX_METADATA_BYTES) {
        return { status: 'invalid_input', output: { stage: null, substatus: null, reason: 'metadata_too_large' } };
      }
    }

    if (!ctx.conversationId) {
      return { status: 'invalid_input', output: { stage: null, substatus: null, reason: 'conversation_id_required' } };
    }

    await this.pool.query(
      `UPDATE conversations
       SET commercial_stage = $3,
           commercial_substatus = COALESCE(NULLIF($4, ''), commercial_substatus),
           commercial_state_metadata_json = COALESCE($5::jsonb, commercial_state_metadata_json),
           commercial_state_updated_at = NOW(),
           updated_at = NOW()
       WHERE company_id = $1 AND id = $2`,
      [ctx.companyId, ctx.conversationId, stage, substatus, Object.keys(metadata).length ? json(metadata) : null]
    );

    await this.pool.query(
      `INSERT INTO operational_actions (
         company_id, conversation_id, actor_user_id, action_type, status, description, metadata_json
       )
       VALUES ($1, $2, $3, 'conversation_state_changed', 'completed', $4, $5::jsonb)`,
      [
        ctx.companyId,
        ctx.conversationId,
        ctx.actorUserId ?? null,
        `Estado comercial actualizado a ${stage}${substatus ? '/' + substatus : ''}`,
        json({ stage, substatus, metadata, source: 'ai_tool' }),
      ]
    );

    return {
      status: 'ok',
      output: { stage, substatus: substatus || null, conversationId: ctx.conversationId },
    };
  }
}

let instance: CommercialStateToolService | null = null;

export function getCommercialStateToolService(pool: Queryable): CommercialStateToolService {
  if (!instance) instance = new CommercialStateToolService(pool);
  return instance;
}
