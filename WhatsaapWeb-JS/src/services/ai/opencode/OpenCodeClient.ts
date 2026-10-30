import config from '../../../config/index';

export type AiMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

type OpenCodeOptions = {
  model?: string | null;
  temperature?: number;
};

export type AiProviderModel = {
  id: string;
  name: string;
};

export type AiProviderStatus = {
  provider: 'opencode';
  configured: boolean;
  apiUrlConfigured: boolean;
  hasApiKey: boolean;
  chatPath: string;
  modelsPath: string;
  defaultModel: string | null;
};

export class OpenCodeClient {
  private readonly apiUrl = String(config.ai?.opencode?.apiUrl || '').replace(/\/+$/, '');
  private readonly chatPath = String(config.ai?.opencode?.chatPath || '/v1/chat/completions');
  private readonly modelsPath = String(config.ai?.opencode?.modelsPath || '/v1/models');
  private readonly apiKey = String(config.ai?.opencode?.apiKey || '');
  private readonly defaultModel = String(config.ai?.opencode?.model || '');
  private readonly timeoutMs = Number(config.ai?.opencode?.requestTimeoutMs || 30000);
  private resolvedDefaultModel: string | null = null;

  isConfigured(): boolean {
    return Boolean(this.apiUrl);
  }

  getStatus(): AiProviderStatus {
    return {
      provider: 'opencode',
      configured: this.isConfigured(),
      apiUrlConfigured: Boolean(this.apiUrl),
      hasApiKey: Boolean(this.apiKey),
      chatPath: this.chatPath,
      modelsPath: this.modelsPath,
      defaultModel: this.defaultModel || null,
    };
  }

  async listModels(): Promise<AiProviderModel[]> {
    if (!this.apiUrl) {
      const error = new Error('OPENCODE_API_URL no configurado');
      (error as any).code = 'AI_PROVIDER_NOT_CONFIGURED';
      throw error;
    }

    const payload = await this.requestJson(this.modelsPath, { method: 'GET' });
    return this.extractModels(payload);
  }

  async testConnection(model?: string | null): Promise<{ ok: true; model: string | null; reply: string }> {
    const resolvedModel = await this.resolveModel(model || null);
    const reply = await this.complete(
      [
        {
          role: 'system',
          content: 'Responde solo JSON valido con esta forma: {"ok":true,"reply":"pong"}.',
        },
        {
          role: 'user',
          content: 'ping',
        },
      ],
      { model: resolvedModel, temperature: 0 }
    );

    return {
      ok: true,
      model: resolvedModel,
      reply,
    };
  }

  async complete(messages: AiMessage[], options: OpenCodeOptions = {}): Promise<string> {
    if (!this.apiUrl) {
      const error = new Error('OPENCODE_API_URL no configurado');
      (error as any).code = 'AI_PROVIDER_NOT_CONFIGURED';
      throw error;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const model = await this.resolveModel(options.model || null);
      const response = await fetch(`${this.apiUrl}${this.chatPath}`, {
        method: 'POST',
        headers: this.buildHeaders(),
        signal: controller.signal,
        body: JSON.stringify(this.buildBody(messages, { ...options, model })),
      });

      const text = await response.text();
      let payload: any = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        payload = null;
      }

      if (!response.ok) {
        const error = new Error(`OpenCode API error ${response.status}: ${payload?.error?.message || text || response.statusText}`);
        (error as any).code = 'AI_PROVIDER_ERROR';
        (error as any).statusCode = 502;
        (error as any).providerStatusCode = response.status;
        throw error;
      }

      return this.extractText(payload, text);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async requestJson(pathName: string, init: RequestInit): Promise<any> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.apiUrl}${pathName}`, {
        ...init,
        headers: this.buildHeaders(),
        signal: controller.signal,
      });

      const text = await response.text();
      let payload: any = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        payload = null;
      }

      if (!response.ok) {
        const error = new Error(`OpenCode API error ${response.status}: ${payload?.error?.message || text || response.statusText}`);
        (error as any).code = 'AI_PROVIDER_ERROR';
        (error as any).statusCode = 502;
        (error as any).providerStatusCode = response.status;
        throw error;
      }

      return payload ?? text;
    } finally {
      clearTimeout(timeout);
    }
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    return headers;
  }

  private buildBody(messages: AiMessage[], options: OpenCodeOptions): Record<string, unknown> {
    const model = options.model || this.defaultModel || undefined;
    const prompt = messages.map((message) => `${message.role.toUpperCase()}:\n${message.content}`).join('\n\n');

    return {
      model,
      messages,
      prompt,
      temperature: options.temperature ?? 0.2,
      response_format: { type: 'json_object' },
    };
  }

  private extractText(payload: any, rawText: string): string {
    if (!payload) return rawText;

    const choiceContent = payload.choices?.[0]?.message?.content || payload.choices?.[0]?.text;
    if (typeof choiceContent === 'string') return choiceContent;

    const directText = payload.output_text || payload.response || payload.text || payload.content;
    if (typeof directText === 'string') return directText;

    const messageContent = payload.message?.content;
    if (typeof messageContent === 'string') return messageContent;

    if (Array.isArray(payload.output)) {
      const outputText = payload.output
        .flatMap((item: any) => item.content || [])
        .map((item: any) => item.text || '')
        .filter(Boolean)
        .join('\n');
      if (outputText) return outputText;
    }

    return JSON.stringify(payload);
  }

  private extractModels(payload: any): AiProviderModel[] {
    const source = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.data)
        ? payload.data
        : Array.isArray(payload?.models)
          ? payload.models
          : [];

    return source
      .map((item: any) => {
        const id = typeof item === 'string' ? item : item?.id || item?.model || item?.name;
        if (!id) return null;
        return {
          id: String(id),
          name: String(item?.name || item?.label || id),
        };
      })
      .filter(Boolean) as AiProviderModel[];
  }

  private async resolveModel(requestedModel?: string | null): Promise<string | null> {
    const explicitModel = String(requestedModel || this.defaultModel || '').trim();
    if (explicitModel) return explicitModel;
    if (this.resolvedDefaultModel) return this.resolvedDefaultModel;

    const models = await this.listModels();
    const selected = this.pickChatModel(models);
    if (!selected) {
      const error = new Error('No se detecto ningun modelo de chat. Configura OPENCODE_MODEL en .env.');
      (error as any).code = 'AI_MODEL_NOT_CONFIGURED';
      (error as any).statusCode = 400;
      throw error;
    }

    this.resolvedDefaultModel = selected.id;
    return selected.id;
  }

  private pickChatModel(models: AiProviderModel[]): AiProviderModel | null {
    const blocked = /(embedding|whisper|tts|audio|image|vision|moderation|dall-e|realtime|transcribe|search)/i;
    const chatModels = models.filter((model) => !blocked.test(model.id));

    const preferred = [
      'qwen3.6-plus',
      'kimi-k2.6',
      'deepseek-v4-flash',
      'glm-5.1',
      'qwen3.5-plus',
      'kimi-k2.5',
      'mimo-v2.5',
      'gpt-4.1-mini',
      'gpt-4o-mini',
      'gpt-5-mini',
      'gpt-4.1',
      'gpt-4o',
      'gpt-5',
      'gpt-3.5-turbo',
    ];

    for (const prefix of preferred) {
      const match = chatModels.find((model) => model.id === prefix || model.id.startsWith(`${prefix}-`));
      if (match) return match;
    }

    return chatModels.find((model) => /gpt|chat|llama|claude|gemini|mistral|qwen/i.test(model.id)) || chatModels[0] || null;
  }
}

export default OpenCodeClient;
