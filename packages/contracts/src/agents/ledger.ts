import { z } from 'zod';

/**
 * Status of Ledger Entry Records
 */
export const LEDGER_ENTRY_STATUSES = [
  'success',
  'failed',
  'timeout',
  'rate_limited',
  'budget_exhausted',
] as const;

export type LedgerEntryStatus = (typeof LEDGER_ENTRY_STATUSES)[number];
export const ledgerEntryStatusSchema = z.enum(LEDGER_ENTRY_STATUSES);
export const tokenLedgerStatusSchema = ledgerEntryStatusSchema;
export type TokenLedgerStatus = LedgerEntryStatus;

/**
 * AI Ledger Operation Categories
 */
export const LEDGER_OPERATIONS = [
  'completion',
  'embedding',
  'eval',
  'tool_reasoning',
] as const;

export type LedgerOperation = (typeof LEDGER_OPERATIONS)[number];
export const ledgerOperationSchema = z.enum(LEDGER_OPERATIONS);

/**
 * Actions when Tenant AI Quota Hard Limit is reached
 */
export const QUOTA_HARD_LIMIT_ACTIONS = [
  'block',
  'fallback_local',
  'warn',
] as const;

export type QuotaHardLimitAction = (typeof QUOTA_HARD_LIMIT_ACTIONS)[number];
export const quotaHardLimitActionSchema = z.enum(QUOTA_HARD_LIMIT_ACTIONS);

/**
 * Immutable AI Token & Cost Ledger Entry (Audit Event)
 * Specification: ADR-021, PROD-017, ROADMAP §F5
 */
export const tokenLedgerEntryV1Schema = z.object({
  id: z.union([z.string().min(1), z.number().int().positive()]).optional(),
  tenantId: z.union([z.string().min(1), z.number().int().positive()]),
  workspaceId: z.union([z.string().min(1), z.number().int().positive()]).nullish(),
  agentId: z.string().nullish(),
  agentRunId: z.string().nullish(),
  conversationId: z.union([z.string().min(1), z.number().int().positive()]).nullish(),
  provider: z.string().min(1),
  model: z.string().min(1),
  operation: ledgerOperationSchema.default('completion'),
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  costMicroUsd: z.number().int().nonnegative(),
  isByok: z.boolean().default(false),
  latencyMs: z.number().int().nonnegative().default(0),
  status: ledgerEntryStatusSchema.default('success'),
  metadataJson: z.record(z.unknown()).default({}),
  createdAt: z.string().datetime().optional(),
});

export type TokenLedgerEntryV1 = z.infer<typeof tokenLedgerEntryV1Schema>;

/**
 * Command to record a new entry in the accounting ledger
 */
export const createTokenLedgerEntryCommandV1Schema = z.object({
  tenantId: z.union([z.string().min(1), z.number().int().positive()]),
  workspaceId: z.union([z.string().min(1), z.number().int().positive()]).nullish(),
  agentId: z.string().nullish(),
  agentRunId: z.string().nullish(),
  conversationId: z.union([z.string().min(1), z.number().int().positive()]).nullish(),
  provider: z.string().min(1),
  model: z.string().min(1),
  operation: ledgerOperationSchema.default('completion'),
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  costMicroUsd: z.number().int().nonnegative(),
  isByok: z.boolean().default(false),
  latencyMs: z.number().int().nonnegative().default(0),
  status: ledgerEntryStatusSchema.default('success'),
  metadataJson: z.record(z.unknown()).default({}),
});

export type CreateTokenLedgerEntryCommandV1 = z.infer<typeof createTokenLedgerEntryCommandV1Schema>;

/**
 * Tenant Monthly Spending Quota & Ceilings
 */
export const tenantTokenQuotaV1Schema = z.object({
  tenantId: z.union([z.string().min(1), z.number().int().positive()]),
  monthlyCostLimitMicroUsd: z.number().int().nonnegative().default(100_000_000), // $100.00 USD
  monthlyTokenLimit: z.number().int().nonnegative().default(10_000_000),         // 10M tokens
  currentMonthCostMicroUsd: z.number().int().nonnegative().default(0),
  currentMonthTokensUsed: z.number().int().nonnegative().default(0),
  hardLimitEnabled: z.boolean().default(true),
  hardLimitAction: quotaHardLimitActionSchema.default('block'),
  periodStart: z.string().datetime(),
  resetAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
});

export type TenantTokenQuotaV1 = z.infer<typeof tenantTokenQuotaV1Schema>;

/**
 * Monthly Usage Summary returned by GET /api/v1/ai/usage/summary
 */
export const tenantUsageSummaryV1Schema = z.object({
  tenantId: z.union([z.string().min(1), z.number().int().positive()]).optional(),
  monthlyCostLimitMicroUsd: z.number().int().nonnegative(),
  currentMonthCostMicroUsd: z.number().int().nonnegative(),
  currentMonthCostUsd: z.string(), // Formatted decimal e.g. "12.45"
  monthlyTokenLimit: z.number().int().nonnegative(),
  currentMonthTokensUsed: z.number().int().nonnegative(),
  percentageCostUsed: z.number().nonnegative().optional(),
  percentageTokensUsed: z.number().nonnegative().optional(),
  percentageUsed: z.number().nonnegative().optional(),
  hardLimitEnabled: z.boolean(),
  periodStart: z.string().datetime(),
});

export type TenantUsageSummaryV1 = z.infer<typeof tenantUsageSummaryV1Schema>;
export const aiUsageSummaryResponseSchema = tenantUsageSummaryV1Schema;
export type AiUsageSummaryResponse = TenantUsageSummaryV1;

/**
 * Query Filter for Ledger Retrieval (GET /api/v1/ai/usage/ledger)
 */
export const tokenLedgerQueryV1Schema = z.object({
  cursor: z.union([z.string(), z.number()]).optional(),
  limit: z.number().int().positive().max(100).default(50),
  agentRunId: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
});

export type TokenLedgerQueryV1 = z.infer<typeof tokenLedgerQueryV1Schema>;

/**
 * Model Pricing Rate Card Entry
 * Rates are expressed in micro-USD per 1,000,000 tokens (1 USD = 1,000,000 micro-USD)
 */
export interface ModelRateCardEntry {
  readonly promptPerM: number;
  readonly completionPerM: number;
}

export const MODEL_RATE_CARDS: Readonly<Record<string, ModelRateCardEntry>> = {
  // OpenAI Models
  'gpt-4o': { promptPerM: 2500000, completionPerM: 10000000 },          // $2.50 / $10.00
  'gpt-4o-mini': { promptPerM: 150000, completionPerM: 600000 },        // $0.15 / $0.60
  'o3-mini': { promptPerM: 1100000, completionPerM: 4400000 },           // $1.10 / $4.40
  'text-embedding-3-small': { promptPerM: 20000, completionPerM: 0 },   // $0.02 / 1M
  'text-embedding-3-large': { promptPerM: 130000, completionPerM: 0 },  // $0.13 / 1M
  // Anthropic Models
  'claude-3-5-sonnet-20241022': { promptPerM: 3000000, completionPerM: 15000000 }, // $3.00 / $15.00
  'claude-3-5-haiku-20241022': { promptPerM: 800000, completionPerM: 4000000 },    // $0.80 / $4.00
  // Local Models (vLLM, Ollama)
  'local_openai': { promptPerM: 0, completionPerM: 0 },
  'nomic-embed-text': { promptPerM: 0, completionPerM: 0 },
};

export const DEFAULT_RATE_CARD: ModelRateCardEntry = {
  promptPerM: 2500000,
  completionPerM: 10000000,
};

/**
 * Deterministic integer cost calculation in micro-USD.
 * Eliminates floating-point rounding drift.
 */
export function calculateCostMicroUsd(
  model: string,
  promptTokens: number,
  completionTokens: number
): number {
  const rates = MODEL_RATE_CARDS[model] ?? DEFAULT_RATE_CARD;
  const p = Math.max(0, Math.floor(promptTokens));
  const c = Math.max(0, Math.floor(completionTokens));
  const promptCost = Math.round((p * rates.promptPerM) / 1000000);
  const completionCost = Math.round((c * rates.completionPerM) / 1000000);
  return promptCost + completionCost;
}

/**
 * Converts integer micro-USD to formatted USD decimal string.
 */
export function formatMicroUsdToUsd(costMicroUsd: number): string {
  return (Math.max(0, costMicroUsd) / 1000000).toFixed(2);
}
