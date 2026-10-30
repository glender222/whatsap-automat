import { Queryable } from '../../../../shared/UnitOfWorkPort';
import { AgentHandoffService } from '../AgentHandoffService';
import { AgentPauseService } from '../AgentPauseService';
import { HandoffTicketRepositoryPg } from '../../infra/db/HandoffTicketRepositoryPg';
import { IaPauseOverrideRepositoryPg } from '../../infra/db/IaPauseOverrideRepositoryPg';
import type { AgentToolContext, ToolExecutorOutcome } from '../../domain/tool.types';
import { getCommercialStateToolService } from './CommercialStateToolService';

type CreateHandoffInput = {
  reason: string;
  priority?: 'low' | 'medium' | 'high';
  orderId?: number | null;
  messageToCustomer?: string;
};

const HANDOFF_REASONS = [
  'payment_closure',
  'customer_asks_human',
  'product_not_found',
  'low_confidence',
  'stock_capacity',
  'policy_restriction',
  'support',
  'other',
] as const;

export class HandoffToolService {
  constructor(
    private readonly pool: Queryable,
    private readonly handoffService: AgentHandoffService,
    private readonly pauseService: AgentPauseService
  ) {}

  async create(ctx: AgentToolContext, raw: CreateHandoffInput): Promise<ToolExecutorOutcome> {
    const reason = String(raw.reason || '').trim();
    if (!HANDOFF_REASONS.includes(reason as (typeof HANDOFF_REASONS)[number])) {
      return { status: 'invalid_input', output: { ticketId: null, reason: 'invalid_reason' } };
    }
    if (!ctx.chatId) {
      return { status: 'invalid_input', output: { ticketId: null, reason: 'chat_id_required' } };
    }

    const conversationId = ctx.conversationId ?? (await this.resolveConversationId(ctx.companyId, ctx.chatId));
    if (!conversationId) {
      return { status: 'failed', output: { ticketId: null, reason: 'conversation_not_found' } };
    }

    const priority = raw.priority && ['low', 'medium', 'high'].includes(raw.priority) ? raw.priority : undefined;
    const orderId = raw.orderId ? Number(raw.orderId) : null;

    const ticket = await this.handoffService.createTicket({
      companyId: ctx.companyId,
      conversationId,
      chatId: ctx.chatId,
      agentId: ctx.agentId,
      orderId: orderId ?? null,
      reason,
      priority,
      metadata: {
        source: 'ai_tool',
        tool: 'handoff.create',
        messageToCustomer: raw.messageToCustomer || null,
      },
    });

    try {
      await this.pauseService.pause({
        companyId: ctx.companyId,
        conversationId,
        chatId: ctx.chatId,
        pausedBy: null,
        reason: `handoff:${reason}`,
        durationHours: 24,
      });
    } catch (err) {
      // pausa fallida no bloquea handoff; se loguea via executor
    }

    const stateService = getCommercialStateToolService(this.pool);
    await stateService.setState(
      { ...ctx, conversationId },
      { stage: 'handoff', substatus: 'handoff_pending', metadata: { ticketId: ticket.id, reason } },
      { skipForbiddenCheck: true }
    );

    await this.pool.query(
      `INSERT INTO operational_actions (
         company_id, conversation_id, actor_user_id, action_type, status, description, metadata_json
       )
       VALUES ($1, $2, $3, 'handoff_created', 'completed', $4, $5::jsonb)`,
      [
        ctx.companyId,
        conversationId,
        ctx.actorUserId ?? null,
        `Handoff creado: ${reason}`,
        JSON.stringify({ ticketId: ticket.id, reason, priority: ticket.priority, orderId: ticket.orderId, source: 'ai_tool' }),
      ]
    );

    return {
      status: 'ok',
      output: {
        ticketId: ticket.id,
        status: ticket.status,
        priority: ticket.priority,
        conversationPaused: true,
        messageToCustomer: raw.messageToCustomer || null,
      },
      relatedHandoffId: ticket.id,
      relatedOrderId: orderId ?? null,
    };
  }

  private async resolveConversationId(companyId: number, chatId: string): Promise<number | null> {
    const normalized = String(chatId).replace('@c.us', '').replace('@s.whatsapp.net', '').replace(/[^\d]/g, '');
    if (!normalized) return null;
    const result = await this.pool.query(
      `SELECT id FROM conversations
       WHERE company_id = $1 AND channel = 'whatsapp'
         AND external_conversation_id = ANY($2::varchar[])
       ORDER BY last_message_at DESC NULLS LAST, id DESC LIMIT 1`,
      [companyId, [chatId, normalized, `${normalized}@c.us`, `${normalized}@s.whatsapp.net`].filter(Boolean)]
    );
    return result.rows[0]?.id ? Number(result.rows[0].id) : null;
  }
}

let instance: HandoffToolService | null = null;

export function getHandoffToolService(pool: Queryable): HandoffToolService {
  if (!instance) {
    const handoffService = new AgentHandoffService(new HandoffTicketRepositoryPg(pool));
    const pauseService = new AgentPauseService(new IaPauseOverrideRepositoryPg(pool));
    instance = new HandoffToolService(pool, handoffService, pauseService);
  }
  return instance;
}
