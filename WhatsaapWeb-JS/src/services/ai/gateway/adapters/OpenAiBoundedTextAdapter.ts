import { modelTokenUsageV1Schema } from '@whatsap-automat/contracts';
import {
  boundedTextCapability, type BoundedTextAdapter, type BoundedTextRequest, type BoundedTextResult,
} from '../BoundedTextCompletion';
import type { FetchFunction } from './BaseModelAdapter';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function usageDetails(value: unknown): Record<string, unknown> {
  if (value == null) return {};
  const details = asRecord(value);
  if (!details) throw new Error('Bounded completion usage details could not be verified');
  return details;
}

function verifiedUsage(payload: Record<string, unknown>): BoundedTextResult['usage'] {
  const raw = asRecord(payload.usage);
  const parsed = modelTokenUsageV1Schema.safeParse({
    promptTokens: raw?.prompt_tokens, completionTokens: raw?.completion_tokens, totalTokens: raw?.total_tokens,
  });
  if (!parsed.success || !raw) throw new Error('Bounded completion usage could not be verified');
  const { promptTokens, completionTokens, totalTokens } = parsed.data;
  const promptDetails = usageDetails(raw.prompt_tokens_details);
  const completionDetails = usageDetails(raw.completion_tokens_details);
  const cachedTokens = promptDetails.cached_tokens === undefined ? 0 : promptDetails.cached_tokens;
  const reasoningTokens = completionDetails.reasoning_tokens === undefined ? 0 : completionDetails.reasoning_tokens;
  const unsupported = [promptDetails.cache_write_tokens, promptDetails.image_tokens, promptDetails.audio_tokens, completionDetails.audio_tokens];
  if (promptTokens < 1 || totalTokens > 2_147_483_647 || totalTokens !== promptTokens + completionTokens ||
      typeof cachedTokens !== 'number' || !Number.isSafeInteger(cachedTokens) || cachedTokens < 0 || cachedTokens > promptTokens ||
      typeof reasoningTokens !== 'number' || !Number.isSafeInteger(reasoningTokens) || reasoningTokens < 0 || reasoningTokens > completionTokens ||
      unsupported.some((count) => count !== undefined && count !== 0)) {
    throw new Error('Bounded completion usage was inconsistent');
  }
  return { promptTokens, completionTokens, cachedTokens };
}

function usableOutput(choices: unknown): BoundedTextResult['output'] {
  if (!Array.isArray(choices) || choices.length !== 1) return null;
  const choice = asRecord(choices[0]);
  const message = asRecord(choice?.message);
  const finishReason = choice?.finish_reason;
  if (!message || message.role !== 'assistant' || typeof message.content !== 'string' ||
      message.refusal != null || message.function_call != null ||
      (message.tool_calls !== undefined && (!Array.isArray(message.tool_calls) || message.tool_calls.length !== 0)) ||
      (finishReason !== 'stop' && finishReason !== 'length')) return null;
  return { text: message.content, finishReason };
}

async function readResponseBody(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Bounded completion response was empty');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 256 * 1024) {
        void reader.cancel().catch(() => undefined);
        throw new Error('Bounded completion response was too large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks, length).toString('utf8'));
}

/** The caller supplies transport explicitly. The application has no production composition for this adapter. */
export class OpenAiBoundedTextAdapter implements BoundedTextAdapter {
  readonly capabilityId = boundedTextCapability.id;

  constructor(private readonly transport: FetchFunction) {}

  async complete(request: BoundedTextRequest, signal: AbortSignal): Promise<BoundedTextResult> {
    signal.throwIfAborted();
    const response = await this.transport('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      redirect: 'error',
      signal,
      body: JSON.stringify({
        model: boundedTextCapability.model,
        messages: [{ role: 'system', content: request.system }, { role: 'user', content: request.input }],
        n: 1,
        stream: false,
        store: false,
        modalities: ['text'],
        service_tier: 'default',
        reasoning_effort: 'none',
        max_completion_tokens: request.maxCompletionTokens,
      }),
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error('Bounded completion response was unsuccessful');
    }
    const payload = asRecord(await readResponseBody(response));
    if (!payload || payload.model !== boundedTextCapability.model || payload.service_tier !== 'default') {
      throw new Error('Bounded completion model or service tier could not be verified');
    }
    return { usage: verifiedUsage(payload), output: usableOutput(payload.choices) };
  }
}
