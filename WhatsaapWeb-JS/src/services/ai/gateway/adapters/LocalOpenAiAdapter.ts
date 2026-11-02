import { BaseModelAdapter, FetchFunction } from './BaseModelAdapter';
import {
  ModelGatewayRequest,
  AdapterRawResult,
  ModelToolCall,
  ModelFinishReason,
} from '../types';
import { SsrfGuard } from '../../../temporal/activities/ssrfGuard';

export class LocalOpenAiAdapter extends BaseModelAdapter {
  readonly provider = 'local_openai';

  constructor(
    apiKey?: string | null,
    baseUrl?: string | null,
    customFetch?: FetchFunction
  ) {
    super(apiKey, baseUrl, customFetch);
  }

  async complete(request: ModelGatewayRequest): Promise<AdapterRawResult> {
    if (!this.baseUrl || this.baseUrl.trim().length === 0) {
      const err = new Error("Local OpenAI adapter requires a configured 'baseUrl'") as any;
      err.statusCode = 400;
      err.code = 'VALIDATION_ERROR';
      throw err;
    }

    // Mandatory SSRF Pre-flight check before connecting to any socket
    const ssrfResult = await SsrfGuard.validateUrl(this.baseUrl);
    if (!ssrfResult.safe) {
      const error = new Error(
        `SSRF_BLOCKED: Prohibited target '${this.baseUrl}': ${ssrfResult.reason}`
      ) as any;
      error.statusCode = 403;
      error.code = 'POLICY_DENIED';
      throw error;
    }

    // Determine completions path
    const trimmedBase = this.baseUrl.replace(/\/+$/, '');
    const url = trimmedBase.endsWith('/v1')
      ? `${trimmedBase}/chat/completions`
      : `${trimmedBase}/v1/chat/completions`;

    const payload: Record<string, unknown> = {
      model: request.model,
      messages: request.messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.name ? { name: m.name } : {}),
        ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
      })),
    };

    if (request.temperature !== undefined) payload.temperature = request.temperature;
    if (request.maxTokens !== undefined) payload.max_tokens = request.maxTokens;
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

    const headers: Record<string, string> = {};
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

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
