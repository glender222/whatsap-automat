import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import { SsrfEgressGuard, SsrfRedirectError, SsrfBlockedError } from './SsrfEgressGuard';

export interface SafeHttpRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  timeoutMs?: number;
  maxRedirects?: number;
  maxResponseSizeBytes?: number;
}

export interface SafeHttpResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  finalUrl: string;
  redirectCount: number;
  resolvedIp: string;
}

export class SafeHttpClient {
  private static readonly DEFAULT_TIMEOUT_MS = 30_000;
  private static readonly MAX_REDIRECTS = 5;
  private static readonly MAX_RESPONSE_SIZE = 10 * 1024 * 1024; // 10MB

  public static async request(
    initialUrl: string,
    options: SafeHttpRequestOptions = {}
  ): Promise<SafeHttpResponse> {
    let currentUrl = initialUrl;
    let method = (options.method || 'GET').toUpperCase();
    let body = options.body;
    let currentHeaders: Record<string, string> = { ...(options.headers || {}) };
    const maxRedirects = options.maxRedirects ?? this.MAX_REDIRECTS;
    const timeoutMs = options.timeoutMs ?? this.DEFAULT_TIMEOUT_MS;
    const maxResponseSize = options.maxResponseSizeBytes ?? this.MAX_RESPONSE_SIZE;

    let redirectCount = 0;
    let lastResolvedIp = '';

    while (true) {
      // 1. Assert current URL is SSRF safe and obtain pinned IP
      const resolvedIps = await SsrfEgressGuard.assertUrlIsSafe(currentUrl);
      const chosenIp = resolvedIps[0];
      lastResolvedIp = chosenIp;

      const parsedUrl = new URL(currentUrl);
      const isHttps = parsedUrl.protocol === 'https:';
      const port = parsedUrl.port ? Number(parsedUrl.port) : isHttps ? 443 : 80;

      // 2. Execute HTTP/HTTPS request with IP PINNING (prevents TOCTOU DNS Rebinding)
      const response = await this.executePinnedRequest({
        isHttps,
        pinnedIp: chosenIp,
        hostname: parsedUrl.hostname,
        port,
        path: `${parsedUrl.pathname}${parsedUrl.search}`,
        method,
        headers: {
          ...currentHeaders,
          Host: parsedUrl.host, // Preserve virtual host
        },
        body,
        timeoutMs,
        maxResponseSize,
      });

      // 3. Handle Redirects (301, 302, 303, 307, 308)
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        redirectCount++;
        if (redirectCount > maxRedirects) {
          throw new SsrfRedirectError(
            `Too many redirects: exceeded maximum of ${maxRedirects} hops`,
            'MAX_REDIRECTS_EXCEEDED'
          );
        }

        const locationHeader = response.headers['location'];
        if (!locationHeader) {
          throw new SsrfRedirectError(
            `Redirect HTTP ${response.status} missing Location header`,
            'MALFORMED_REDIRECT'
          );
        }

        const targetUrl = new URL(locationHeader, currentUrl).href;
        const targetParsed = new URL(targetUrl);

        // Security: Strip sensitive headers on cross-origin redirects
        if (targetParsed.origin !== parsedUrl.origin) {
          delete currentHeaders['authorization'];
          delete currentHeaders['Authorization'];
          delete currentHeaders['proxy-authorization'];
          delete currentHeaders['cookie'];
          delete currentHeaders['x-api-key'];
        }

        // Method adjustments according to RFC 7231 / RFC 7538
        if (
          response.status === 303 ||
          ((response.status === 301 || response.status === 302) && method === 'POST')
        ) {
          method = 'GET';
          body = undefined;
          delete currentHeaders['content-type'];
          delete currentHeaders['content-length'];
        }

        currentUrl = targetUrl;
        continue;
      }

      return {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        body: response.body,
        finalUrl: currentUrl,
        redirectCount,
        resolvedIp: lastResolvedIp,
      };
    }
  }

  private static executePinnedRequest(params: {
    isHttps: boolean;
    pinnedIp: string;
    hostname: string;
    port: number;
    path: string;
    method: string;
    headers: Record<string, string>;
    body?: string | Buffer;
    timeoutMs: number;
    maxResponseSize: number;
  }): Promise<{ status: number; statusText: string; headers: Record<string, string>; body: string }> {
    return new Promise((resolve, reject) => {
      const client = params.isHttps ? https : http;

      const requestOptions: https.RequestOptions = {
        host: params.pinnedIp, // Direct socket connection to verified IP
        port: params.port,
        path: params.path,
        method: params.method,
        headers: params.headers,
        servername: params.hostname, // Preserves TLS SNI & certificate verification
      };

      const req = client.request(requestOptions, (res) => {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (v !== undefined) {
            headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
          }
        }

        const chunks: Buffer[] = [];
        let totalBytes = 0;

        res.on('data', (chunk: Buffer) => {
          totalBytes += chunk.length;
          if (totalBytes > params.maxResponseSize) {
            req.destroy(new Error(`Response exceeded maximum size limit of ${params.maxResponseSize} bytes`));
            return;
          }
          chunks.push(chunk);
        });

        res.on('end', () => {
          resolve({
            status: res.statusCode || 200,
            statusText: res.statusMessage || '',
            headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      });

      req.setTimeout(params.timeoutMs, () => {
        req.destroy(new Error(`Request timed out after ${params.timeoutMs}ms`));
      });

      req.on('error', (err) => {
        reject(err);
      });

      if (params.body) {
        req.write(params.body);
      }
      req.end();
    });
  }
}
