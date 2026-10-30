import { Queryable } from '../../../shared/UnitOfWorkPort';
import { AgentRuntimeLogRepositoryPg } from '../infra/db/AgentRuntimeLogRepositoryPg';
import { AiSessionEventService } from './AiSessionEventService';
import type {
  AgentToolContext,
  AgentToolLogPayload,
  AgentRuntimeLogToolInput,
  ToolCallResult,
  ToolName,
  ToolResultStatus,
} from '../domain/tool.types';

export class AgentToolLogger {
  constructor(
    private readonly logRepo: AgentRuntimeLogRepositoryPg,
    private readonly eventService?: AiSessionEventService | null
  ) {}

  async logToolStarted(
    ctx: AgentToolContext,
    call: { id: string; name: ToolName; input: Record<string, unknown> }
  ): Promise<void> {
    if (!this.eventService || !ctx.sessionId || !ctx.turnId || !ctx.conversationId || !ctx.chatId) return;
    const safeInput = this.summarizeInput(call.input);
    await this.eventService.record({
      companyId: ctx.companyId,
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      domainKey: ctx.domainKey || 'gestion_web',
      conversationId: ctx.conversationId,
      chatId: ctx.chatId,
      agentId: ctx.agentId,
      kind: this.eventKindForTool(call.name),
      title: `Ejecutando ${call.name}`,
      summary: 'Tool iniciada por el runtime IA.',
      status: 'running',
      toolName: call.name,
      toolCallId: call.id,
      input: safeInput,
      output: {},
      isTest: Boolean(ctx.isTest),
    });
  }

  async logToolCall(
    ctx: AgentToolContext,
    call: { id: string; name: ToolName; input: Record<string, unknown> },
    result: ToolCallResult,
    options: { stage?: string; summary?: string; confidence?: number | null } = {}
  ): Promise<void> {
    const safeInput = this.summarizeInput(call.input);
    const payload: AgentToolLogPayload = {
      toolCallId: call.id,
      toolName: call.name,
      input: safeInput,
      outputSummary: this.summarizeOutput(result.output),
      durationMs: result.durationMs,
      companyMode: ctx.companyMode,
      agentMode: ctx.agentMode,
      agentPurpose: ctx.agentPurpose,
      scope: {
        catalogIds: ctx.catalogScope.catalogIds,
        sectionIds: ctx.catalogScope.sectionIds,
      },
    };

    const input: AgentRuntimeLogToolInput = {
      companyId: ctx.companyId,
      agentId: ctx.agentId,
      chatId: ctx.chatId,
      inboundProviderMessageId: ctx.inboundProviderMessageId,
      stage: options.stage || this.stageForStatus(result.status),
      level: this.levelForStatus(result.status),
      status: this.statusForLog(result.status),
      summary: options.summary || `${call.name} -> ${result.status}`,
      payload,
      confidence: options.confidence ?? null,
      toolName: call.name,
      toolResultStatus: result.status,
      relatedOrderId: result.relatedOrderId ?? null,
      relatedHandoffId: result.relatedHandoffId ?? null,
      provider: ctx.provider || 'opencode',
    };

    await this.logRepo.log(input);

    if (this.eventService && ctx.sessionId && ctx.turnId && ctx.conversationId && ctx.chatId) {
      await this.eventService.record({
        companyId: ctx.companyId,
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        domainKey: ctx.domainKey || 'gestion_web',
        conversationId: ctx.conversationId,
        chatId: ctx.chatId,
        agentId: ctx.agentId,
        kind: this.eventKindForTool(call.name),
        title: `Se ejecuto ${call.name}`,
        summary: options.summary || `${call.name} -> ${result.status}`,
        status: this.eventStatusForResult(result.status),
        toolName: call.name,
        toolCallId: call.id,
        durationMs: result.durationMs,
        input: safeInput,
        output: this.summarizeOutput(result.output),
        relatedOrderId: result.relatedOrderId ?? null,
        relatedHandoffId: result.relatedHandoffId ?? null,
        isTest: Boolean(ctx.isTest),
      });
    }
  }

  async logStage(
    ctx: AgentToolContext,
    stage: string,
    options: {
      status?: 'ok' | 'skipped' | 'failed';
      summary?: string;
      payload?: Record<string, unknown>;
      confidence?: number | null;
      action?: import('../domain/runtime.types').AgentAction | null;
      toolName?: ToolName | null;
      toolResultStatus?: ToolResultStatus | null;
      relatedOrderId?: number | null;
      relatedHandoffId?: number | null;
    } = {}
  ): Promise<void> {
    await this.logRepo.log({
      companyId: ctx.companyId,
      agentId: ctx.agentId,
      chatId: ctx.chatId,
      inboundProviderMessageId: ctx.inboundProviderMessageId,
      stage,
      level: options.status === 'failed' ? 'error' : 'info',
      status: options.status || 'ok',
      summary: options.summary || '',
      payload: options.payload || {},
      confidence: options.confidence ?? null,
      action: options.action ?? null,
      toolName: options.toolName ?? null,
      toolResultStatus: options.toolResultStatus ?? null,
      relatedOrderId: options.relatedOrderId ?? null,
      relatedHandoffId: options.relatedHandoffId ?? null,
      provider: ctx.provider || 'opencode',
    });

    if (this.eventService && ctx.sessionId && ctx.turnId && ctx.conversationId && ctx.chatId) {
      await this.eventService.record({
        companyId: ctx.companyId,
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        domainKey: ctx.domainKey || 'gestion_web',
        conversationId: ctx.conversationId,
        chatId: ctx.chatId,
        agentId: ctx.agentId,
        kind: options.status === 'failed' ? 'error' : 'state',
        title: stage,
        summary: options.summary || '',
        status: options.status || 'ok',
        toolName: options.toolName || null,
        input: options.payload || {},
        output: {},
        relatedOrderId: options.relatedOrderId ?? null,
        relatedHandoffId: options.relatedHandoffId ?? null,
        isTest: Boolean(ctx.isTest),
      });
    }
  }

  private summarizeOutput(output: unknown): Record<string, unknown> {
    if (output && typeof output === 'object') {
      const obj = output as Record<string, unknown>;
      if (Array.isArray((obj as any).items)) {
        return { itemsCount: (obj as any).items.length, status: 'ok' };
      }
      if (Array.isArray((obj as any).alternatives)) {
        return { alternativesCount: (obj as any).alternatives.length, status: 'ok' };
      }
      if ('orderId' in obj) {
        return { orderId: obj.orderId, status: 'ok' };
      }
      if ('ticketId' in obj) {
        return { ticketId: obj.ticketId, status: 'ok' };
      }
      if ('available' in obj) {
        return { available: obj.available, status: 'ok' };
      }
      if ('sent' in obj) {
        return { sent: obj.sent, status: 'ok' };
      }
    }
    return { status: 'ok' };
  }

  private summarizeInput(input: Record<string, unknown>): Record<string, unknown> {
    const summary: Record<string, unknown> = {
      fields: Object.keys(input).sort().slice(0, 30),
    };
    const numericFields = ['commercialItemId', 'orderId', 'quantity', 'limit'];
    for (const field of numericFields) {
      const value = Number(input[field]);
      if (Number.isFinite(value)) summary[field] = value;
    }
    if (Array.isArray(input.items)) summary.itemsCount = input.items.length;
    if (typeof input.query === 'string') summary.queryLength = input.query.length;
    if (typeof input.messageToCustomer === 'string') {
      summary.hasMessageToCustomer = input.messageToCustomer.trim().length > 0;
    }
    if (typeof input.reason === 'string') summary.reason = input.reason.slice(0, 80);
    if (typeof input.priority === 'string') summary.priority = input.priority.slice(0, 20);
    if (typeof input.stage === 'string') summary.stage = input.stage.slice(0, 40);
    if (typeof input.substatus === 'string') summary.substatus = input.substatus.slice(0, 60);
    return summary;
  }

  private stageForStatus(status: ToolResultStatus): string {
    if (status === 'ok') return 'tool_executed';
    if (status === 'forbidden') return 'tool_forbidden';
    if (status === 'disabled_future_tool') return 'tool_future_disabled';
    if (status === 'not_found') return 'tool_not_found';
    if (status === 'scope_empty') return 'tool_scope_empty';
    if (status === 'permission_denied') return 'tool_permission_denied';
    if (status === 'invalid_input') return 'tool_invalid_input';
    return 'tool_failed';
  }

  private levelForStatus(status: ToolResultStatus): 'debug' | 'info' | 'warn' | 'error' {
    if (status === 'ok') return 'info';
    if (status === 'skipped') return 'debug';
    if (status === 'failed') return 'error';
    return 'warn';
  }

  private statusForLog(status: ToolResultStatus): 'ok' | 'skipped' | 'failed' {
    if (status === 'ok') return 'ok';
    if (status === 'skipped') return 'skipped';
    return 'failed';
  }

  private eventStatusForResult(status: ToolResultStatus): 'ok' | 'skipped' | 'failed' | 'forbidden' {
    if (status === 'ok') return 'ok';
    if (status === 'skipped') return 'skipped';
    if (status === 'forbidden' || status === 'permission_denied') return 'forbidden';
    return 'failed';
  }

  private eventKindForTool(name: ToolName): 'tool' | 'preorder' | 'handoff' | 'delivery' | 'state' {
    if (name === 'order.upsertPreorder') return 'preorder';
    if (name === 'handoff.create') return 'handoff';
    if (name === 'message.sendProductCard') return 'delivery';
    if (name === 'conversation.setCommercialState' || name === 'tag.applySystem') return 'state';
    return 'tool';
  }
}

let defaultLogger: AgentToolLogger | null = null;

export function getDefaultToolLogger(pool: Queryable): AgentToolLogger {
  if (!defaultLogger) {
    defaultLogger = new AgentToolLogger(new AgentRuntimeLogRepositoryPg(pool));
  }
  return defaultLogger;
}
