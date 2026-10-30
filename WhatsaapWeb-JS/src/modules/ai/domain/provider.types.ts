export type AiMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
};

export type AiCompletionOptions = {
  model?: string | null;
  temperature?: number;
};

export type AiProviderModel = {
  id: string;
  name: string;
};

export type AiProviderStatus = {
  provider: string;
  configured: boolean;
  apiUrlConfigured: boolean;
  hasApiKey: boolean;
  chatPath: string;
  modelsPath: string;
  defaultModel: string | null;
};

export type AiProviderTestResult = {
  ok: boolean;
  model: string | null;
  reply: string;
};

export type AiProviderConfig = {
  apiUrl: string;
  chatPath: string;
  modelsPath: string;
  apiKey: string;
  defaultModel: string;
  requestTimeoutMs: number;
};

export interface AiProviderPort {
  readonly providerName: string;
  isConfigured(): boolean;
  getStatus(): AiProviderStatus;
  listModels(): Promise<AiProviderModel[]>;
  testConnection(model?: string | null): Promise<AiProviderTestResult>;
  complete(messages: AiMessage[], options?: AiCompletionOptions): Promise<string>;
}

export interface AiProviderFactory {
  create(provider: string): AiProviderPort;
  getDefault(): AiProviderPort;
}
