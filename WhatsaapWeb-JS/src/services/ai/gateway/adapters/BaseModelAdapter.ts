import { IModelAdapter } from './IModelAdapter';
import { ModelGatewayRequest, AdapterRawResult } from '../types';

export type FetchFunction = typeof globalThis.fetch;

export abstract class BaseModelAdapter implements IModelAdapter {
  abstract readonly provider: string;

  constructor(
    protected readonly apiKey?: string | null,
    protected readonly baseUrl?: string | null,
    protected readonly customFetch: FetchFunction = globalThis.fetch
  ) {}

  abstract complete(request: ModelGatewayRequest): Promise<AdapterRawResult>;

  /**
   * Safe fetch with timeout and header abstraction.
   */
  protected async postJson(
    url: string,
    headers: Record<string, string>,
    body: unknown,
    timeoutMs: number = 30000
  ): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await this.customFetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!response.ok) {
        let errorDetails: string;
        try {
          const errJson = await response.json();
          errorDetails = JSON.stringify(errJson);
        } catch {
          errorDetails = await response.text();
        }
        const err = new Error(
          `Provider '${this.provider}' returned HTTP ${response.status}: ${this.sanitizeError(errorDetails)}`
        ) as any;
        err.statusCode = response.status;
        err.code = response.status === 429 ? 'RATE_LIMITED' : 'PROVIDER_ERROR';
        throw err;
      }

      return await response.json();
    } catch (error: any) {
      clearTimeout(timer);
      if (error.name === 'AbortError' || error.code === 'ABORT_ERR') {
        const timeoutErr = new Error(`Request to provider '${this.provider}' timed out after ${timeoutMs}ms`) as any;
        timeoutErr.statusCode = 504;
        timeoutErr.code = 'TIMEOUT';
        throw timeoutErr;
      }
      throw error;
    }
  }

  /**
   * Sanitizes strings to prevent credential exposure in logs/errors.
   */
  protected sanitizeError(msg: string): string {
    if (!this.apiKey) return msg;
    return msg.split(this.apiKey).join('[REDACTED_API_KEY]');
  }
}
