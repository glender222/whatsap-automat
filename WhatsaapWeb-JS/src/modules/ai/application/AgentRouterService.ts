import { queryInTenantScope } from '../../../db/TenantScopedUoW';
import { Queryable } from '../../../shared/UnitOfWorkPort';
import { AgentRepositoryPg } from '../infra/db/AgentRepositoryPg';
import { AgentRuntimeLogRepositoryPg } from '../infra/db/AgentRuntimeLogRepositoryPg';
import { getAiProviderFactory } from '../infra/provider/AiProviderFactory';
import type { AiProviderPort } from '../domain/provider.types';
import { getHandoffToolService } from './tools';
import type { AiAgent, AgentPurpose, AutomatorMode } from '../domain/agent.types';
import type { AiMessage } from '../domain/provider.types';
import { ROUTER_CONFIDENCE_THRESHOLD } from '../domain/tool.types';

export type RouterAgentSummary = {
  id: number;
  name: string;
  purpose: AgentPurpose;
  mode: AiAgent['mode'];
  moduleAccess: AiAgent['moduleAccess'];
  hasCatalogScope: boolean;
};

export type RouterInput = {
  companyId: number;
  chatId: string;
  message: string;
  history: Array<{ fromMe: boolean; body: string }>;
  companyMode: AutomatorMode;
  conversationId: number | null;
  inboundProviderMessageId: string | null;
};

export type RouterRoute =
  | 'customer_service'
  | 'sales_assistant'
  | 'support'
  | 'inventory_stock'
  | 'order_tracking'
  | 'preorder'
  | 'booking'
  | 'operations'
  | 'handoff'
  | 'none';

export type RouterOutcome = {
  route: RouterRoute;
  targetAgent: AiAgent | null;
  confidence: number;
  reason: string;
  handoffReason: string | null;
  handoffTicketId: number | null;
  routerMissing: boolean;
};

const ALLOWED_ROUTES: ReadonlySet<RouterRoute> = new Set<RouterRoute>([
  'customer_service',
  'sales_assistant',
  'support',
  'inventory_stock',
  'order_tracking',
  'preorder',
  'booking',
  'operations',
  'handoff',
  'none',
]);

function hasCatalogScope(agent: AiAgent): boolean {
  const scope = agent.catalogScope || { catalogIds: [], sectionIds: [] };
  return (scope.catalogIds || []).length > 0 || (scope.sectionIds || []).length > 0;
}

function clampConfidence(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function cleanJsonResponse(raw: string): string {
  return String(raw || '')
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();
}

export class AgentRouterService {
  constructor(
    private readonly pool: Queryable,
    private readonly agentRepo: AgentRepositoryPg,
    private readonly logRepo: AgentRuntimeLogRepositoryPg,
    private readonly providerFactory: { create: (name: string) => AiProviderPort } | null = null
  ) {}

  async route(input: RouterInput): Promise<RouterOutcome> {
    const router = await this.findActiveRouter(input.companyId);
    if (!router) {
      await this.logRepo.log({
        companyId: input.companyId,
        agentId: null,
        chatId: input.chatId,
        inboundProviderMessageId: input.inboundProviderMessageId,
        stage: 'router_missing',
        level: 'warn',
        status: 'skipped',
        summary: 'No hay agente router activo para enrutar la conversacion.',
        payload: {},
        provider: 'none',
      });
      return {
        route: 'none',
        targetAgent: null,
        confidence: 0,
        reason: 'router_missing',
        handoffReason: null,
        handoffTicketId: null,
        routerMissing: true,
      };
    }

    const availableAgents = await this.listAvailableAgents(input.companyId);
    let parsed: Awaited<ReturnType<AgentRouterService['callRouterLlm']>>;
    try {
      parsed = await this.callRouterLlm(router, input, availableAgents);
    } catch (error: unknown) {
      const providerError = error as { code?: unknown; providerStatusCode?: unknown };
      await this.logRepo.log({
        companyId: input.companyId,
        agentId: router.id,
        chatId: input.chatId,
        inboundProviderMessageId: input.inboundProviderMessageId,
        stage: 'router_provider_failed',
        level: 'error',
        status: 'failed',
        summary: 'El proveedor IA del router no pudo completar la clasificacion.',
        errorCode: typeof providerError.code === 'string' ? providerError.code : 'AI_PROVIDER_ERROR',
        payload: {
          providerStatusCode: typeof providerError.providerStatusCode === 'number'
            ? providerError.providerStatusCode
            : null,
        },
        provider: router.provider || 'opencode',
      });
      return await this.createSafetyHandoff(input, 'low_confidence', 'router_provider_failed');
    }
    const route = this.normalizeRoute(parsed.route);
    const confidence = clampConfidence(parsed.confidence);
    const reason = String(parsed.reason || '').trim();
    const handoffReason = parsed.handoffReason ? String(parsed.handoffReason).trim() : null;
    const targetAgentId = parsed.targetAgentId ? Number(parsed.targetAgentId) : null;

    await this.logRepo.log({
      companyId: input.companyId,
      agentId: router.id,
      chatId: input.chatId,
      inboundProviderMessageId: input.inboundProviderMessageId,
      stage: 'router_decision',
      level: 'info',
      status: 'ok',
      summary: `route=${route} confidence=${confidence.toFixed(2)} target=${targetAgentId ?? '-'}`,
      payload: { route, confidence, targetAgentId, availableAgents: availableAgents.length },
      confidence,
      provider: router.provider || 'opencode',
    });

    if (confidence < ROUTER_CONFIDENCE_THRESHOLD) {
      return await this.handleLowConfidence(input, availableAgents, reason || 'baja_confianza');
    }

    if (route === 'handoff' || route === 'none') {
      return await this.createSafetyHandoff(input, route === 'none' ? 'low_confidence' : handoffReason || 'other', reason);
    }

    const target = await this.resolveTargetAgentAsync(route, targetAgentId, availableAgents, input.companyId);
    if (!target) {
      return await this.createSafetyHandoff(input, 'sin_agente_disponible', `Ruta ${route} sin agente valido.`);
    }

    if (this.routeRequiresCatalog(route)) {
      if (target.moduleAccess?.catalog === false || !hasCatalogScope(target)) {
        return await this.createSafetyHandoff(input, 'sin_agente_disponible', 'Agente ventas sin scope catalogo.');
      }
    }

    return {
      route,
      targetAgent: target,
      confidence,
      reason,
      handoffReason: null,
      handoffTicketId: null,
      routerMissing: false,
    };
  }

  private async findActiveRouter(companyId: number): Promise<AiAgent | null> {
    const result = await queryInTenantScope(this.pool, companyId,
      `SELECT id FROM ai_agents
       WHERE company_id = $1 AND purpose = 'router' AND status = 'active' AND mode <> 'disabled'
       ORDER BY is_default DESC, updated_at DESC, id DESC
       LIMIT 1`,
      [companyId]
    );
    if (!result.rows[0]) return null;
    try {
      return await this.agentRepo.get(companyId, Number(result.rows[0].id));
    } catch {
      return null;
    }
  }

  private async listAvailableAgents(companyId: number): Promise<RouterAgentSummary[]> {
    const agents = await this.agentRepo.list(companyId);
    return agents
      .filter((a) => a.status === 'active' && a.mode !== 'disabled' && a.purpose !== 'router')
      .map((a) => ({
        id: a.id,
        name: a.name,
        purpose: a.purpose,
        mode: a.mode,
        moduleAccess: a.moduleAccess,
        hasCatalogScope: hasCatalogScope(a),
      }));
  }

  private async callRouterLlm(
    router: AiAgent,
    input: RouterInput,
    availableAgents: RouterAgentSummary[]
  ): Promise<{ route?: string; targetAgentId?: number | null; confidence?: number; reason?: string; handoffReason?: string | null }> {
    const system = this.buildRouterPrompt(input, availableAgents);
    const messages: AiMessage[] = [
      { role: 'system', content: system },
      {
        role: 'user',
        content: `Mensaje actual del cliente:\n${input.message}\n\nHistorial reciente:\n${input.history.map((h) => `${h.fromMe ? 'EMPRESA' : 'CLIENTE'}: ${h.body}`).join('\n') || '(sin historial)'}`,
      },
    ];
    const provider = (this.providerFactory ?? getAiProviderFactory()).create(router.provider || 'opencode');
    const raw = await provider.complete(messages, { model: String(router.model || '') });
    return this.parseRouterJson(raw, input, router.provider || 'opencode');
  }

  private buildRouterPrompt(input: RouterInput, availableAgents: RouterAgentSummary[]): string {
    const agentsJson = JSON.stringify(
      availableAgents.map((a) => ({
        id: a.id,
        name: a.name,
        purpose: a.purpose,
        mode: a.mode,
        moduleAccess: a.moduleAccess,
        hasCatalogScope: a.hasCatalogScope,
      }))
    );
    return [
      'Eres el agente ROUTER de una empresa por WhatsApp. Solo clasificas intencion y derivas a un agente especializado.',
      'No vendes, no recomiendas productos, no consultas catalogo, no procesas pagos.',
      'Debes devolver SIEMPRE JSON valido con esta forma exacta:',
      '{"route":"customer_service|sales_assistant|inventory_stock|order_tracking|preorder|handoff|none","targetAgentId":10,"confidence":0.82,"reason":"...","handoffReason":null}',
      'customer_service: consultas generales, atencion o soporte que no son ventas, stock ni pedidos.',
      'sales_assistant: informacion de productos, precios, promociones, recomendaciones o cotizaciones.',
      'inventory_stock: disponibilidad, existencias, stock, cupos o capacidad.',
      'order_tracking: estado, seguimiento, incidencia o consulta sobre un pedido ya existente.',
      'preorder: intencion explicita de comprar, armar, registrar o modificar un pedido o prepedido.',
      'handoff: el cliente pide una persona, hay cierre de pago, tema sensible o no existe agente compatible.',
      'route: distingue la intencion antes de elegir un agente. Si no hay agente valido, usa "handoff".',
      'targetAgentId: ID del agente disponible elegido, o null si no aplica.',
      'confidence: 0.0 a 1.0. Si < 0.70 el sistema derivara a soporte o handoff.',
      'handoffReason: motivo si route=handoff (payment_closure|customer_asks_human|product_not_found|low_confidence|stock_capacity|policy_restriction|support|other).',
      `Modo empresa actual: ${input.companyMode}`,
      `Agentes disponibles:\n${agentsJson}`,
    ].join('\n');
  }

  private async parseRouterJson(
    raw: string,
    input: RouterInput,
    providerName: string
  ): Promise<{ route?: string; targetAgentId?: number | null; confidence?: number; reason?: string; handoffReason?: string | null }> {
    const cleaned = cleanJsonResponse(raw);
    try {
      return JSON.parse(cleaned);
    } catch {
      // intentar reparar una vez: extraer primer objeto JSON
      const match = cleaned.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          return JSON.parse(match[0]);
        } catch {
          // falla reparacion
        }
      }
      await this.logRepo.log({
        companyId: input.companyId,
        chatId: input.chatId,
        inboundProviderMessageId: input.inboundProviderMessageId,
        stage: 'router_invalid_json',
        level: 'warn',
        status: 'failed',
        summary: 'Router devolvio JSON invalido tras intento de reparacion.',
        payload: {},
        provider: providerName,
      });
      return { route: 'none', targetAgentId: null, confidence: 0, reason: 'router_invalid_json', handoffReason: 'low_confidence' };
    }
  }

  private normalizeRoute(value: unknown): RouterRoute {
    const route = String(value || 'none').trim();
    if (ALLOWED_ROUTES.has(route as RouterRoute)) return route as RouterRoute;
    return 'none';
  }

  private async resolveTargetAgentAsync(
    route: RouterRoute,
    targetAgentId: number | null,
    availableAgents: RouterAgentSummary[],
    companyId: number
  ): Promise<AiAgent | null> {
    const purposes = this.purposesForRoute(route);
    const compatible = availableAgents.filter((agent) => {
      if (!purposes.includes(agent.purpose)) return false;
      if (!this.routeRequiresCatalog(route)) return true;
      return agent.moduleAccess?.catalog !== false && agent.hasCatalogScope;
    });
    const requested = targetAgentId
      ? compatible.find((agent) => agent.id === targetAgentId)
      : null;
    const ordered = [
      ...(requested ? [requested] : []),
      ...purposes.flatMap((purpose) => compatible.filter((agent) => agent.purpose === purpose)),
    ].filter((agent, index, agents) => agents.findIndex((candidate) => candidate.id === agent.id) === index);

    for (const candidate of ordered) {
      try {
        const agent = await this.agentRepo.get(companyId, candidate.id);
        if (
          this.routeRequiresCatalog(route)
          && (agent.moduleAccess?.catalog === false || !hasCatalogScope(agent))
        ) {
          continue;
        }
        return agent;
      } catch {
        // Intenta el siguiente agente compatible antes de crear un handoff.
      }
    }
    return null;
  }

  private purposesForRoute(route: RouterRoute): AgentPurpose[] {
    if (route === 'customer_service' || route === 'support') return ['support', 'general'];
    if (route === 'sales_assistant') return ['sales_assistant'];
    if (route === 'inventory_stock') return ['operations', 'sales_assistant'];
    if (route === 'order_tracking') return ['order_tracking', 'operations'];
    if (route === 'preorder') return ['sales_assistant', 'operations'];
    if (route === 'booking') return ['booking', 'operations'];
    if (route === 'operations') return ['operations'];
    return [];
  }

  private routeRequiresCatalog(route: RouterRoute): boolean {
    return route === 'sales_assistant' || route === 'inventory_stock' || route === 'preorder';
  }

  private async handleLowConfidence(input: RouterInput, availableAgents: RouterAgentSummary[], reason: string): Promise<RouterOutcome> {
    const support = availableAgents.find((a) => a.purpose === 'support');
    if (support) {
      try {
        const agent = await this.agentRepo.get(input.companyId, support.id);
        return {
          route: 'customer_service',
          targetAgent: agent,
          confidence: ROUTER_CONFIDENCE_THRESHOLD,
          reason: 'baja_confianza_enrutado_soporte',
          handoffReason: null,
          handoffTicketId: null,
          routerMissing: false,
        };
      } catch {
        // fall through to handoff
      }
    }
    return await this.createSafetyHandoff(input, 'low_confidence', reason || 'baja_confianza');
  }

  private async createSafetyHandoff(input: RouterInput, reason: string, summary: string): Promise<RouterOutcome> {
    let ticketId: number | null = null;
    try {
      const handoffService = getHandoffToolService(this.pool);
      const result = await handoffService.create(
        {
          companyId: input.companyId,
          conversationId: input.conversationId,
          chatId: input.chatId,
          agentId: null,
          agentPurpose: 'router' as AgentPurpose,
          companyMode: input.companyMode,
          agentMode: 'suggest',
          moduleAccess: { handoff: true },
          toolAccess: { handoffCreate: true },
          catalogScope: { catalogIds: [], sectionIds: [] },
          inboundProviderMessageId: input.inboundProviderMessageId,
          actorUserId: null,
        },
        { reason: this.mapHandoffReason(reason), priority: this.priorityForReason(reason), messageToCustomer: 'Un asesor continuara contigo.' }
      );
      if (result.status === 'ok' && result.output && typeof result.output === 'object') {
        const out = result.output as { ticketId?: number };
        ticketId = out.ticketId ?? null;
      }
    } catch {
      // best-effort
    }
    return {
      route: 'handoff',
      targetAgent: null,
      confidence: 0,
      reason: summary,
      handoffReason: reason,
      handoffTicketId: ticketId,
      routerMissing: false,
    };
  }

  private mapHandoffReason(reason: string): string {
    const allowed = ['payment_closure', 'customer_asks_human', 'product_not_found', 'low_confidence', 'stock_capacity', 'policy_restriction', 'support', 'other'];
    return allowed.includes(reason) ? reason : 'other';
  }

  private priorityForReason(reason: string): 'low' | 'medium' | 'high' {
    if (reason === 'payment_closure' || reason === 'customer_asks_human') return 'high';
    if (reason === 'low_confidence' || reason === 'product_not_found' || reason === 'stock_capacity') return 'medium';
    return 'medium';
  }
}

let instance: AgentRouterService | null = null;

export function getAgentRouterService(pool: Queryable): AgentRouterService {
  if (!instance) {
    instance = new AgentRouterService(pool, new AgentRepositoryPg(pool), new AgentRuntimeLogRepositoryPg(pool));
  }
  return instance;
}
