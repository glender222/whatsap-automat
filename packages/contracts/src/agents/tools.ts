import { z } from 'zod';
import { createHash } from 'node:crypto';
import { ModelToolDefinitionV1 } from './models';

/**
 * Canonical 5-Tier Tool Risk Taxonomy
 * Phase F5: PR-F5-02 (WAA-012, SEC-007, ADR-012)
 *
 * Tier 1: 'read'        - Safe query operations without internal/external mutations (e.g. catalog.search)
 * Tier 2: 'write'       - Internal state mutations within tenant boundary (e.g. tag.apply, draft_order.create)
 * Tier 3: 'send'        - Outbound messaging to customers, requiring CAS anti-takeover fencing (e.g. message.send)
 * Tier 4: 'financial'   - Monetary side-effects requiring mandatory human approval (e.g. payment.create_link)
 * Tier 5: 'destructive' - Irreversible operations requiring mandatory human approval (e.g. contact.purge, order.cancel)
 */
export const TOOL_RISK_LEVELS = [
  'read',
  'write',
  'send',
  'financial',
  'destructive',
] as const;

export type ToolRiskLevel = (typeof TOOL_RISK_LEVELS)[number];
export const toolRiskLevelSchema = z.enum(TOOL_RISK_LEVELS);

/**
 * Execution Statuses of Tool Invocations
 */
export const TOOL_EXECUTION_STATUSES = [
  'executed',
  'awaiting_approval',
  'rejected',
  'failed',
  'cached',
  'cas_conflict',
  'ssrf_blocked',
  'unauthorized',
  'budget_exhausted',
] as const;

export type ToolExecutionStatus = (typeof TOOL_EXECUTION_STATUSES)[number];
export const toolExecutionStatusSchema = z.enum(TOOL_EXECUTION_STATUSES);

/**
 * Operational Failsafe & Budget Limits (ADR-012, ROADMAP §F5)
 */
export const TOOL_BROKER_BUDGET_LIMITS = {
  MAX_STEPS_PER_RUN: 15,
  MAX_MODEL_TOKENS_PER_RUN: 4000,
  ABSOLUTE_MAX_STEPS: 50,
  ABSOLUTE_MAX_MODEL_TOKENS: 32000,
  DEFAULT_STEP_TIMEOUT_MS: 10_000,
  MAX_STEP_TIMEOUT_MS: 60_000,
} as const;

export const agentBudgetLimitsV1Schema = z.object({
  maxSteps: z
    .number()
    .int()
    .positive()
    .max(TOOL_BROKER_BUDGET_LIMITS.ABSOLUTE_MAX_STEPS)
    .default(TOOL_BROKER_BUDGET_LIMITS.MAX_STEPS_PER_RUN),
  maxModelTokens: z
    .number()
    .int()
    .positive()
    .max(TOOL_BROKER_BUDGET_LIMITS.ABSOLUTE_MAX_MODEL_TOKENS)
    .default(TOOL_BROKER_BUDGET_LIMITS.MAX_MODEL_TOKENS_PER_RUN),
  maxDurationSeconds: z.number().int().positive().default(60),
  maxCostMicroUsd: z.number().int().positive().default(100_000),
});

export type AgentBudgetLimitsV1 = z.infer<typeof agentBudgetLimitsV1Schema>;

/**
 * Tool Definition Contract (ToolRegistry & Security Barrier)
 */
export const toolDefinitionV1Schema = z.object({
  schemaVersion: z.literal(1).default(1),
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(
      /^[a-zA-Z0-9_.-]+$/,
      'Tool name must only contain alphanumeric characters, underscores, dots, or hyphens'
    ),
  description: z.string().min(1).max(1024),
  riskLevel: toolRiskLevelSchema,
  requiredRoles: z.array(z.string().min(1)).min(1, 'Tool requires at least one authorized role'),
  parameters: z.record(z.unknown()).default({}),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(TOOL_BROKER_BUDGET_LIMITS.MAX_STEP_TIMEOUT_MS)
    .default(TOOL_BROKER_BUDGET_LIMITS.DEFAULT_STEP_TIMEOUT_MS),
  requiresApproval: z.boolean().optional(),
  requiresCasFencing: z.boolean().optional(),
  isEgressNetworkTool: z.boolean().default(false),
  idempotent: z.boolean().optional(),
});

export type ToolDefinitionV1 = z.infer<typeof toolDefinitionV1Schema>;

/**
 * Regex for standard Effect Idempotency Keys: 8-128 alphanumeric characters with _:.-
 */
export const EFFECT_KEY_REGEX = /^[a-zA-Z0-9_.:-]{8,128}$/;

/**
 * Tool Execution Request Contract (Submitted to ToolBroker.execute)
 */
export const toolExecutionRequestV1Schema = z.object({
  tenantId: z.union([z.string().min(1), z.number().int().positive()]),
  agentGraphId: z.string().min(1),
  runId: z.string().min(1),
  toolName: z.string().min(1),
  input: z.record(z.unknown()).default({}),
  expectedConversationVersion: z.number().int().nonnegative().optional(),
  actorRoles: z.array(z.string().min(1)).default([]),
  actorId: z.string().optional(),
  conversationId: z.union([z.string().min(1), z.number().int().positive()]).optional(),
  effectKey: z
    .string()
    .regex(EFFECT_KEY_REGEX, 'Effect key must be 8-128 alphanumeric characters with _:.-')
    .optional(),
  currentStep: z.number().int().nonnegative().default(1),
  currentTokensUsed: z.number().int().nonnegative().default(0),
});

export type ToolExecutionRequestV1 = z.infer<typeof toolExecutionRequestV1Schema>;

/**
 * Tool Execution Result Contract (Returned by ToolBroker.execute)
 */
export const toolExecutionResultV1Schema = z.object({
  success: z.boolean(),
  status: toolExecutionStatusSchema,
  output: z.unknown().nullable().default(null),
  error: z
    .object({
      code: z.string().min(1),
      message: z.string().min(1),
      details: z.unknown().optional(),
    })
    .optional(),
  durationMs: z.number().int().nonnegative(),
  riskLevel: toolRiskLevelSchema,
  hitlRequired: z.boolean().default(false),
  approvalId: z.string().nullable().default(null),
  effectKey: z.string().nullable().default(null),
});

export type ToolExecutionResultV1 = z.infer<typeof toolExecutionResultV1Schema>;

// ============================================================================
// Helper Functions & Security Predicates
// ============================================================================

/**
 * Determines whether the specified risk level requires Human-In-The-Loop (HITL) approval.
 * Hard rule (ADR-012): 'financial' and 'destructive' ALWAYS require approval.
 */
export function isHitlRequired(riskLevel: ToolRiskLevel): boolean {
  return riskLevel === 'financial' || riskLevel === 'destructive';
}

/**
 * Determines whether the specified risk level is mutative and requires an effect idempotency key.
 * Hard rule (ADR-0008, ADR-012): Any non-read tool ('write', 'send', 'financial', 'destructive') is mutative.
 */
export function isMutativeTool(riskLevel: ToolRiskLevel): boolean {
  return riskLevel !== 'read';
}

/**
 * Determines whether the specified risk level requires CAS anti-takeover conversation fencing.
 * Hard rule (ADR-012): 'send' actions transmitting outbound messages to end-users must verify conversation version.
 */
export function requiresCasFencing(riskLevel: ToolRiskLevel): boolean {
  return riskLevel === 'send';
}

/**
 * Validates operational limits and triggers budget exhaustion if thresholds are breached.
 */
export function checkBudgetExhausted(
  currentSteps: number,
  currentTokens: number,
  limits: Partial<AgentBudgetLimitsV1> = {}
): { isExhausted: boolean; reason?: 'steps_exhausted' | 'tokens_exhausted' } {
  const maxSteps = limits.maxSteps ?? TOOL_BROKER_BUDGET_LIMITS.MAX_STEPS_PER_RUN;
  const maxTokens = limits.maxModelTokens ?? TOOL_BROKER_BUDGET_LIMITS.MAX_MODEL_TOKENS_PER_RUN;

  if (currentSteps >= maxSteps) {
    return { isExhausted: true, reason: 'steps_exhausted' };
  }
  if (currentTokens >= maxTokens) {
    return { isExhausted: true, reason: 'tokens_exhausted' };
  }
  return { isExhausted: false };
}

/**
 * Validates execution request against risk constraints:
 * - Mutative tools must supply an effectKey.
 * - Outbound 'send' tools must supply expectedConversationVersion.
 */
export function validateToolExecutionRequest(
  request: ToolExecutionRequestV1,
  toolRiskLevel: ToolRiskLevel
): { valid: boolean; error?: string } {
  if (isMutativeTool(toolRiskLevel)) {
    if (!request.effectKey || request.effectKey.trim().length === 0) {
      return {
        valid: false,
        error: `Mutative tool '${request.toolName}' with risk level '${toolRiskLevel}' requires a valid effectKey for idempotency.`,
      };
    }
  }

  if (requiresCasFencing(toolRiskLevel)) {
    if (request.expectedConversationVersion === undefined || request.expectedConversationVersion === null) {
      return {
        valid: false,
        error: `Outbound send tool '${request.toolName}' requires expectedConversationVersion for CAS anti-takeover fencing.`,
      };
    }
  }

  return { valid: true };
}

/**
 * Computes a deterministic effect idempotency key for mutative tools.
 */
export function computeEffectKey(
  tenantId: string | number,
  runId: string,
  toolName: string,
  step: number,
  input: Record<string, unknown>
): string {
  const serializedInput = JSON.stringify(input, Object.keys(input).sort());
  const hash = createHash('sha256')
    .update(`${tenantId}:${runId}:${toolName}:${step}:${serializedInput}`)
    .digest('hex')
    .slice(0, 16);
  const sanitizedTool = toolName.replace(/[^a-zA-Z0-9]/g, '_');
  return `eff_${sanitizedTool}_step${step}_${hash}`;
}

/**
 * Converts a canonical ToolDefinitionV1 to a provider-neutral ModelToolDefinitionV1 for LLM prompts.
 */
export function toModelToolDefinition(tool: ToolDefinitionV1): ModelToolDefinitionV1 {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  };
}
