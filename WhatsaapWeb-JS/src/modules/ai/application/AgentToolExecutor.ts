import { Queryable } from '../../../shared/UnitOfWorkPort';
import { AgentToolRegistry } from './AgentToolRegistry';
import { AgentToolLogger } from './AgentToolLogger';
import {
  getAvailabilityToolService,
  getCommercialCatalogToolService,
  getCommercialStateToolService,
  getHandoffToolService,
  createMessageSendProductCardToolService,
  getPreorderToolService,
  getSystemTagToolService,
  MessageSendProductCardToolService,
  ProductCardSender,
} from './tools';
import type {
  AgentToolContext,
  ToolCallRequest,
  ToolCallResult,
  ToolExecutorOutcome,
  ToolName,
  ToolResultStatus,
} from '../domain/tool.types';
import { TOOL_EXECUTION_ERROR_CODE } from '../domain/tool.types';
import type { AgentModuleAccess, AgentToolAccess } from '../domain/agent.types';

const READ_TOOLS: ReadonlySet<ToolName> = new Set<ToolName>([
  'catalog.search',
  'catalog.getItem',
  'catalog.recommendAlternatives',
  'availability.check',
]);

const WRITE_TOOLS: ReadonlySet<ToolName> = new Set<ToolName>([
  'order.upsertPreorder',
  'handoff.create',
  'conversation.setCommercialState',
  'tag.applySystem',
]);

const SEND_TOOLS: ReadonlySet<ToolName> = new Set<ToolName>(['message.sendProductCard']);

const PAYMENT_INTENT_TOOL: ToolName = 'payment.createLink';

function hasModule(moduleAccess: AgentModuleAccess | undefined, key: keyof AgentModuleAccess): boolean {
  return Boolean(moduleAccess && moduleAccess[key] !== false);
}

function hasTool(toolAccess: AgentToolAccess | undefined, key: keyof AgentToolAccess): boolean {
  return Boolean(toolAccess && toolAccess[key] !== false);
}

export class AgentToolExecutor {
  private readonly messageToolService: MessageSendProductCardToolService | null;

  constructor(
    private readonly pool: Queryable,
    private readonly registry: AgentToolRegistry,
    private readonly logger: AgentToolLogger,
    sender?: ProductCardSender
  ) {
    this.messageToolService = sender ? createMessageSendProductCardToolService(pool, sender) : null;
  }

  async execute(ctx: AgentToolContext, call: ToolCallRequest, signal?: AbortSignal): Promise<ToolCallResult> {
    signal?.throwIfAborted();
    const startedAt = Date.now();
    const definition = this.registry.get(call.name);

    if (!definition) {
      return this.finalize(ctx, call, { status: 'not_found', output: { reason: 'tool_not_registered' } }, startedAt);
    }
    try {
      await this.logger.logToolStarted(ctx, { id: call.id, name: call.name, input: call.input || {} });
    } catch {
      // logging best-effort
    }
    if (definition.systemOnly) {
      return this.finalize(ctx, call, { status: 'forbidden', output: { reason: 'system_only_tool' } }, startedAt);
    }
    if (definition.disabled || definition.kind === 'payment_future') {
      const outcome: ToolExecutorOutcome = { status: 'disabled_future_tool', output: { reason: 'future_tool_disabled' } };
      const result = await this.finalize(ctx, call, outcome, startedAt);
      if (definition.kind === 'payment_future' && call.name !== 'handoff.create' && ctx.chatId && this.isPaymentClosureIntent(call)) {
        await this.execute(ctx, {
          id: `${call.id}:handoff`,
          name: 'handoff.create',
          input: { reason: 'payment_closure', priority: 'high', messageToCustomer: 'Un asesor continuara contigo para cerrar el pago.' },
        }, signal);
      }
      return result;
    }

    const modeError = this.validateMode(ctx, call.name);
    if (modeError) {
      return this.finalize(ctx, call, { status: modeError, output: { reason: 'mode_blocked' } }, startedAt);
    }

    if (definition.requiresModule && !hasModule(ctx.moduleAccess, definition.requiresModule)) {
      return this.finalize(ctx, call, { status: 'permission_denied', output: { reason: 'module_access_missing', module: definition.requiresModule } }, startedAt);
    }
    if (definition.requiresToolFlag && !hasTool(ctx.toolAccess, definition.requiresToolFlag)) {
      return this.finalize(ctx, call, { status: 'permission_denied', output: { reason: 'tool_flag_missing', flag: definition.requiresToolFlag } }, startedAt);
    }

    if (ctx.isTest && (WRITE_TOOLS.has(call.name) || SEND_TOOLS.has(call.name))) {
      return this.finalize(
        ctx,
        call,
        {
          status: 'ok',
          output: {
            dryRun: true,
            reason: 'sandbox_no_mutation',
            toolName: call.name,
            input: call.input || {},
          },
        },
        startedAt
      );
    }

    signal?.throwIfAborted();
    let outcome: ToolExecutorOutcome;
    try {
      outcome = await this.dispatch(ctx, call);
    } catch {
      outcome = {
        status: 'failed',
        output: { reason: 'execution_error', errorCode: TOOL_EXECUTION_ERROR_CODE },
      };
    }

    return this.finalize(ctx, call, outcome, startedAt);
  }

  private validateMode(ctx: AgentToolContext, name: ToolName): ToolResultStatus | null {
    if (ctx.companyMode === 'normal') {
      return 'permission_denied';
    }
    if (ctx.agentMode === 'disabled') {
      return 'permission_denied';
    }
    if (ctx.companyMode === 'mixed') {
      if (WRITE_TOOLS.has(name) || SEND_TOOLS.has(name)) {
        return 'forbidden';
      }
    }
    if (ctx.companyMode === 'automator') {
      if (ctx.agentMode !== 'auto' && (WRITE_TOOLS.has(name) || SEND_TOOLS.has(name))) {
        return 'forbidden';
      }
    }
    return null;
  }

  private async dispatch(ctx: AgentToolContext, call: ToolCallRequest): Promise<ToolExecutorOutcome> {
    const input = (call.input || {}) as Record<string, unknown>;
    switch (call.name) {
      case 'catalog.search':
        return getCommercialCatalogToolService(this.pool).search(ctx, input as any);
      case 'catalog.getItem':
        return getCommercialCatalogToolService(this.pool).getItem(ctx, input as any);
      case 'catalog.recommendAlternatives':
        return getCommercialCatalogToolService(this.pool).recommendAlternatives(ctx, input as any);
      case 'availability.check':
        return getAvailabilityToolService(this.pool).check(ctx, input as any);
      case 'message.sendProductCard': {
        if (!this.messageToolService) return { status: 'failed', output: { sent: false, reason: 'sender_not_configured' } };
        return this.messageToolService.send(ctx, input as any);
      }
      case 'order.upsertPreorder':
        return getPreorderToolService(this.pool).upsertPreorder(ctx, input as any);
      case 'handoff.create':
        return getHandoffToolService(this.pool).create(ctx, input as any);
      case 'conversation.setCommercialState':
        return getCommercialStateToolService(this.pool).setState(ctx, input as any);
      case 'tag.applySystem':
        return getSystemTagToolService(this.pool).apply(ctx, input as any);
      default:
        return { status: 'not_found', output: { reason: 'tool_not_implemented' } };
    }
  }

  private isPaymentClosureIntent(call: ToolCallRequest): boolean {
    return call.name === PAYMENT_INTENT_TOOL || /pay|pago|payment|compr|confirm/i.test(JSON.stringify(call.input || {}));
  }

  private async finalize(
    ctx: AgentToolContext,
    call: ToolCallRequest,
    outcome: ToolExecutorOutcome,
    startedAt: number
  ): Promise<ToolCallResult> {
    const durationMs = Date.now() - startedAt;
    const result: ToolCallResult = {
      toolCallId: call.id,
      toolName: call.name,
      status: outcome.status,
      output: outcome.output,
      durationMs,
      relatedOrderId: outcome.relatedOrderId ?? null,
      relatedHandoffId: outcome.relatedHandoffId ?? null,
    };
    try {
      await this.logger.logToolCall(ctx, { id: call.id, name: call.name, input: call.input || {} }, result);
    } catch {
      // logging best-effort
    }
    return result;
  }
}
