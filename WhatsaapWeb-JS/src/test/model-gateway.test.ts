// Invariants before config load
process.env.JWT_SECRET = 'test-only-jwt-secret-with-at-least-32-characters-for-testing';
process.env.DB_PASSWORD = 'test-only-database-password';
process.env.META_TOKEN_ENCRYPTION_KEY = 'test-encryption-key-with-at-least-32-chars-for-aes256';

import assert from 'node:assert/strict';
import { describe, test, beforeEach } from 'node:test';
const { SecretCipher } = require('../services/security/SecretCipher') as typeof import('../services/security/SecretCipher');
const { CostCalculator } = require('../services/ai/gateway/CostCalculator') as typeof import('../services/ai/gateway/CostCalculator');
const { maskApiKey } = require('../services/ai/gateway/byok/keyMasker') as typeof import('../services/ai/gateway/byok/keyMasker');
const { ByokService } = require('../services/ai/gateway/byok/ByokService') as typeof import('../services/ai/gateway/byok/ByokService');
const { QuotaManager } = require('../services/ai/gateway/QuotaManager') as typeof import('../services/ai/gateway/QuotaManager');
const { TokenCostLedger } = require('../services/ai/gateway/TokenCostLedger') as typeof import('../services/ai/gateway/TokenCostLedger');
const { OpenAiAdapter } = require('../services/ai/gateway/adapters/OpenAiAdapter') as typeof import('../services/ai/gateway/adapters/OpenAiAdapter');
const { AnthropicAdapter } = require('../services/ai/gateway/adapters/AnthropicAdapter') as typeof import('../services/ai/gateway/adapters/AnthropicAdapter');
const { LocalOpenAiAdapter } = require('../services/ai/gateway/adapters/LocalOpenAiAdapter') as typeof import('../services/ai/gateway/adapters/LocalOpenAiAdapter');
const { ModelGateway } = require('../services/ai/gateway/ModelGateway') as typeof import('../services/ai/gateway/ModelGateway');
const { TenantScopedUoW } = require('../db/TenantScopedUoW') as typeof import('../db/TenantScopedUoW');
import type { Queryable } from '../shared/UnitOfWorkPort';


// =============================================================================
// Mock In-Memory TenantScopedUoW Database Engine
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

        if (trimmed.startsWith('UPDATE TENANT_AI_PROVIDERS')) {
          const [tenantId, provider] = params;
          const item = store.providers.find(
            (p) => p.tenant_id === tenantId && p.provider === provider
          );
          if (item) {
            item.is_active = false;
            item.updated_at = new Date();
          }
          return { rows: [], rowCount: item ? 1 : 0 };
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
          return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
        }

        if (trimmed.startsWith('UPDATE TENANT_AI_QUOTAS')) {
          // Check if reset or consumption
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
      return work(mockClient);
    },
  } as unknown as TenantScopedUoW & { store: typeof store };

  return mockUow;
}

describe('PR-F5-01: ModelGateway, BYOK, Quotas, and Token Cost Ledger', () => {
  describe('Suite 1: CostCalculator & Deterministic Micro-USD Precision', () => {
    test('1.1: Calculates exact micro-USD costs for OpenAI models', () => {
      // gpt-4o: $2.50 / $10.00 per M -> 1000 prompt = 2500, 500 completion = 5000 -> 7500 micro-USD
      const gpt4oCost = CostCalculator.calculate('gpt-4o', 1000, 500);
      assert.equal(gpt4oCost, 7500);
      assert.equal(CostCalculator.formatToUsd(gpt4oCost), '0.01');

      // gpt-4o-mini: $0.15 / $0.60 per M -> 1000 prompt = 150, 500 completion = 300 -> 450 micro-USD
      const miniCost = CostCalculator.calculate('gpt-4o-mini', 1000, 500);
      assert.equal(miniCost, 450);
      assert.equal(CostCalculator.formatToUsd(miniCost), '0.00');
    });

    test('1.2: Calculates exact micro-USD costs for Anthropic models', () => {
      // claude-3-5-sonnet: $3.00 / $15.00 per M -> 2000 prompt = 6000, 400 completion = 6000 -> 12000 micro-USD
      const sonnetCost = CostCalculator.calculate('claude-3-5-sonnet-20241022', 2000, 400);
      assert.equal(sonnetCost, 12000);

      // claude-3-5-haiku: $0.80 / $4.00 per M -> 5000 prompt = 4000, 1000 completion = 4000 -> 8000 micro-USD
      const haikuCost = CostCalculator.calculate('claude-3-5-haiku-20241022', 5000, 1000);
      assert.equal(haikuCost, 8000);
    });

    test('1.3: Local models produce zero micro-USD cost with full token accounting', () => {
      const localCost = CostCalculator.calculate('local_openai', 10000, 2000);
      assert.equal(localCost, 0);
    });

    test('1.4: Formats large micro-USD amounts accurately', () => {
      assert.equal(CostCalculator.formatToUsd(100000000), '100.00'); // $100.00
      assert.equal(CostCalculator.formatToUsd(12450000), '12.45');   // $12.45
      assert.equal(CostCalculator.formatToUsd(0), '0.00');
    });
  });

  describe('Suite 2: KeyMasker & BYOK Fingerprint Obfuscation', () => {
    test('2.1: Masks standard OpenAI API keys', () => {
      const masked = maskApiKey('sk-1234567890abcdef4f2a');
      assert.equal(masked, 'sk-...4f2a');
    });

    test('2.2: Masks OpenAI project API keys', () => {
      const masked = maskApiKey('sk-proj-9876543210zyxwvut98b1');
      assert.equal(masked, 'sk-proj-...98b1');
    });

    test('2.3: Masks Anthropic API keys', () => {
      const masked = maskApiKey('sk-ant-api03-abcdef1234567890abcd');
      assert.equal(masked, 'sk-ant-...abcd');
    });

    test('2.4: Handles short keys and nullish values safely', () => {
      assert.equal(maskApiKey('12345'), '****');
      assert.equal(maskApiKey(''), null);
      assert.equal(maskApiKey(null), null);
      assert.equal(maskApiKey(undefined), null);
    });
  });

  describe('Suite 3: SecretCipher AES-256-GCM BYOK Security', () => {
    test('3.1: Encrypts and decrypts secret round-trip cleanly', () => {
      const cipher = new SecretCipher('encryption-key-for-testing-purposes-at-least-32-chars');
      const plaintext = 'sk-real-secret-key-12345';
      const encrypted = cipher.encrypt(plaintext);

      assert.match(encrypted, /^v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/);
      const decrypted = cipher.decrypt(encrypted);
      assert.equal(decrypted, plaintext);
    });

    test('3.2: Tampering with ciphertext or authentication tag throws error', () => {
      const cipher = new SecretCipher('encryption-key-for-testing-purposes-at-least-32-chars');
      const encrypted = cipher.encrypt('super-secret-key');
      const parts = encrypted.split(':');

      // Corrupt auth tag
      const corruptedTag = [parts[0], parts[1], 'corruptedtag123456', parts[3]].join(':');
      assert.throws(() => cipher.decrypt(corruptedTag));

      // Corrupt ciphertext
      const corruptedCipher = [parts[0], parts[1], parts[2], 'tamperedciphertext'].join(':');
      assert.throws(() => cipher.decrypt(corruptedCipher));
    });
  });

  describe('Suite 4: ByokService & SSRF Pre-flight Validation', () => {
    let mockUow: ReturnType<typeof createMockUow>;
    let byokService: ByokService;

    beforeEach(() => {
      mockUow = createMockUow();
      const cipher = new SecretCipher('encryption-key-for-testing-purposes-at-least-32-chars');
      byokService = new ByokService(cipher, mockUow);
    });

    test('4.1: Saves and resolves encrypted BYOK credentials for tenant', async () => {
      const saveRes = await byokService.saveCredential(
        1,
        'openai',
        'sk-proj-testkey1234567890abcd',
        null,
        'gpt-4o'
      );
      assert.equal(saveRes.keyFingerprint, 'sk-proj-...abcd');

      const resolved = await byokService.resolveDecryptedCredential(1, 'openai');
      assert.equal(resolved.isByok, true);
      assert.equal(resolved.apiKey, 'sk-proj-testkey1234567890abcd');
      assert.equal(resolved.defaultModel, 'gpt-4o');
    });

    test('4.2: Blocks SSRF targets when saving local endpoint baseUrl (IMDS & Loopback)', async () => {
      // AWS IMDS
      await assert.rejects(
        async () => {
          await byokService.saveCredential(
            1,
            'local_openai',
            undefined,
            'http://169.254.169.254/v1',
            'llama3'
          );
        },
        (err: any) => err.code === 'POLICY_DENIED' && err.statusCode === 403
      );

      // Loopback
      await assert.rejects(
        async () => {
          await byokService.saveCredential(
            1,
            'local_openai',
            undefined,
            'http://127.0.0.1:11434/v1',
            'llama3'
          );
        },
        (err: any) => err.code === 'POLICY_DENIED'
      );
    });

    test('4.3: Emits safe public summaries without exposing API keys', async () => {
      await byokService.saveCredential(1, 'openai', 'sk-test-key-1234567890', null, 'gpt-4o');

      const summaries = await byokService.listCredentialSummaries(1);
      assert.equal(summaries.length, 3); // openai, anthropic, local_openai

      const openaiSummary = summaries.find((s) => s.provider === 'openai');
      assert.ok(openaiSummary);
      assert.equal(openaiSummary.isConfigured, true);
      assert.equal(openaiSummary.keyFingerprint, 'sk-...7890');
      // No sensitive properties on summary
      assert.equal((openaiSummary as any).apiKey, undefined);
      assert.equal((openaiSummary as any).encryptedApiKey, undefined);
    });
  });

  describe('Suite 5: QuotaManager Atomic Spend Enforcement', () => {
    let mockUow: ReturnType<typeof createMockUow>;
    let quotaManager: QuotaManager;

    beforeEach(() => {
      mockUow = createMockUow();
      quotaManager = new QuotaManager(mockUow);
    });

    test('5.1: Allows execution when within monthly budget quota', async () => {
      await assert.doesNotReject(async () => {
        await quotaManager.assertWithinQuota(1);
      });
    });

    test('5.2: Blocks execution with 429 RATE_LIMITED when budget limit breached', async () => {
      // Consume up to and beyond 100M micro-USD ($100.00)
      await quotaManager.consume(1, 100000000, 5000000);

      await assert.rejects(
        async () => {
          await quotaManager.assertWithinQuota(1);
        },
        (err: any) => err.code === 'RATE_LIMITED' && err.statusCode === 429
      );
    });

    test('5.3: Produces accurate dashboard usage summaries', async () => {
      await quotaManager.consume(1, 12500000, 1000000); // $12.50
      const summary = await quotaManager.getSummary(1);

      assert.equal(summary.tenantId, 1);
      assert.equal(summary.currentMonthCostMicroUsd, 12500000);
      assert.equal(summary.currentMonthCostUsd, '12.50');
      assert.equal(summary.percentageCostUsed, 12.5);
      assert.equal(summary.hardLimitEnabled, true);
    });
  });

  describe('Suite 6: Provider Adapters (OpenAI, Anthropic, LocalOpenAI)', () => {
    test('6.1: OpenAiAdapter normalizes text, tool calls and token usage', async () => {
      const mockFetch = async () => {
        return {
          ok: true,
          json: async () => ({
            id: 'chatcmpl-mock-1',
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: 'Test response',
                  tool_calls: [
                    {
                      id: 'call_1',
                      type: 'function',
                      function: {
                        name: 'catalog.search',
                        arguments: JSON.stringify({ query: 'shoes' }),
                      },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
            usage: {
              prompt_tokens: 150,
              completion_tokens: 50,
              total_tokens: 200,
            },
          }),
        } as any;
      };

      const adapter = new OpenAiAdapter('mock-key', null, mockFetch);
      const res = await adapter.complete({
        schemaVersion: 1,
        tenantId: 1,
        provider: 'openai',
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Search shoes' }],
      });

      assert.equal(res.text, 'Test response');
      assert.equal(res.toolCalls.length, 1);
      assert.equal(res.toolCalls[0].name, 'catalog.search');
      assert.deepEqual(res.toolCalls[0].arguments, { query: 'shoes' });
      assert.equal(res.usage.totalTokens, 200);
      assert.equal(res.finishReason, 'tool_calls');
    });

    test('6.2: AnthropicAdapter maps system prompt, tool_use blocks and usage', async () => {
      const mockFetch = async (_url: any, init: any) => {
        const body = JSON.parse(init.body);
        assert.equal(body.system, 'You are an assistant.');
        assert.equal(body.max_tokens, 4096);

        return {
          ok: true,
          json: async () => ({
            id: 'msg_mock_1',
            role: 'assistant',
            content: [
              { type: 'text', text: 'Anthropic text output' },
              { type: 'tool_use', id: 'toolu_1', name: 'order.check', input: { id: 42 } },
            ],
            stop_reason: 'tool_use',
            usage: {
              input_tokens: 220,
              output_tokens: 45,
            },
          }),
        } as any;
      };

      const adapter = new AnthropicAdapter('mock-ant-key', null, mockFetch);
      const res = await adapter.complete({
        schemaVersion: 1,
        tenantId: 1,
        provider: 'anthropic',
        model: 'claude-3-5-sonnet-20241022',
        messages: [
          { role: 'system', content: 'You are an assistant.' },
          { role: 'user', content: 'Check order 42' },
        ],
      });

      assert.equal(res.text, 'Anthropic text output');
      assert.equal(res.toolCalls.length, 1);
      assert.equal(res.toolCalls[0].name, 'order.check');
      assert.deepEqual(res.toolCalls[0].arguments, { id: 42 });
      assert.equal(res.usage.promptTokens, 220);
      assert.equal(res.usage.completionTokens, 45);
      assert.equal(res.usage.totalTokens, 265);
      assert.equal(res.finishReason, 'tool_calls');
    });

    test('6.3: LocalOpenAiAdapter enforces SSRF pre-flight check before making requests', async () => {
      const adapter = new LocalOpenAiAdapter(null, 'http://169.254.169.254:8000/v1');

      await assert.rejects(
        async () => {
          await adapter.complete({
            schemaVersion: 1,
            tenantId: 1,
            provider: 'local_openai',
            model: 'llama3',
            messages: [{ role: 'user', content: 'ping' }],
          });
        },
        (err: any) => err.code === 'POLICY_DENIED' && err.statusCode === 403
      );
    });
  });

  describe('Suite 7: Neutral ModelGateway Facade Full Execution Cycle', () => {
    test('7.1: Executes complete cycle: quota -> credential -> adapter -> cost -> ledger -> consume', async () => {
      const mockUow = createMockUow();
      const cipher = new SecretCipher('encryption-key-for-testing-purposes-at-least-32-chars');
      const byok = new ByokService(cipher, mockUow);
      const quota = new QuotaManager(mockUow);
      const ledger = new TokenCostLedger(mockUow);

      // Save credentials for tenant 1
      await byok.saveCredential(1, 'openai', 'sk-test-proj-key12345678', null, 'gpt-4o');

      const mockFetch = async () => ({
        ok: true,
        json: async () => ({
          choices: [{ message: { role: 'assistant', content: 'Gateway completed successfully' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
        }),
      });

      const gateway = new ModelGateway(byok, quota, ledger, mockFetch as any);

      const result = await gateway.complete({
        schemaVersion: 1,
        tenantId: 1,
        provider: 'openai',
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hello gateway' }],
      });

      assert.equal(result.text, 'Gateway completed successfully');
      assert.equal(result.costMicroUsd, 7500); // 1000 * $2.50/M + 500 * $10.00/M
      assert.equal(result.finishReason, 'stop');

      // Verify immutable ledger entry was recorded
      assert.equal(mockUow.store.ledger.length, 1);
      const ledgerEntry = mockUow.store.ledger[0];
      assert.equal(ledgerEntry.tenant_id, 1);
      assert.equal(ledgerEntry.model, 'gpt-4o');
      assert.equal(ledgerEntry.cost_micro_usd, 7500n);
      assert.equal(ledgerEntry.is_byok, true);
      assert.equal(ledgerEntry.status, 'success');

      // Verify quota was consumed
      const quotaEntry = mockUow.store.quotas.find((q) => q.tenant_id === 1);
      assert.ok(quotaEntry);
      assert.equal(quotaEntry.current_month_cost_micro_usd, 7500n);
      assert.equal(quotaEntry.current_month_tokens_used, 1500n);
    });

    test('7.2: Records failure entry in ledger when provider adapter fails', async () => {
      const mockUow = createMockUow();
      const cipher = new SecretCipher('encryption-key-for-testing-purposes-at-least-32-chars');
      const byok = new ByokService(cipher, mockUow);
      const quota = new QuotaManager(mockUow);
      const ledger = new TokenCostLedger(mockUow);

      await byok.saveCredential(1, 'openai', 'sk-test-proj-key12345678', null, 'gpt-4o');

      const mockFetch = async () => ({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error from upstream',
      });

      const gateway = new ModelGateway(byok, quota, ledger, mockFetch as any);

      await assert.rejects(async () => {
        await gateway.complete({
          schemaVersion: 1,
          tenantId: 1,
          provider: 'openai',
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'Fail this' }],
        });
      });

      // Assert failed call is logged in ledger
      assert.equal(mockUow.store.ledger.length, 1);
      assert.equal(mockUow.store.ledger[0].status, 'failed');
    });
  });
});
