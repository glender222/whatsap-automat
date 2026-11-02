import assert from 'node:assert/strict';
import { describe, test, beforeEach } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

describe('PR-F5-02: Migration 028 ToolBroker DDL & Multi-Tenant RLS Verification', () => {
  const migrationPath = path.resolve(
    __dirname,
    '../db/migrations/028_create_agent_studio_toolbroker_rag.sql'
  );

  test('Migration 028 file exists on filesystem', () => {
    assert.ok(fs.existsSync(migrationPath), `Migration file not found at ${migrationPath}`);
  });

  const sqlContent = fs.readFileSync(migrationPath, 'utf8');

  describe('Suite 1: Static DDL & Schema Verification', () => {
    test('1.1: Defines table tool_definitions with required columns and constraints', () => {
      assert.match(sqlContent, /CREATE TABLE IF NOT EXISTS tool_definitions/i);
      assert.match(sqlContent, /id VARCHAR\(255\) PRIMARY KEY/i);
      assert.match(sqlContent, /tenant_id INTEGER REFERENCES tenants\(id\)/i);
      assert.match(sqlContent, /risk_level VARCHAR\(30\) NOT NULL/i);
      assert.match(sqlContent, /chk_tool_definitions_risk_level/i);
      assert.match(sqlContent, /chk_tool_definitions_timeout/i);
    });

    test('1.2: Defines table agent_tool_grants with composite uniqueness', () => {
      assert.match(sqlContent, /CREATE TABLE IF NOT EXISTS agent_tool_grants/i);
      assert.match(sqlContent, /uq_agent_tool_grants_tenant_agent_tool UNIQUE \(tenant_id, agent_graph_id, tool_name\)/i);
      assert.match(sqlContent, /is_enabled BOOLEAN NOT NULL DEFAULT true/i);
    });

    test('1.3: Defines table approval_requests with CAS version and check constraints', () => {
      assert.match(sqlContent, /CREATE TABLE IF NOT EXISTS approval_requests/i);
      assert.match(sqlContent, /effect_key VARCHAR\(255\) NOT NULL/i);
      assert.match(sqlContent, /proposed_action_hash VARCHAR\(64\) NOT NULL/i);
      assert.match(sqlContent, /version INTEGER NOT NULL DEFAULT 1/i);
      assert.match(sqlContent, /chk_approval_requests_risk/i);
      assert.match(sqlContent, /chk_approval_requests_status/i);
      assert.match(sqlContent, /chk_approval_requests_version CHECK \(version >= 1\)/i);
    });

    test('1.4: Defines table tool_execution_effects with idempotency unique constraint', () => {
      assert.match(sqlContent, /CREATE TABLE IF NOT EXISTS tool_execution_effects/i);
      assert.match(sqlContent, /uq_tool_execution_effects UNIQUE \(tenant_id, effect_key\)/i);
    });

    test('1.5: Creates partial unique indexes for built-ins vs tenant tools', () => {
      assert.match(sqlContent, /CREATE UNIQUE INDEX IF NOT EXISTS uq_tool_definitions_builtin_name/i);
      assert.match(sqlContent, /CREATE UNIQUE INDEX IF NOT EXISTS uq_tool_definitions_tenant_name/i);
    });

    test('1.6: Seeds all 4 canonical built-in tools', () => {
      assert.match(sqlContent, /'tool_builtin_http_request'/i);
      assert.match(sqlContent, /'http_request'/i);
      assert.match(sqlContent, /'tool_builtin_search_knowledge'/i);
      assert.match(sqlContent, /'search_knowledge'/i);
      assert.match(sqlContent, /'tool_builtin_send_whatsapp_message'/i);
      assert.match(sqlContent, /'send_whatsapp_message'/i);
      assert.match(sqlContent, /'tool_builtin_create_invoice'/i);
      assert.match(sqlContent, /'create_invoice'/i);
    });

    test('1.7: Enables and forces RLS on all 4 tables with AS PERMISSIVE policies', () => {
      const tables = [
        'tool_definitions',
        'agent_tool_grants',
        'approval_requests',
        'tool_execution_effects',
      ];

      for (const table of tables) {
        const enableRegex = new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`, 'i');
        const forceRegex = new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`, 'i');
        const policyRegex = new RegExp(`CREATE POLICY tenant_isolation_policy ON ${table}\\s+AS PERMISSIVE`, 'i');

        assert.match(sqlContent, enableRegex, `Missing ENABLE RLS on ${table}`);
        assert.match(sqlContent, forceRegex, `Missing FORCE RLS on ${table}`);
        assert.match(sqlContent, policyRegex, `Missing AS PERMISSIVE tenant_isolation_policy on ${table}`);
      }
    });

    test('1.8: Documents rollback / revert specifications', () => {
      assert.match(sqlContent, /REVERT \/ ROLLBACK SPECIFICATION:/i);
      assert.match(sqlContent, /DROP TABLE IF EXISTS tool_execution_effects CASCADE;/i);
      assert.match(sqlContent, /DROP TABLE IF EXISTS approval_requests CASCADE;/i);
      assert.match(sqlContent, /DROP TABLE IF EXISTS agent_tool_grants CASCADE;/i);
      assert.match(sqlContent, /DROP TABLE IF EXISTS tool_definitions CASCADE;/i);
    });
  });

  describe('Suite 2: Multi-Tenant RLS & Concurrency Semantics Simulation', () => {
    interface ToolDef {
      id: string;
      tenant_id: number | null;
      name: string;
      risk_level: string;
    }

    interface ApprovalReq {
      id: string;
      tenant_id: number;
      effect_key: string;
      version: number;
      status: string;
    }

    interface EffectRecord {
      tenant_id: number;
      effect_key: string;
      output: any;
    }

    let toolDefs: ToolDef[];
    let approvals: ApprovalReq[];
    let effects: EffectRecord[];

    beforeEach(() => {
      toolDefs = [
        { id: 'tool_builtin_http_request', tenant_id: null, name: 'http_request', risk_level: 'write' },
        { id: 'tool_builtin_search_knowledge', tenant_id: null, name: 'search_knowledge', risk_level: 'read' },
        { id: 'tool_custom_t1', tenant_id: 1, name: 'custom_query_crm', risk_level: 'read' },
        { id: 'tool_custom_t2', tenant_id: 2, name: 'custom_sync_erp', risk_level: 'write' },
      ];

      approvals = [
        { id: 'appr_1', tenant_id: 1, effect_key: 'eff_1', version: 1, status: 'pending' },
        { id: 'appr_2', tenant_id: 2, effect_key: 'eff_2', version: 1, status: 'pending' },
      ];

      effects = [
        { tenant_id: 1, effect_key: 'eff_key_alpha', output: { ok: true } },
      ];
    });

    function queryToolsAsTenant(sessionTenantId: number | null): ToolDef[] {
      return toolDefs.filter((t) => t.tenant_id === null || t.tenant_id === sessionTenantId);
    }

    function queryApprovalsAsTenant(sessionTenantId: number | null): ApprovalReq[] {
      if (sessionTenantId === null) return [];
      return approvals.filter((a) => a.tenant_id === sessionTenantId);
    }

    test('2.1: Global built-in tools are visible to all tenants, custom tools are isolated', () => {
      const t1Tools = queryToolsAsTenant(1);
      assert.equal(t1Tools.length, 3);
      assert.ok(t1Tools.some((t) => t.name === 'http_request'));
      assert.ok(t1Tools.some((t) => t.name === 'custom_query_crm'));
      assert.ok(!t1Tools.some((t) => t.name === 'custom_sync_erp'));

      const t2Tools = queryToolsAsTenant(2);
      assert.equal(t2Tools.length, 3);
      assert.ok(t2Tools.some((t) => t.name === 'http_request'));
      assert.ok(t2Tools.some((t) => t.name === 'custom_sync_erp'));
      assert.ok(!t2Tools.some((t) => t.name === 'custom_query_crm'));
    });

    test('2.2: Approval requests are strictly tenant-isolated', () => {
      const t1Approvals = queryApprovalsAsTenant(1);
      assert.equal(t1Approvals.length, 1);
      assert.equal(t1Approvals[0].id, 'appr_1');

      const t2Approvals = queryApprovalsAsTenant(2);
      assert.equal(t2Approvals.length, 1);
      assert.equal(t2Approvals[0].id, 'appr_2');

      const noSessionApprovals = queryApprovalsAsTenant(null);
      assert.equal(noSessionApprovals.length, 0);
    });

    test('2.3: CAS concurrency on approvals prevents stale decision updates', () => {
      const approval = approvals[0];
      const expectedVersion = 1;

      // Simulated atomic update: WHERE id = $1 AND version = $2
      if (approval.version === expectedVersion && approval.status === 'pending') {
        approval.status = 'approved';
        approval.version += 1;
      } else {
        assert.fail('Update should have succeeded');
      }

      assert.equal(approval.version, 2);
      assert.equal(approval.status, 'approved');

      // Second concurrent attempt with old expectedVersion 1 must fail
      let secondAttemptSuccess = false;
      if (approval.version === expectedVersion && approval.status === 'pending') {
        secondAttemptSuccess = true;
      }

      assert.equal(secondAttemptSuccess, false, 'Stale CAS version must be rejected');
    });

    test('2.4: Effect key uniqueness enforces idempotency per tenant', () => {
      function insertEffect(tenantId: number, effectKey: string, output: any) {
        const existing = effects.find((e) => e.tenant_id === tenantId && e.effect_key === effectKey);
        if (existing) {
          throw new Error('duplicate key value violates unique constraint "uq_tool_execution_effects"');
        }
        effects.push({ tenant_id: tenantId, effect_key: effectKey, output });
      }

      // Re-inserting for tenant 1 fails
      assert.throws(
        () => insertEffect(1, 'eff_key_alpha', { ok: true }),
        /duplicate key value violates unique constraint/
      );

      // Same effect key for tenant 2 succeeds (tenant scoped)
      assert.doesNotThrow(() => insertEffect(2, 'eff_key_alpha', { ok: true }));
      assert.equal(effects.length, 2);
    });
  });
});
