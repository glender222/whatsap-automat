import config from '../../../../config/index';
import type {
  AiCompletionOptions,
  AiMessage,
  AiProviderModel,
  AiProviderPort,
  AiProviderStatus,
  AiProviderTestResult,
} from '../../domain/provider.types';

const OPENAI_API_URL = 'https://api.openai.com/v1';
const RESPONSES_PATH = '/responses';
const MODELS_PATH = '/models';

type OpenAIProviderOptions = {
  apiKey?: string;
  model?: string;
  requestTimeoutMs?: number;
  apiUrl?: string;
};

type ProviderError = Error & {
  code: string;
  statusCode: number;
  providerStatusCode?: number;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null;
}

export class OpenAIProvider implements AiProviderPort {
  readonly providerName = 'openai';

  private readonly apiKey: string;
  private readonly defaultModel: string;
  private readonly timeoutMs: number;
  private readonly apiUrl: string;

  constructor(options: OpenAIProviderOptions = {}) {
    this.apiKey = String(options.apiKey ?? config.ai.openai.apiKey ?? '').trim();
    this.defaultModel = String(options.model ?? config.ai.openai.model ?? '').trim();
    this.timeoutMs = Number(options.requestTimeoutMs ?? config.ai.openai.requestTimeoutMs ?? 30000);
    this.apiUrl = String(options.apiUrl ?? OPENAI_API_URL).replace(/\/+$/, '');
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  getStatus(): AiProviderStatus {
    return {
      provider: this.providerName,
      configured: this.isConfigured(),
      apiUrlConfigured: true,
      hasApiKey: Boolean(this.apiKey),
      chatPath: RESPONSES_PATH,
      modelsPath: MODELS_PATH,
      defaultModel: this.defaultModel || null,
    };
  }

  async listModels(): Promise<AiProviderModel[]> {
    this.assertConfigured();
    const payload = asRecord(await this.request(MODELS_PATH, { method: 'GET' }));
    const data = Array.isArray(payload?.data) ? payload.data : [];
    return data.flatMap((entry) => {
      const model = asRecord(entry);
      const id = typeof model?.id === 'string' ? model.id : '';
      return id ? [{ id, name: id }] : [];
    });
  }

  async testConnection(model?: string | null): Promise<AiProviderTestResult> {
    const resolvedModel = this.resolveModel(model);
    const reply = await this.complete(
      [
        { role: 'system', content: 'Responde solo JSON valido con esta forma: {"ok":true,"reply":"pong"}.' },
        { role: 'user', content: 'ping' },
      ],
      { model: resolvedModel }
    );
    return { ok: true, model: resolvedModel, reply };
  }

  async complete(messages: AiMessage[], options: AiCompletionOptions = {}): Promise<string> {
    this.assertConfigured();
    const model = this.resolveModel(options.model);
    const payload = await this.request(RESPONSES_PATH, {
      method: 'POST',
      signal: options.signal,
      body: JSON.stringify({
        model,
        input: messages.map((message) => this.toResponseInput(message)),
      }),
    });
    return this.extractResponseText(payload);
  }

  private toResponseInput(message: AiMessage): { role: 'system' | 'user' | 'assistant'; content: string } {
    if (message.role === 'tool') {
      return { role: 'user', content: `Resultado de herramienta:\n${message.content}` };
    }
    return { role: message.role, content: message.content };
  }

  private resolveModel(requestedModel?: string | null): string {
    const model = String(requestedModel || this.defaultModel || '').trim();
    if (model) return model;
    throw this.createError('AI_MODEL_NOT_CONFIGURED', 'OPENAI_MODEL no configurado', 400);
  }

  private assertConfigured(): void {
    if (!this.apiKey) {
      throw this.createError('AI_PROVIDER_NOT_CONFIGURED', 'OPENAI_API_KEY no configurado', 503);
    }
  }

  private async request(pathName: string, init: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.apiUrl}${pathName}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        signal: init.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal,
      });
      const raw = await response.text();
      const payload = this.parseJson(raw);

      if (!response.ok) {
        const code = response.status === 401 || response.status === 403
          ? 'AI_PROVIDER_AUTH_ERROR'
          : 'AI_PROVIDER_ERROR';
        const error = this.createError(code, `OpenAI API request failed (${response.status})`, 502);
        error.providerStatusCode = response.status;
        throw error;
      }
      return payload;
    } catch (error: unknown) {
      init.signal?.throwIfAborted();
      if (this.isProviderError(error)) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw this.createError('AI_PROVIDER_TIMEOUT', 'OpenAI API request timed out', 504);
      }
      throw this.createError('AI_PROVIDER_UNAVAILABLE', 'No se pudo conectar con OpenAI', 502);
    } finally {
      clearTimeout(timeout);
    }
  }

  private parseJson(raw: string): unknown {
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      throw this.createError('AI_PROVIDER_INVALID_RESPONSE', 'OpenAI devolvio una respuesta no valida', 502);
    }
  }

  private extractResponseText(payload: unknown): string {
    const root = asRecord(payload);
    const output = Array.isArray(root?.output) ? root.output : [];
    const chunks: string[] = [];

    for (const itemValue of output) {
      const item = asRecord(itemValue);
      const content = Array.isArray(item?.content) ? item.content : [];
      for (const contentValue of content) {
        const part = asRecord(contentValue);
        if (part?.type === 'output_text' && typeof part.text === 'string') {
          chunks.push(part.text);
        }
      }
    }

    if (chunks.length > 0) return chunks.join('\n');
    throw this.createError('AI_PROVIDER_INVALID_RESPONSE', 'OpenAI no devolvio texto utilizable', 502);
  }

  private createError(code: string, message: string, statusCode: number): ProviderError {
    return Object.assign(new Error(message), { code, statusCode });
  }

  private isProviderError(error: unknown): error is ProviderError {
    return error instanceof Error && typeof (error as Partial<ProviderError>).code === 'string';
  }
}
