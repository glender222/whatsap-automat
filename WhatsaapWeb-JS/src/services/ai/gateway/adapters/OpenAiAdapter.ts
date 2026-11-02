import { BaseModelAdapter, FetchFunction } from './BaseModelAdapter';
import {
  ModelGatewayRequest,
  AdapterRawResult,
  ModelToolCall,
  ModelFinishReason,
} from '../types';

export class OpenAiAdapter extends BaseModelAdapter {
  readonly provider = 'openai';

  constructor(
    apiKey?: string | null,
    baseUrl?: string | null,
    customFetch?: FetchFunction
  ) {
    super(apiKey, baseUrl, customFetch);
  }

  async complete(request: ModelGatewayRequest): Promise<AdapterRawResult> {
    const root = (this.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
    const url = `${root}/chat/completions`;

    const payload: Record<string, unknown> = {
      model: request.model,
      messages: request.messages.map((m) => {
        const msgObj: Record<string, unknown> = {
          role: m.role,
          content: m.content,
        };
        if (m.name) msgObj.name = m.name;
        if (m.toolCallId) msgObj.tool_call_id = m.toolCallId;
        return msgObj;
      }),
    };

    if (request.temperature !== undefined) {
      payload.temperature = request.temperature;
    }
    if (request.maxTokens !== undefined) {
      payload.max_tokens = request.maxTokens;
    }
    if (request.tools && request.tools.length > 0) {
      payload.tools = request.tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey || ''}`,
    };

    const data = await this.postJson(url, headers, payload, request.timeoutMs || 30000);

    const choice = data?.choices?.[0];
    const message = choice?.message;
    const text = message?.content ?? null;

    const toolCalls: ModelToolCall[] = (message?.tool_calls || []).map((tc: any) => {
      let args: Record<string, unknown> = {};
      if (typeof tc.function?.arguments === 'string') {
        try {
          args = JSON.parse(tc.function.arguments);
        } catch {
          args = { raw: tc.function.arguments };
        }
      } else if (tc.function?.arguments && typeof tc.function.arguments === 'object') {
        args = tc.function.arguments;
      }
      return {
        id: tc.id || `call_${Date.now()}`,
        name: tc.function?.name || '',
        arguments: args,
      };
    });

    let finishReason: ModelFinishReason = 'stop';
    if (choice?.finish_reason === 'tool_calls') finishReason = 'tool_calls';
    else if (choice?.finish_reason === 'length') finishReason = 'length';
    else if (choice?.finish_reason === 'content_filter') finishReason = 'content_filter';
    else if (toolCalls.length > 0) finishReason = 'tool_calls';

    return {
      text,
      toolCalls,
      usage: {
        promptTokens: data?.usage?.prompt_tokens ?? 0,
        completionTokens: data?.usage?.completion_tokens ?? 0,
        totalTokens: data?.usage?.total_tokens ?? 0,
      },
      finishReason,
      rawResponse: data,
    };
  }
}
