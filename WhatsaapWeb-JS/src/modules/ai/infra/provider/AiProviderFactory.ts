import type { AiProviderFactory, AiProviderPort } from '../../domain/provider.types';
import config from '../../../../config/index';
import { OpenCodeProvider } from './OpenCodeProvider';
import { OpenAIProvider } from './OpenAIProvider';

const SUPPORTED_PROVIDERS = new Set(['opencode', 'openai']);

export class AiProviderFactoryPg implements AiProviderFactory {
  private readonly cache = new Map<string, AiProviderPort>();
  private defaultProvider: AiProviderPort | null = null;

  create(provider: string): AiProviderPort {
    const normalized = String(provider || 'opencode').toLowerCase();
    if (!SUPPORTED_PROVIDERS.has(normalized)) {
      const error = new Error(`Proveedor IA no soportado: ${normalized}`) as Error & { code: string; statusCode: number };
      error.code = 'PROVIDER_NOT_SUPPORTED';
      error.statusCode = 400;
      throw error;
    }
    if (!this.cache.has(normalized)) {
      this.cache.set(normalized, normalized === 'openai' ? new OpenAIProvider() : new OpenCodeProvider());
    }
    return this.cache.get(normalized)!;
  }

  getDefault(): AiProviderPort {
    if (!this.defaultProvider) this.defaultProvider = this.create(config.ai.provider || 'opencode');
    return this.defaultProvider;
  }
}

let factoryInstance: AiProviderFactoryPg | null = null;

export function getAiProviderFactory(): AiProviderFactoryPg {
  if (!factoryInstance) factoryInstance = new AiProviderFactoryPg();
  return factoryInstance;
}
