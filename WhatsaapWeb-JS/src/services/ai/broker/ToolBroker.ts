import { createHash } from 'node:crypto';
import {
  ToolExecutionRequestV1,
  ToolExecutionResultV1,
  ToolRiskLevel,
  TOOL_BROKER_BUDGET_LIMITS,
} from '@whatsap-automat/contracts';
import { ToolRegistry } from './ToolRegistry';
import { HitlApprovalService } from './HitlApprovalService';
import { SsrfEgressGuard } from './SsrfEgressGuard';
import { EffectCache } from './EffectCache';
import { ConversationCasService } from '../../conversations/ConversationCasService';
import { TenantScopedUoW, tenantScopedUoW } from '../../../db/TenantScopedUoW';

export type BrokerEffectStore = Pick<EffectCache, 'claim' | 'complete' | 'markUnknown'>;

export interface ToolBrokerOptions {
  uow?: TenantScopedUoW;
  registry?: ToolRegistry;
  hitlService?: HitlApprovalService;
  casService?: ConversationCasService;
  ssrfGuard?: typeof SsrfEgressGuard;
  effectCache?: BrokerEffectStore;
}

export class ToolBroker {
  private readonly uow: TenantScopedUoW;
  private readonly registry: ToolRegistry;
  private readonly hitlService: HitlApprovalService;
  private readonly casService: ConversationCasService;
  private readonly ssrfGuard: typeof SsrfEgressGuard;
  private readonly effectCache: BrokerEffectStore;

  constructor(options: ToolBrokerOptions = {}) {
    this.uow = options.uow || tenantScopedUoW;
    this.registry = options.registry || new ToolRegistry(this.uow);
    this.hitlService = options.hitlService || new HitlApprovalService(this.uow);
    this.casService = options.casService || new ConversationCasService(this.uow);
    this.ssrfGuard = options.ssrfGuard || SsrfEgressGuard;
    this.effectCache = options.effectCache || new EffectCache(this.uow);
  }

  async execute(request: ToolExecutionRequestV1): Promise<ToolExecutionResultV1> {
    const startTime = Date.now();
    const tenantIdNum = Number(request.tenantId);

    // =========================================================================
    // STEP 1: Schema Validation of Tool Input Arguments
    // =========================================================================
    const tool = await this.registry.getTool(tenantIdNum, request.toolName);
    if (!tool) {
      return {
        success: false,
        status: 'failed',
        output: null,
        error: {
          code: 'TOOL_NOT_FOUND',
          message: `Tool '${request.toolName}' is not registered or active for tenant ${tenantIdNum}`,
        },
        durationMs: Date.now() - startTime,
        riskLevel: 'destructive', // Fail-secure
        hitlRequired: false,
        approvalId: null,
        effectKey: null,
      };
    }

    const validation = tool.validateInput(request.input);
    if (!validation.valid) {
      return {
        success: false,
        status: 'failed',
        output: null,
        error: {
          code: 'VALIDATION_ERROR',
          message: `Tool '${request.toolName}' input validation failed`,
          details: validation.errors,
        },
        durationMs: Date.now() - startTime,
        riskLevel: tool.definition.riskLevel,
        hitlRequired: false,
        approvalId: null,
        effectKey: null,
      };
    }

    // =========================================================================
    // STEP 2: RBAC Authorization (agent_tool_grants & Actor Roles)
    // =========================================================================
    const isAuthorized = await this.checkAuthorization(tenantIdNum, request, tool.definition.requiredRoles);
    if (!isAuthorized.granted) {
      return {
        success: false,
        status: 'unauthorized',
        output: null,
        error: {
          code: isAuthorized.code || 'FORBIDDEN',
          message: isAuthorized.message || 'Unauthorized tool invocation',
        },
        durationMs: Date.now() - startTime,
        riskLevel: tool.definition.riskLevel,
        hitlRequired: false,
        approvalId: null,
        effectKey: null,
      };
    }

    // =========================================================================
    // STEP 3: Operational Limits (Step & Token Budget Failsafe)
    // =========================================================================
    const currentStep = request.currentStep ?? 1;
    const currentTokens = request.currentTokensUsed ?? 0;
    if (
      currentStep > TOOL_BROKER_BUDGET_LIMITS.MAX_STEPS_PER_RUN ||
      currentTokens >= TOOL_BROKER_BUDGET_LIMITS.MAX_MODEL_TOKENS_PER_RUN
    ) {
      return {
        success: false,
        status: 'budget_exhausted',
        output: null,
        error: {
          code: 'BUDGET_EXHAUSTED',
          message: `Operational limit exceeded: steps=${currentStep}/${TOOL_BROKER_BUDGET_LIMITS.MAX_STEPS_PER_RUN}, tokens=${currentTokens}/${TOOL_BROKER_BUDGET_LIMITS.MAX_MODEL_TOKENS_PER_RUN}`,
        },
        durationMs: Date.now() - startTime,
        riskLevel: tool.definition.riskLevel,
        hitlRequired: false,
        approvalId: null,
        effectKey: null,
      };
    }

    // =========================================================================
    // STEP 4: Risk Categorization & Idempotency Key Determination
    // =========================================================================
    const riskLevel: ToolRiskLevel = tool.definition.riskLevel;
    const proposedActionHash = this.computeActionHash(request);
    const effectKey = request.effectKey || this.generateEffectKey(
      tenantIdNum,
      request.runId,
      request.toolName,
      proposedActionHash
    );

    // =========================================================================
    // STEP 5: HITL Approvals for 'financial' or 'destructive' Risk
    // =========================================================================
    if (riskLevel === 'financial' || riskLevel === 'destructive' || tool.definition.requiresApproval) {
      const reservation = await this.hitlService.reserveEffectApproval({
        tenantId: tenantIdNum,
        runId: request.runId,
        agentGraphId: request.agentGraphId,
        nodeId: 'nodeId' in request && typeof request.nodeId === 'string' ? request.nodeId : 'tool_call',
        toolName: request.toolName,
        effectKey,
        proposedActionHash,
        risk: riskLevel,
        inputPayload: request.input,
        conversationId: request.conversationId ? Number(request.conversationId) : undefined,
        expectedConversationVersion: request.expectedConversationVersion,
      });

      if (reservation.kind === 'conflict') {
        return {
          success: false,
          status: 'unauthorized',
          output: null,
          error: { code: 'APPROVAL_EFFECT_CONFLICT', message: 'Historical approvals for this effect require review' },
          durationMs: Date.now() - startTime,
          riskLevel,
          hitlRequired: true,
          approvalId: null,
          effectKey,
        };
      }

      const { approval: existingApproval } = reservation;
      if (existingApproval.proposedActionHash !== proposedActionHash || existingApproval.runId !== request.runId ||
          existingApproval.details?.toolName !== request.toolName || existingApproval.risk !== riskLevel) {
        return {
          success: false,
          status: 'unauthorized',
          output: null,
          error: { code: 'APPROVAL_ACTION_MISMATCH', message: 'Approval is bound to a different action, run or risk' },
          durationMs: Date.now() - startTime,
          riskLevel,
          hitlRequired: true,
          approvalId: null,
          effectKey,
        };
      }

      if (existingApproval.status === 'expired' || Date.parse(existingApproval.expiresAt) <= Date.now()) {
        return {
          success: false,
          status: 'rejected',
          output: null,
          error: { code: 'APPROVAL_EXPIRED', message: 'Approval expired before the action was executed' },
          durationMs: Date.now() - startTime,
          riskLevel,
          hitlRequired: false,
          approvalId: existingApproval.id,
          effectKey,
        };
      }

      if (existingApproval.status === 'pending') {
        const created = reservation.kind === 'created';
        return {
          success: false,
          status: 'awaiting_approval',
          output: null,
          error: {
            code: created ? 'HITL_REQUIRED' : 'HITL_PENDING',
            message: `Execution awaits supervisor approval (Approval ID: ${existingApproval.id})`,
          },
          durationMs: Date.now() - startTime,
          riskLevel,
          hitlRequired: true,
          approvalId: existingApproval.id,
          effectKey,
        };
      }

      if (existingApproval.status !== 'approved') {
        return {
          success: false,
          status: 'rejected',
          output: null,
          error: {
            code: 'APPROVAL_REJECTED',
            message: `Human supervisor rejected execution: ${existingApproval.details?.summary || 'Rejected'}`,
          },
          durationMs: Date.now() - startTime,
          riskLevel,
          hitlRequired: false,
          approvalId: existingApproval.id,
          effectKey,
        };
      }

      // If existingApproval.status === 'approved', execution is allowed to proceed
    }

    // =========================================================================
    // STEP 6: CAS Anti-Takeover Fencing for 'send' Risk
    // =========================================================================
    if (riskLevel === 'send' || tool.definition.requiresCasFencing) {
      const convId = request.conversationId || request.input.conversationId;
      if (!convId) {
        return {
          success: false,
          status: 'failed',
          output: null,
          error: {
            code: 'MISSING_CONVERSATION_ID',
            message: `Tool '${request.toolName}' with 'send' risk requires conversationId for CAS fencing`,
          },
          durationMs: Date.now() - startTime,
          riskLevel,
          hitlRequired: false,
          approvalId: null,
          effectKey,
        };
      }

      const convState = await this.casService.getConversationState({
        tenantId: tenantIdNum,
        conversationId: convId as any,
      });

      if (!convState) {
        return {
          success: false,
          status: 'failed',
          output: null,
          error: {
            code: 'CONVERSATION_NOT_FOUND',
            message: `Conversation ${convId} not found in tenant ${tenantIdNum}`,
          },
          durationMs: Date.now() - startTime,
          riskLevel,
          hitlRequired: false,
          approvalId: null,
          effectKey,
        };
      }

      // Check human takeover active status
      if (convState.aiPaused || convState.ownerType === 'human') {
        return {
          success: false,
          status: 'cas_conflict',
          output: null,
          error: {
            code: 'HUMAN_TAKEOVER_ACTIVE',
            message: `Outbound send blocked: conversation is currently controlled by human operator (${convState.ownerId || 'human'}) or AI is paused`,
          },
          durationMs: Date.now() - startTime,
          riskLevel,
          hitlRequired: false,
          approvalId: null,
          effectKey,
        };
      }

      // Check expectedConversationVersion if specified
      if (
        request.expectedConversationVersion !== undefined &&
        convState.version !== request.expectedConversationVersion
      ) {
        return {
          success: false,
          status: 'cas_conflict',
          output: null,
          error: {
            code: 'CONCURRENCY_CONFLICT',
            message: `CAS version mismatch on conversation ${convId}: expected version ${request.expectedConversationVersion}, but current version is ${convState.version}`,
          },
          durationMs: Date.now() - startTime,
          riskLevel,
          hitlRequired: false,
          approvalId: null,
          effectKey,
        };
      }
    }

    // =========================================================================
    // STEP 7: Route External Egress through SsrfEgressGuard
    // =========================================================================
    if (tool.definition.isEgressNetworkTool) {
      const targetUrl = String(request.input.url || '');
      const ssrfCheck = await this.ssrfGuard.validateUrl(targetUrl);
      if (!ssrfCheck.safe) {
        return {
          success: false,
          status: 'ssrf_blocked',
          output: null,
          error: {
            code: 'SSRF_BLOCKED',
            message: `SSRF Violation: Target URL '${targetUrl}' is prohibited (${ssrfCheck.reason})`,
          },
          durationMs: Date.now() - startTime,
          riskLevel,
          hitlRequired: false,
          approvalId: null,
          effectKey,
        };
      }
    }

    // =========================================================================
    // STEP 8: Commit an exclusive effect claim before invoking a mutative tool.
    // =========================================================================
    const effectFailure = (code: string, message: string): ToolExecutionResultV1 => ({
      success: false, status: 'failed', output: null, error: { code, message },
      durationMs: Date.now() - startTime, riskLevel, hitlRequired: false, approvalId: null, effectKey,
    });
    let claimToken: string | undefined;
    if (riskLevel !== 'read') {
      let claim;
      try {
        claim = await this.effectCache.claim(tenantIdNum, effectKey, {
          runId: request.runId, toolName: request.toolName, actionHash: proposedActionHash,
        }, tool.definition.timeoutMs);
      } catch {
        return effectFailure('EFFECT_STORE_UNAVAILABLE', 'The durable effect claim could not be confirmed; no tool was dispatched.');
      }
      if (claim.kind === 'cached') {
        return {
          success: true,
          status: 'cached',
          output: claim.record.output,
          durationMs: Date.now() - startTime,
          riskLevel,
          hitlRequired: false,
          approvalId: null,
          effectKey,
        };
      }
      if (claim.kind === 'conflict') {
        return effectFailure('EFFECT_KEY_CONFLICT', 'This effect key is bound to a different action or run.');
      }
      if (claim.kind === 'unbound') {
        return effectFailure('EFFECT_LEGACY_UNBOUND', 'A historical result exists without a verified action binding; inspect it before proceeding.');
      }
      if (claim.kind === 'in_progress') {
        return effectFailure('EFFECT_IN_PROGRESS', 'The effect has already been claimed and its outcome is not confirmed yet; no additional tool was dispatched.');
      }
      if (claim.kind === 'unknown') {
        return effectFailure('EFFECT_OUTCOME_UNKNOWN', 'The previous effect outcome is uncertain and requires reconciliation; it will not be dispatched again.');
      }
      claimToken = claim.token;
    }

    // Execute physical tool implementation with timeout protection
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const output = await Promise.race([
        tool.execute(request.input, {
          tenantId: tenantIdNum,
          agentGraphId: request.agentGraphId,
          runId: request.runId,
          actorId: request.actorId,
          actorRoles: request.actorRoles || [],
          conversationId: request.conversationId,
          expectedConversationVersion: request.expectedConversationVersion,
        }),
        new Promise((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error(`Tool execution timed out after ${tool.definition.timeoutMs}ms`)),
            tool.definition.timeoutMs
          );
        }),
      ]);

      if (claimToken) await this.effectCache.complete(tenantIdNum, effectKey, claimToken, output);

      return {
        success: true,
        status: 'executed',
        output,
        durationMs: Date.now() - startTime,
        riskLevel,
        hitlRequired: false,
        approvalId: null,
        effectKey,
      };
    } catch (err: any) {
      if (claimToken) {
        // A timeout does not cancel the tool; neither a thrown error nor a lost
        // persistence acknowledgement proves the physical effect did not happen.
        try { await this.effectCache.markUnknown(tenantIdNum, effectKey, claimToken); } catch {
          // The committed claim still fences retries even if this diagnostic update fails.
        }
        return effectFailure('EFFECT_OUTCOME_UNKNOWN', 'The tool outcome could not be confirmed durably; reconcile the existing effect before proceeding.');
      }
      return {
        success: false,
        status: 'failed',
        output: null,
        error: {
          code: err.code || 'EXECUTION_FAILED',
          message: err.message || 'Tool execution encountered an internal error',
        },
        durationMs: Date.now() - startTime,
        riskLevel,
        hitlRequired: false,
        approvalId: null,
        effectKey,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async checkAuthorization(
    tenantId: number,
    request: ToolExecutionRequestV1,
    requiredRoles: string[]
  ): Promise<{ granted: boolean; code?: string; message?: string }> {
    try {
      return await this.uow.run(tenantId, async (client) => {
        // 1. Check if tool is granted to tenant / agent
        const grantRes = await client.query(
          `SELECT is_enabled, required_roles
           FROM agent_tool_grants
           WHERE tenant_id = $1 AND tool_name = $2
             AND (agent_graph_id IS NULL OR agent_graph_id = $3)
           ORDER BY (agent_graph_id IS NOT NULL) DESC, is_enabled ASC
           LIMIT 1`,
          [tenantId, request.toolName, request.agentGraphId]
        );

        // If no grant row found in database, check default role requirements
        if (grantRes.rowCount === 0) {
          const actorRoles = (request.actorRoles || []).map((r) => r.toLowerCase());
          const reqRoles = requiredRoles.map((r) => r.toLowerCase());
          const hasRole = reqRoles.some((r) => actorRoles.includes(r));
          if (!hasRole) {
            return {
              granted: false,
              code: 'FORBIDDEN',
              message: `Actor lacking required role. Tool requires one of: [${requiredRoles.join(', ')}]`,
            };
          }
          return { granted: true };
        }

        const grant = grantRes.rows[0];
        if (!grant.is_enabled) {
          return {
            granted: false,
            code: 'TOOL_DISABLED',
            message: `Tool '${request.toolName}' has been disabled by tenant administration`,
          };
        }

        const effectiveRoles = grant.required_roles?.length > 0 ? grant.required_roles : requiredRoles;
        const actorRoles = (request.actorRoles || []).map((r: string) => r.toLowerCase());
        const effectiveRolesLower = effectiveRoles.map((r: string) => r.toLowerCase());
        const hasRole = effectiveRolesLower.some((r: string) => actorRoles.includes(r));

        if (!hasRole) {
          return {
            granted: false,
            code: 'FORBIDDEN',
            message: `Actor lacking required role. Tool grant requires one of: [${effectiveRoles.join(', ')}]`,
          };
        }

        return { granted: true };
      });
    } catch {
      return { granted: false, code: 'GRANTS_UNAVAILABLE', message: 'Tool permissions could not be verified' };
    }
  }

  private computeActionHash(request: ToolExecutionRequestV1): string {
    const action = {
      toolName: request.toolName,
      graphId: request.agentGraphId,
      conversationId: request.conversationId,
      expectedConversationVersion: request.expectedConversationVersion,
      input: request.input,
    };
    const serialized = JSON.stringify(action, (_key, value: unknown) => {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
      const entries = Object.entries(value);
      entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
      return Object.fromEntries(entries);
    });
    return createHash('sha256').update(serialized).digest('hex');
  }

  private generateEffectKey(
    tenantId: number,
    runId: string,
    toolName: string,
    actionHash: string
  ): string {
    return `eff_${tenantId}_${runId.slice(0, 8)}_${toolName.replace(/[^a-zA-Z0-9]/g, '_')}_${actionHash.slice(0, 16)}`;
  }
}
