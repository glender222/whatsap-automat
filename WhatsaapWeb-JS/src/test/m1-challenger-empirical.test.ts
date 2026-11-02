// Invariants before config load
process.env.JWT_SECRET = 'test-only-jwt-secret-with-at-least-32-characters-for-testing';
process.env.DB_PASSWORD = 'test-only-database-password';
process.env.META_TOKEN_ENCRYPTION_KEY = 'test-encryption-key-with-at-least-32-chars-for-aes256';

import assert from 'node:assert/strict';
import { describe, test, beforeEach } from 'node:test';
import {
  calculateCostMicroUsd,
  formatMicroUsdToUsd,
  MODEL_RATE_CARDS,
  modelCompletionResultV1Schema,
  FINISH_REASONS,
} from '@whatsap-automat/contracts';

const { CostCalculator } = require('../services/ai/gateway/CostCalculator') as typeof import('../services/ai/gateway/CostCalculator');
const { ByokService } = require('../services/ai/gateway/byok/ByokService') as typeof import('../services/ai/gateway/byok/ByokService');
const { QuotaManager } = require('../services/ai/gateway/QuotaManager') as typeof import('../services/ai/gateway/QuotaManager');
const { TokenCostLedger } = require('../services/ai/gateway/TokenCostLedger') as typeof import('../services/ai/gateway/TokenCostLedger');
const { OpenAiAdapter } = require('../services/ai/gateway/adapters/OpenAiAdapter') as typeof import('../services/ai/gateway/adapters/OpenAiAdapter');
const { AnthropicAdapter } = require('../services/ai/gateway/adapters/AnthropicAdapter') as typeof import('../services/ai/gateway/adapters/AnthropicAdapter');
const { LocalOpenAiAdapter } = require('../services/ai/gateway/adapters/LocalOpenAiAdapter') as typeof import('../services/ai/gateway/adapters/LocalOpenAiAdapter');
const { ModelGateway } = require('../services/ai/gateway/ModelGateway') as typeof import('../services/ai/gateway/ModelGateway');
const { SecretCipher } = require('../services/security/SecretCipher') as typeof import('../services/security/SecretCipher');
import type { Queryable } from '../shared/UnitOfWorkPort';
import type { TenantScopedUoW } from '../db/TenantScopedUoW';

// =============================================================================
// Concurrent In-Memory Mock Database Engine with Thread-Safe Mutex Simulation
// =============================================================================

function createMockUow() {
  const store = {
    providers: [] as any[],
    quotas: [] as any[],
    ledger: [] as any[],
  };

  let nextProviderId = 1;
  let nextLedgerId = 1;

  const mockClient: Queryable = {
    async query(sql: string, params: any[] = []): Promise<any> {
      const trimmed = sql.trim().toUpperCase();

      // 1. tenant_ai_providers
      if (sql.includes('tenant_ai_providers')) {
        if (trimmed.startsWith('INSERT INTO TENANT_AI_PROVIDERS')) {
          const [tenantId, provider, encKey, fingerprint, baseUrl, defaultModel] = params;
          const existingIdx = store.providers.findIndex(
            (p) => p.tenant_id === tenantId && p.provider === provider
          );
          if (existingIdx >= 0) {
            store.providers[existingIdx] = {
              ...store.providers[existingIdx],
              encrypted_api_key: encKey ?? store.providers[existingIdx].encrypted_api_key,
              key_fingerprint: fingerprint ?? store.providers[existingIdx].key_fingerprint,
              base_url: baseUrl,
              default_model: defaultModel ?? store.providers[existingIdx].default_model,
              is_active: true,
              updated_at: new Date(),
            };
            return { rows: [store.providers[existingIdx]], rowCount: 1 };
          }
          const record = {
            id: nextProviderId++,
            tenant_id: tenantId,
            provider,
            encrypted_api_key: encKey,
            key_fingerprint: fingerprint,
            base_url: baseUrl,
            default_model: defaultModel,
            is_active: true,
            created_at: new Date(),
            updated_at: new Date(),
          };
          store.providers.push(record);
          return { rows: [record], rowCount: 1 };
        }

        if (trimmed.startsWith('SELECT')) {
          const tenantId = params[0];
          if (params.length >= 2) {
            const provider = params[1];
            const rows = store.providers.filter(
              (p) => p.tenant_id === tenantId && p.provider === provider
            );
            return { rows, rowCount: rows.length };
          }
          const rows = store.providers.filter((p) => p.tenant_id === tenantId);
          return { rows, rowCount: rows.length };
        }
      }

      // 2. tenant_ai_quotas
      if (sql.includes('tenant_ai_quotas')) {
        if (trimmed.startsWith('INSERT INTO TENANT_AI_QUOTAS')) {
          const tenantId = params[0];
          const exists = store.quotas.find((q) => q.tenant_id === tenantId);
          if (!exists) {
            store.quotas.push({
              tenant_id: tenantId,
              monthly_cost_limit_micro_usd: 100000000n, // $100.00
              monthly_token_limit: 10000000n,          // 10M
              current_month_cost_micro_usd: 0n,
              current_month_tokens_used: 0n,
              hard_limit_enabled: true,
              hard_limit_action: 'block',
              period_start: new Date(Date.UTC(new Date().getFullYear(), new Date().getMonth(), 1)),
              reset_at: new Date(Date.UTC(new Date().getFullYear(), new Date().getMonth() + 1, 1)),
              updated_at: new Date(),
            });
          }
          return { rows: [], rowCount: 1 };
        }

        if (trimmed.startsWith('SELECT')) {
          const tenantId = params[0];
          const row = store.quotas.find((q) => q.tenant_id === tenantId);
          return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
        }

        if (trimmed.startsWith('UPDATE TENANT_AI_QUOTAS')) {
          if (sql.includes('current_month_cost_micro_usd = 0')) {
            const tenantId = params[0];
            const q = store.quotas.find((q) => q.tenant_id === tenantId);
            if (q) {
              q.current_month_cost_micro_usd = 0n;
              q.current_month_tokens_used = 0n;
              q.period_start = new Date();
              q.updated_at = new Date();
            }
            return { rows: [], rowCount: 1 };
          }
          const [costDelta, tokenDelta, tenantId] = params;
          let q = store.quotas.find((item) => item.tenant_id === tenantId);
          if (!q) {
            q = {
              tenant_id: tenantId,
              monthly_cost_limit_micro_usd: 100000000n,
              monthly_token_limit: 10000000n,
              current_month_cost_micro_usd: 0n,
              current_month_tokens_used: 0n,
              hard_limit_enabled: true,
              hard_limit_action: 'block',
              period_start: new Date(Date.UTC(new Date().getFullYear(), new Date().getMonth(), 1)),
              reset_at: new Date(Date.UTC(new Date().getFullYear(), new Date().getMonth() + 1, 1)),
              updated_at: new Date(),
            };
            store.quotas.push(q);
          }
          // Atomic addition as in Postgres UPDATE ... SET counter = counter + delta
          q.current_month_cost_micro_usd = BigInt(q.current_month_cost_micro_usd) + BigInt(costDelta);
          q.current_month_tokens_used = BigInt(q.current_month_tokens_used) + BigInt(tokenDelta);
          q.updated_at = new Date();
          return { rows: [], rowCount: 1 };
        }
      }

      // 3. ai_token_cost_ledger
      if (sql.includes('ai_token_cost_ledger')) {
        if (trimmed.startsWith('INSERT INTO AI_TOKEN_COST_LEDGER')) {
          const record = {
            id: nextLedgerId++,
            tenant_id: params[0],
            workspace_id: params[1],
            agent_id: params[2],
            agent_run_id: params[3],
            conversation_id: params[4],
            provider: params[5],
            model: params[6],
            operation: params[7],
            prompt_tokens: params[8],
            completion_tokens: params[9],
            total_tokens: params[10],
            cost_micro_usd: BigInt(params[11]),
            is_byok: params[12],
            latency_ms: params[13],
            status: params[14],
            metadata_json: params[15],
            created_at: new Date(),
          };
          store.ledger.push(record);
          return { rows: [{ id: record.id }], rowCount: 1 };
        }

        if (trimmed.startsWith('SELECT')) {
          const tenantId = params[0];
          let results = store.ledger.filter((l) => l.tenant_id === tenantId);
          results.sort((a, b) => b.id - a.id);
          return { rows: results, rowCount: results.length };
        }
      }

      return { rows: [], rowCount: 0 };
    },
  };

  const mockUow = {
    store,
    async run<T>(tenantId: any, work: (client: Queryable) => Promise<T>): Promise<T> {
      await new Promise((resolve) => setImmediate(resolve));
      return work(mockClient);
    },
  } as unknown as TenantScopedUoW & { store: typeof store };

  return mockUow;
}

/**
 * Creates a mock fetch function that listens to AbortSignal like the standard Web Fetch API.
 */
function createHangingFetch() {
  return (_url: any, init: any) =>
    new Promise<any>((_resolve, reject) => {
      const signal: AbortSignal | undefined = init?.signal;
      if (signal?.aborted) {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        return reject(err);
      }
      signal?.addEventListener('abort', () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
}

describe('Empirical Challenge Suite: ModelGateway, QuotaManager & TokenCostLedger Robustness', () => {
  // ===========================================================================
  // Vector 1: Concurrency and Quota Hard Limit Race Conditions
  // ===========================================================================
  describe('Vector 1: Concurrency & Quota Hard Limit Handling', () => {
    let mockUow: ReturnType<typeof createMockUow>;
    let quotaManager: QuotaManager;

    beforeEach(() => {
      mockUow = createMockUow();
      quotaManager = new QuotaManager(mockUow);
    });

    test('1.1: 50 concurrent consume() calls atomically accumulate without lost updates', async () => {
      const tenantId = 1;
      const concurrency = 50;
      const costPerCall = 1_000_000; // 1M micro-USD ($1.00)
      const tokensPerCall = 50_000;

      // Initialize quota row
      await quotaManager.assertWithinQuota(tenantId);

      // Launch 50 concurrent increments
      await Promise.all(
        Array.from({ length: concurrency }).map(() =>
          quotaManager.consume(tenantId, costPerCall, tokensPerCall)
        )
      );

      const summary = await quotaManager.getSummary(tenantId);
      assert.equal(
        summary.currentMonthCostMicroUsd,
        concurrency * costPerCall,
        'All 50 increments must be atomically summed with zero lost updates'
      );
      assert.equal(
        summary.currentMonthTokensUsed,
        concurrency * tokensPerCall,
        'All 50 token increments must be atomically summed with zero lost updates'
      );
    });

    test('1.2: 50 concurrent assertWithinQuota() calls all reject when limit is breached', async () => {
      const tenantId = 2;
      // Pre-breach the quota (limit is 100M micro-USD)
      await quotaManager.consume(tenantId, 100_000_000, 5_000_000);

      // Launch 50 concurrent checks
      const results = await Promise.allSettled(
        Array.from({ length: 50 }).map(() => quotaManager.assertWithinQuota(tenantId))
      );

      // Every single call must be rejected with 429 RATE_LIMITED
      const rejected = results.filter((r) => r.status === 'rejected');
      assert.equal(rejected.length, 50, 'All 50 concurrent checks must be blocked');

      for (const r of rejected) {
        if (r.status === 'rejected') {
          assert.equal(r.reason.code, 'RATE_LIMITED');
          assert.equal(r.reason.statusCode, 429);
        }
      }
    });

    test('1.3: Concurrency Window of Vulnerability: In-flight calls during quota boundary', async () => {
      const tenantId = 3;
      const cipher = new SecretCipher('encryption-key-for-testing-purposes-at-least-32-chars');
      const byok = new ByokService(cipher, mockUow);
      const ledger = new TokenCostLedger(mockUow);

      await byok.saveCredential(tenantId, 'openai', 'sk-test-key-12345', null, 'gpt-4o');

      // Set initial quota near hard limit ($9.99 out of $10.00)
      const q = mockUow.store.quotas.find((item) => item.tenant_id === tenantId) || {
        tenant_id: tenantId,
        monthly_cost_limit_micro_usd: 10_000_000n, // $10.00
        monthly_token_limit: 10_000_000n,
        current_month_cost_micro_usd: 9_990_000n,   // $9.99
        current_month_tokens_used: 1_000_000n,
        hard_limit_enabled: true,
        hard_limit_action: 'block',
        period_start: new Date(Date.UTC(new Date().getFullYear(), new Date().getMonth(), 1)),
        reset_at: new Date(Date.UTC(new Date().getFullYear(), new Date().getMonth() + 1, 1)),
        updated_at: new Date(),
      };
      if (!mockUow.store.quotas.some((item) => item.tenant_id === tenantId)) {
        mockUow.store.quotas.push(q);
      } else {
        q.current_month_cost_micro_usd = 9_990_000n;
        q.monthly_cost_limit_micro_usd = 10_000_000n;
      }

      // Mock fetch with artificial 20ms network latency to simulate concurrent requests in flight
      const mockFetch = async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { role: 'assistant', content: 'In flight answer' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 }, // gpt-4o cost = 7500 micro-USD
          }),
        };
      };

      const gateway = new ModelGateway(byok, quotaManager, ledger, mockFetch as any);

      // Launch 5 concurrent calls
      const burstResults = await Promise.allSettled(
        Array.from({ length: 5 }).map(() =>
          gateway.complete({
            schemaVersion: 1,
            tenantId,
            provider: 'openai',
            model: 'gpt-4o',
            messages: [{ role: 'user', content: 'test burst' }],
          })
        )
      );

      // In-flight calls that pre-checked before consumption succeed
      const successfulBurst = burstResults.filter((r) => r.status === 'fulfilled');
      assert.ok(successfulBurst.length > 0, 'Concurrent calls in flight succeed');

      // Subsequent 6th call must be blocked immediately
      await assert.rejects(
        async () => {
          await gateway.complete({
            schemaVersion: 1,
            tenantId,
            provider: 'openai',
            model: 'gpt-4o',
            messages: [{ role: 'user', content: 'post-burst attempt' }],
          });
        },
        (err: any) => err.code === 'RATE_LIMITED' && err.statusCode === 429
      );

      // Confirm ledger correctly recorded all events
      const ledgerCount = mockUow.store.ledger.filter((l) => l.tenant_id === tenantId).length;
      assert.equal(ledgerCount, successfulBurst.length);
    });

    test('1.4: Concurrent calls during month roll-over reset cleanly without corruption', async () => {
      const tenantId = 4;
      // Setup quota record from past date
      mockUow.store.quotas.push({
        tenant_id: tenantId,
        monthly_cost_limit_micro_usd: 100_000_000n,
        monthly_token_limit: 10_000_000n,
        current_month_cost_micro_usd: 100_000_000n, // Was maxed out in past month
        current_month_tokens_used: 10_000_000n,
        hard_limit_enabled: true,
        hard_limit_action: 'block',
        period_start: new Date(2023, 0, 1), // Past date triggers roll-over
        reset_at: new Date(2023, 1, 1),
        updated_at: new Date(2023, 0, 1),
      });

      // 10 concurrent requests at the roll-over moment
      const results = await Promise.allSettled(
        Array.from({ length: 10 }).map(() => quotaManager.assertWithinQuota(tenantId))
      );

      // All 10 must succeed because quota was reset to 0
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      assert.equal(fulfilled.length, 10);

      const summary = await quotaManager.getSummary(tenantId);
      assert.equal(summary.currentMonthCostMicroUsd, 0);
      assert.equal(summary.currentMonthTokensUsed, 0);
    });
  });

  // ===========================================================================
  // Vector 2: Rate Card Calculations with Large Token Numbers (5,000,000 tokens)
  // ===========================================================================
  describe('Vector 2: Large Token Numbers (5,000,000 tokens) & Rate Card Precision', () => {
    test('2.1: Exactly calculates 5,000,000 token costs across all supported models', () => {
      const tokens = 5_000_000;

      // 1. gpt-4o: prompt $2.50/M, completion $10.00/M
      // 5M prompt = 5 * 2.50 = $12.50 = 12,500,000 micro-USD
      // 5M completion = 5 * 10.00 = $50.00 = 50,000,000 micro-USD
      // Total: 62,500,000 micro-USD
      const gpt4oCost = calculateCostMicroUsd('gpt-4o', tokens, tokens);
      assert.equal(gpt4oCost, 62_500_000);
      assert.equal(formatMicroUsdToUsd(gpt4oCost), '62.50');
      assert.equal(Number.isSafeInteger(gpt4oCost), true);

      // 2. gpt-4o-mini: prompt $0.15/M, completion $0.60/M
      // 5M prompt = 5 * 0.15 = $0.75 = 750,000 micro-USD
      // 5M completion = 5 * 0.60 = $3.00 = 3,000,000 micro-USD
      // Total: 3,750,000 micro-USD
      const miniCost = calculateCostMicroUsd('gpt-4o-mini', tokens, tokens);
      assert.equal(miniCost, 3_750_000);
      assert.equal(formatMicroUsdToUsd(miniCost), '3.75');

      // 3. o3-mini: prompt $1.10/M, completion $4.40/M
      // 5M prompt = 5 * 1.10 = $5.50 = 5,500,000 micro-USD
      // 5M completion = 5 * 4.40 = $22.00 = 22,000,000 micro-USD
      // Total: 27,500,000 micro-USD
      const o3Cost = calculateCostMicroUsd('o3-mini', tokens, tokens);
      assert.equal(o3Cost, 27_500_000);
      assert.equal(formatMicroUsdToUsd(o3Cost), '27.50');

      // 4. claude-3-5-sonnet-20241022: prompt $3.00/M, completion $15.00/M
      // 5M prompt = 5 * 3.00 = $15.00 = 15,000,000 micro-USD
      // 5M completion = 5 * 15.00 = $75.00 = 75,000,000 micro-USD
      // Total: 90,000,000 micro-USD
      const sonnetCost = calculateCostMicroUsd('claude-3-5-sonnet-20241022', tokens, tokens);
      assert.equal(sonnetCost, 90_000_000);
      assert.equal(formatMicroUsdToUsd(sonnetCost), '90.00');

      // 5. claude-3-5-haiku-20241022: prompt $0.80/M, completion $4.00/M
      // 5M prompt = 5 * 0.80 = $4.00 = 4,000,000 micro-USD
      // 5M completion = 5 * 4.00 = $20.00 = 20,000,000 micro-USD
      // Total: 24,000,000 micro-USD
      const haikuCost = calculateCostMicroUsd('claude-3-5-haiku-20241022', tokens, tokens);
      assert.equal(haikuCost, 24_000_000);
      assert.equal(formatMicroUsdToUsd(haikuCost), '24.00');

      // 6. local_openai: prompt 0, completion 0
      const localCost = calculateCostMicroUsd('local_openai', tokens, tokens);
      assert.equal(localCost, 0);
      assert.equal(formatMicroUsdToUsd(localCost), '0.00');
    });

    test('2.2: Extreme token scale (100,000,000 tokens) retains safe integer precision', () => {
      const hugeTokens = 100_000_000; // 100M tokens
      const hugeCost = calculateCostMicroUsd('claude-3-5-sonnet-20241022', 0, hugeTokens);
      assert.equal(hugeCost, 1_500_000_000);
      assert.equal(formatMicroUsdToUsd(hugeCost), '1500.00');
      assert.equal(Number.isSafeInteger(hugeCost), true);
      assert.ok(hugeCost < Number.MAX_SAFE_INTEGER);
    });

    test('2.3: Non-round token counts (5,000,001 tokens) rounding behavior', () => {
      // 5,000,001 tokens in gpt-4o:
      // prompt: (5,000,001 * 2,500,000) / 1,000,000 = 12,500,002.5 -> Math.round -> 12,500,003 micro-USD
      const costPrompt = calculateCostMicroUsd('gpt-4o', 5_000_001, 0);
      assert.equal(costPrompt, 12_500_003);

      // Float tokens are floored: 5,000,000.999 is treated as 5,000,000
      const flooredCost = calculateCostMicroUsd('gpt-4o', 5_000_000.999, 0);
      assert.equal(flooredCost, 12_500_000);

      // Negative tokens clamped to 0
      const negCost = calculateCostMicroUsd('gpt-4o', -500, -100);
      assert.equal(negCost, 0);
    });
  });

  // ===========================================================================
  // Vector 3: Timeout Handling when Upstream Provider Hangs
  // ===========================================================================
  describe('Vector 3: Upstream Provider Hangs & Timeout Handling', () => {
    test('3.1: OpenAiAdapter aborts with 504 TIMEOUT when upstream hangs', async () => {
      const adapter = new OpenAiAdapter('test-key', 'https://api.openai.com/v1', createHangingFetch() as any);

      await assert.rejects(
        async () => {
          await adapter.complete({
            schemaVersion: 1,
            tenantId: 1,
            provider: 'openai',
            model: 'gpt-4o',
            messages: [{ role: 'user', content: 'test hang' }],
            timeoutMs: 40, // 40ms timeout
          });
        },
        (err: any) => {
          assert.equal(err.code, 'TIMEOUT');
          assert.equal(err.statusCode, 504);
          assert.match(err.message, /timed out after 40ms/);
          return true;
        }
      );
    });

    test('3.2: AnthropicAdapter aborts with 504 TIMEOUT when upstream hangs', async () => {
      const adapter = new AnthropicAdapter('test-key', 'https://api.anthropic.com/v1', createHangingFetch() as any);

      await assert.rejects(
        async () => {
          await adapter.complete({
            schemaVersion: 1,
            tenantId: 1,
            provider: 'anthropic',
            model: 'claude-3-5-sonnet-20241022',
            messages: [{ role: 'user', content: 'test hang' }],
            timeoutMs: 40,
          });
        },
        (err: any) => {
          assert.equal(err.code, 'TIMEOUT');
          assert.equal(err.statusCode, 504);
          return true;
        }
      );
    });

    test('3.3: ModelGateway records status: timeout in audit ledger and does not consume quota', async () => {
      const mockUow = createMockUow();
      const cipher = new SecretCipher('encryption-key-for-testing-purposes-at-least-32-chars');
      const byok = new ByokService(cipher, mockUow);
      const quota = new QuotaManager(mockUow);
      const ledger = new TokenCostLedger(mockUow);

      await byok.saveCredential(1, 'openai', 'sk-test-openai-key-12345', null, 'gpt-4o');

      const gateway = new ModelGateway(byok, quota, ledger, createHangingFetch() as any);

      const startTime = Date.now();
      await assert.rejects(
        async () => {
          await gateway.complete({
            schemaVersion: 1,
            tenantId: 1,
            provider: 'openai',
            model: 'gpt-4o',
            messages: [{ role: 'user', content: 'Hang gateway' }],
            timeoutMs: 50,
          });
        },
        (err: any) => {
          assert.equal(err.code, 'TIMEOUT');
          assert.equal(err.statusCode, 504);
          return true;
        }
      );
      const elapsed = Date.now() - startTime;
      assert.ok(elapsed >= 45, `Elapsed time ${elapsed}ms should be >= timeoutMs`);

      // Ledger must record the timeout event with cost 0
      assert.equal(mockUow.store.ledger.length, 1);
      const entry = mockUow.store.ledger[0];
      assert.equal(entry.status, 'timeout');
      assert.equal(entry.cost_micro_usd, 0n);
      assert.equal(entry.prompt_tokens, 0);
      assert.equal(entry.completion_tokens, 0);
      assert.ok(entry.latency_ms >= 45);

      // Quota must NOT have been consumed
      const summary = await quota.getSummary(1);
      assert.equal(summary.currentMonthCostMicroUsd, 0);
      assert.equal(summary.currentMonthTokensUsed, 0);
    });
  });

  // ===========================================================================
  // Vector 4: Provider Response Finish Reasons
  // ===========================================================================
  describe('Vector 4: Provider Response Finish Reasons Normalization', () => {
    test('4.1: OpenAiAdapter correctly maps all standard finish reasons', async () => {
      const testCases: Array<{
        choiceReason: string;
        toolCalls?: any[];
        expectedFinishReason: string;
      }> = [
        { choiceReason: 'stop', expectedFinishReason: 'stop' },
        { choiceReason: 'tool_calls', expectedFinishReason: 'tool_calls' },
        { choiceReason: 'length', expectedFinishReason: 'length' },
        { choiceReason: 'content_filter', expectedFinishReason: 'content_filter' },
        {
          choiceReason: 'stop',
          toolCalls: [{ id: 'tc_1', type: 'function', function: { name: 'f', arguments: '{}' } }],
          expectedFinishReason: 'tool_calls',
        },
      ];

      for (const tc of testCases) {
        const mockFetch = async () => ({
          ok: true,
          json: async () => ({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: 'text',
                  tool_calls: tc.toolCalls || [],
                },
                finish_reason: tc.choiceReason,
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
          }),
        });

        const adapter = new OpenAiAdapter('test-key', null, mockFetch as any);
        const result = await adapter.complete({
          schemaVersion: 1,
          tenantId: 1,
          provider: 'openai',
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'test' }],
        });

        assert.equal(
          result.finishReason,
          tc.expectedFinishReason,
          `OpenAI finish_reason '${tc.choiceReason}' must map to '${tc.expectedFinishReason}'`
        );
      }
    });

    test('4.2: AnthropicAdapter correctly maps Anthropic stop reasons', async () => {
      const testCases: Array<{
        stopReason: string;
        content: any[];
        expectedFinishReason: string;
      }> = [
        {
          stopReason: 'end_turn',
          content: [{ type: 'text', text: 'Anthropic end turn' }],
          expectedFinishReason: 'stop',
        },
        {
          stopReason: 'stop_sequence',
          content: [{ type: 'text', text: 'Anthropic stop seq' }],
          expectedFinishReason: 'stop',
        },
        {
          stopReason: 'tool_use',
          content: [{ type: 'tool_use', id: 'tu_1', name: 'search', input: {} }],
          expectedFinishReason: 'tool_calls',
        },
        {
          stopReason: 'max_tokens',
          content: [{ type: 'text', text: 'Anthropic max tokens reached' }],
          expectedFinishReason: 'length',
        },
      ];

      for (const tc of testCases) {
        const mockFetch = async () => ({
          ok: true,
          json: async () => ({
            role: 'assistant',
            content: tc.content,
            stop_reason: tc.stopReason,
            usage: { input_tokens: 15, output_tokens: 15 },
          }),
        });

        const adapter = new AnthropicAdapter('test-key', null, mockFetch as any);
        const result = await adapter.complete({
          schemaVersion: 1,
          tenantId: 1,
          provider: 'anthropic',
          model: 'claude-3-5-sonnet-20241022',
          messages: [{ role: 'user', content: 'test' }],
        });

        assert.equal(
          result.finishReason,
          tc.expectedFinishReason,
          `Anthropic stop_reason '${tc.stopReason}' must map to '${tc.expectedFinishReason}'`
        );
      }
    });

    test('4.3: Canonical schema validates all 5 FINISH_REASONS and rejects invalid reasons', () => {
      // 1. All 5 canonical values validate cleanly
      for (const reason of FINISH_REASONS) {
        const candidate = {
          text: 'test',
          toolCalls: [],
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          costMicroUsd: 100,
          provider: 'openai',
          model: 'gpt-4o',
          finishReason: reason,
          latencyMs: 150,
        };
        const parsed = modelCompletionResultV1Schema.safeParse(candidate);
        assert.equal(parsed.success, true, `Finish reason '${reason}' must pass schema validation`);
      }

      // 2. Unrecognized reason is rejected by schema
      const invalidCandidate = {
        text: 'test',
        toolCalls: [],
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        costMicroUsd: 100,
        provider: 'openai',
        model: 'gpt-4o',
        finishReason: 'cancelled', // not in FINISH_REASONS
        latencyMs: 150,
      };
      const invalidResult = modelCompletionResultV1Schema.safeParse(invalidCandidate);
      assert.equal(invalidResult.success, false, "Unknown finishReason 'cancelled' must fail validation");
    });
  });
});
