import {
  ModelProvider,
  ModelMessageV1,
  ModelToolDefinitionV1,
  ModelToolCallV1,
  ModelTokenUsageV1,
  FinishReason,
  ModelCompletionRequestV1,
  ModelCompletionResultV1,
  ByokCredentialV1,
  ByokCredentialSummaryV1,
  RegisterByokCredentialCommandV1,
  TestByokConnectionRequestV1,
  TestByokConnectionResultV1,
  TokenLedgerEntryV1,
  CreateTokenLedgerEntryCommandV1,
  TenantTokenQuotaV1,
  TenantUsageSummaryV1,
  TokenLedgerQueryV1,
} from '@whatsap-automat/contracts';

export type {
  ModelProvider,
  ModelMessageV1 as ModelMessage,
  ModelToolDefinitionV1 as ModelToolDefinition,
  ModelToolCallV1 as ModelToolCall,
  ModelTokenUsageV1 as ModelUsage,
  FinishReason as ModelFinishReason,
  ModelCompletionRequestV1 as ModelGatewayRequest,
  ModelCompletionResultV1 as ModelCompletionResult,
  ByokCredentialV1,
  ByokCredentialSummaryV1,
  RegisterByokCredentialCommandV1,
  TestByokConnectionRequestV1,
  TestByokConnectionResultV1,
  TokenLedgerEntryV1,
  CreateTokenLedgerEntryCommandV1,
  TenantTokenQuotaV1,
  TenantUsageSummaryV1,
  TokenLedgerQueryV1,
};

export interface ResolvedCredential {
  readonly apiKey: string | null;
  readonly baseUrl: string | null;
  readonly defaultModel: string | null;
  readonly isByok: boolean;
}

export interface AdapterRawResult {
  readonly text: string | null;
  readonly toolCalls: readonly ModelToolCallV1[];
  readonly usage: ModelTokenUsageV1;
  readonly finishReason: FinishReason;
  readonly rawResponse?: unknown;
}

export interface EmbeddingRequest {
  readonly tenantId: number | string;
  readonly provider?: ModelProvider;
  readonly model?: string;
  readonly input: string[];
}

export interface EmbeddingResult {
  readonly embeddings: number[][];
  readonly usage: { promptTokens: number; totalTokens: number };
  readonly costMicroUsd: number;
  readonly provider: string;
  readonly model: string;
  readonly latencyMs: number;
}

export interface IModelGateway {
  complete(request: ModelCompletionRequestV1): Promise<ModelCompletionResultV1>;
  embed(request: EmbeddingRequest): Promise<EmbeddingResult>;
}

