export const boundedTextCapability = {
  id: 'openai-chat-text-standard-2026-11-v1',
  provider: 'openai',
  model: 'gpt-5.4-mini-2026-03-17',
  maxPromptTokens: 400_000,
  maxCompletionTokens: 4_096,
  maxTimeoutMs: 30_000,
} as const;

export interface BoundedTextRequest {
  readonly system: string;
  readonly input: string;
  readonly maxCompletionTokens: number;
}

export interface BoundedTextResult {
  readonly usage: {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly cachedTokens: number;
  };
  readonly output: { readonly text: string; readonly finishReason: 'stop' | 'length' } | null;
}

export interface BoundedTextAdapter {
  readonly capabilityId: typeof boundedTextCapability.id;
  complete(request: BoundedTextRequest, signal: AbortSignal): Promise<BoundedTextResult>;
}

// Standard text rates in milli-micro-USD per token. Round up once for quota accounting.
export function boundedTextCost(promptTokens: number, completionTokens: number, cachedTokens = 0): number {
  return Math.ceil(((promptTokens - cachedTokens) * 750 + cachedTokens * 75 + completionTokens * 4_500) / 1_000);
}
