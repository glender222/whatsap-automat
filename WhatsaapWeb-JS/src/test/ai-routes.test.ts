// Invariants before config load
process.env.JWT_SECRET = 'test-only-jwt-secret-with-at-least-32-characters-for-testing';
process.env.DB_PASSWORD = 'test-only-database-password';
process.env.META_TOKEN_ENCRYPTION_KEY = 'test-encryption-key-with-at-least-32-chars-for-aes256';

import assert from 'node:assert/strict';
import { describe, test, beforeEach } from 'node:test';
const jwt = require('jsonwebtoken');

const createAiRoutes = require('../routes/ai.routes').default as typeof import('../routes/ai.routes').default;
const { ByokService } = require('../services/ai/gateway/byok/ByokService') as typeof import('../services/ai/gateway/byok/ByokService');
const { QuotaManager } = require('../services/ai/gateway/QuotaManager') as typeof import('../services/ai/gateway/QuotaManager');
const { TokenCostLedger } = require('../services/ai/gateway/TokenCostLedger') as typeof import('../services/ai/gateway/TokenCostLedger');
const { ModelGateway } = require('../services/ai/gateway/ModelGateway') as typeof import('../services/ai/gateway/ModelGateway');
const { SecretCipher } = require('../services/security/SecretCipher') as typeof import('../services/security/SecretCipher');
import type { Queryable } from '../shared/UnitOfWorkPort';
import type { TenantScopedUoW } from '../db/TenantScopedUoW';

// =============================================================================
// Mock In-Memory Database Engine for Route Integration
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

      if (sql.includes('tenant_ai_quotas')) {
        if (trimmed.startsWith('INSERT INTO TENANT_AI_QUOTAS')) {
          const tenantId = params[0];
          const exists = store.quotas.find((q) => q.tenant_id === tenantId);
          if (!exists) {
            store.quotas.push({
              tenant_id: tenantId,
              monthly_cost_limit_micro_usd: 100000000n,
              monthly_token_limit: 10000000n,
              current_month_cost_micro_usd: 0n,
              current_month_tokens_used: 0n,
              hard_limit_enabled: true,
              hard_limit_action: 'block',
              period_start: new Date(Date.UTC(new Date().getFullYear(), new Date().getMonth(), 1)),
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
              period_start: new Date(),
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

  return {
    store,
    async run<T>(tenantId: any, work: (client: Queryable) => Promise<T>): Promise<T> {
      return work(mockClient);
    },
  } as unknown as TenantScopedUoW & { store: typeof store };
}

async function invokeExpressRoute(
  router: any,
  method: 'get' | 'post',
  path: string,
  options: {
    body?: any;
    query?: any;
    params?: any;
    token?: string;
  } = {}
) {
  const layer = router.stack.find(
    (candidate: any) =>
      candidate.route?.path === path && candidate.route?.methods?.[method.toLowerCase()]
  );
  assert.ok(layer, `Route ${method.toUpperCase()} ${path} must exist in router stack`);

  let statusCode = 200;
  let jsonBody: any = null;
  const resHeaders: Record<string, string> = {};

  const req: any = {
    method: method.toUpperCase(),
    params: options.params || {},
    query: options.query || {},
    body: options.body || {},
    headers: options.token ? { authorization: `Bearer ${options.token}` } : {},
    originalUrl: `/api/v1/ai${path}`,
  };

  const res: any = {
    setHeader(name: string, value: string) {
      resHeaders[name.toLowerCase()] = value;
      return res;
    },
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(data: any) {
      jsonBody = data;
      return res;
    },
  };

  for (const mw of layer.route.stack) {
    let calledNext = false;
    let nextErr: any = null;
    try {
      await mw.handle(req, res, (err: any) => {
        calledNext = true;
        nextErr = err;
      });
    } catch (caughtErr) {
      nextErr = caughtErr;
    }

    if (nextErr) {
      return {
        status: nextErr.statusCode || (nextErr.name === 'JsonWebTokenError' ? 401 : 500),
        body: { error: nextErr.code || 'ERROR', message: nextErr.message },
        error: nextErr,
      };
    }

    if (!calledNext) {
      break; // Middleware ended response
    }
  }

  return { status: statusCode, headers: resHeaders, body: jsonBody };
}

describe('PR-F5-01: Express AI Routes Integration (/api/v1/ai)', () => {
  const JWT_SECRET = process.env.JWT_SECRET!;
  let validToken: string;
  let mockUow: ReturnType<typeof createMockUow>;
  let router: any;

  beforeEach(() => {
    validToken = jwt.sign(
      { userId: 42, tenantId: 1, role: 'admin', workspaceId: 10 },
      JWT_SECRET
    );
    mockUow = createMockUow();
    const cipher = new SecretCipher('encryption-key-for-testing-purposes-at-least-32-chars');
    const byok = new ByokService(cipher, mockUow);
    const quota = new QuotaManager(mockUow);
    const ledger = new TokenCostLedger(mockUow);

    const mockFetch = async () => ({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: { role: 'assistant', content: 'Model response via route' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 300, completion_tokens: 100, total_tokens: 400 },
      }),
    });

    const gateway = new ModelGateway(byok, quota, ledger, mockFetch as any);

    router = createAiRoutes({
      gateway,
      byokService: byok,
      quotaManager: quota,
      ledger,
    });
  });

  describe('GET /providers', () => {
    test('rejects unauthenticated request with 401', async () => {
      const res = await invokeExpressRoute(router, 'get', '/providers');
      assert.equal(res.status, 401);
    });

    test('returns list of supported providers with safe masked summaries when authenticated', async () => {
      const res = await invokeExpressRoute(router, 'get', '/providers', {
        token: validToken,
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.equal(Array.isArray(res.body.data), true);
      assert.equal(res.body.data.length, 3); // openai, anthropic, local_openai

      for (const p of res.body.data) {
        assert.equal(p.apiKey, undefined);
        assert.equal(p.encryptedApiKey, undefined);
      }
    });
  });

  describe('POST /providers', () => {
    test('rejects malformed request body with 400', async () => {
      const res = await invokeExpressRoute(router, 'post', '/providers', {
        token: validToken,
        body: { provider: 'openai', apiKey: '' }, // invalid empty key
      });

      assert.equal(res.status, 400);
      assert.equal(res.body.success, false);
      assert.equal(res.body.error, 'VALIDATION_ERROR');
    });

    test('blocks local endpoint with SSRF target using 403 POLICY_DENIED', async () => {
      const res = await invokeExpressRoute(router, 'post', '/providers', {
        token: validToken,
        body: {
          provider: 'local_openai',
          baseUrl: 'http://169.254.169.254/v1',
          defaultModel: 'llama3',
        },
      });

      assert.equal(res.status, 403);
      assert.equal(res.body.success, false);
      assert.equal(res.body.code, 'SSRF_BLOCKED');
      assert.match(res.body.message, /SSRF_BLOCKED/);
    });

    test('saves valid OpenAI credential and returns 200 with masked keyFingerprint', async () => {
      const res = await invokeExpressRoute(router, 'post', '/providers', {
        token: validToken,
        body: {
          provider: 'openai',
          apiKey: 'sk-proj-supersecretkey1234567890abcd',
          defaultModel: 'gpt-4o',
        },
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.keyFingerprint, 'sk-proj-...abcd');
    });
  });

  describe('POST /providers/test', () => {
    test('tests connection and returns 200 with ok status', async () => {
      const res = await invokeExpressRoute(router, 'post', '/providers/test', {
        token: validToken,
        body: {
          provider: 'openai',
          apiKey: 'sk-mock-key-for-test-endpoint',
          model: 'gpt-4o-mini',
        },
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.data.ok, true);
      assert.equal(typeof res.body.data.latencyMs, 'number');
    });
  });

  describe('GET /usage/summary', () => {
    test('returns monthly budget quota and spend summary', async () => {
      const res = await invokeExpressRoute(router, 'get', '/usage/summary', {
        token: validToken,
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.data.monthlyCostLimitMicroUsd, 100000000);
      assert.equal(res.body.data.currentMonthCostMicroUsd, 0);
      assert.equal(res.body.data.currentMonthCostUsd, '0.00');
    });
  });

  describe('GET /usage/ledger', () => {
    test('returns paginated token cost ledger', async () => {
      const res = await invokeExpressRoute(router, 'get', '/usage/ledger', {
        token: validToken,
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.equal(Array.isArray(res.body.data), true);
    });
  });

  describe('POST /completions', () => {
    test('executes model completion via ModelGateway and returns 200', async () => {
      // First register BYOK key
      await invokeExpressRoute(router, 'post', '/providers', {
        token: validToken,
        body: {
          provider: 'openai',
          apiKey: 'sk-proj-live-token-12345678',
          defaultModel: 'gpt-4o',
        },
      });

      const res = await invokeExpressRoute(router, 'post', '/completions', {
        token: validToken,
        body: {
          provider: 'openai',
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'What is the pricing?' }],
        },
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.data.text, 'Model response via route');
      assert.equal(res.body.data.usage.totalTokens, 400);
      assert.equal(typeof res.body.data.costMicroUsd, 'number');
    });
  });
});
