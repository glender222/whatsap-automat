import { Queryable } from '../../../shared/UnitOfWorkPort';
import { AgentToolExecutor } from './AgentToolExecutor';
import { AgentToolLogger } from './AgentToolLogger';
import { AgentToolRegistry } from './AgentToolRegistry';
import { getHandoffToolService } from './tools';
import { getAiProviderFactory } from '../infra/provider/AiProviderFactory';
import { emitDashboard, emitConversation } from '../../../sockets/socketEmitter';
import type { AiAgent, AutomatorMode } from '../domain/agent.types';
import type {
  AgentToolContext,
  ToolCallRequest,
  ToolCallResult,
  ToolFinalResponse,
  ToolRequest,
} from '../domain/tool.types';
import type { AgentAction } from '../domain/runtime.types';
import {
  MAX_CATALOG_ITEMS_PER_TOOL,
  MAX_TOOL_CALLS_PER_MESSAGE,
  MAX_TOOL_ROUNDS,
  MATCH_CONFIDENCE_THRESHOLD,
} from '../domain/tool.types';

export type RuntimeLoopResult = {
  final: ToolFinalResponse | null;
  handoffTicketId: number | null;
  toolResults: ToolCallResult[];
  rounds: number;
  fallbackReason: string | null;
};

type RuntimeLoopInput = {
  ctx: AgentToolContext;
  agent: AiAgent;
  message: string;
  history: Array<{ fromMe: boolean; body: string }>;
  companyMode: AutomatorMode;
};

function cleanJsonResponse(raw: string): string {
  return String(raw || '')
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();
}

function tryParseJson(raw: string): { ok: true; value: any } | { ok: false } {
  const cleaned = cleanJsonResponse(raw);
  try {
    return { ok: true, value: JSON.parse(cleaned) };
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return { ok: true, value: JSON.parse(match[0]) };
      } catch {
        return { ok: false };
      }
    }
    return { ok: false };
  }
}

export class AgentToolRuntimeLoop {
  constructor(
    private readonly pool: Queryable,
    private readonly registry: AgentToolRegistry,
    private readonly logger: AgentToolLogger,
    private readonly executor: AgentToolExecutor
  ) {}

  async run(input: RuntimeLoopInput): Promise<RuntimeLoopResult> {
    const { ctx, agent, message, history } = input;
    const toolResults: ToolCallResult[] = [];
    const sessionItemConfidence = new Map<number, number>();
    let totalCalls = 0;
    let rounds = 0;
    let repairUsed = false;
    let finalReviewUsed = false;
    let handoffTicketId: number | null = null;

    const system = this.buildAgentPrompt(agent, ctx, input.companyMode);
    const conversation: Array<{ role: 'system' | 'user' | 'assistant' | 'tool'; content: string }> = [
      { role: 'system', content: system },
      {
        role: 'user',
        content: `Historial reciente:\n${history.map((h) => `${h.fromMe ? 'EMPRESA' : 'CLIENTE'}: ${h.body}`).join('\n') || '(sin historial)'}\n\nMensaje actual del cliente:\n${message}`,
      },
    ];

    while (rounds < MAX_TOOL_ROUNDS && totalCalls < MAX_TOOL_CALLS_PER_MESSAGE) {
      rounds++;
      const provider = getAiProviderFactory().create(agent.provider || 'opencode');
      if (ctx.chatId) emitConversation(ctx.companyId, ctx.chatId, 'agent:typing', { chatId: ctx.chatId, agentId: agent.id });

      const raw = await provider.complete(conversation as any, { model: String(agent.model || '') });
      const parsed = tryParseJson(raw);

      if (!parsed.ok) {
        if (!repairUsed) {
          repairUsed = true;
          conversation.push({ role: 'assistant', content: raw || '' });
          conversation.push({
            role: 'user',
            content: 'Tu respuesta anterior no es JSON valido. Devuelve SOLO JSON valido con tool_request o final.',
          });
          continue;
        }
        await this.logger.logStage(ctx, 'loop_invalid_json', { status: 'failed', summary: 'JSON invalido tras reparacion. Fallback handoff.' });
        return await this.fallbackHandoff(ctx, 'low_confidence', 'Respuesta IA no es JSON valido tras reparacion.');
      }

      const value = parsed.value;

      if (value && value.type === 'tool_request' && Array.isArray(value.toolCalls)) {
        conversation.push({ role: 'assistant', content: JSON.stringify(value) });
        const toolRequest = value as ToolRequest;
        const callsThisRound = Math.min(toolRequest.toolCalls.length, MAX_TOOL_CALLS_PER_MESSAGE - totalCalls);
        for (let i = 0; i < callsThisRound; i++) {
          const call = this.normalizeToolCall(toolRequest.toolCalls[i]);
          totalCalls++;
          const result = await this.executor.execute(ctx, call);
          toolResults.push(result);
          if (call.name === 'handoff.create' && result.relatedHandoffId) {
            handoffTicketId = result.relatedHandoffId;
          }
          this.trackItemConfidence(call, result, sessionItemConfidence);
          conversation.push({
            role: 'tool',
            content: JSON.stringify({ toolCallId: result.toolCallId, toolName: result.toolName, status: result.status, output: result.output }),
          });
        }
        continue;
      }

      if (value && value.type === 'final') {
        const finalResponse = this.normalizeFinal(value);
        const adjusted = this.applyMatchConfidenceGuard(finalResponse, sessionItemConfidence);
        if (this.shouldReviewFinalDecision(adjusted, toolResults.length, finalReviewUsed)) {
          finalReviewUsed = true;
          conversation.push({ role: 'assistant', content: JSON.stringify(value) });
          conversation.push({
            role: 'user',
            content: [
              'Revisa semanticamente tu decision antes de finalizar.',
              'Si el cliente esta pidiendo que lo atienda una persona del equipo, un asesor humano, soporte humano, vendedor o empleado, debes usar tool_request con handoff.create reason="customer_asks_human" priority="high".',
              'Si el cliente quiere pagar, cerrar compra o necesita intervencion humana por venta, usa el flujo de prepedido + handoff indicado en el sistema.',
              'Si tu decision anterior sigue siendo correcta, devuelve final. Responde SOLO JSON valido.',
            ].join('\n'),
          });
          continue;
        }
        if (ctx.chatId) {
          emitConversation(ctx.companyId, ctx.chatId, 'agent:final', { chatId: ctx.chatId, agentId: agent.id, action: adjusted.action, confidence: adjusted.confidence });
        }
        emitDashboard('agent:final', { companyId: ctx.companyId, chatId: ctx.chatId, agentId: agent.id, action: adjusted.action, confidence: adjusted.confidence });
        return { final: adjusted, handoffTicketId, toolResults, rounds, fallbackReason: null };
      }

      // tipo desconocido
      conversation.push({
        role: 'user',
        content: 'Formato no reconocido. Devuelve JSON con type="tool_request" o type="final".',
      });
    }

    await this.logger.logStage(ctx, 'loop_limit_reached', { status: 'skipped', summary: `Loop termino por limite (rounds=${rounds}, calls=${totalCalls}).` });
    return await this.fallbackHandoff(ctx, 'low_confidence', 'Loop alcanzo limite sin respuesta final.');
  }

  private buildAgentPrompt(agent: AiAgent, ctx: AgentToolContext, companyMode: AutomatorMode): string {
    const profile = agent.profile;
    const rules = agent.rules;
    const toolSchemas = this.registry.schemasForPrompt();
    const disabledTools = this.registry.listDisabled().map((t) => t.name);

    const modeLine =
      companyMode === 'automator'
        ? 'Modo AUTOMATICO. Puedes usar tools seguras (read + write + send) pero NUNCA confirmar venta, reservar stock, validar pago ni cerrar cobro. Si cliente quiere pagar, usa order.upsertPreorder con pending_handoff + handoff.create.'
        : companyMode === 'mixed'
          ? 'Modo ASISTIDO. Solo tools read-only. NO enviar WhatsApp, NO crear prepedido, NO crear handoff. Emite sugerencia al humano via action="suggest".'
          : 'Modo MANUAL. Solo sugieres respuestas; el humano envia. No ejecutas tools write/send.';

    return [
      'Eres un agente especializado de atencion por WhatsApp. Respondes SOLO sobre la empresa, productos, servicios, precios, politicas y soporte.',
      'No inventes informacion. Si falta o hay riesgo, deriva a humano.',
      'Solo puedes recomendar productos que vengan de las tools catalog.search o catalog.getItem. Nunca inventes productos, precios, stock ni imagenes.',
      'Si catalogScope esta vacio, no puedes ver productos.',
      'Debes responder SIEMPRE con JSON valido de uno de dos tipos:',
      '1) tool_request: {"type":"tool_request","toolCalls":[{"id":"call_1","name":"...","input":{...}}]}',
      '2) final: {"type":"final","reply":"...","action":"auto_reply|suggest|handoff|block","confidence":0.0,"reason":"...","detectedOrder":{"intent":"quote|purchase|confirm|question|cancel|unknown|none","customerConfirmed":false,"items":[{"commercialItemId":123,"quantity":1}],"recommendedAction":"quote|create_draft|handoff|ask_clarification"},"delivery":{"productCards":[{"commercialItemId":123,"caption":"..."}]}}',
      `Tools disponibles (schemas): ${JSON.stringify(toolSchemas)}`,
      disabledTools.length ? `Tools futuras desactivadas (NO usar): ${disabledTools.join(', ')}` : '',
      'Prohibido: confirmar venta, reservar stock/cupo, validar pago, cancelar pago, marcar pedido completado.',
      'Intencion de handoff humano: si semanticamente el cliente pide atencion por una persona del equipo, asesor humano, soporte humano, vendedor, empleado o representante, usa handoff.create con reason="customer_asks_human", priority="high", y responde que un asesor humano continuara. Nunca devuelvas action="none" ni una respuesta normal para esa intencion.',
      'Si el cliente quiere pagar/cerrar compra: usa order.upsertPreorder con status="pending_handoff", luego handoff.create con reason="payment_closure", tag.applySystem con "handoff-pendiente", conversation.setCommercialState a handoff/handoff_pending, y responde que un asesor continuara.',
      `Limite: max ${MAX_TOOL_ROUNDS} rondas, ${MAX_TOOL_CALLS_PER_MESSAGE} tool calls, ${MAX_CATALOG_ITEMS_PER_TOOL} items catalogo por tool.`,
      `Para recomendar/enviar ficha de un producto, el matchConfidence debe ser >= ${MATCH_CONFIDENCE_THRESHOLD}. Si es menor o hay varios matches, pide aclaracion o sugiere 1 opcion.`,
      modeLine,
      `Proposito: ${agent.purpose}`,
      `Modulos: ${JSON.stringify(agent.moduleAccess)}`,
      `Tools flags: ${JSON.stringify(agent.toolAccess)}`,
      `Alcance catalogo: ${JSON.stringify(agent.catalogScope)}`,
      `Empresa: ${profile?.businessDescription || ''}`,
      `Como hablar: ${profile?.communicationStyle || ''}`,
      `Que vender: ${profile?.sellingScope || ''}`,
      `Que no decir: ${profile?.forbiddenClaims || ''}`,
      `Idioma: ${profile?.language || 'es'}`,
      `Tono: ${profile?.tone || ''}`,
      `Confianza minima: ${rules?.confidenceThreshold ?? 0.75}`,
    ].filter(Boolean).join('\n');
  }

  private normalizeToolCall(call: any): ToolCallRequest {
    return {
      id: String(call?.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
      name: String(call?.name || '') as ToolCallRequest['name'],
      input: (call?.input && typeof call.input === 'object' ? call.input : {}) as Record<string, unknown>,
    };
  }

  private normalizeFinal(value: any): ToolFinalResponse {
    const action = (['auto_reply', 'suggest', 'handoff', 'block'].includes(String(value?.action)) ? value.action : 'suggest') as ToolFinalResponse['action'];
    const confidence = Math.max(0, Math.min(1, Number(value?.confidence ?? 0.5)));
    const detectedOrder = value?.detectedOrder && typeof value.detectedOrder === 'object' ? value.detectedOrder : null;
    return {
      type: 'final',
      reply: String(value?.reply || '').trim(),
      action,
      confidence,
      reason: String(value?.reason || '').trim(),
      detectedOrder,
      delivery: value?.delivery && typeof value.delivery === 'object'
        ? {
            productCards: Array.isArray(value.delivery.productCards)
              ? value.delivery.productCards
                  .map((item: any) => ({
                    commercialItemId: Number(item?.commercialItemId || 0),
                    caption: item?.caption ? String(item.caption) : undefined,
                  }))
                  .filter((item: any) => item.commercialItemId > 0)
                  .slice(0, 1)
              : [],
          }
        : null,
    };
  }

  private trackItemConfidence(call: ToolCallRequest, result: ToolCallResult, session: Map<number, number>): void {
    const output = result.output as any;
    if (!output || typeof output !== 'object') return;
    if (Array.isArray(output.items)) {
      for (const item of output.items) {
        if (item && typeof item.id === 'number') {
          const prev = session.get(item.id) ?? 0;
          const score = Number(item.matchConfidence ?? 0);
          if (score > prev) session.set(item.id, score);
        }
      }
    }
    if (output.item && typeof output.item.id === 'number') {
      const id = output.item.id;
      const prev = session.get(id) ?? 0;
      if (prev < 1) session.set(id, 1);
    }
    if (Array.isArray(output.alternatives)) {
      for (const alt of output.alternatives) {
        if (alt && typeof alt.id === 'number') {
          const prev = session.get(alt.id) ?? 0;
          if (prev < 0.6) session.set(alt.id, 0.6);
        }
      }
    }
  }

  private applyMatchConfidenceGuard(final: ToolFinalResponse, session: Map<number, number>): ToolFinalResponse {
    const items = final.detectedOrder?.items || [];
    if (items.length === 0) return final;
    const hasLowMatch = items.some((item) => {
      const conf = session.get(Number(item.commercialItemId)) ?? 0;
      return conf < MATCH_CONFIDENCE_THRESHOLD;
    });
    if (hasLowMatch && final.action === 'auto_reply') {
      return {
        ...final,
        action: 'suggest',
        reason: `Match confidence < ${MATCH_CONFIDENCE_THRESHOLD}; se requiere aclaracion o validacion humana. ${final.reason}`.trim(),
      };
    }
    return final;
  }

  private shouldReviewFinalDecision(final: ToolFinalResponse, toolResultCount: number, reviewUsed: boolean): boolean {
    if (reviewUsed) return false;
    if (toolResultCount > 0) return false;
    if (final.action === 'handoff' || final.action === 'block') return false;
    return final.confidence < 0.9 || !final.reply.trim();
  }

  private async fallbackHandoff(ctx: AgentToolContext, reason: string, summary: string): Promise<RuntimeLoopResult> {
    let ticketId: number | null = null;
    try {
      if (ctx.moduleAccess?.handoff !== false && ctx.toolAccess?.handoffCreate !== false && ctx.chatId) {
        const handoffService = getHandoffToolService(this.pool);
        const result = await handoffService.create(ctx, { reason, priority: 'medium', messageToCustomer: 'Un asesor continuara contigo.' });
        if (result.status === 'ok' && result.output && typeof result.output === 'object') {
          ticketId = (result.output as { ticketId?: number }).ticketId ?? null;
        }
      }
    } catch {
      // best-effort
    }
    const fallback: ToolFinalResponse = {
      type: 'final',
      reply: '',
      action: 'handoff' as AgentAction,
      confidence: 0,
      reason: summary,
      detectedOrder: null,
    };
    return { final: fallback, handoffTicketId: ticketId, toolResults: [], rounds: 0, fallbackReason: summary };
  }
}
