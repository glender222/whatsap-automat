import { ProblemDetailsV1, StandardErrorCode } from '@whatsap-automat/contracts';
import { createErrorFromResponse, ProblemDetailsError, ValidationError } from './errors';

export interface HttpClientOptions {
  baseUrl: string;
  apiKey?: string;
  token?: string;
  tenantId?: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetchFn?: typeof fetch;
}

export interface RequestOptions {
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
  timeoutMs?: number;
  signal?: AbortSignal;
  sensitive?: boolean;
}

const approvalReauthReasons = new Map<string, readonly string[]>([
  ['POLICY_DENIED', ['APPROVAL_REAUTH_REQUIRED', 'APPROVAL_REAUTH_INVALID']],
  ['RATE_LIMITED', ['APPROVAL_REAUTH_LIMITED']],
  ['VALIDATION_ERROR', ['VALIDATION_ERROR']],
]);

function sensitiveProblemDetails(body: unknown): Partial<ProblemDetailsV1> {
  if (!body || typeof body !== 'object') return {};
  const problem = body as Partial<ProblemDetailsV1>;
  const code = Object.values(StandardErrorCode).find((known) => known === problem.code);
  const reason = problem.metadata?.reason;
  return {
    ...(code && { code }),
    ...(code && typeof reason === 'string' && approvalReauthReasons.get(code)?.includes(reason) && { metadata: { reason } }),
  };
}

function validateSensitiveUrl(url: string): void {
  const endpoint = new URL(url);
  const loopback = endpoint.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
  if ((endpoint.protocol !== 'https:' && !loopback) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new ValidationError({ detail: 'Password-bearing requests require HTTPS or local loopback HTTP.' });
  }
}

export class HttpClient {
  readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly token?: string;
  private readonly tenantId?: string;
  private readonly defaultTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetch: typeof fetch;

  constructor(options: HttpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.token = options.token;
    this.tenantId = options.tenantId;
    this.defaultTimeoutMs = options.timeoutMs ?? 30000;
    this.maxRetries = options.maxRetries ?? 3;
    this.fetch = options.fetchFn ?? globalThis.fetch;
  }

  async get<T>(path: string, options?: RequestOptions): Promise<T> {
    return this.request<T>('GET', path, undefined, options);
  }

  async post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>('POST', path, body, options);
  }

  async put<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>('PUT', path, body, options);
  }

  async delete<T>(path: string, options?: RequestOptions): Promise<T> {
    return this.request<T>('DELETE', path, undefined, options);
  }

  private async request<T>(
    method: string,
    subPath: string,
    body?: unknown,
    options: RequestOptions = {}
  ): Promise<T> {
    const url = this.buildUrl(subPath, options.query);
    if (options.sensitive) validateSensitiveUrl(url);
    const headers = this.buildHeaders(options.headers);
    const timeout = options.timeoutMs ?? this.defaultTimeoutMs;
    const canRetry = !options.sensitive && (method === 'GET' || Object.entries(options.headers ?? {})
      .some(([name, value]) => name.toLowerCase() === 'idempotency-key' && value.trim() !== ''));

    let attempt = 0;
    while (true) {
      attempt++;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      let responseError: ProblemDetailsError | undefined;
      try {
        const response = await this.fetch(url, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: options.signal ?? controller.signal,
          ...(options.sensitive && { redirect: 'error', cache: 'no-store' }),
        });

        clearTimeout(timeoutId);

        if (response.ok) {
          if (response.status === 204) {
            return undefined as unknown as T;
          }
          const text = await response.text();
          return text ? (JSON.parse(text) as T) : (undefined as unknown as T);
        }

        const isRetryable = response.status === 429 || response.status === 503;
        if (canRetry && isRetryable && attempt <= this.maxRetries) {
          const retryAfter = response.headers.get('retry-after');
          const delayMs = retryAfter
            ? parseInt(retryAfter, 10) * 1000
            : Math.min(100 * Math.pow(2, attempt) + Math.random() * 50, 2000);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }

        const errorText = await response.text();
        let errorBody: unknown = { detail: errorText };
        try {
          errorBody = JSON.parse(errorText);
        } catch {
          // Proxies can return plain-text or HTML errors.
        }

        responseError = createErrorFromResponse(
          response.status,
          options.sensitive ? sensitiveProblemDetails(errorBody) : errorBody,
          response.headers,
        );
        throw responseError;
      } catch (err: any) {
        clearTimeout(timeoutId);
        if (err instanceof ProblemDetailsError && (!options.sensitive || err === responseError)) {
          throw err;
        }
        if (err?.name === 'AbortError') {
          throw new ProblemDetailsError({
            status: 504,
            title: 'Gateway Timeout',
            detail: `Request timed out after ${timeout}ms`,
          });
        }
        if (canRetry && attempt <= this.maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, 100 * Math.pow(2, attempt)));
          continue;
        }
        throw new ProblemDetailsError({
          status: 500,
          title: 'Network Error',
          detail: options.sensitive ? 'Network request failed.' : err.message || 'Unknown network failure',
        });
      }
    }
  }

  private buildUrl(subPath: string, query?: Record<string, string | number | boolean | undefined>): string {
    const cleanPath = subPath.startsWith('/') ? subPath : `/${subPath}`;
    const baseWithV1 = this.baseUrl.endsWith('/api/v1') ? this.baseUrl : `${this.baseUrl}/api/v1`;
    const fullUrl = new URL(`${baseWithV1}${cleanPath}`);

    if (query) {
      for (const [key, val] of Object.entries(query)) {
        if (val !== undefined && val !== null) {
          fullUrl.searchParams.set(key, String(val));
        }
      }
    }

    return fullUrl.toString();
  }

  private buildHeaders(custom?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': '@whatsap-automat/sdk/0.4.0',
      ...custom,
    };

    const authToken = this.apiKey || this.token;
    if (authToken) {
      headers['Authorization'] = `Bearer ${authToken}`;
    }

    if (this.tenantId) {
      headers['X-Tenant-Id'] = this.tenantId;
    }

    return headers;
  }
}
