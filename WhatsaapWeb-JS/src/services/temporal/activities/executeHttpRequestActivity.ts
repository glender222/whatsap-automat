import { ApplicationFailure } from '@temporalio/activity';
import { SsrfGuard } from './ssrfGuard';
import type { HttpRequestActivityInput, HttpRequestActivityResult } from './types';

const MAX_REDIRECTS = 3;

/**
 * Outbound HTTP Activity with SSRF protection, DNS pre-validation,
 * manual redirect verification, and Temporal retry classification.
 */
export async function executeHttpRequestActivity(
  input: HttpRequestActivityInput
): Promise<HttpRequestActivityResult> {
  let currentUrl = input.url;
  const method = input.method || 'GET';
  const timeoutMs = input.timeoutMs || 30_000;

  // 1. Initial SSRF Guard assertion
  let resolvedIps = await SsrfGuard.assertUrlIsSafe(currentUrl);

  const requestHeaders: Record<string, string> = {
    'Accept': 'application/json, text/plain, */*',
    ...(input.headers || {}),
  };

  if (input.correlationId && !requestHeaders['x-correlation-id']) {
    requestHeaders['x-correlation-id'] = input.correlationId;
  }
  if (input.runId && !requestHeaders['x-workflow-run-id']) {
    requestHeaders['x-workflow-run-id'] = input.runId;
  }
  if (input.idempotencyKey && !requestHeaders['x-idempotency-key']) {
    requestHeaders['x-idempotency-key'] = input.idempotencyKey;
  }

  let requestBody: string | undefined = undefined;
  if (input.body !== undefined && input.body !== null && method !== 'GET' && method !== 'DELETE') {
    if (typeof input.body === 'string') {
      requestBody = input.body;
    } else {
      requestBody = JSON.stringify(input.body);
      if (!requestHeaders['Content-Type'] && !requestHeaders['content-type']) {
        requestHeaders['Content-Type'] = 'application/json';
      }
    }
  }

  let redirectCount = 0;
  let response: Response;

  while (true) {
    try {
      response = await fetch(currentUrl, {
        method,
        headers: requestHeaders,
        body: requestBody,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err: any) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        throw ApplicationFailure.retryable(
          `HTTP request timed out after ${timeoutMs}ms to ${currentUrl}`,
          'REQUEST_TIMEOUT'
        );
      }
      throw ApplicationFailure.retryable(
        `HTTP network failure to ${currentUrl}: ${err.message}`,
        'NETWORK_ERROR'
      );
    }

    // 2. Manual redirect validation
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      redirectCount++;
      if (redirectCount > MAX_REDIRECTS) {
        throw ApplicationFailure.nonRetryable(
          `Too many redirects (exceeded maximum of ${MAX_REDIRECTS})`,
          'MAX_REDIRECTS_EXCEEDED'
        );
      }

      const locationHeader = response.headers.get('location');
      if (!locationHeader) {
        throw ApplicationFailure.nonRetryable(
          `Redirect status ${response.status} missing Location header`,
          'MALFORMED_REDIRECT'
        );
      }

      const redirectTarget = new URL(locationHeader, currentUrl).href;
      // Assert the redirect destination is SSRF safe
      resolvedIps = await SsrfGuard.assertUrlIsSafe(redirectTarget);
      currentUrl = redirectTarget;
      continue;
    }

    break;
  }

  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key.toLowerCase()] = value;
  });

  const rawText = await response.text();
  let parsedBody: unknown = rawText;
  const contentType = responseHeaders['content-type'] || '';
  if (contentType.includes('application/json') && rawText.trim().length > 0) {
    try {
      parsedBody = JSON.parse(rawText);
    } catch {
      parsedBody = rawText;
    }
  }

  // 3. Error Classification
  if (response.status === 429) {
    throw ApplicationFailure.retryable(
      `HTTP 429 Rate Limited: ${rawText.slice(0, 500)}`,
      'RATE_LIMITED'
    );
  }

  if (response.status >= 400 && response.status < 500) {
    throw ApplicationFailure.nonRetryable(
      `HTTP ${response.status} Client Error: ${rawText.slice(0, 500)}`,
      'HTTP_CLIENT_ERROR',
      { status: response.status, body: parsedBody }
    );
  }

  if (response.status >= 500) {
    throw ApplicationFailure.retryable(
      `HTTP ${response.status} Server Error: ${rawText.slice(0, 500)}`,
      'SERVER_ERROR',
      { status: response.status, body: parsedBody }
    );
  }

  return {
    status: response.status,
    headers: responseHeaders,
    body: parsedBody,
    resolvedIp: resolvedIps[0],
  };
}
