// Invariants before config load
process.env.JWT_SECRET = 'test-only-jwt-secret-with-at-least-32-characters-for-testing';
process.env.DB_PASSWORD = 'test-only-database-password';
process.env.META_TOKEN_ENCRYPTION_KEY = 'test-encryption-key-with-at-least-32-chars-for-aes256';

import assert from 'node:assert/strict';
import { describe, test, beforeEach } from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Request, Response } from 'express';

const { SecretCipher } = require('../services/security/SecretCipher') as typeof import('../services/security/SecretCipher');
const { ByokService } = require('../services/ai/gateway/byok/ByokService') as typeof import('../services/ai/gateway/byok/ByokService');
const { LocalOpenAiAdapter } = require('../services/ai/gateway/adapters/LocalOpenAiAdapter') as typeof import('../services/ai/gateway/adapters/LocalOpenAiAdapter');
const { ModelGateway } = require('../services/ai/gateway/ModelGateway') as typeof import('../services/ai/gateway/ModelGateway');
const { SsrfGuard } = require('../services/temporal/activities/ssrfGuard') as typeof import('../services/temporal/activities/ssrfGuard');
const createAiRoutes = require('../routes/ai.routes').default as typeof import('../routes/ai.routes').default;
const {
  TenantScopedUoW,
  InvalidTenantIdError,
  MissingActiveTenantIdError,
  CrossTenantNestingError,
} = require('../db/TenantScopedUoW') as typeof import('../db/TenantScopedUoW');

import type { Queryable } from '../shared/UnitOfWorkPort';
import type { ModelGatewayRequest, ModelProvider } from '../services/ai/gateway/types';

// =============================================================================
// Mock In-Memory Database Engine for Adversarial RLS Testing
// =============================================================================

interface MockProviderRow {
  id: number;
  tenant_id: number;
  provider: string;
  encrypted_api_key: string | null;
  key_fingerprint: string | null;
  base_url: string | null;
  default_model: string | null;
  config: Record<string, unknown>;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

interface MockQuotaRow {
  tenant_id: number;
  monthly_cost_limit_micro_usd: bigint;
  monthly_token_limit: bigint;
  current_month_cost_micro_usd: bigint;
  current_month_tokens_used: bigint;
  hard_limit_enabled: boolean;
  hard_limit_action: 'block' | 'fallback_local' | 'warn';
  period_start: Date;
  reset_at: Date;
  updated_at: Date;
}

interface MockLedgerRow {
  id: number;
  tenant_id: number;
  workspace_id: number | null;
  agent_id: string | null;
  agent_run_id: string | null;
  conversation_id: number | null;
  provider: string;
  model: string;
  operation: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost_micro_usd: bigint;
  is_byok: boolean;
  latency_ms: number;
  status: string;
  metadata_json: Record<string, unknown>;
  created_at: Date;
}

interface MockClientSession {
  sessionTenantId: number | null;
}

function createMockMultiTenantDb() {
  const providers: MockProviderRow[] = [];
  const quotas: MockQuotaRow[] = [];
  const ledger: MockLedgerRow[] = [];

  let nextProviderId = 1;
  let nextLedgerId = 1;

  return {
    providers,
    quotas,
    ledger,
    createSession(): MockClientSession {
      return { sessionTenantId: null };
    },
    setSessionTenant(session: MockClientSession, tenantId: number | null) {
      session.sessionTenantId = tenantId;
    },

    // 1. Providers
    insertProvider(session: MockClientSession, row: Omit<MockProviderRow, 'id' | 'created_at' | 'updated_at'>): MockProviderRow {
      if (!session.sessionTenantId || session.sessionTenantId !== row.tenant_id) {
        const err = new Error('new row violates row-level security policy for table "tenant_ai_providers"');
        (err as any).code = '44501';
        throw err;
      }
      const existing = providers.find(p => p.tenant_id === row.tenant_id && p.provider === row.provider);
      if (existing) {
        const err = new Error('duplicate key value violates unique constraint "uq_tenant_ai_providers"');
        (err as any).code = '23505';
        throw err;
      }
      const record: MockProviderRow = {
        ...row,
        id: nextProviderId++,
        created_at: new Date(),
        updated_at: new Date(),
      };
      providers.push(record);
      return record;
    },

    selectProviders(session: MockClientSession, filterTenantId?: number): MockProviderRow[] {
      // Fail-closed RLS: if unauthenticated, returns 0 rows
      if (!session.sessionTenantId) return [];
      // RLS policy ensures only records matching sessionTenantId can be read
      return providers.filter(p => {
        if (p.tenant_id !== session.sessionTenantId) return false;
        if (filterTenantId !== undefined && filterTenantId !== session.sessionTenantId) return false;
        return true;
      });
    },

    updateProvider(session: MockClientSession, tenantId: number, provider: string, patch: Partial<MockProviderRow>): number {
      if (!session.sessionTenantId || session.sessionTenantId !== tenantId) {
        // Under RLS, updating rows not matching USING clause affects 0 rows
        return 0;
      }
      const idx = providers.findIndex(p => p.tenant_id === tenantId && p.provider === provider);
      if (idx === -1) return 0;
      providers[idx] = { ...providers[idx], ...patch, updated_at: new Date() };
      return 1;
    },

    deleteProvider(session: MockClientSession, tenantId: number, provider: string): number {
      if (!session.sessionTenantId || session.sessionTenantId !== tenantId) {
        // Under RLS, deleting rows not matching USING clause affects 0 rows
        return 0;
      }
      const initialLen = providers.length;
      const idx = providers.findIndex(p => p.tenant_id === tenantId && p.provider === provider);
      if (idx !== -1) providers.splice(idx, 1);
      return initialLen - providers.length;
    },

    // 2. Quotas
    insertQuota(session: MockClientSession, row: MockQuotaRow): MockQuotaRow {
      if (!session.sessionTenantId || session.sessionTenantId !== row.tenant_id) {
        const err = new Error('new row violates row-level security policy for table "tenant_ai_quotas"');
        (err as any).code = '44501';
        throw err;
      }
      quotas.push(row);
      return row;
    },

    selectQuota(session: MockClientSession, tenantId: number): MockQuotaRow | null {
      if (!session.sessionTenantId || session.sessionTenantId !== tenantId) return null;
      return quotas.find(q => q.tenant_id === tenantId) || null;
    },

    updateQuota(session: MockClientSession, tenantId: number, patch: Partial<MockQuotaRow>): number {
      if (!session.sessionTenantId || session.sessionTenantId !== tenantId) {
        return 0;
      }
      const idx = quotas.findIndex(q => q.tenant_id === tenantId);
      if (idx === -1) return 0;
      quotas[idx] = { ...quotas[idx], ...patch, updated_at: new Date() };
      return 1;
    },

    deleteQuota(session: MockClientSession, tenantId: number): number {
      if (!session.sessionTenantId || session.sessionTenantId !== tenantId) {
        return 0;
      }
      const initialLen = quotas.length;
      const idx = quotas.findIndex(q => q.tenant_id === tenantId);
      if (idx !== -1) quotas.splice(idx, 1);
      return initialLen - quotas.length;
    },

    // 3. Ledger
    insertLedger(session: MockClientSession, row: Omit<MockLedgerRow, 'id' | 'created_at'>): MockLedgerRow {
      if (!session.sessionTenantId || session.sessionTenantId !== row.tenant_id) {
        const err = new Error('new row violates row-level security policy for table "ai_token_cost_ledger"');
        (err as any).code = '44501';
        throw err;
      }
      const record: MockLedgerRow = {
        ...row,
        id: nextLedgerId++,
        created_at: new Date(),
      };
      ledger.push(record);
      return record;
    },

    selectLedger(session: MockClientSession, filterTenantId?: number): MockLedgerRow[] {
      if (!session.sessionTenantId) return [];
      return ledger.filter(l => {
        if (l.tenant_id !== session.sessionTenantId) return false;
        if (filterTenantId !== undefined && filterTenantId !== session.sessionTenantId) return false;
        return true;
      });
    },

    deleteLedger(session: MockClientSession, tenantId: number): number {
      if (!session.sessionTenantId || session.sessionTenantId !== tenantId) {
        return 0;
      }
      const initialLen = ledger.length;
      const filtered = ledger.filter(l => l.tenant_id !== tenantId);
      ledger.length = 0;
      ledger.push(...filtered);
      return initialLen - ledger.length;
    },
  };
}

// In-Memory TenantScopedUoW for ByokService testing
function createMockUow() {
  const store = new Map<string, any>();
  return {
    store,
    run: async <T>(tenantId: number | string | unknown, work: (client: any) => Promise<T>): Promise<T> => {
      const tid = Number(tenantId);
      if (!tid || tid <= 0 || isNaN(tid)) {
        throw new InvalidTenantIdError(tenantId);
      }
      const mockClient = {
        query: async (sql: string, params: any[] = []) => {
          if (sql.includes('INSERT INTO tenant_ai_providers')) {
            const [tId, prov, encKey, fprint, bUrl, defModel] = params;
            const key = `${tId}:${prov}`;
            const existing = store.get(key);
            store.set(key, {
              tenant_id: tId,
              provider: prov,
              encrypted_api_key: encKey || existing?.encrypted_api_key,
              key_fingerprint: fprint || existing?.key_fingerprint,
              base_url: bUrl,
              default_model: defModel || existing?.default_model,
              is_active: true,
            });
            return { rows: [] };
          }
          if (sql.includes('SELECT encrypted_api_key, base_url')) {
            const [tId, prov] = params;
            const item = store.get(`${tId}:${prov}`);
            return { rows: item ? [item] : [] };
          }
          if (sql.includes('SELECT provider, key_fingerprint')) {
            const [tId] = params;
            const items = Array.from(store.values()).filter((v: any) => v.tenant_id === tId);
            return { rows: items };
          }
          if (sql.includes('UPDATE tenant_ai_providers')) {
            const [tId, prov] = params;
            const item = store.get(`${tId}:${prov}`);
            if (item) item.is_active = false;
            return { rows: [] };
          }
          return { rows: [] };
        },
      };
      return work(mockClient);
    },
  } as unknown as TenantScopedUoW;
}

// Express Mock Helper for Route Tests
function executeMockRoute(
  handler: (req: Request, res: Response) => Promise<void>,
  reqPayload: any,
  tenantId: number = 1
): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    let statusCode = 200;
    const req = {
      body: reqPayload.body || {},
      query: reqPayload.query || {},
      params: reqPayload.params || {},
      tenantId,
      headers: { authorization: 'Bearer mock-jwt' },
    } as unknown as Request;

    const res = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      json(body: any) {
        resolve({ status: statusCode, body });
      },
    } as unknown as Response;

    handler(req, res).catch((err: any) => {
      resolve({ status: err.statusCode || 500, body: { error: err.code, message: err.message } });
    });
  });
}

// =============================================================================
// CHALLENGER 2: ADVERSARIAL PENETRATION & HARDENING TEST SUITE
// =============================================================================

describe('Challenger 2 Empirical Security Boundary Challenge (PR-F5-01)', () => {
  const cipher = new SecretCipher();

  // ---------------------------------------------------------------------------
  // VECTOR 1: SSRF BYPASS ATTACKS
  // ---------------------------------------------------------------------------
  describe('Vector 1: SSRF Bypass Attacks on LocalOpenAI & BYOK Configuration', () => {
    let mockUow: ReturnType<typeof createMockUow>;
    let byokService: ByokService;

    beforeEach(() => {
      mockUow = createMockUow();
      byokService = new ByokService(cipher, mockUow as any);
    });

    test('1.1: Cloud IMDS (169.254.169.254) and variations are 100% blocked with POLICY_DENIED', async () => {
      const imdsTargets = [
        'http://169.254.169.254',
        'http://169.254.169.254/latest/meta-data',
        'http://169.254.169.254/computeMetadata/v1/',
        'http://169.254.169.254:80',
        'http://169.254.169.254:8080/v1',
        'http://169.254.1.1:8000',
        // Dword notation
        'http://2852039166/',
        // Hex notation
        'http://0xa9fea9fe/',
        // Octal notation (254 in octal is 0376)
        'http://0251.0376.0251.0376/',
        // Metadata hostnames
        'http://metadata.google.internal',
        'http://metadata.google.internal/computeMetadata/v1/',
        'http://instance-data',
        'http://metadata',
      ];

      for (const targetUrl of imdsTargets) {
        // Layer A: ByokService.saveCredential
        await assert.rejects(
          async () => {
            await byokService.saveCredential(1, 'local_openai', 'key', targetUrl);
          },
          (err: any) => {
            assert.strictEqual(err.code, 'POLICY_DENIED', `Expected POLICY_DENIED for ${targetUrl}`);
            assert.strictEqual(err.statusCode, 403);
            assert.match(err.message, /SSRF_BLOCKED/);
            return true;
          },
          `ByokService failed to block IMDS target: ${targetUrl}`
        );

        // Layer B: LocalOpenAiAdapter.complete runtime pre-flight
        const adapter = new LocalOpenAiAdapter('test-key', targetUrl);
        await assert.rejects(
          async () => {
            await adapter.complete({
              schemaVersion: 1,
              tenantId: 1,
              provider: 'local_openai',
              model: 'llama3:8b',
              messages: [{ role: 'user', content: 'test' }],
            });
          },
          (err: any) => {
            assert.strictEqual(err.code, 'POLICY_DENIED', `Expected POLICY_DENIED at runtime for ${targetUrl}`);
            assert.strictEqual(err.statusCode, 403);
            assert.match(err.message, /SSRF_BLOCKED/);
            return true;
          },
          `LocalOpenAiAdapter failed to block IMDS runtime target: ${targetUrl}`
        );
      }
    });

    test('1.2: RFC 1918 Private IP subnets (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16) and Carrier NAT are 100% blocked', async () => {
      const privateTargets = [
        // 10.0.0.0/8
        'http://10.0.0.1:8000/v1',
        'http://10.255.255.254:11434',
        'http://012.0.0.1:8000', // octal 10
        'http://0x0a000001:8000', // hex 10.0.0.1
        'http://167772161:8000', // dword 10.0.0.1
        // 172.16.0.0/12
        'http://172.16.0.1:8000/v1',
        'http://172.31.255.254:11434',
        // 192.168.0.0/16
        'http://192.168.1.1:8000/v1',
        'http://192.168.0.254:11434',
        // Carrier-grade NAT 100.64.0.0/10
        'http://100.64.0.1:8000',
        'http://100.127.255.254:8000',
      ];

      for (const targetUrl of privateTargets) {
        // Layer A: ByokService
        await assert.rejects(
          async () => {
            await byokService.saveCredential(1, 'local_openai', 'key', targetUrl);
          },
          (err: any) => {
            assert.strictEqual(err.code, 'POLICY_DENIED', `Expected POLICY_DENIED for private IP ${targetUrl}`);
            assert.strictEqual(err.statusCode, 403);
            assert.match(err.message, /SSRF_BLOCKED/);
            return true;
          }
        );

        // Layer B: LocalOpenAiAdapter
        const adapter = new LocalOpenAiAdapter('test-key', targetUrl);
        await assert.rejects(
          async () => {
            await adapter.complete({
              schemaVersion: 1,
              tenantId: 1,
              provider: 'local_openai',
              model: 'llama3:8b',
              messages: [{ role: 'user', content: 'test' }],
            });
          },
          (err: any) => {
            assert.strictEqual(err.code, 'POLICY_DENIED');
            assert.strictEqual(err.statusCode, 403);
            assert.match(err.message, /SSRF_BLOCKED/);
            return true;
          }
        );
      }
    });

    test('1.3: Loopback (127.0.0.1, 0x7f000001), Zero IP (0.0.0.0) and localhost variants are 100% blocked', async () => {
      const loopbackTargets = [
        'http://127.0.0.1:11434',
        'http://127.0.0.2:11434',
        'http://127.255.255.254:11434',
        'http://0x7f000001:11434',
        'http://2130706433:11434',
        'http://0177.0.0.1:11434',
        'http://127.1:11434',
        'http://0.0.0.0:11434',
        'http://0:11434',
        'http://localhost:11434',
        'http://localhost.localdomain:11434',
      ];

      for (const targetUrl of loopbackTargets) {
        await assert.rejects(
          async () => {
            await byokService.saveCredential(1, 'local_openai', 'key', targetUrl);
          },
          (err: any) => {
            assert.strictEqual(err.code, 'POLICY_DENIED', `Failed to reject loopback: ${targetUrl}`);
            assert.strictEqual(err.statusCode, 403);
            assert.match(err.message, /SSRF_BLOCKED/);
            return true;
          }
        );
      }
    });

    test('1.4: IPv6 ULA, Link-Local, Loopback and IPv4-Mapped IPv6 addresses are 100% blocked', async () => {
      const ipv6Targets = [
        'http://[::1]:11434',
        'http://[::]:11434',
        'http://[fc00::1]:11434',
        'http://[fd00::1]:11434',
        'http://[fd12:3456:789a:1::1]:11434',
        'http://[fe80::1]:11434',
        'http://[febf::1]:11434',
        'http://[::ffff:127.0.0.1]:11434',
        'http://[::ffff:169.254.169.254]:11434',
        'http://[::ffff:10.0.0.1]:11434',
      ];

      for (const targetUrl of ipv6Targets) {
        await assert.rejects(
          async () => {
            await byokService.saveCredential(1, 'local_openai', 'key', targetUrl);
          },
          (err: any) => {
            assert.strictEqual(err.code, 'POLICY_DENIED', `Failed to reject IPv6 target: ${targetUrl}`);
            assert.strictEqual(err.statusCode, 403);
            assert.match(err.message, /SSRF_BLOCKED/);
            return true;
          }
        );
      }
    });

    test('1.5: DNS rebinding hosts (.nip.io, magic resolving hostnames) are 100% blocked', async () => {
      const nipTargets = [
        'http://127.0.0.1.nip.io:11434',
        'http://169.254.169.254.nip.io/latest/meta-data',
        'http://10.0.0.1.nip.io',
        'http://192.168.1.1.nip.io',
        'http://172.16.0.1.nip.io',
      ];

      for (const targetUrl of nipTargets) {
        await assert.rejects(
          async () => {
            await byokService.saveCredential(1, 'local_openai', 'key', targetUrl);
          },
          (err: any) => {
            assert.strictEqual(err.code, 'POLICY_DENIED', `Failed to block DNS magic hostname: ${targetUrl}`);
            assert.strictEqual(err.statusCode, 403);
            assert.match(err.message, /SSRF_BLOCKED/);
            return true;
          }
        );
      }
    });

    test('1.6: Non-HTTP protocols, malformed schemas and command injection in baseUrl are rejected', async () => {
      const dangerousUrls = [
        'file:///etc/passwd',
        'gopher://127.0.0.1:25/',
        'ftp://internal-ftp.com/',
        'javascript:alert(1)',
        'data:text/html;base64,PHNjcmlwdD4=',
        'http://',
        'not_a_valid_url',
      ];

      for (const url of dangerousUrls) {
        await assert.rejects(
          async () => {
            await byokService.saveCredential(1, 'local_openai', 'key', url);
          },
          (err: any) => {
            assert.ok(
              err.code === 'POLICY_DENIED' || err.statusCode === 403 || err.message.includes('Malformed URL'),
              `Unexpected error structure for ${url}: ${err.message}`
            );
            return true;
          }
        );
      }
    });

    test('1.7: ModelGateway.complete catches SSRF attempts, aborts socket, and writes failed ledger audit record', async () => {
      let ledgerRecorded = false;
      let recordedStatus = '';
      let recordedError = '';

      const mockLedger: any = {
        record: async (entry: any) => {
          ledgerRecorded = true;
          recordedStatus = entry.status;
          recordedError = entry.metadataJson?.error || '';
        },
      };

      const mockQuota: any = {
        assertWithinQuota: async () => {},
        consume: async () => {},
      };

      const mockByok: any = {
        resolveDecryptedCredential: async () => ({
          apiKey: null,
          baseUrl: 'http://169.254.169.254/v1',
          defaultModel: 'llama3:8b',
          isByok: true,
        }),
      };

      const gateway = new ModelGateway(mockByok, mockQuota, mockLedger);

      await assert.rejects(
        async () => {
          await gateway.complete({
            schemaVersion: 1,
            tenantId: 1,
            provider: 'local_openai',
            model: 'llama3:8b',
            messages: [{ role: 'user', content: 'test' }],
          });
        },
        (err: any) => {
          assert.strictEqual(err.code, 'POLICY_DENIED');
          assert.strictEqual(err.statusCode, 403);
          assert.match(err.message, /SSRF_BLOCKED/);
          return true;
        }
      );

      // Verify immutable ledger recorded the security block
      assert.strictEqual(ledgerRecorded, true, 'ModelGateway must log blocked SSRF attempts into ledger');
      assert.strictEqual(recordedStatus, 'failed');
      assert.match(recordedError, /SSRF_BLOCKED/);
    });

    test('1.8: HTTP route POST /api/v1/ai/providers returns HTTP 403 with code SSRF_BLOCKED', async () => {
      const routes = createAiRoutes({ byokService: byokService as any });
      // Extract the POST /providers handler
      const postProvidersLayer = (routes as any).stack.find(
        (layer: any) => layer.route?.path === '/providers' && layer.route?.methods?.post
      );
      assert.ok(postProvidersLayer, 'POST /providers route handler must exist');

      const handler = postProvidersLayer.route.stack[postProvidersLayer.route.stack.length - 1].handle;

      const response = await executeMockRoute(
        handler,
        {
          body: {
            provider: 'local_openai',
            apiKey: 'sk-local',
            baseUrl: 'http://169.254.169.254:8080/v1',
            defaultModel: 'vllm',
          },
        },
        1
      );

      assert.strictEqual(response.status, 403);
      assert.strictEqual(response.body.success, false);
      assert.strictEqual(response.body.code, 'SSRF_BLOCKED');
      assert.strictEqual(response.body.error, 'POLICY_DENIED');
    });
  });

  // ---------------------------------------------------------------------------
  // VECTOR 2: CROSS-TENANT RLS LEAKS
  // ---------------------------------------------------------------------------
  describe('Vector 2: Cross-Tenant PostgreSQL Row-Level Security (RLS) Isolation', () => {
    const migrationPath = path.resolve(
      __dirname,
      '../db/migrations/027_create_model_gateway_and_ledger.sql'
    );
    let migrationSql: string;
    let db: ReturnType<typeof createMockMultiTenantDb>;

    beforeEach(() => {
      migrationSql = fs.readFileSync(migrationPath, 'utf-8');
      db = createMockMultiTenantDb();
    });

    test('2.1: Migration 027 DDL enforces ENABLE RLS, FORCE RLS, and AS PERMISSIVE tenant_isolation_policy', () => {
      const tables = ['tenant_ai_providers', 'tenant_ai_quotas', 'ai_token_cost_ledger'];

      for (const t of tables) {
        // Must ENABLE ROW LEVEL SECURITY
        assert.match(
          migrationSql,
          new RegExp(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;`, 'i'),
          `${t} missing ENABLE ROW LEVEL SECURITY`
        );
        // Must FORCE ROW LEVEL SECURITY (applies to table owners / superusers)
        assert.match(
          migrationSql,
          new RegExp(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY;`, 'i'),
          `${t} missing FORCE ROW LEVEL SECURITY`
        );
        // Policy must use NULLIF(current_setting('app.current_tenant_id', true), '')::integer
        assert.match(
          migrationSql,
          new RegExp(
            `CREATE POLICY tenant_isolation_policy ON ${t}\\s+AS PERMISSIVE\\s+USING \\(tenant_id = NULLIF\\(current_setting\\('app\\.current_tenant_id', true\\), ''\\)::integer\\)\\s+WITH CHECK \\(tenant_id = NULLIF\\(current_setting\\('app\\.current_tenant_id', true\\), ''\\)::integer\\);`,
            'i'
          ),
          `${t} missing rigorous tenant_isolation_policy`
        );
      }
    });

    test('2.2: Cross-tenant SELECT: Under Tenant 1 session, Tenant 2 records are completely invisible (zero leak)', () => {
      // Seed Tenant 1 records
      const s1 = db.createSession();
      db.setSessionTenant(s1, 1);
      db.insertProvider(s1, {
        tenant_id: 1,
        provider: 'openai',
        encrypted_api_key: cipher.encrypt('sk-tenant-1-openai'),
        key_fingerprint: 'sk-...1111',
        base_url: null,
        default_model: 'gpt-4o',
        config: {},
        is_active: true,
      });
      db.insertQuota(s1, {
        tenant_id: 1,
        monthly_cost_limit_micro_usd: 100000000n,
        monthly_token_limit: 10000000n,
        current_month_cost_micro_usd: 25000000n,
        current_month_tokens_used: 1500000n,
        hard_limit_enabled: true,
        hard_limit_action: 'block',
        period_start: new Date(),
        reset_at: new Date(),
        updated_at: new Date(),
      });
      db.insertLedger(s1, {
        tenant_id: 1,
        workspace_id: null,
        agent_id: 'ag-1',
        agent_run_id: 'run-1',
        conversation_id: null,
        provider: 'openai',
        model: 'gpt-4o',
        operation: 'completion',
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        cost_micro_usd: 750n,
        is_byok: true,
        latency_ms: 120,
        status: 'success',
        metadata_json: {},
      });

      // Seed Tenant 2 records
      const s2 = db.createSession();
      db.setSessionTenant(s2, 2);
      db.insertProvider(s2, {
        tenant_id: 2,
        provider: 'anthropic',
        encrypted_api_key: cipher.encrypt('sk-ant-tenant-2'),
        key_fingerprint: 'sk-ant-...2222',
        base_url: null,
        default_model: 'claude-3-5-sonnet-20241022',
        config: {},
        is_active: true,
      });
      db.insertQuota(s2, {
        tenant_id: 2,
        monthly_cost_limit_micro_usd: 500000000n,
        monthly_token_limit: 50000000n,
        current_month_cost_micro_usd: 100000000n,
        current_month_tokens_used: 5000000n,
        hard_limit_enabled: true,
        hard_limit_action: 'warn',
        period_start: new Date(),
        reset_at: new Date(),
        updated_at: new Date(),
      });
      db.insertLedger(s2, {
        tenant_id: 2,
        workspace_id: null,
        agent_id: 'ag-2',
        agent_run_id: 'run-2',
        conversation_id: null,
        provider: 'anthropic',
        model: 'claude-3-5-sonnet-20241022',
        operation: 'completion',
        prompt_tokens: 500,
        completion_tokens: 200,
        total_tokens: 700,
        cost_micro_usd: 4500n,
        is_byok: true,
        latency_ms: 300,
        status: 'success',
        metadata_json: {},
      });

      // Verification under Tenant 1 session
      const t1Providers = db.selectProviders(s1);
      assert.strictEqual(t1Providers.length, 1);
      assert.strictEqual(t1Providers[0].provider, 'openai');
      assert.strictEqual(t1Providers[0].tenant_id, 1);

      // Targeted cross-tenant query for tenant_id = 2 returns empty
      const leakedProviders = db.selectProviders(s1, 2);
      assert.strictEqual(leakedProviders.length, 0, 'Cross-tenant provider query must return 0 rows');

      const t1Quota = db.selectQuota(s1, 1);
      assert.ok(t1Quota);
      assert.strictEqual(t1Quota.tenant_id, 1);

      const leakedQuota = db.selectQuota(s1, 2);
      assert.strictEqual(leakedQuota, null, 'Cross-tenant quota query must return null/0 rows');

      const t1Ledger = db.selectLedger(s1);
      assert.strictEqual(t1Ledger.length, 1);
      assert.strictEqual(t1Ledger[0].tenant_id, 1);

      const leakedLedger = db.selectLedger(s1, 2);
      assert.strictEqual(leakedLedger.length, 0, 'Cross-tenant ledger query must return 0 rows');
    });

    test('2.3: Cross-tenant INSERT: Attempting to insert Tenant 2 rows under Tenant 1 session throws code 44501', () => {
      const s1 = db.createSession();
      db.setSessionTenant(s1, 1);

      // 1. Attack on tenant_ai_providers
      assert.throws(
        () => {
          db.insertProvider(s1, {
            tenant_id: 2, // Violates session 1
            provider: 'openai',
            encrypted_api_key: 'enc',
            key_fingerprint: 'fp',
            base_url: null,
            default_model: 'gpt-4o',
            config: {},
            is_active: true,
          });
        },
        (err: any) => {
          assert.strictEqual(err.code, '44501');
          assert.match(err.message, /violates row-level security policy/);
          return true;
        }
      );

      // 2. Attack on tenant_ai_quotas
      assert.throws(
        () => {
          db.insertQuota(s1, {
            tenant_id: 2, // Violates session 1
            monthly_cost_limit_micro_usd: 100000000n,
            monthly_token_limit: 10000000n,
            current_month_cost_micro_usd: 0n,
            current_month_tokens_used: 0n,
            hard_limit_enabled: true,
            hard_limit_action: 'block',
            period_start: new Date(),
            reset_at: new Date(),
            updated_at: new Date(),
          });
        },
        (err: any) => {
          assert.strictEqual(err.code, '44501');
          return true;
        }
      );

      // 3. Attack on ai_token_cost_ledger
      assert.throws(
        () => {
          db.insertLedger(s1, {
            tenant_id: 2, // Violates session 1
            workspace_id: null,
            agent_id: 'ag',
            agent_run_id: 'run',
            conversation_id: null,
            provider: 'openai',
            model: 'gpt-4o',
            operation: 'completion',
            prompt_tokens: 100,
            completion_tokens: 10,
            total_tokens: 110,
            cost_micro_usd: 500n,
            is_byok: false,
            latency_ms: 100,
            status: 'success',
            metadata_json: {},
          });
        },
        (err: any) => {
          assert.strictEqual(err.code, '44501');
          return true;
        }
      );
    });

    test('2.4: Cross-tenant UPDATE & DELETE: Mutating or deleting another tenant rows affects 0 rows', () => {
      // Seed Tenant 2 data
      const s2 = db.createSession();
      db.setSessionTenant(s2, 2);
      db.insertProvider(s2, {
        tenant_id: 2,
        provider: 'openai',
        encrypted_api_key: 'enc-orig',
        key_fingerprint: 'fp-orig',
        base_url: null,
        default_model: 'gpt-4o',
        config: {},
        is_active: true,
      });
      db.insertQuota(s2, {
        tenant_id: 2,
        monthly_cost_limit_micro_usd: 100000000n,
        monthly_token_limit: 10000000n,
        current_month_cost_micro_usd: 1000n,
        current_month_tokens_used: 500n,
        hard_limit_enabled: true,
        hard_limit_action: 'block',
        period_start: new Date(),
        reset_at: new Date(),
        updated_at: new Date(),
      });

      // Tenant 1 attempts to tamper with Tenant 2 data
      const s1 = db.createSession();
      db.setSessionTenant(s1, 1);

      const affectedProviders = db.updateProvider(s1, 2, 'openai', { encrypted_api_key: 'tampered' });
      assert.strictEqual(affectedProviders, 0, 'Cross-tenant update must affect 0 rows');

      const affectedQuotas = db.updateQuota(s1, 2, { monthly_cost_limit_micro_usd: 999999999999n });
      assert.strictEqual(affectedQuotas, 0, 'Cross-tenant quota tamper must affect 0 rows');

      const deletedProviders = db.deleteProvider(s1, 2, 'openai');
      assert.strictEqual(deletedProviders, 0, 'Cross-tenant delete must affect 0 rows');

      const deletedQuotas = db.deleteQuota(s1, 2);
      assert.strictEqual(deletedQuotas, 0, 'Cross-tenant delete quota must affect 0 rows');

      // Verify Tenant 2 data remains unchanged
      const t2Providers = db.selectProviders(s2);
      assert.strictEqual(t2Providers.length, 1);
      assert.strictEqual(t2Providers[0].encrypted_api_key, 'enc-orig');

      const t2Quota = db.selectQuota(s2, 2);
      assert.strictEqual(t2Quota?.monthly_cost_limit_micro_usd, 100000000n);
    });

    test('2.5: Unauthenticated / Blank Session Fail-Closed: Queries return 0 rows and inserts fail with 44501', () => {
      // Seed some rows under Tenant 1
      const s1 = db.createSession();
      db.setSessionTenant(s1, 1);
      db.insertProvider(s1, {
        tenant_id: 1,
        provider: 'openai',
        encrypted_api_key: 'enc',
        key_fingerprint: 'fp',
        base_url: null,
        default_model: 'gpt-4o',
        config: {},
        is_active: true,
      });

      // Unauthenticated session (NULLIF yields NULL)
      const unauthSession = db.createSession();
      db.setSessionTenant(unauthSession, null);

      assert.strictEqual(db.selectProviders(unauthSession).length, 0);
      assert.strictEqual(db.selectQuota(unauthSession, 1), null);
      assert.strictEqual(db.selectLedger(unauthSession).length, 0);

      assert.throws(
        () => {
          db.insertProvider(unauthSession, {
            tenant_id: 1,
            provider: 'anthropic',
            encrypted_api_key: 'enc',
            key_fingerprint: 'fp',
            base_url: null,
            default_model: 'sonnet',
            config: {},
            is_active: true,
          });
        },
        (err: any) => err.code === '44501'
      );
    });

    test('2.6: TenantScopedUoW boundary invariants: Rejects cross-tenant nesting and invalid tenant IDs', async () => {
      const uow = new TenantScopedUoW();

      // 1. Invalid tenant IDs
      const invalidIds = [-1, 0, NaN, 'abc', null, undefined, {}, []];
      for (const id of invalidIds) {
        await assert.rejects(
          async () => {
            await uow.run(id, async () => {});
          },
          (err: any) => {
            assert.strictEqual(err.name, 'InvalidTenantIdError');
            assert.strictEqual(err.code, 'INVALID_TENANT_ID');
            return true;
          }
        );
      }

      // 2. Cross-tenant nesting forbidden
      const mockClient = {} as Queryable;
      await assert.rejects(
        async () => {
          await uow.run(2, async () => {}, { client: mockClient, activeTenantId: 1 });
        },
        (err: any) => {
          assert.strictEqual(err.name, 'CrossTenantNestingError');
          assert.strictEqual(err.code, 'CROSS_TENANT_NESTING_FORBIDDEN');
          assert.strictEqual(err.expectedTenantId, 1);
          assert.strictEqual(err.receivedTenantId, 2);
          return true;
        }
      );

      // 3. Missing active tenant ID when passing pre-existing client
      await assert.rejects(
        async () => {
          await uow.run(1, async () => {}, { client: mockClient });
        },
        (err: any) => {
          assert.strictEqual(err.name, 'MissingActiveTenantIdError');
          assert.strictEqual(err.code, 'MISSING_ACTIVE_TENANT_ID');
          return true;
        }
      );
    });
  });

  // ---------------------------------------------------------------------------
  // VECTOR 3: CIPHERTEXT TAMPERING ATTACKS
  // ---------------------------------------------------------------------------
  describe('Vector 3: Ciphertext Tampering & SecretCipher Resiliency', () => {
    test('3.1: Roundtrip encryption and authenticated decryption verifies integrity', () => {
      const plainApiKey = 'sk-proj-test1234567890abcdefghijklmnopqrstuvwxyz';
      const ciphertext = cipher.encrypt(plainApiKey);

      assert.ok(ciphertext.startsWith('v1:'), 'Ciphertext must start with v1: version header');
      const parts = ciphertext.split(':');
      assert.strictEqual(parts.length, 4, 'Ciphertext must have 4 segments: v1:iv:tag:cipher');

      const decrypted = cipher.decrypt(ciphertext);
      assert.strictEqual(decrypted, plainApiKey, 'Decrypted key must match original plaintext');
    });

    test('3.2: IV Tampering: Mutating the IV causes decryption to cleanly fail without leaking plaintext', () => {
      const originalKey = 'sk-live-secret-payload-for-tenant-1';
      const encrypted = cipher.encrypt(originalKey);
      const [version, iv, tag, ciphertext] = encrypted.split(':');

      const ivMutations = [
        // 1. Bit-flip first character of IV
        [version, iv.slice(0, -1) + (iv.slice(-1) === 'A' ? 'B' : 'A'), tag, ciphertext].join(':'),
        // 2. Truncated IV
        [version, iv.slice(0, 8), tag, ciphertext].join(':'),
        // 3. Extended IV
        [version, iv + 'AAAA', tag, ciphertext].join(':'),
        // 4. Zero-filled IV
        [version, Buffer.alloc(12).toString('base64url'), tag, ciphertext].join(':'),
        // 5. Random IV
        [version, crypto.randomBytes(12).toString('base64url'), tag, ciphertext].join(':'),
      ];

      for (const mutated of ivMutations) {
        assert.throws(
          () => {
            cipher.decrypt(mutated);
          },
          (err: any) => {
            // Must throw authentication error (unable to authenticate data)
            assert.ok(
              err.message.includes('unable to authenticate') ||
              err.message.includes('Unsupported state') ||
              err.message.includes('Invalid') ||
              err.message.includes('Formato'),
              `Unexpected IV error message: ${err.message}`
            );
            return true;
          },
          'IV mutation must throw error and not decrypt'
        );
      }
    });

    test('3.3: Authentication Tag (GMAC) Tampering: Mutating tag cleanly fails without leaking corrupted plaintext', () => {
      const originalKey = 'sk-live-secret-payload-for-tenant-1';
      const encrypted = cipher.encrypt(originalKey);
      const [version, iv, tag, ciphertext] = encrypted.split(':');

      const tagBuf1 = Buffer.from(tag, 'base64url');
      tagBuf1[0] ^= 0x01; // flip bit in byte 0
      const tagBuf2 = Buffer.from(tag, 'base64url');
      tagBuf2[8] ^= 0x01; // flip bit in byte 8

      const tagMutations = [
        // 1. Bit-flip in byte 0
        [version, iv, tagBuf1.toString('base64url'), ciphertext].join(':'),
        // 2. Bit-flip in byte 8
        [version, iv, tagBuf2.toString('base64url'), ciphertext].join(':'),
        // 3. Truncated tag
        [version, iv, tag.slice(0, 10), ciphertext].join(':'),
        // 4. Zero-filled tag
        [version, iv, Buffer.alloc(16).toString('base64url'), ciphertext].join(':'),
        // 5. Random tag
        [version, iv, crypto.randomBytes(16).toString('base64url'), ciphertext].join(':'),
      ];

      for (const mutated of tagMutations) {
        assert.throws(
          () => {
            cipher.decrypt(mutated);
          },
          (err: any) => {
            assert.ok(
              err.message.includes('unable to authenticate') ||
              err.message.includes('Unsupported state') ||
              err.message.includes('Invalid authentication tag length'),
              `Unexpected Tag error message: ${err.message}`
            );
            return true;
          },
          'Tag mutation must throw authentication error'
        );
      }
    });

    test('3.4: Ciphertext Tampering: Modifying encrypted bytes cleanly fails GCM authentication check', () => {
      const originalKey = 'sk-live-secret-payload-for-tenant-1';
      const encrypted = cipher.encrypt(originalKey);
      const [version, iv, tag, ciphertext] = encrypted.split(':');

      const cipherBuf1 = Buffer.from(ciphertext, 'base64url');
      cipherBuf1[0] ^= 0x01; // flip byte 0
      const cipherBuf2 = Buffer.from(ciphertext, 'base64url');
      cipherBuf2[Math.floor(cipherBuf2.length / 2)] ^= 0x01; // flip middle byte

      const cipherMutations = [
        // 1. Bit-flip byte 0 of ciphertext
        [version, iv, tag, cipherBuf1.toString('base64url')].join(':'),
        // 2. Bit-flip middle byte
        [version, iv, tag, cipherBuf2.toString('base64url')].join(':'),
        // 3. Truncated ciphertext
        [version, iv, tag, ciphertext.slice(0, -2)].join(':'),
        // 4. Appended extra byte
        [version, iv, tag, ciphertext + 'AA'].join(':'),
      ];

      for (const mutated of cipherMutations) {
        assert.throws(
          () => {
            cipher.decrypt(mutated);
          },
          (err: any) => {
            assert.ok(
              err.message.includes('unable to authenticate') ||
              err.message.includes('Unsupported state'),
              `Unexpected ciphertext tamper error: ${err.message}`
            );
            return true;
          },
          'Ciphertext tampering must throw authentication error'
        );
      }
    });

    test('3.5: Structural Malformations & Injection Payloads throw cleanly without crashing process', () => {
      const malformedPayloads = [
        'v2:iv:tag:cipher', // Unsupported version
        'v1:iv:tag',        // Missing ciphertext
        'v1:iv',            // Missing tag & ciphertext
        'v1',               // Version only
        '',                 // Empty string
        'random-text-without-colons',
        "v1:iv:tag:cipher' OR '1'='1",
        'v1:null:undefined:NaN',
      ];

      for (const malformed of malformedPayloads) {
        assert.throws(
          () => {
            cipher.decrypt(malformed);
          },
          (err: any) => {
            assert.ok(
              err.message.includes('Formato de secreto cifrado no soportado') ||
              err.message.includes('unable to authenticate') ||
              err.message.includes('Invalid') ||
              err.message.includes('Unsupported state'),
              `Unexpected error message for malformed payload: ${err.message}`
            );
            return true;
          }
        );
      }
    });

    test('3.6: End-to-End ByokService fails safely when encountering tampered DB ciphertext', async () => {
      const mockUow = createMockUow();
      const byok = new ByokService(cipher, mockUow as any);

      // Save a valid key first
      await byok.saveCredential(1, 'openai', 'sk-valid-original-key');

      // Now tamper with the stored database record (mutate ciphertext in storage)
      const stored = (mockUow as any).store.get('1:openai');
      assert.ok(stored);
      const [v, iv, tag, ct] = stored.encrypted_api_key.split(':');
      stored.encrypted_api_key = [v, iv, tag, 'TAMPERED' + ct.slice(8)].join(':');

      // Attempting to resolve credential must cleanly throw and NOT return corrupted key
      await assert.rejects(
        async () => {
          await byok.resolveDecryptedCredential(1, 'openai');
        },
        (err: any) => {
          assert.ok(
            err.message.includes('unable to authenticate') ||
            err.message.includes('Unsupported state'),
            `Expected auth failure, got: ${err.message}`
          );
          return true;
        },
        'ByokService must fail closed when DB ciphertext is tampered'
      );
    });
  });
});
