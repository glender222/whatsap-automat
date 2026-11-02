import { BaseModelAdapter, FetchFunction } from './BaseModelAdapter';
import {
  ModelGatewayRequest,
  AdapterRawResult,
  ModelToolCall,
  ModelFinishReason,
} from '../types';

export class AnthropicAdapter extends BaseModelAdapter {
  readonly provider = 'anthropic';

  constructor(
    apiKey?: string | null,
    baseUrl?: string | null,
    customFetch?: FetchFunction
  ) {
    super(apiKey, baseUrl, customFetch);
  }

  async complete(request: ModelGatewayRequest): Promise<AdapterRawResult> {
    const root = (this.baseUrl || 'https://api.anthropic.com/v1').replace(/\/+$/, '');
    const url = `${root}/messages`;

    // Extract system prompt
    const systemMessages = request.messages.filter((m) => m.role === 'system');
    const systemPrompt = systemMessages.map((m) => m.content).join('\n\n');

    // Filter non-system messages
    const conversationMessages = request.messages.filter((m) => m.role !== 'system');

    // Map messages into Anthropic user/assistant turns
    const messages = conversationMessages.map((m) => {
      const role = m.role === 'assistant' ? 'assistant' : 'user';
      return {
        role,
        content: m.content,
      };
    });

    // Ensure at least one user message
    if (messages.length === 0) {
      messages.push({ role: 'user', content: 'Hello' });
    }

    const payload: Record<string, unknown> = {
      model: request.model,
      messages,
      max_tokens: request.maxTokens || 4096,
    };

    if (systemPrompt.length > 0) {
      payload.system = systemPrompt;
    }
    if (request.temperature !== undefined) {
      payload.temperature = request.temperature;
    }
    if (request.tools && request.tools.length > 0) {
      payload.tools = request.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));
    }

    const headers: Record<string, string> = {
      'x-api-key': this.apiKey || '',
      'anthropic-version': '2023-06-01',
    };

    const data = await this.postJson(url, headers, payload, request.timeoutMs || 30000);

    // Parse content blocks
    const contentBlocks: any[] = Array.isArray(data?.content) ? data.content : [];
    const textBlocks = contentBlocks.filter((b) => b.type === 'text');
    const toolUseBlocks = contentBlocks.filter((b) => b.type === 'tool_use');

    const text = textBlocks.length > 0
      ? textBlocks.map((b) => b.text).join('')
      : null;

    const toolCalls: ModelToolCall[] = toolUseBlocks.map((b) => ({
      id: b.id || `call_${Date.now()}`,
      name: b.name || '',
      arguments: (b.input && typeof b.input === 'object') ? b.input : {},
    }));

    let finishReason: ModelFinishReason = 'stop';
    if (data?.stop_reason === 'tool_use' || toolCalls.length > 0) {
      finishReason = 'tool_calls';
    } else if (data?.stop_reason === 'max_tokens') {
      finishReason = 'length';
    }

    const promptTokens = Number(data?.usage?.input_tokens ?? 0);
    const completionTokens = Number(data?.usage?.output_tokens ?? 0);

    return {
      text,
      toolCalls,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      },
      finishReason,
      rawResponse: data,
    };
  }
}
