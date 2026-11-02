// Invariants before config load
process.env.JWT_SECRET = 'test-only-jwt-secret-with-at-least-32-characters-for-testing';
process.env.DB_PASSWORD = 'test-only-database-password';

import assert from 'node:assert/strict';
import { describe, test, beforeEach } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

// =============================================================================
// Mock In-Memory Database Engine for Migration 027 RLS Verification
// =============================================================================

interface ProviderRecord {
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

interface QuotaRecord {
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

interface LedgerRecord {
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

interface MockClientState {
  sessionTenantId: number | null;
  inTransaction: boolean;
}

function createMockGatewayDb() {
  const tables = {
    tenant_ai_providers: [] as ProviderRecord[],
    tenant_ai_quotas: [] as QuotaRecord[],
    ai_token_cost_ledger: [] as LedgerRecord[],
  };

  let nextProviderId = 1;
  let nextLedgerId = 1;

  return {
    tables,
    createClientState(): MockClientState {
      return { sessionTenantId: null, inTransaction: false };
    },
    setSessionTenant(state: MockClientState, tenantId: number | null) {
      state.sessionTenantId = tenantId;
    },

    // 1. Providers
    insertProvider(state: MockClientState, row: Omit<ProviderRecord, 'id' | 'created_at' | 'updated_at'>): ProviderRecord {
      if (!state.sessionTenantId || state.sessionTenantId !== row.tenant_id) {
        const err = new Error('new row violates row-level security policy for table "tenant_ai_providers"');
        (err as any).code = '44501';
        throw err;
      }
      const allowedProviders = ['openai', 'anthropic', 'local_openai', 'ollama', 'vllm'];
      if (!allowedProviders.includes(row.provider)) {
        const err = new Error('value violates check constraint "chk_tenant_ai_providers_provider"');
        (err as any).code = '23514';
        throw err;
      }
      const exists = tables.tenant_ai_providers.find(p => p.tenant_id === row.tenant_id && p.provider === row.provider);
      if (exists) {
        const err = new Error('duplicate key value violates unique constraint "uq_tenant_ai_providers"');
        (err as any).code = '23505';
        throw err;
      }
      const record: ProviderRecord = {
        ...row,
        id: nextProviderId++,
        created_at: new Date(),
        updated_at: new Date(),
      };
      tables.tenant_ai_providers.push(record);
      return record;
    },

    selectProviders(state: MockClientState): ProviderRecord[] {
      if (!state.sessionTenantId) return []; // Fail-closed RLS
      return tables.tenant_ai_providers.filter(p => p.tenant_id === state.sessionTenantId);
    },

    // 2. Quotas
    upsertQuota(state: MockClientState, row: QuotaRecord): QuotaRecord {
      if (!state.sessionTenantId || state.sessionTenantId !== row.tenant_id) {
        const err = new Error('new row violates row-level security policy for table "tenant_ai_quotas"');
        (err as any).code = '44501';
        throw err;
      }
      if (
        row.monthly_cost_limit_micro_usd < 0n ||
        row.current_month_cost_micro_usd < 0n ||
        row.monthly_token_limit < 0n ||
        row.current_month_tokens_used < 0n
      ) {
        const err = new Error('value violates check constraint "chk_tenant_ai_quotas_non_negative"');
        (err as any).code = '23514';
        throw err;
      }
      const allowedActions = ['block', 'fallback_local', 'warn'];
      if (!allowedActions.includes(row.hard_limit_action)) {
        const err = new Error('value violates check constraint "chk_tenant_ai_quotas_action"');
        (err as any).code = '23514';
        throw err;
      }
      const idx = tables.tenant_ai_quotas.findIndex(q => q.tenant_id === row.tenant_id);
      if (idx >= 0) {
        tables.tenant_ai_quotas[idx] = { ...row, updated_at: new Date() };
        return tables.tenant_ai_quotas[idx];
      }
      tables.tenant_ai_quotas.push(row);
      return row;
    },

    selectQuota(state: MockClientState, tenantId: number): QuotaRecord | null {
      if (!state.sessionTenantId || state.sessionTenantId !== tenantId) return null; // Fail-closed RLS
      return tables.tenant_ai_quotas.find(q => q.tenant_id === tenantId) || null;
    },

    // 3. Ledger
    insertLedger(state: MockClientState, row: Omit<LedgerRecord, 'id' | 'created_at'>): LedgerRecord {
      if (!state.sessionTenantId || state.sessionTenantId !== row.tenant_id) {
        const err = new Error('new row violates row-level security policy for table "ai_token_cost_ledger"');
        (err as any).code = '44501';
        throw err;
      }
      if (row.prompt_tokens < 0 || row.completion_tokens < 0 || row.total_tokens < 0 || row.cost_micro_usd < 0n) {
        const err = new Error('value violates check constraint "chk_ai_ledger_tokens_non_negative"');
        (err as any).code = '23514';
        throw err;
      }
      const allowedOps = ['completion', 'embedding', 'eval', 'tool_reasoning'];
      if (!allowedOps.includes(row.operation)) {
        const err = new Error('value violates check constraint "chk_ai_ledger_operation"');
        (err as any).code = '23514';
        throw err;
      }
      const record: LedgerRecord = {
        ...row,
        id: nextLedgerId++,
        created_at: new Date(),
      };
      tables.ai_token_cost_ledger.push(record);
      return record;
    },

    selectLedger(state: MockClientState): LedgerRecord[] {
      if (!state.sessionTenantId) return []; // Fail-closed RLS
      return tables.ai_token_cost_ledger.filter(l => l.tenant_id === state.sessionTenantId);
    },

    // 4. Cascade delete
    deleteTenantCascade(tenantId: number) {
      tables.tenant_ai_providers = tables.tenant_ai_providers.filter(p => p.tenant_id !== tenantId);
      tables.tenant_ai_quotas = tables.tenant_ai_quotas.filter(q => q.tenant_id !== tenantId);
      tables.ai_token_cost_ledger = tables.ai_token_cost_ledger.filter(l => l.tenant_id !== tenantId);
    },
  };
}

describe('PR-F5-01: Migration 027 - ModelGateway BYOK, Quotas & Token Cost Ledger', () => {
  const migrationPath = path.resolve(
    __dirname,
    '../db/migrations/027_create_model_gateway_and_ledger.sql'
  );

  let migrationSql: string;

  beforeEach(() => {
    assert.ok(fs.existsSync(migrationPath), `Migration file must exist at ${migrationPath}`);
    migrationSql = fs.readFileSync(migrationPath, 'utf-8');
  });

  describe('Suite 1: Static DDL & Integrity Contract Verification', () => {
    test('1.1: Migration 027 file exists and references Phase F5 specifications', () => {
      assert.match(migrationSql, /Migration 027/i);
      assert.match(migrationSql, /PR-F5-01/i);
      assert.match(migrationSql, /WAA-012/i);
      assert.match(migrationSql, /PROD-009/i);
      assert.match(migrationSql, /PROD-017/i);
      assert.match(migrationSql, /ADR-011/i);
    });

    test('1.2: Defines tenant_ai_providers with provider whitelist and unique constraint', () => {
      assert.match(migrationSql, /CREATE TABLE IF NOT EXISTS tenant_ai_providers/i);
      assert.match(migrationSql, /CONSTRAINT uq_tenant_ai_providers UNIQUE \(tenant_id, provider\)/i);
      assert.match(migrationSql, /chk_tenant_ai_providers_provider CHECK/i);
      assert.match(migrationSql, /'openai'/);
      assert.match(migrationSql, /'anthropic'/);
      assert.match(migrationSql, /'local_openai'/);
      assert.match(migrationSql, /idx_tenant_ai_providers_lookup/i);
    });

    test('1.3: Defines tenant_ai_quotas with micro-USD integer fields and non-negative checks', () => {
      assert.match(migrationSql, /CREATE TABLE IF NOT EXISTS tenant_ai_quotas/i);
      assert.match(migrationSql, /monthly_cost_limit_micro_usd BIGINT/i);
      assert.match(migrationSql, /current_month_cost_micro_usd BIGINT/i);
      assert.match(migrationSql, /chk_tenant_ai_quotas_non_negative CHECK/i);
      assert.match(migrationSql, /chk_tenant_ai_quotas_action CHECK/i);
      assert.match(migrationSql, /'block'/);
      assert.match(migrationSql, /'fallback_local'/);
      assert.match(migrationSql, /'warn'/);
    });

    test('1.4: Defines ai_token_cost_ledger with token counts, micro-USD cost and indexes', () => {
      assert.match(migrationSql, /CREATE TABLE IF NOT EXISTS ai_token_cost_ledger/i);
      assert.match(migrationSql, /prompt_tokens INTEGER/i);
      assert.match(migrationSql, /completion_tokens INTEGER/i);
      assert.match(migrationSql, /total_tokens INTEGER/i);
      assert.match(migrationSql, /cost_micro_usd BIGINT/i);
      assert.match(migrationSql, /chk_ai_ledger_tokens_non_negative CHECK/i);
      assert.match(migrationSql, /chk_ai_ledger_operation CHECK/i);
      assert.match(migrationSql, /chk_ai_ledger_status CHECK/i);
      assert.match(migrationSql, /idx_ai_token_cost_ledger_tenant_time/i);
      assert.match(migrationSql, /idx_ai_token_cost_ledger_run/i);
    });

    test('1.5: Enforces RLS with FORCE ROW LEVEL SECURITY and AS PERMISSIVE on all 3 tables', () => {
      const tables = ['tenant_ai_providers', 'tenant_ai_quotas', 'ai_token_cost_ledger'];
      for (const t of tables) {
        const enableRegex = new RegExp(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;`, 'i');
        const forceRegex = new RegExp(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY;`, 'i');
        const policyRegex = new RegExp(`CREATE POLICY tenant_isolation_policy ON ${t}\\s+AS PERMISSIVE`, 'i');
        assert.match(migrationSql, enableRegex);
        assert.match(migrationSql, forceRegex);
        assert.match(migrationSql, policyRegex);
      }
      assert.match(migrationSql, /current_setting\('app\.current_tenant_id', true\)/);
    });

    test('1.6: Idempotent backfill seeds default quotas for existing tenants', () => {
      assert.match(migrationSql, /INSERT INTO tenant_ai_quotas/i);
      assert.match(migrationSql, /SELECT\s+t\.id/i);
      assert.match(migrationSql, /FROM tenants t/i);
      assert.match(migrationSql, /ON CONFLICT \(tenant_id\) DO NOTHING/i);
    });

    test('1.7: Revert script in comment block executes reverse topological drops idempotently', () => {
      assert.match(migrationSql, /DROP TABLE IF EXISTS ai_token_cost_ledger/i);
      assert.match(migrationSql, /DROP TABLE IF EXISTS tenant_ai_quotas/i);
      assert.match(migrationSql, /DROP TABLE IF EXISTS tenant_ai_providers/i);
    });
  });

  describe('Suite 2: Multi-Tenant RLS Dynamic Isolation Simulation', () => {
    let db: ReturnType<typeof createMockGatewayDb>;

    beforeEach(() => {
      db = createMockGatewayDb();
    });

    test('2.1: Fail-closed isolation: Unauthenticated queries return 0 rows', () => {
      const unauthClient = db.createClientState();
      // Populate records under tenant 1 and 2
      const client1 = db.createClientState();
      db.setSessionTenant(client1, 1);
      db.insertProvider(client1, {
        tenant_id: 1,
        provider: 'openai',
        encrypted_api_key: 'v1:iv:tag:secret',
        key_fingerprint: 'sk-...4a2b',
        base_url: null,
        default_model: 'gpt-4o',
        config: {},
        is_active: true,
      });

      // Unauthenticated query sees 0 rows
      const results = db.selectProviders(unauthClient);
      assert.equal(results.length, 0);
      assert.equal(db.selectLedger(unauthClient).length, 0);
    });

    test('2.2: Cross-tenant read isolation: Tenant 1 cannot select Tenant 2 data', () => {
      const client1 = db.createClientState();
      db.setSessionTenant(client1, 1);
      db.insertProvider(client1, {
        tenant_id: 1,
        provider: 'openai',
        encrypted_api_key: 'v1:iv1:tag1:secret1',
        key_fingerprint: 'sk-...1111',
        base_url: null,
        default_model: 'gpt-4o',
        config: {},
        is_active: true,
      });

      const client2 = db.createClientState();
      db.setSessionTenant(client2, 2);
      db.insertProvider(client2, {
        tenant_id: 2,
        provider: 'anthropic',
        encrypted_api_key: 'v1:iv2:tag2:secret2',
        key_fingerprint: 'sk-ant-...2222',
        base_url: null,
        default_model: 'claude-3-5-sonnet-20241022',
        config: {},
        is_active: true,
      });

      const tenant1Providers = db.selectProviders(client1);
      assert.equal(tenant1Providers.length, 1);
      assert.equal(tenant1Providers[0].provider, 'openai');

      const tenant2Providers = db.selectProviders(client2);
      assert.equal(tenant2Providers.length, 1);
      assert.equal(tenant2Providers[0].provider, 'anthropic');
    });

    test('2.3: Cross-tenant write rejection: Inserting row with tenant_id = 2 under session 1 throws 44501', () => {
      const client1 = db.createClientState();
      db.setSessionTenant(client1, 1);

      assert.throws(
        () => {
          db.insertProvider(client1, {
            tenant_id: 2, // Mismatch with sessionTenantId = 1
            provider: 'openai',
            encrypted_api_key: 'v1:iv:tag:secret',
            key_fingerprint: 'sk-...4a2b',
            base_url: null,
            default_model: 'gpt-4o',
            config: {},
            is_active: true,
          });
        },
        (err: any) => err.code === '44501'
      );
    });

    test('2.4: Tenant BYOK uniqueness: Duplicate provider per tenant throws 23505; distinct tenants succeed', () => {
      const client1 = db.createClientState();
      db.setSessionTenant(client1, 1);

      db.insertProvider(client1, {
        tenant_id: 1,
        provider: 'openai',
        encrypted_api_key: 'v1:iv:tag:key1',
        key_fingerprint: 'sk-...1111',
        base_url: null,
        default_model: 'gpt-4o',
        config: {},
        is_active: true,
      });

      // Duplicate for tenant 1
      assert.throws(
        () => {
          db.insertProvider(client1, {
            tenant_id: 1,
            provider: 'openai',
            encrypted_api_key: 'v1:iv:tag:key2',
            key_fingerprint: 'sk-...2222',
            base_url: null,
            default_model: 'gpt-4o',
            config: {},
            is_active: true,
          });
        },
        (err: any) => err.code === '23505'
      );

      // Distinct tenant succeeds with same provider
      const client2 = db.createClientState();
      db.setSessionTenant(client2, 2);
      assert.doesNotThrow(() => {
        db.insertProvider(client2, {
          tenant_id: 2,
          provider: 'openai',
          encrypted_api_key: 'v1:iv:tag:key3',
          key_fingerprint: 'sk-...3333',
          base_url: null,
          default_model: 'gpt-4o',
          config: {},
          is_active: true,
        });
      });
    });

    test('2.5: Quota check constraint rejects negative costs or token limits with 23514', () => {
      const client1 = db.createClientState();
      db.setSessionTenant(client1, 1);

      assert.throws(
        () => {
          db.upsertQuota(client1, {
            tenant_id: 1,
            monthly_cost_limit_micro_usd: -500n, // Negative!
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
        (err: any) => err.code === '23514'
      );
    });

    test('2.6: Ledger integer micro-USD precision: Accumulates exact integer costs without floating point drift', () => {
      const client1 = db.createClientState();
      db.setSessionTenant(client1, 1);

      // Record 3 events with exact micro-USD costs
      db.insertLedger(client1, {
        tenant_id: 1,
        workspace_id: null,
        agent_id: 'agent_1',
        agent_run_id: 'run_1',
        conversation_id: 10,
        provider: 'openai',
        model: 'gpt-4o-mini',
        operation: 'completion',
        prompt_tokens: 1000,
        completion_tokens: 200,
        total_tokens: 1200,
        cost_micro_usd: 270n, // $0.000270
        is_byok: true,
        latency_ms: 320,
        status: 'success',
        metadata_json: {},
      });

      db.insertLedger(client1, {
        tenant_id: 1,
        workspace_id: null,
        agent_id: 'agent_1',
        agent_run_id: 'run_2',
        conversation_id: 10,
        provider: 'openai',
        model: 'gpt-4o-mini',
        operation: 'completion',
        prompt_tokens: 1500,
        completion_tokens: 300,
        total_tokens: 1800,
        cost_micro_usd: 405n, // $0.000405
        is_byok: true,
        latency_ms: 350,
        status: 'success',
        metadata_json: {},
      });

      const entries = db.selectLedger(client1);
      assert.equal(entries.length, 2);
      const totalCostMicroUsd = entries.reduce((acc, e) => acc + e.cost_micro_usd, 0n);
      assert.equal(totalCostMicroUsd, 675n);
    });

    test('2.7: Cascade deletion: Deleting tenant cascades cleanly to providers, quotas, and ledger records', () => {
      const client1 = db.createClientState();
      db.setSessionTenant(client1, 1);
      db.insertProvider(client1, {
        tenant_id: 1,
        provider: 'openai',
        encrypted_api_key: 'v1:iv:tag:k',
        key_fingerprint: 'sk-...1111',
        base_url: null,
        default_model: 'gpt-4o',
        config: {},
        is_active: true,
      });
      db.upsertQuota(client1, {
        tenant_id: 1,
        monthly_cost_limit_micro_usd: 100000000n,
        monthly_token_limit: 10000000n,
        current_month_cost_micro_usd: 5000n,
        current_month_tokens_used: 1000n,
        hard_limit_enabled: true,
        hard_limit_action: 'block',
        period_start: new Date(),
        reset_at: new Date(),
        updated_at: new Date(),
      });
      db.insertLedger(client1, {
        tenant_id: 1,
        workspace_id: null,
        agent_id: 'agent_1',
        agent_run_id: 'run_1',
        conversation_id: null,
        provider: 'openai',
        model: 'gpt-4o',
        operation: 'completion',
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        cost_micro_usd: 750n,
        is_byok: false,
        latency_ms: 200,
        status: 'success',
        metadata_json: {},
      });

      assert.equal(db.tables.tenant_ai_providers.length, 1);
      assert.equal(db.tables.tenant_ai_quotas.length, 1);
      assert.equal(db.tables.ai_token_cost_ledger.length, 1);

      // Delete tenant 1 cascade
      db.deleteTenantCascade(1);

      assert.equal(db.tables.tenant_ai_providers.length, 0);
      assert.equal(db.tables.tenant_ai_quotas.length, 0);
      assert.equal(db.tables.ai_token_cost_ledger.length, 0);
    });
  });
});
