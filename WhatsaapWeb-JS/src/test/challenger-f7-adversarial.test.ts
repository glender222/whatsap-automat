import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// 1. Outbound Webhook Signer Imports
import {
  OutboundWebhookSigner,
  InvalidWebhookSecretError,
  ReplayAttackError,
  ClockSkewError,
  WebhookVerificationError,
} from '../services/webhooks/OutboundWebhookSigner';

// 2. SDK Imports
import { HttpClient } from '../../../packages/sdk/src/http';
import { CursorPager, PagedResponse } from '../../../packages/sdk/src/pagination';
import {
  createErrorFromResponse,
  ProblemDetailsError,
  UnauthorizedError,
  PolicyDeniedError,
  NotFoundError,
  ConflictError,
  ValidationError,
  ApprovalRequiredError,
  RateLimitedError,
  UnknownDeliveryError,
  ServiceUnavailableError,
} from '../../../packages/sdk/src/errors';

// 3. CLI & Tar Tool Imports
import { packDirectoryToTarGz, readTarGzEntries, calculateSha256 } from '../../../packages/cli/src/utils/tar';
import { validateManifestFile, FORBIDDEN_PERMISSION_SCOPES } from '../../../packages/cli/src/utils/validator';

describe('CHALLENGER-F7: Adversarial Stress Test Suite', () => {

  /* ========================================================================
   * 1. OutboundWebhookSigner Adversarial Stress Tests
   * ======================================================================== */
  describe('Area 1: OutboundWebhookSigner Adversarial Stress', () => {
    const validSecret = 'test-secret-key-that-is-at-least-32-bytes-long-12345';
    const samplePayload = JSON.stringify({
      event: 'message.received',
      tenantId: 'tenant-42',
      data: { text: 'Hello, World!' },
    });

    describe('1.1 Replay Attack Boundaries', () => {
      it('EMPIRICAL: accepts webhook at exact tolerance boundary (now - 300s)', () => {
        const now = 1700000000;
        const exactBoundaryTimestamp = now - 300; // exactly 300s old

        const headers = OutboundWebhookSigner.sign({
          payload: samplePayload,
          secret: validSecret,
          timestamp: exactBoundaryTimestamp,
        });

        const isValid = OutboundWebhookSigner.verify({
          payload: samplePayload,
          signatureHeader: headers['X-Automat-Signature'],
          timestampHeader: headers['X-Automat-Timestamp'],
          secret: validSecret,
          currentTimestamp: now,
          toleranceSeconds: 300,
        });

        assert.equal(isValid, true, 'Timestamp at exact 300s boundary should be valid');
      });

      it('EMPIRICAL: rejects webhook 1 second beyond tolerance boundary (now - 301s)', () => {
        const now = 1700000000;
        const expiredTimestamp = now - 301; // 301s old

        const headers = OutboundWebhookSigner.sign({
          payload: samplePayload,
          secret: validSecret,
          timestamp: expiredTimestamp,
        });

        assert.throws(
          () =>
            OutboundWebhookSigner.verifyStrict({
              payload: samplePayload,
              signatureHeader: headers['X-Automat-Signature'],
              timestampHeader: headers['X-Automat-Timestamp'],
              secret: validSecret,
              currentTimestamp: now,
              toleranceSeconds: 300,
            }),
          ReplayAttackError
        );

        const isValid = OutboundWebhookSigner.verify({
          payload: samplePayload,
          signatureHeader: headers['X-Automat-Signature'],
          timestampHeader: headers['X-Automat-Timestamp'],
          secret: validSecret,
          currentTimestamp: now,
          toleranceSeconds: 300,
        });
        assert.equal(isValid, false);
      });

      it('EMPIRICAL: rejects extreme past timestamps (e.g. 100,000s in past or 0)', () => {
        const now = 1700000000;
        for (const pastTime of [now - 100000, 0, -1]) {
          const headers = OutboundWebhookSigner.sign({
            payload: samplePayload,
            secret: validSecret,
            timestamp: pastTime,
          });

          assert.throws(
            () =>
              OutboundWebhookSigner.verifyStrict({
                payload: samplePayload,
                signatureHeader: headers['X-Automat-Signature'],
                timestampHeader: headers['X-Automat-Timestamp'],
                secret: validSecret,
                currentTimestamp: now,
              }),
            ReplayAttackError
          );
        }
      });

      it('EMPIRICAL: enforces custom toleranceSeconds strictly', () => {
        const now = 1700000000;
        const customTolerance = 15; // 15 seconds

        const headersPass = OutboundWebhookSigner.sign({
          payload: samplePayload,
          secret: validSecret,
          timestamp: now - 15,
        });
        assert.doesNotThrow(() =>
          OutboundWebhookSigner.verifyStrict({
            payload: samplePayload,
            signatureHeader: headersPass['X-Automat-Signature'],
            timestampHeader: headersPass['X-Automat-Timestamp'],
            secret: validSecret,
            currentTimestamp: now,
            toleranceSeconds: customTolerance,
          })
        );

        const headersFail = OutboundWebhookSigner.sign({
          payload: samplePayload,
          secret: validSecret,
          timestamp: now - 16,
        });
        assert.throws(
          () =>
            OutboundWebhookSigner.verifyStrict({
              payload: samplePayload,
              signatureHeader: headersFail['X-Automat-Signature'],
              timestampHeader: headersFail['X-Automat-Timestamp'],
              secret: validSecret,
              currentTimestamp: now,
              toleranceSeconds: customTolerance,
            }),
          ReplayAttackError
        );
      });
    });

    describe('1.2 Clock Skew Boundaries', () => {
      it('EMPIRICAL: accepts webhook at exact clock skew boundary (now + 60s)', () => {
        const now = 1700000000;
        const exactSkewTimestamp = now + 60; // exactly 60s in future

        const headers = OutboundWebhookSigner.sign({
          payload: samplePayload,
          secret: validSecret,
          timestamp: exactSkewTimestamp,
        });

        const isValid = OutboundWebhookSigner.verify({
          payload: samplePayload,
          signatureHeader: headers['X-Automat-Signature'],
          timestampHeader: headers['X-Automat-Timestamp'],
          secret: validSecret,
          currentTimestamp: now,
          maxFutureSkewSeconds: 60,
        });

        assert.equal(isValid, true, 'Timestamp at exact +60s skew boundary should be valid');
      });

      it('EMPIRICAL: rejects webhook 1 second beyond clock skew boundary (now + 61s)', () => {
        const now = 1700000000;
        const futureTimestamp = now + 61; // 61s ahead

        const headers = OutboundWebhookSigner.sign({
          payload: samplePayload,
          secret: validSecret,
          timestamp: futureTimestamp,
        });

        assert.throws(
          () =>
            OutboundWebhookSigner.verifyStrict({
              payload: samplePayload,
              signatureHeader: headers['X-Automat-Signature'],
              timestampHeader: headers['X-Automat-Timestamp'],
              secret: validSecret,
              currentTimestamp: now,
              maxFutureSkewSeconds: 60,
            }),
          ClockSkewError
        );
      });

      it('EMPIRICAL: rejects extreme future timestamps (e.g. 1,000,000s in future)', () => {
        const now = 1700000000;
        const futureTimestamp = now + 1000000;

        const headers = OutboundWebhookSigner.sign({
          payload: samplePayload,
          secret: validSecret,
          timestamp: futureTimestamp,
        });

        assert.throws(
          () =>
            OutboundWebhookSigner.verifyStrict({
              payload: samplePayload,
              signatureHeader: headers['X-Automat-Signature'],
              timestampHeader: headers['X-Automat-Timestamp'],
              secret: validSecret,
              currentTimestamp: now,
            }),
          ClockSkewError
        );
      });
    });

    describe('1.3 Cryptographic Tamper & Mutation Attacks', () => {
      it('EMPIRICAL: single byte bit-flip at byte 0, middle, and end invalidates signature', () => {
        const now = 1700000000;
        const headers = OutboundWebhookSigner.sign({
          payload: samplePayload,
          secret: validSecret,
          timestamp: now,
        });

        // Mutate byte 0: '{' -> '['
        const tamperedStart = '[' + samplePayload.slice(1);
        assert.equal(
          OutboundWebhookSigner.verify({
            payload: tamperedStart,
            signatureHeader: headers['X-Automat-Signature'],
            timestampHeader: headers['X-Automat-Timestamp'],
            secret: validSecret,
            currentTimestamp: now,
          }),
          false
        );

        // Mutate middle byte: replace character
        const midIdx = Math.floor(samplePayload.length / 2);
        const tamperedMid =
          samplePayload.substring(0, midIdx) +
          (samplePayload[midIdx] === 'X' ? 'Y' : 'X') +
          samplePayload.substring(midIdx + 1);
        assert.equal(
          OutboundWebhookSigner.verify({
            payload: tamperedMid,
            signatureHeader: headers['X-Automat-Signature'],
            timestampHeader: headers['X-Automat-Timestamp'],
            secret: validSecret,
            currentTimestamp: now,
          }),
          false
        );

        // Mutate end byte: '}' -> ']'
        const tamperedEnd = samplePayload.slice(0, -1) + ']';
        assert.equal(
          OutboundWebhookSigner.verify({
            payload: tamperedEnd,
            signatureHeader: headers['X-Automat-Signature'],
            timestampHeader: headers['X-Automat-Timestamp'],
            secret: validSecret,
            currentTimestamp: now,
          }),
          false
        );
      });

      it('EMPIRICAL: whitespace addition invalidates HMAC signature', () => {
        const now = 1700000000;
        const headers = OutboundWebhookSigner.sign({
          payload: samplePayload,
          secret: validSecret,
          timestamp: now,
        });

        // Trailing newline or space
        for (const appended of ['\n', ' ', '\r\n', '\t']) {
          assert.equal(
            OutboundWebhookSigner.verify({
              payload: samplePayload + appended,
              signatureHeader: headers['X-Automat-Signature'],
              timestampHeader: headers['X-Automat-Timestamp'],
              secret: validSecret,
              currentTimestamp: now,
            }),
            false,
            `Appended whitespace "${JSON.stringify(appended)}" must invalidate signature`
          );
        }
      });

      it('EMPIRICAL: tampering timestamp in header invalidates HMAC signature even if within tolerance', () => {
        const now = 1700000000;
        const headers = OutboundWebhookSigner.sign({
          payload: samplePayload,
          secret: validSecret,
          timestamp: now,
        });

        // Attacker claims timestamp was now - 1
        assert.equal(
          OutboundWebhookSigner.verify({
            payload: samplePayload,
            signatureHeader: headers['X-Automat-Signature'],
            timestampHeader: String(now - 1),
            secret: validSecret,
            currentTimestamp: now,
          }),
          false
        );
      });

      it('EMPIRICAL: tampering signature hash characters or length throws WebhookVerificationError', () => {
        const now = 1700000000;
        const headers = OutboundWebhookSigner.sign({
          payload: samplePayload,
          secret: validSecret,
          timestamp: now,
        });

        const rawSig = headers['X-Automat-Signature']; // "v1=<64-hex>"
        // 1. Bit flip one char in the hex string
        const flippedChar = rawSig.endsWith('0') ? '1' : '0';
        const flippedSig = rawSig.slice(0, -1) + flippedChar;
        assert.throws(
          () =>
            OutboundWebhookSigner.verifyStrict({
              payload: samplePayload,
              signatureHeader: flippedSig,
              timestampHeader: headers['X-Automat-Timestamp'],
              secret: validSecret,
              currentTimestamp: now,
            }),
          WebhookVerificationError
        );

        // 2. Truncate hash (63 hex chars)
        const truncatedSig = rawSig.slice(0, -1);
        assert.throws(
          () =>
            OutboundWebhookSigner.verifyStrict({
              payload: samplePayload,
              signatureHeader: truncatedSig,
              timestampHeader: headers['X-Automat-Timestamp'],
              secret: validSecret,
              currentTimestamp: now,
            }),
          WebhookVerificationError
        );

        // 3. Extend hash (65 hex chars)
        const extendedSig = rawSig + 'a';
        assert.throws(
          () =>
            OutboundWebhookSigner.verifyStrict({
              payload: samplePayload,
              signatureHeader: extendedSig,
              timestampHeader: headers['X-Automat-Timestamp'],
              secret: validSecret,
              currentTimestamp: now,
            }),
          WebhookVerificationError
        );
      });

      it('EMPIRICAL: supports v1=, sha256=, and raw hex, rejects unsupported v2= prefix', () => {
        const now = 1700000000;
        const headers = OutboundWebhookSigner.sign({
          payload: samplePayload,
          secret: validSecret,
          timestamp: now,
        });
        const hex = headers['X-Automat-Signature'].replace('v1=', '');

        // Test sha256= prefix
        assert.equal(
          OutboundWebhookSigner.verify({
            payload: samplePayload,
            signatureHeader: `sha256=${hex}`,
            timestampHeader: headers['X-Automat-Timestamp'],
            secret: validSecret,
            currentTimestamp: now,
          }),
          true
        );

        // Test raw hex without prefix
        assert.equal(
          OutboundWebhookSigner.verify({
            payload: samplePayload,
            signatureHeader: hex,
            timestampHeader: headers['X-Automat-Timestamp'],
            secret: validSecret,
            currentTimestamp: now,
          }),
          true
        );

        // Test unsupported v2= prefix
        assert.equal(
          OutboundWebhookSigner.verify({
            payload: samplePayload,
            signatureHeader: `v2=${hex}`,
            timestampHeader: headers['X-Automat-Timestamp'],
            secret: validSecret,
            currentTimestamp: now,
          }),
          false
        );
      });

      it('EMPIRICAL: handles multibyte UTF-8 payload (emojis and multilingual text) correctly', () => {
        const now = 1700000000;
        const unicodePayload = JSON.stringify({
          msg: '🚀 Lanzamiento campaña éxito — Привет мир! 日本語 🌍',
          amount: '€99.99',
        });

        const headers = OutboundWebhookSigner.sign({
          payload: unicodePayload,
          secret: validSecret,
          timestamp: now,
        });

        assert.equal(
          OutboundWebhookSigner.verify({
            payload: unicodePayload,
            signatureHeader: headers['X-Automat-Signature'],
            timestampHeader: headers['X-Automat-Timestamp'],
            secret: validSecret,
            currentTimestamp: now,
          }),
          true
        );
      });

      it('EMPIRICAL: handles empty string payload gracefully', () => {
        const now = 1700000000;
        const headers = OutboundWebhookSigner.sign({
          payload: '',
          secret: validSecret,
          timestamp: now,
        });

        assert.equal(
          OutboundWebhookSigner.verify({
            payload: '',
            signatureHeader: headers['X-Automat-Signature'],
            timestampHeader: headers['X-Automat-Timestamp'],
            secret: validSecret,
            currentTimestamp: now,
          }),
          true
        );
      });
    });

    describe('1.4 Weak/Short Secret Fail-Closed Enforcement (< 32 bytes)', () => {
      it('EMPIRICAL: rejects ASCII secrets with lengths 0 through 31 bytes', () => {
        for (let len = 0; len < 32; len++) {
          const shortSecret = 'x'.repeat(len);
          assert.throws(
            () => OutboundWebhookSigner.validateSecret(shortSecret),
            InvalidWebhookSecretError,
            `Secret of length ${len} must be rejected`
          );
        }
      });

      it('EMPIRICAL: accepts ASCII secret with exactly 32 bytes', () => {
        const exactSecret = 'x'.repeat(32);
        assert.doesNotThrow(() => OutboundWebhookSigner.validateSecret(exactSecret));
      });

      it('EMPIRICAL: measures byte length correctly on multibyte UTF-8 characters', () => {
        // '🔑' is 4 bytes in UTF-8
        // 7 * 4 = 28 bytes -> should throw
        assert.throws(
          () => OutboundWebhookSigner.validateSecret('🔑'.repeat(7)),
          InvalidWebhookSecretError
        );

        // 7 * 4 + 3 bytes ASCII = 31 bytes -> should throw
        assert.throws(
          () => OutboundWebhookSigner.validateSecret('🔑'.repeat(7) + 'abc'),
          InvalidWebhookSecretError
        );

        // 8 * 4 = 32 bytes -> should succeed
        assert.doesNotThrow(() => OutboundWebhookSigner.validateSecret('🔑'.repeat(8)));
      });

      it('EMPIRICAL: rejects non-string types fail-closed', () => {
        const invalidTypes: any[] = [null, undefined, 12345678901234567890123456789012, true, {}, []];
        for (const item of invalidTypes) {
          assert.throws(
            () => OutboundWebhookSigner.validateSecret(item),
            InvalidWebhookSecretError
          );
        }
      });
    });
  });

  /* ========================================================================
   * 2. SDK Resilience & Paging Adversarial Stress Tests
   * ======================================================================== */
  describe('Area 2: SDK Resilience & Paging Adversarial Stress', () => {
    describe('2.1 HttpClient Retry Logic & Backoff', () => {
      it('EMPIRICAL: retries on 429 Rate Limited and succeeds on 3rd attempt', async () => {
        let attempts = 0;
        const mockFetch = async (): Promise<Response> => {
          attempts++;
          if (attempts < 3) {
            return new Response(JSON.stringify({ title: 'Rate Limited' }), {
              status: 429,
              headers: { 'retry-after': '0' },
            });
          }
          return new Response(JSON.stringify({ success: true, attempts }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        };

        const client = new HttpClient({
          baseUrl: 'http://localhost:3000',
          maxRetries: 3,
          fetchFn: mockFetch as any,
        });

        const res = await client.get<any>('/test-endpoint');
        assert.equal(res.success, true);
        assert.equal(attempts, 3);
      });

      it('EMPIRICAL: retries on 503 Service Unavailable and succeeds on 2nd attempt', async () => {
        let attempts = 0;
        const mockFetch = async (): Promise<Response> => {
          attempts++;
          if (attempts < 2) {
            return new Response(JSON.stringify({ title: 'Service Unavailable' }), {
              status: 503,
              headers: { 'retry-after': '0' },
            });
          }
          return new Response(JSON.stringify({ serviceReady: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        };

        const client = new HttpClient({
          baseUrl: 'http://localhost:3000',
          maxRetries: 2,
          fetchFn: mockFetch as any,
        });

        const res = await client.get<any>('/service-endpoint');
        assert.equal(res.serviceReady, true);
        assert.equal(attempts, 2);
      });

      it('EMPIRICAL: exhausts retries on continuous 429 and throws typed RateLimitedError', async () => {
        let attempts = 0;
        const mockFetch = async (): Promise<Response> => {
          attempts++;
          return new Response(JSON.stringify({ title: 'Rate Limited', detail: 'Too many requests' }), {
            status: 429,
            headers: { 'retry-after': '0' },
          });
        };

        const client = new HttpClient({
          baseUrl: 'http://localhost:3000',
          maxRetries: 2,
          fetchFn: mockFetch as any,
        });

        await assert.rejects(
          async () => client.get('/rate-limit-exhaust'),
          (err: any) => {
            assert.ok(err instanceof RateLimitedError);
            assert.equal(err.status, 429);
            assert.equal(err.retryAfterSeconds, 0);
            return true;
          }
        );

        // initial attempt (1) + 2 retries = 3 attempts total
        assert.equal(attempts, 3);
      });

      it('EMPIRICAL: exhausts retries on continuous 503 and throws typed ServiceUnavailableError', async () => {
        let attempts = 0;
        const mockFetch = async (): Promise<Response> => {
          attempts++;
          return new Response(JSON.stringify({ title: 'Service Unavailable', detail: 'Maintenance mode' }), {
            status: 503,
          });
        };

        const client = new HttpClient({
          baseUrl: 'http://localhost:3000',
          maxRetries: 1,
          fetchFn: mockFetch as any,
        });

        await assert.rejects(
          async () => client.get('/maintenance'),
          (err: any) => {
            assert.ok(err instanceof ServiceUnavailableError);
            assert.equal(err.status, 503);
            return true;
          }
        );

        // initial (1) + 1 retry = 2 attempts total
        assert.equal(attempts, 2);
      });

      it('EMPIRICAL: does NOT retry non-retryable 4xx client errors (400, 401, 403, 404, 409, 422)', async () => {
        const statusCodes = [400, 401, 403, 404, 409, 422];

        for (const status of statusCodes) {
          let attempts = 0;
          const mockFetch = async (): Promise<Response> => {
            attempts++;
            return new Response(JSON.stringify({ title: `Error ${status}`, detail: 'Test' }), {
              status,
            });
          };

          const client = new HttpClient({
            baseUrl: 'http://localhost:3000',
            maxRetries: 3,
            fetchFn: mockFetch as any,
          });

          await assert.rejects(async () => client.get(`/error-${status}`));
          assert.equal(attempts, 1, `Status ${status} should not be retried`);
        }
      });

      it('EMPIRICAL: retries on network exception (fetch throws TypeError) and succeeds', async () => {
        let attempts = 0;
        const mockFetch = async (): Promise<Response> => {
          attempts++;
          if (attempts === 1) {
            throw new TypeError('fetch failed: network socket disconnected');
          }
          return new Response(JSON.stringify({ recovered: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        };

        const client = new HttpClient({
          baseUrl: 'http://localhost:3000',
          maxRetries: 2,
          fetchFn: mockFetch as any,
        });

        const res = await client.get<any>('/network-retry');
        assert.equal(res.recovered, true);
        assert.equal(attempts, 2);
      });

      it('EMPIRICAL: maps timeout AbortError to RFC 7807 504 Gateway Timeout', async () => {
        const mockFetch = async (): Promise<Response> => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          throw err;
        };

        const client = new HttpClient({
          baseUrl: 'http://localhost:3000',
          timeoutMs: 100,
          maxRetries: 0,
          fetchFn: mockFetch as any,
        });

        await assert.rejects(
          async () => client.get('/timeout-test'),
          (err: any) => {
            assert.ok(err instanceof ProblemDetailsError);
            assert.equal(err.status, 504);
            assert.equal(err.detail, 'Request timed out after 100ms');
            return true;
          }
        );
      });

      it('EMPIRICAL: handles 204 No Content without JSON parsing errors', async () => {
        const mockFetch = async (): Promise<Response> => {
          return new Response(null, { status: 204 });
        };

        const client = new HttpClient({
          baseUrl: 'http://localhost:3000',
          fetchFn: mockFetch as any,
        });

        const res = await client.delete<void>('/items/123');
        assert.equal(res, undefined);
      });
    });

    describe('2.2 CursorPager Edge Cases & Defect Resistance', () => {
      it('EMPIRICAL: empty dataset returns empty array and terminates immediately', async () => {
        let calls = 0;
        const fetcher = async (): Promise<PagedResponse<string>> => {
          calls++;
          return { items: [], nextCursor: null, hasMore: false };
        };

        const pager = new CursorPager(fetcher);
        const collected: string[] = [];
        for await (const item of pager) {
          collected.push(item);
        }

        assert.equal(collected.length, 0);
        assert.equal(calls, 1);
        const allRes = await pager.all();
        assert.deepEqual(allRes, []);
      });

      it('EMPIRICAL: single-page dataset terminates without extraneous calls', async () => {
        let calls = 0;
        const fetcher = async (): Promise<PagedResponse<number>> => {
          calls++;
          return { items: [10, 20, 30], nextCursor: null, hasMore: false };
        };

        const pager = new CursorPager(fetcher);
        const collected: number[] = [];
        for await (const item of pager) {
          collected.push(item);
        }

        assert.deepEqual(collected, [10, 20, 30]);
        assert.equal(calls, 1);
      });

      it('EMPIRICAL: multi-page dataset correctly iterates through all pages with cursors', async () => {
        const pages: Record<string, PagedResponse<string>> = {
          initial: { items: ['alpha', 'bravo'], nextCursor: 'cursor_2', hasMore: true },
          cursor_2: { items: ['charlie', 'delta'], nextCursor: 'cursor_3', hasMore: true },
          cursor_3: { items: ['echo'], nextCursor: null, hasMore: false },
        };

        const calledCursors: (string | undefined)[] = [];
        const fetcher = async (cursor?: string): Promise<PagedResponse<string>> => {
          calledCursors.push(cursor);
          return pages[cursor || 'initial']!;
        };

        const pager = new CursorPager(fetcher);
        const collected: string[] = [];
        for await (const item of pager) {
          collected.push(item);
        }

        assert.deepEqual(collected, ['alpha', 'bravo', 'charlie', 'delta', 'echo']);
        assert.deepEqual(calledCursors, [undefined, 'cursor_2', 'cursor_3']);
      });

      it('EMPIRICAL: defect resistance — backend returns hasMore: true but nextCursor: null terminates safely', async () => {
        let calls = 0;
        const buggyFetcher = async (): Promise<PagedResponse<string>> => {
          calls++;
          // Defective backend payload
          return { items: ['item_1'], nextCursor: null, hasMore: true };
        };

        const pager = new CursorPager(buggyFetcher);
        const collected: string[] = [];
        for await (const item of pager) {
          collected.push(item);
        }

        assert.deepEqual(collected, ['item_1']);
        assert.equal(calls, 1, 'Must NOT loop indefinitely when nextCursor is null');
      });

      it('EMPIRICAL: handles empty page with hasMore: true followed by page with items', async () => {
        let calls = 0;
        const fetcher = async (cursor?: string): Promise<PagedResponse<string>> => {
          calls++;
          if (!cursor) {
            return { items: [], nextCursor: 'page_2', hasMore: true };
          }
          return { items: ['valid_item'], nextCursor: null, hasMore: false };
        };

        const pager = new CursorPager(fetcher);
        const collected: string[] = [];
        for await (const item of pager) {
          collected.push(item);
        }

        assert.deepEqual(collected, ['valid_item']);
        assert.equal(calls, 2);
      });

      it('EMPIRICAL: all(maxItems) caps results at requested limit without fetching infinite items', async () => {
        let calls = 0;
        const infiniteFetcher = async (cursor?: string): Promise<PagedResponse<number>> => {
          calls++;
          const start = cursor ? parseInt(cursor, 10) : 0;
          const items = Array.from({ length: 10 }, (_, i) => start + i);
          return { items, nextCursor: String(start + 10), hasMore: true };
        };

        const pager = new CursorPager(infiniteFetcher);
        const capped = await pager.all(15);
        assert.equal(capped.length, 15);
        assert.deepEqual(capped, Array.from({ length: 15 }, (_, i) => i));
        assert.ok(calls <= 2, `Should fetch at most 2 pages, got ${calls}`);
      });
    });

    describe('2.3 RFC 7807 Error Parser & Typed Exception Mapping', () => {
      it('EMPIRICAL: maps all standard RFC 7807 HTTP status codes to typed exceptions', () => {
        const mappings: [number, any, string][] = [
          [401, UnauthorizedError, 'UnauthorizedError'],
          [403, PolicyDeniedError, 'PolicyDeniedError'],
          [404, NotFoundError, 'NotFoundError'],
          [409, ConflictError, 'ConflictError'],
          [422, ValidationError, 'ValidationError'],
          [428, ApprovalRequiredError, 'ApprovalRequiredError'],
          [429, RateLimitedError, 'RateLimitedError'],
          [502, UnknownDeliveryError, 'UnknownDeliveryError'],
          [503, ServiceUnavailableError, 'ServiceUnavailableError'],
        ];

        for (const [statusCode, expectedClass, expectedName] of mappings) {
          const err = createErrorFromResponse(statusCode, {
            type: `https://api.whatsap-automat.com/errors/${statusCode}`,
            title: `Error Title for ${statusCode}`,
            detail: `Detailed explanation for ${statusCode}`,
            instance: `/api/v1/resource/${statusCode}`,
            code: 'TEST_ERROR_CODE',
            correlationId: `corr-${statusCode}`,
          });

          assert.ok(err instanceof expectedClass, `Status ${statusCode} should map to ${expectedName}`);
          assert.equal(err.status, statusCode);
          assert.equal(err.name, expectedName);
          assert.equal(err.detail, `Detailed explanation for ${statusCode}`);
          assert.equal(err.correlationId, `corr-${statusCode}`);
          assert.equal(err.instance, `/api/v1/resource/${statusCode}`);
        }
      });

      it('EMPIRICAL: parses invalidParams in ValidationError', () => {
        const err = createErrorFromResponse(422, {
          title: 'Validation Failed',
          invalidParams: [
            { name: 'email', reason: 'Invalid email format' },
            { name: 'phone', reason: 'Must be E.164' },
          ],
        });

        assert.ok(err instanceof ValidationError);
        assert.equal(err.invalidParams?.length, 2);
        assert.equal(err.invalidParams[0]?.name, 'email');
        assert.equal(err.invalidParams[1]?.name, 'phone');
      });

      it('EMPIRICAL: parses Retry-After header in RateLimitedError', () => {
        const headers = new Headers({ 'retry-after': '120' });
        const err = createErrorFromResponse(429, { title: 'Slow Down' }, headers);

        assert.ok(err instanceof RateLimitedError);
        assert.equal(err.retryAfterSeconds, 120);
      });

      it('EMPIRICAL: gracefully falls back on unexpected non-JSON body or unknown status codes', () => {
        const err = createErrorFromResponse(418, 'I am a teapot non-json string' as any);
        assert.ok(err instanceof ProblemDetailsError);
        assert.equal(err.status, 418);
      });
    });
  });

  /* ========================================================================
   * 3. CLI Packaging & SEC-009 Validation Adversarial Stress Tests
   * ======================================================================== */
  describe('Area 3: CLI Packaging & SEC-009 Validation Adversarial Stress', () => {
    let testDir: string;

    before(() => {
      testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'challenger-cli-test-'));
    });

    after(() => {
      try {
        fs.rmSync(testDir, { recursive: true, force: true });
      } catch (_) {}
    });

    describe('3.1 automat pack: Secret Exclusions & Bundle Integrity', () => {
      it('EMPIRICAL: packaging strictly excludes .env, .env.*, nested node_modules, .git, and .agents', () => {
        const pluginDir = path.join(testDir, 'secret-leak-plugin');
        fs.mkdirSync(pluginDir, { recursive: true });

        // Legitimate extension files
        fs.writeFileSync(
          path.join(pluginDir, 'manifest.json'),
          JSON.stringify({
            name: 'safe-plugin',
            version: '1.0.0',
            type: 'tool',
            entrypoint: './src/index.js',
            permissions: ['tool:execute'],
          })
        );
        fs.mkdirSync(path.join(pluginDir, 'src'), { recursive: true });
        fs.writeFileSync(path.join(pluginDir, 'src/index.js'), 'module.exports = { run() {} };\n');
        fs.mkdirSync(path.join(pluginDir, 'assets'), { recursive: true });
        fs.writeFileSync(path.join(pluginDir, 'assets/icon.png'), 'PNG_FAKE_BYTES');
        fs.mkdirSync(path.join(pluginDir, 'config'), { recursive: true });
        fs.writeFileSync(path.join(pluginDir, 'config/settings.json'), '{"timeout": 5000}\n');

        // Plant forbidden secret files (top-level and nested)
        fs.writeFileSync(path.join(pluginDir, '.env'), 'DATABASE_PASSWORD=supersecret_master\n');
        fs.writeFileSync(path.join(pluginDir, '.env.production'), 'PROD_API_KEY=prod_key_12345\n');
        fs.writeFileSync(path.join(pluginDir, '.env.local'), 'LOCAL_JWT_SECRET=local_jwt_secret\n');
        fs.writeFileSync(path.join(pluginDir, '.env.staging'), 'STAGING_SECRET=staging_secret\n');
        fs.writeFileSync(path.join(pluginDir, '.env.test'), 'TEST_SECRET=test_secret\n');
        fs.writeFileSync(path.join(pluginDir, 'config/.env'), 'NESTED_ENV_SECRET=nested_secret\n');
        fs.writeFileSync(path.join(pluginDir, 'config/.env.local'), 'NESTED_ENV_LOCAL=nested_local\n');

        // Plant unwanted directories (top-level and nested node_modules, .git, .agents, coverage)
        const topNodeModules = path.join(pluginDir, 'node_modules', 'foo');
        fs.mkdirSync(topNodeModules, { recursive: true });
        fs.writeFileSync(path.join(topNodeModules, 'index.js'), 'module.exports = "foo";\n');

        const nestedNodeModules = path.join(pluginDir, 'vendor', 'node_modules', 'bar');
        fs.mkdirSync(nestedNodeModules, { recursive: true });
        fs.writeFileSync(path.join(nestedNodeModules, 'bar.js'), 'module.exports = "bar";\n');

        const gitDir = path.join(pluginDir, '.git');
        fs.mkdirSync(gitDir, { recursive: true });
        fs.writeFileSync(path.join(gitDir, 'config'), '[core] repositoryformatversion = 0\n');

        const coverageDir = path.join(pluginDir, 'coverage');
        fs.mkdirSync(coverageDir, { recursive: true });
        fs.writeFileSync(path.join(coverageDir, 'lcov.info'), 'TN:\n');

        const agentsDir = path.join(pluginDir, '.agents', 'teamwork');
        fs.mkdirSync(agentsDir, { recursive: true });
        fs.writeFileSync(path.join(agentsDir, 'plan.md'), '# Agent Internal Plan\n');

        // Plant dummy tgz and sha256 to verify archive recursion exclusion
        fs.writeFileSync(path.join(pluginDir, 'prev.tgz'), 'OLD_TGZ');
        fs.writeFileSync(path.join(pluginDir, 'prev.tgz.sha256'), 'OLD_SHA');

        // Execute pack
        const { gzBuffer, includedFiles } = packDirectoryToTarGz(pluginDir);

        // Decompress and parse tar entries directly
        const entries = readTarGzEntries(gzBuffer);
        const entryNames = entries.map((e) => e.name);

        // STRICT SECURITY ASSERTIONS:
        // 1. No .env files of any form anywhere in archive
        const envEntries = entryNames.filter((n) => n.split('/').some((part) => part === '.env' || part.startsWith('.env.')));
        assert.deepEqual(envEntries, [], 'CRITICAL: .env secret files leaked into bundle: ' + envEntries.join(', '));

        // 2. No node_modules of any nesting level in archive
        const nmEntries = entryNames.filter((n) => n.split('/').includes('node_modules'));
        assert.deepEqual(nmEntries, [], 'CRITICAL: node_modules leaked into bundle: ' + nmEntries.join(', '));

        // 3. No .git, .agents, coverage, or archives
        const unwantedEntries = entryNames.filter((n) =>
          n.split('/').some((part) => ['.git', '.agents', 'coverage'].includes(part)) ||
          n.endsWith('.tgz') ||
          n.endsWith('.sha256')
        );
        assert.deepEqual(unwantedEntries, [], 'Unwanted metadata leaked into bundle: ' + unwantedEntries.join(', '));

        // 4. Legitimate files MUST be present and uncorrupted
        assert.ok(entryNames.includes('manifest.json'), 'manifest.json missing from bundle');
        assert.ok(entryNames.includes('src/index.js'), 'src/index.js missing from bundle');
        assert.ok(entryNames.includes('assets/icon.png'), 'assets/icon.png missing from bundle');
        assert.ok(entryNames.includes('config/settings.json'), 'config/settings.json missing from bundle');

        // 5. SHA-256 calculation matches archive buffer
        const sha256 = calculateSha256(gzBuffer);
        const expectedHash = crypto.createHash('sha256').update(gzBuffer).digest('hex');
        assert.equal(sha256, expectedHash);
      });
    });

    describe('3.2 automat validate: SEC-009 Forbidden Scopes Enforcement', () => {
      it('EMPIRICAL: rejects every forbidden permission scope under SEC-009 individually', () => {
        const forbiddenScopes = [
          'database.raw_query',
          'system.process',
          'secrets.master_key',
          'filesystem.root',
          'network.raw_socket',
        ];

        for (const scope of forbiddenScopes) {
          const manifestPath = path.join(testDir, `forbidden-${scope.replace(/[^a-z0-9]/g, '-')}.json`);
          fs.writeFileSync(
            manifestPath,
            JSON.stringify({
              name: 'hostile-plugin',
              version: '1.0.0',
              type: 'tool',
              entrypoint: './dist/index.js',
              permissions: ['tool:execute', scope],
            })
          );

          const result = validateManifestFile(manifestPath);
          assert.equal(result.valid, false, `Scope "${scope}" must be rejected under SEC-009`);
          assert.ok(
            result.errors.some((err) => err.includes(scope) && err.includes('SEC-009')),
            `Error message must cite SEC-009 for "${scope}"`
          );
        }
      });

      it('EMPIRICAL: catches multiple forbidden scopes simultaneously', () => {
        const hostileMultiPath = path.join(testDir, 'hostile-multi.json');
        fs.writeFileSync(
          hostileMultiPath,
          JSON.stringify({
            name: 'super-hostile-plugin',
            version: '1.0.0',
            type: 'tool',
            entrypoint: './dist/index.js',
            permissions: [
              'database.raw_query',
              'secrets.master_key',
              'system.process',
              'filesystem.root',
              'network.raw_socket',
            ],
          })
        );

        const result = validateManifestFile(hostileMultiPath);
        assert.equal(result.valid, false);
        assert.equal(result.errors.length, 5, 'Should catch all 5 forbidden scopes');
      });

      it('EMPIRICAL: accepts valid permitted scopes', () => {
        const validPath = path.join(testDir, 'permitted-manifest.json');
        fs.writeFileSync(
          validPath,
          JSON.stringify({
            name: 'permitted-plugin',
            version: '1.0.0',
            type: 'channel',
            entrypoint: './dist/index.js',
            permissions: ['channel:inbound', 'channel:send', 'webhook:receive'],
          })
        );

        const result = validateManifestFile(validPath);
        assert.equal(result.valid, true);
        assert.equal(result.errors.length, 0);
      });
    });

    describe('3.3 automat validate: Semver Version Enforcement', () => {
      it('EMPIRICAL: rejects malformed SemVer strings', () => {
        const malformedVersions = [
          'v1.0.0',       // leading 'v' is not strict semver
          '1.0',          // missing patch
          '1',            // single digit
          'latest',       // tag string
          '1.0.0.0',      // 4 numbers
          'beta-1.0.0',   // prefix prerelease
          '',             // empty string
          '1.0.0_beta',   // underscore in version
        ];

        for (const ver of malformedVersions) {
          const testPath = path.join(testDir, `semver-test-${encodeURIComponent(ver || 'empty')}.json`);
          fs.writeFileSync(
            testPath,
            JSON.stringify({
              name: 'semver-test-plugin',
              version: ver,
              type: 'tool',
              entrypoint: './dist/index.js',
              permissions: ['tool:execute'],
            })
          );

          const result = validateManifestFile(testPath);
          assert.equal(result.valid, false, `Malformed version "${ver}" must be rejected`);
          assert.ok(
            result.errors.some((err) => err.includes('version') || err.includes('SemVer')),
            `Should report version error for "${ver}"`
          );
        }
      });

      it('EMPIRICAL: accepts valid SemVer strings (standard, 0.x, prerelease)', () => {
        const validVersions = [
          '0.1.0',
          '1.0.0',
          '2.14.3',
          '1.0.0-beta.1',
          '1.0.0-rc.2',
        ];

        for (const ver of validVersions) {
          const testPath = path.join(testDir, `semver-valid-${ver}.json`);
          fs.writeFileSync(
            testPath,
            JSON.stringify({
              name: 'semver-valid-plugin',
              version: ver,
              type: 'tool',
              entrypoint: './dist/index.js',
              permissions: ['tool:execute'],
            })
          );

          const result = validateManifestFile(testPath);
          assert.equal(result.valid, true, `Valid version "${ver}" should be accepted`);
        }
      });
    });
  });
});
