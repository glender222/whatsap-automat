import { queryInTenantScope } from '../../../db/TenantScopedUoW';
import { Queryable } from '../../../shared/UnitOfWorkPort';
import { AgentRepositoryPg } from '../infra/db/AgentRepositoryPg';
import { AgentRuntimeLogRepositoryPg } from '../infra/db/AgentRuntimeLogRepositoryPg';
import { AgentRouterService, type RouterOutcome, type RouterRoute } from './AgentRouterService';
import { AgentToolExecutor } from './AgentToolExecutor';
import { AgentToolLogger } from './AgentToolLogger';
import { AgentToolRegistry, getDefaultToolRegistry } from './AgentToolRegistry';
import { AgentToolRuntimeLoop } from './AgentToolRuntimeLoop';
import { AiChatSessionService } from './AiChatSessionService';
import { AiSessionEventService } from './AiSessionEventService';
import type { ProductCardSender } from './tools';
import { emitDashboard } from '../../../sockets/socketEmitter';
import type { AgentToolContext } from '../domain/tool.types';
import type { AiAgent, AiDomainKey, AutomatorMode } from '../domain/agent.types';
import { AiSessionRepositoryPg } from '../infra/db/AiSessionRepositoryPg';

export type OrchestratorInput = {
  companyId: number;
  chatId: string;
  message: string;
  history: Array<{ fromMe: boolean; body: string }>;
  inboundProviderMessageId: string | null;
  sender: ProductCardSender;
  conversationId?: number;
  signal?: AbortSignal;
};

export type OrchestratorResult = {
  routerMissing: boolean;
  route: string;
  agentId: number | null;
  action: 'auto_reply' | 'suggest' | 'handoff' | 'block' | 'none';
  reply: string;
  confidence: number;
  reason: string;
  handoffTicketId: number | null;
  toolResults: Array<{ toolName: string; status: string }>;
  rounds: number;
  delivery?: {
    productCards?: Array<{ commercialItemId: number; caption?: string }>;
  } | null;
};

export class AiRuntimeOrchestrator {
  constructor(
    private readonly pool: Queryable,
    private readonly agentRepo: AgentRepositoryPg,
    private readonly routerService: AgentRouterService,
    private readonly registry: AgentToolRegistry,
    private readonly logger: AgentToolLogger,
    private readonly sessionService: AiChatSessionService
  ) {}

  async processInbound(input: OrchestratorInput): Promise<OrchestratorResult> {
    const { companyId, chatId, message, history, inboundProviderMessageId, sender, signal } = input;
    signal?.throwIfAborted();
    const companyMode = await this.agentRepo.getAutomatorMode(companyId);
    const conversationId = input.conversationId ?? await this.resolveConversationId(companyId, chatId);
    signal?.throwIfAborted();
    const routed = await this.routerService.route({
      companyId,
      chatId,
      message,
      history,
      companyMode,
      conversationId,
      inboundProviderMessageId,
      signal,
    });
    signal?.throwIfAborted();

    if (routed.routerMissing) {
      return this.emptyRouteResult(routed);
    }

    if (!routed.targetAgent) {
      return routed.route === 'handoff'
        ? this.handoffRouteResult(routed)
        : this.emptyRouteResult(routed);
    }

    const agent = routed.targetAgent;
    const domainKey = this.domainForRoute(routed.route);
    let sessionId: number | null = null;
    let turnId: number | null = null;

    if (agent.status !== 'active' || agent.mode === 'disabled') {
      await this.logger.logStage(
        this.buildContext(input, agent, companyMode, domainKey, conversationId, null, null),
        'routed_agent_unavailable',
        {
          status: 'skipped',
          summary: 'El agente seleccionado dejo de estar disponible antes de ejecutar el turno.',
          payload: { route: routed.route, targetAgentId: agent.id },
        }
      );
      return {
        routerMissing: false,
        route: 'handoff',
        agentId: agent.id,
        action: 'none',
        reply: '',
        confidence: 0,
        reason: 'routed_agent_unavailable',
        handoffTicketId: null,
        toolResults: [],
        rounds: 0,
      };
    }

    if (conversationId) {
      const started = await this.sessionService.startTurn({
        companyId,
        domainKey,
        conversationId,
        chatId,
        agentId: agent.id,
        inboundProviderMessageId,
        mode: agent.mode === 'auto' ? 'auto' : 'suggest',
        isTest: false,
      });
      sessionId = started.sessionId;
      turnId = started.turnId;
    }

    const ctx = this.buildContext(input, agent, companyMode, domainKey, conversationId, sessionId, turnId);
    await this.logger.logStage(ctx, 'multiagent_route_selected', {
      status: 'ok',
      summary: 'Router selecciono un agente especializado para el turno.',
      confidence: routed.confidence,
      payload: {
        route: routed.route,
        targetAgentId: agent.id,
        routerConfidence: routed.confidence,
        provider: agent.provider,
      },
    });

    const executor = new AgentToolExecutor(this.pool, this.registry, this.logger, sender);
    const loop = new AgentToolRuntimeLoop(this.pool, this.registry, this.logger, executor);
    const loopResult = await loop.run({ ctx, agent, message, history, companyMode, signal });
    signal?.throwIfAborted();

    const final = loopResult.final;
    if (!final) {
      const fallbackAction: OrchestratorResult['action'] = this.hasPersistedHandoffTicket(loopResult.handoffTicketId)
        ? 'handoff'
        : 'none';
      if (sessionId && turnId && conversationId) {
        await this.sessionService.completeTurn({
          companyId,
          sessionId,
          turnId,
          domainKey,
          conversationId,
          chatId,
          agentId: agent.id,
          status: 'failed',
          finalAction: fallbackAction,
          finalReply: '',
          commandCount: loopResult.toolResults.length,
          isTest: false,
        });
      }
      return {
        routerMissing: false,
        route: routed.route,
        agentId: agent.id,
        action: fallbackAction,
        reply: '',
        confidence: 0,
        reason: fallbackAction === 'handoff'
          ? loopResult.fallbackReason || 'loop_no_final'
          : 'handoff_ticket_missing',
        handoffTicketId: loopResult.handoffTicketId,
        toolResults: loopResult.toolResults.map((r) => ({ toolName: r.toolName, status: r.status })),
        rounds: loopResult.rounds,
        delivery: null,
      };
    }

    const handoffTicketMissing = final.action === 'handoff'
      && !this.hasPersistedHandoffTicket(loopResult.handoffTicketId);
    if (handoffTicketMissing) {
      await this.logger.logStage(ctx, 'handoff_ticket_missing', {
        status: 'failed',
        summary: 'El agente solicito handoff, pero no existe un ticket persistido; no se envia promesa al cliente.',
        payload: { requestedAction: final.action },
      });
    }
    const resolvedAction = handoffTicketMissing
      ? 'none'
      : this.resolveFinalAction(companyMode, agent.mode, final.action, final.reply);
    const resolvedReply = handoffTicketMissing ? '' : final.reply;
    const resolvedReason = handoffTicketMissing ? 'handoff_ticket_missing' : final.reason;

    signal?.throwIfAborted();
    if (sessionId && turnId && conversationId) {
      await this.sessionService.completeTurn({
        companyId,
        sessionId,
        turnId,
        domainKey,
        conversationId,
        chatId,
        agentId: agent.id,
        status: handoffTicketMissing ? 'failed' : 'ok',
        finalAction: resolvedAction,
        finalReply: resolvedReply,
        commandCount: loopResult.toolResults.length,
        isTest: false,
      });
      if (resolvedAction === 'handoff') {
        await this.sessionService.markSessionStatus({ companyId, sessionId, status: 'handoff', chatId, agentId: agent.id, domainKey });
      }
    }

    if (resolvedAction === 'suggest' && chatId) {
      emitDashboard('agent:suggestion', { companyId, chatId, agentId: agent.id, reply: resolvedReply, confidence: final.confidence, action: resolvedAction, reason: resolvedReason });
    }

    return {
      routerMissing: false,
      route: routed.route,
      agentId: agent.id,
      action: resolvedAction,
      reply: resolvedReply,
      confidence: final.confidence,
      reason: resolvedReason,
      handoffTicketId: loopResult.handoffTicketId,
      toolResults: loopResult.toolResults.map((r) => ({ toolName: r.toolName, status: r.status })),
      rounds: loopResult.rounds,
      delivery: handoffTicketMissing ? null : final.delivery || null,
    };
  }

  private resolveFinalAction(
    companyMode: AutomatorMode,
    agentMode: 'disabled' | 'suggest' | 'auto',
    action: OrchestratorResult['action'],
    reply: string
  ): OrchestratorResult['action'] {
    if (action === 'handoff' || action === 'block' || action === 'none') return action;
    if (!reply.trim()) return 'none';
    if (action === 'auto_reply' && companyMode === 'automator' && agentMode === 'auto') return 'auto_reply';
    return 'suggest';
  }

  private buildContext(
    input: OrchestratorInput,
    agent: AiAgent,
    companyMode: AutomatorMode,
    domainKey: AiDomainKey,
    conversationId: number | null,
    sessionId: number | null,
    turnId: number | null
  ): AgentToolContext {
    return {
      companyId: input.companyId,
      conversationId,
      chatId: input.chatId,
      domainKey,
      sessionId,
      turnId,
      agentId: agent.id,
      provider: agent.provider || 'opencode',
      agentPurpose: agent.purpose,
      companyMode,
      agentMode: agent.mode,
      moduleAccess: agent.moduleAccess,
      toolAccess: agent.toolAccess || {},
      catalogScope: agent.catalogScope || { catalogIds: [], sectionIds: [] },
      inboundProviderMessageId: input.inboundProviderMessageId,
      actorUserId: null,
      isTest: false,
    };
  }

  private domainForRoute(route: RouterRoute): AiDomainKey {
    if (route === 'inventory_stock') return 'inventory_stock';
    if (route === 'sales_assistant' || route === 'preorder') return 'commercial_catalog';
    if (route === 'order_tracking') return 'orders';
    if (route === 'customer_service' || route === 'support') return 'support';
    return 'gestion_web';
  }

  private emptyRouteResult(routed: RouterOutcome): OrchestratorResult {
    return {
      routerMissing: routed.routerMissing,
      route: routed.route,
      agentId: null,
      action: 'none',
      reply: '',
      confidence: routed.confidence,
      reason: routed.reason,
      handoffTicketId: routed.handoffTicketId,
      toolResults: [],
      rounds: 0,
    };
  }

  private handoffRouteResult(routed: RouterOutcome): OrchestratorResult {
    if (!this.hasPersistedHandoffTicket(routed.handoffTicketId)) {
      return {
        routerMissing: false,
        route: 'handoff',
        agentId: null,
        action: 'none',
        reply: '',
        confidence: 0,
        reason: 'handoff_ticket_missing',
        handoffTicketId: null,
        toolResults: [],
        rounds: 0,
      };
    }
    return {
      routerMissing: false,
      route: 'handoff',
      agentId: null,
      action: 'handoff',
      reply: 'Un asesor humano continuara contigo.',
      confidence: routed.confidence,
      reason: routed.reason,
      handoffTicketId: routed.handoffTicketId,
      toolResults: [],
      rounds: 0,
    };
  }

  private hasPersistedHandoffTicket(ticketId: number | null): boolean {
    return typeof ticketId === 'number' && Number.isInteger(ticketId) && ticketId > 0;
  }

  private async resolveConversationId(companyId: number, chatId: string): Promise<number | null> {
    const normalized = String(chatId).replace('@c.us', '').replace('@s.whatsapp.net', '').replace(/[^\d]/g, '');
    if (!normalized) return null;
    const result = await queryInTenantScope(this.pool, companyId,
      `SELECT id FROM conversations
       WHERE company_id = $1 AND channel = 'whatsapp'
         AND external_conversation_id = ANY($2::varchar[])
       ORDER BY last_message_at DESC NULLS LAST, id DESC LIMIT 1`,
      [companyId, [chatId, normalized, `${normalized}@c.us`, `${normalized}@s.whatsapp.net`].filter(Boolean)]
    );
    return result.rows[0]?.id ? Number(result.rows[0].id) : null;
  }
}

let instance: AiRuntimeOrchestrator | null = null;

export function getAiRuntimeOrchestrator(pool: Queryable): AiRuntimeOrchestrator {
  if (!instance) {
    const agentRepo = new AgentRepositoryPg(pool);
    const logRepo = new AgentRuntimeLogRepositoryPg(pool);
    const sessionRepo = new AiSessionRepositoryPg(pool);
    const sessionEventService = new AiSessionEventService(sessionRepo);
    const sessionService = new AiChatSessionService(sessionRepo, sessionEventService);
    const routerService = new AgentRouterService(pool, agentRepo, logRepo);
    const registry = getDefaultToolRegistry();
    const logger = new AgentToolLogger(logRepo, sessionEventService);
    instance = new AiRuntimeOrchestrator(pool, agentRepo, routerService, registry, logger, sessionService);
  }
  return instance;
}
