import { z } from 'zod';

/**
 * Supported LLM Providers for ModelGateway
 * Phase F5: PR-F5-01 (WAA-012, PROD-009, ADR-011)
 */
export const MODEL_PROVIDERS = [
  'openai',
  'anthropic',
  'local_openai',
] as const;

export type ModelProvider = (typeof MODEL_PROVIDERS)[number];
export const modelProviderSchema = z.enum(MODEL_PROVIDERS);

/**
 * Normalized Model Message Roles
 */
export const MODEL_MESSAGE_ROLES = [
  'system',
  'user',
  'assistant',
  'tool',
] as const;

export type ModelMessageRole = (typeof MODEL_MESSAGE_ROLES)[number];
export const modelMessageRoleSchema = z.enum(MODEL_MESSAGE_ROLES);

/**
 * Model Completion Finish Reasons
 */
export const FINISH_REASONS = [
  'stop',
  'tool_calls',
  'length',
  'content_filter',
  'error',
] as const;

export type FinishReason = (typeof FINISH_REASONS)[number];
export const finishReasonSchema = z.enum(FINISH_REASONS);
export const modelFinishReasonSchema = finishReasonSchema;
export type ModelFinishReason = FinishReason;

/**
 * Normalized Model Message Contract
 */
export const modelMessageV1Schema = z.object({
  role: modelMessageRoleSchema,
  content: z.string(),
  name: z.string().optional(),
  toolCallId: z.string().optional(),
});

export type ModelMessageV1 = z.infer<typeof modelMessageV1Schema>;
export const modelMessageSchema = modelMessageV1Schema;
export type ModelMessage = ModelMessageV1;

/**
 * Model Tool Parameter Definition (JSONSchema compliant)
 */
export const modelToolDefinitionV1Schema = z.object({
  name: z.string().min(1).regex(/^[a-zA-Z0-9_.-]+$/, 'Tool name must contain alphanumeric characters, underscores, dots, or hyphens'),
  description: z.string().min(1),
  parameters: z.record(z.string(), z.unknown()).default({}),
});

export type ModelToolDefinitionV1 = z.infer<typeof modelToolDefinitionV1Schema>;
export const modelToolDefinitionSchema = modelToolDefinitionV1Schema;
export type ModelToolDefinition = ModelToolDefinitionV1;

/**
 * Model Tool Call (LLM intent output)
 */
export const modelToolCallV1Schema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()).default({}),
});

export type ModelToolCallV1 = z.infer<typeof modelToolCallV1Schema>;
export const modelToolCallSchema = modelToolCallV1Schema;
export type ModelToolCall = ModelToolCallV1;

/**
 * Model Token Usage Accounting
 */
export const modelTokenUsageV1Schema = z.object({
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
});

export type ModelTokenUsageV1 = z.infer<typeof modelTokenUsageV1Schema>;
export const modelUsageSchema = modelTokenUsageV1Schema;
export type ModelUsage = ModelTokenUsageV1;

/**
 * Provider-Neutral Model Gateway Completion Request
 */
export const modelCompletionRequestV1Schema = z.object({
  schemaVersion: z.literal(1).default(1),
  tenantId: z.union([z.string().min(1), z.number().int().positive()]),
  workspaceId: z.union([z.string().min(1), z.number().int().positive()]).nullish(),
  agentRunId: z.string().nullish(),
  conversationId: z.union([z.string().min(1), z.number().int().positive()]).nullish(),
  provider: modelProviderSchema,
  model: z.string().min(1),
  messages: z.array(modelMessageV1Schema).min(1, 'At least one message is required'),
  tools: z.array(modelToolDefinitionV1Schema).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
});

export type ModelCompletionRequestV1 = z.infer<typeof modelCompletionRequestV1Schema>;
export const modelGatewayRequestSchema = modelCompletionRequestV1Schema;
export type ModelGatewayRequest = ModelCompletionRequestV1;

/**
 * Provider-Neutral Model Gateway Completion Result
 */
export const modelCompletionResultV1Schema = z.object({
  text: z.string().nullable(),
  toolCalls: z.array(modelToolCallV1Schema).default([]),
  usage: modelTokenUsageV1Schema,
  costMicroUsd: z.number().int().nonnegative(),
  provider: z.string().min(1),
  model: z.string().min(1),
  finishReason: finishReasonSchema,
  latencyMs: z.number().int().nonnegative(),
});

export type ModelCompletionResultV1 = z.infer<typeof modelCompletionResultV1Schema>;
export const modelCompletionResultSchema = modelCompletionResultV1Schema;
export type ModelCompletionResult = ModelCompletionResultV1;

/**
 * BYOK Provider Credential Entity (Database / Internal Storage)
 * Encrypted with AES-256-GCM format: v1:<iv>:<tag>:<ciphertext>
 */
export const byokCredentialV1Schema = z.object({
  id: z.union([z.string().min(1), z.number().int().positive()]).optional(),
  tenantId: z.union([z.string().min(1), z.number().int().positive()]),
  provider: modelProviderSchema,
  encryptedApiKey: z.string().regex(/^v1:[A-Za-z0-9+/=_-]+:[A-Za-z0-9+/=_-]+:[A-Za-z0-9+/=_-]+$/, 'Encrypted key must match AES-256-GCM format v1:<iv>:<tag>:<ciphertext>').nullish(),
  keyFingerprint: z.string().min(4).max(64).nullish(),
  baseUrl: z.string().url('Must be a valid HTTP/HTTPS URL').nullish(),
  defaultModel: z.string().nullish(),
  isActive: z.boolean().default(true),
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
});

export type ByokCredentialV1 = z.infer<typeof byokCredentialV1Schema>;
export const byokCredentialSchema = byokCredentialV1Schema;

/**
 * Safe BYOK Credential Summary for Client UI (GET /api/v1/ai/providers)
 * Guaranteed zero secret leakage (no plaintext or encrypted keys returned)
 */
export const byokCredentialSummaryV1Schema = z.object({
  tenantId: z.union([z.string().min(1), z.number().int().positive()]).optional(),
  provider: modelProviderSchema,
  isConfigured: z.boolean(),
  keyFingerprint: z.string().nullable(),
  baseUrl: z.string().nullable(),
  defaultModel: z.string().nullable(),
  isActive: z.boolean(),
});

export type ByokCredentialSummaryV1 = z.infer<typeof byokCredentialSummaryV1Schema>;

/**
 * Command to Register or Update BYOK Credentials (POST /api/v1/ai/providers)
 */
export const registerByokCredentialCommandV1Schema = z.object({
  provider: modelProviderSchema,
  apiKey: z.string().min(8, 'API Key must be at least 8 characters').optional(),
  baseUrl: z.string().url('Base URL must be a valid HTTP/HTTPS URL').nullish(),
  defaultModel: z.string().min(1).nullish(),
  isActive: z.boolean().default(true),
}).refine(
  (data) => {
    if ((data.provider === 'openai' || data.provider === 'anthropic') && data.isActive !== false) {
      return Boolean(data.apiKey && data.apiKey.trim().length > 0);
    }
    if (data.provider === 'local_openai') {
      return Boolean(data.baseUrl && data.baseUrl.trim().length > 0);
    }
    return true;
  },
  {
    message: 'OpenAI and Anthropic require apiKey; local_openai requires baseUrl',
  }
);

export type RegisterByokCredentialCommandV1 = z.infer<typeof registerByokCredentialCommandV1Schema>;

/**
 * Ephemeral Test Connection Command (POST /api/v1/ai/providers/test)
 */
export const testByokConnectionRequestV1Schema = z.object({
  provider: modelProviderSchema,
  apiKey: z.string().min(1).optional(),
  baseUrl: z.string().url().nullish(),
  model: z.string().min(1).optional(),
});

export type TestByokConnectionRequestV1 = z.infer<typeof testByokConnectionRequestV1Schema>;

export const testByokConnectionResultV1Schema = z.object({
  ok: z.boolean(),
  provider: modelProviderSchema,
  latencyMs: z.number().int().nonnegative(),
  errorMessage: z.string().optional(),
});

export type TestByokConnectionResultV1 = z.infer<typeof testByokConnectionResultV1Schema>;
