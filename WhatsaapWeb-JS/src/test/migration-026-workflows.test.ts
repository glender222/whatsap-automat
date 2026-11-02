// Invariants before config load
process.env.JWT_SECRET = 'test-only-jwt-secret-with-at-least-32-characters-for-testing';
process.env.DB_PASSWORD = 'test-only-database-password';

import assert from 'node:assert/strict';
import { describe, test, beforeEach } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

// =============================================================================
// Mock In-Memory Database Engine for RLS and Workflows / Revisions / Runs
// =============================================================================

interface MockDbRecord {
  id: string;
  tenant_id: number;
  [key: string]: unknown;
}

interface MockClientState {
  sessionTenantId: number | null;
  inTransaction: boolean;
  queries: { sql: string; values?: unknown[] }[];
}

function createMockWorkflowsDb() {
  const tables: {
    workflow_definitions: MockDbRecord[];
    workflow_revisions: MockDbRecord[];
    workflow_runs: MockDbRecord[];
    workflow_triggers: MockDbRecord[];
  } = {
    workflow_definitions: [],
    workflow_revisions: [],
    workflow_runs: [],
    workflow_triggers: [],
  };

  const clientStates: MockClientState[] = [];

  const mockDb = {
    tables,
    clientStates,
    async executeQuery(
      state: MockClientState,
      text: string,
      values: unknown[] = []
    ) {
      const sql = text.trim();
      const upper = sql.toUpperCase();
      state.queries.push({ sql, values });

      // Transaction control
      if (upper === 'BEGIN') {
        state.inTransaction = true;
        return { rows: [], rowCount: 0 };
      }
      if (upper === 'COMMIT') {
        state.inTransaction = false;
        state.sessionTenantId = null;
        return { rows: [], rowCount: 0 };
      }
      if (upper === 'ROLLBACK') {
        state.inTransaction = false;
        state.sessionTenantId = null;
        return { rows: [], rowCount: 0 };
      }

      // SET LOCAL app.current_tenant_id = '1'
      const setMatch = sql.match(/SET LOCAL app\.current_tenant_id\s*=\s*'(\d+)'/i);
      if (setMatch) {
        state.sessionTenantId = parseInt(setMatch[1], 10);
        return { rows: [], rowCount: 0 };
      }

      const effectiveTenantId = state.sessionTenantId;

      // 1. workflow_definitions
      if (sql.includes('workflow_definitions')) {
        const table = tables.workflow_definitions;

        if (upper.startsWith('INSERT')) {
          const insertTenantId = Number(values[1]);
          if (!effectiveTenantId || effectiveTenantId !== insertTenantId) {
            const err = new Error('new row violates row-level security policy for table "workflow_definitions"');
            (err as any).code = '44501';
            throw err;
          }

          const id = String(values[0]);
          const existing = table.find((r) => r.id === id);
          if (existing) {
            const err = new Error('duplicate key value violates unique constraint "workflow_definitions_pkey"');
            (err as any).code = '23505';
            throw err;
          }

          const newRow: MockDbRecord = {
            id,
            tenant_id: insertTenantId,
            workspace_id: values[2] ?? null,
            name: String(values[3]),
            description: values[4] ? String(values[4]) : null,
            published_revision_id: values[5] ? String(values[5]) : null,
            status: values[6] ? String(values[6]) : 'draft',
            created_at: new Date(),
            updated_at: new Date(),
          };
          table.push(newRow);
          return { rows: [newRow], rowCount: 1 };
        }

        if (upper.startsWith('SELECT')) {
          if (!effectiveTenantId) {
            return { rows: [], rowCount: 0 };
          }
          let filtered = table.filter((r) => r.tenant_id === effectiveTenantId);
          if (sql.includes('id = $1') || sql.includes('id = $2')) {
            const targetId = String(values[values.length - 1]);
            filtered = filtered.filter((r) => r.id === targetId);
          }
          return { rows: filtered, rowCount: filtered.length };
        }

        if (upper.startsWith('UPDATE')) {
          if (!effectiveTenantId) {
            return { rows: [], rowCount: 0 };
          }
          // e.g. Rollback: UPDATE workflow_definitions SET published_revision_id = $1 WHERE id = $2 AND tenant_id = $3
          const targetRevId = String(values[0]);
          const targetId = String(values[1]);
          const row = table.find((r) => r.id === targetId && r.tenant_id === effectiveTenantId);
          if (row) {
            row.published_revision_id = targetRevId;
            row.status = 'published';
            row.updated_at = new Date();
            return { rows: [row], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }
      }

      // 2. workflow_revisions
      if (sql.includes('workflow_revisions')) {
        const table = tables.workflow_revisions;

        if (upper.startsWith('INSERT')) {
          const insertTenantId = Number(values[1]);
          if (!effectiveTenantId || effectiveTenantId !== insertTenantId) {
            const err = new Error('new row violates row-level security policy for table "workflow_revisions"');
            (err as any).code = '44501';
            throw err;
          }

          const workflowId = String(values[2]);
          const revNum = Number(values[3]);

          // UNIQUE (tenant_id, workflow_id, revision_number)
          const duplicate = table.find(
            (r) => r.tenant_id === insertTenantId && r.workflow_id === workflowId && r.revision_number === revNum
          );
          if (duplicate) {
            const err = new Error('duplicate key value violates unique constraint "uq_workflow_revisions_tenant_workflow_rev"');
            (err as any).code = '23505';
            throw err;
          }

          const newRow: MockDbRecord = {
            id: String(values[0]),
            tenant_id: insertTenantId,
            workflow_id: workflowId,
            revision_number: revNum,
            status: values[4] ? String(values[4]) : 'draft',
            dag_graph: values[5] ?? { nodes: [], edges: [] },
            spec_hash: String(values[6]),
            limits: values[7] ?? { maxSteps: 100, maxDurationSeconds: 86400 },
            published_at: values[8] ? new Date(values[8] as string) : null,
            created_at: new Date(),
          };
          table.push(newRow);
          return { rows: [newRow], rowCount: 1 };
        }

        if (upper.startsWith('SELECT')) {
          if (!effectiveTenantId) {
            return { rows: [], rowCount: 0 };
          }
          let filtered = table.filter((r) => r.tenant_id === effectiveTenantId);
          if (sql.includes('workflow_id = $1') || sql.includes('workflow_id = $2')) {
            const wId = String(values[values.length - 1]);
            filtered = filtered.filter((r) => r.workflow_id === wId);
          }
          return { rows: filtered, rowCount: filtered.length };
        }
      }

      // 3. workflow_runs
      if (sql.includes('workflow_runs')) {
        const table = tables.workflow_runs;

        if (upper.startsWith('INSERT')) {
          const insertTenantId = Number(values[1]);
          if (!effectiveTenantId || effectiveTenantId !== insertTenantId) {
            const err = new Error('new row violates row-level security policy for table "workflow_runs"');
            (err as any).code = '44501';
            throw err;
          }

          const temporalWfId = String(values[5]);
          // UNIQUE (tenant_id, temporal_workflow_id)
          const dupTemporal = table.find(
            (r) => r.tenant_id === insertTenantId && r.temporal_workflow_id === temporalWfId
          );
          if (dupTemporal) {
            const err = new Error('duplicate key value violates unique constraint "uq_workflow_runs_temporal"');
            (err as any).code = '23505';
            throw err;
          }

          const newRow: MockDbRecord = {
            id: String(values[0]),
            tenant_id: insertTenantId,
            workspace_id: values[2] ?? null,
            workflow_id: String(values[3]),
            revision_id: String(values[4]),
            temporal_workflow_id: temporalWfId,
            temporal_run_id: values[6] ? String(values[6]) : null,
            correlation_id: String(values[7]),
            trigger_type: String(values[8]),
            trigger_payload: values[9] ?? {},
            status: values[10] ? String(values[10]) : 'queued',
            current_step: values[11] ? String(values[11]) : null,
            step_count: Number(values[12] ?? 0),
            state_snapshot: values[13] ?? {},
            started_at: new Date(),
            completed_at: null,
            error_details: null,
          };
          table.push(newRow);
          return { rows: [newRow], rowCount: 1 };
        }

        if (upper.startsWith('SELECT')) {
          if (!effectiveTenantId) {
            return { rows: [], rowCount: 0 };
          }
          let filtered = table.filter((r) => r.tenant_id === effectiveTenantId);
          return { rows: filtered, rowCount: filtered.length };
        }
      }

      // 4. workflow_triggers
      if (sql.includes('workflow_triggers')) {
        const table = tables.workflow_triggers;

        if (upper.startsWith('INSERT')) {
          const insertTenantId = Number(values[1]);
          if (!effectiveTenantId || effectiveTenantId !== insertTenantId) {
            const err = new Error('new row violates row-level security policy for table "workflow_triggers"');
            (err as any).code = '44501';
            throw err;
          }

          const endpointKey = values[4] ? String(values[4]) : null;
          if (endpointKey) {
            const dupEndpoint = table.find((r) => r.endpoint_key === endpointKey);
            if (dupEndpoint) {
              const err = new Error('duplicate key value violates unique constraint "workflow_triggers_endpoint_key_key"');
              (err as any).code = '23505';
              throw err;
            }
          }

          const newRow: MockDbRecord = {
            id: String(values[0]),
            tenant_id: insertTenantId,
            workflow_id: String(values[2]),
            type: String(values[3]),
            endpoint_key: endpointKey,
            auth_token_hash: values[5] ? String(values[5]) : null,
            cron_expression: values[6] ? String(values[6]) : null,
            is_active: values[7] !== undefined ? Boolean(values[7]) : true,
            metadata: values[8] ?? {},
            created_at: new Date(),
            updated_at: new Date(),
          };
          table.push(newRow);
          return { rows: [newRow], rowCount: 1 };
        }

        if (upper.startsWith('SELECT')) {
          if (!effectiveTenantId) {
            return { rows: [], rowCount: 0 };
          }
          let filtered = table.filter((r) => r.tenant_id === effectiveTenantId);
          return { rows: filtered, rowCount: filtered.length };
        }
      }

      return { rows: [], rowCount: 0 };
    },
  };

  return mockDb;
}

// =============================================================================
// Test Suites
// =============================================================================

describe('PR-F4-01: Migration 026 - Workflows, Revisions, Runs & Channel-Less Triggers', () => {
  // ---------------------------------------------------------------------------
  // Suite 1: Static DDL and Schema Verification of Migration 026
  // ---------------------------------------------------------------------------
  describe('Suite 1: Static DDL & Schema Verification', () => {
    const migrationPath = path.join(__dirname, '../db/migrations/026_create_workflows_and_revisions.sql');
    let sqlContent: string;

    beforeEach(() => {
      assert.ok(fs.existsSync(migrationPath), `Migration file must exist at ${migrationPath}`);
      sqlContent = fs.readFileSync(migrationPath, 'utf8');
    });

    test('1.1: Migration 026 references Fase F4 authoritative specifications', () => {
      assert.match(sqlContent, /Migration 026/i);
      assert.match(sqlContent, /WAA-011/i);
      assert.match(sqlContent, /WAA-014/i);
      assert.match(sqlContent, /PROD-001/i);
      assert.match(sqlContent, /PROD-006/i);
      assert.match(sqlContent, /ADR-001/i);
      assert.match(sqlContent, /ADR-006/i);
      assert.match(sqlContent, /ADR-010/i);
      assert.match(sqlContent, /ADR-022/i);
    });

    test('1.2: Defines workflow_definitions table with status constraints and tenant index', () => {
      assert.match(sqlContent, /CREATE TABLE IF NOT EXISTS workflow_definitions/i);
      assert.match(sqlContent, /id VARCHAR\(255\) PRIMARY KEY/i);
      assert.match(sqlContent, /tenant_id INTEGER NOT NULL REFERENCES tenants\(id\) ON DELETE CASCADE/i);
      assert.match(sqlContent, /workspace_id INTEGER REFERENCES workspaces\(id\) ON DELETE SET NULL/i);
      assert.match(sqlContent, /name VARCHAR\(255\) NOT NULL/i);
      assert.match(sqlContent, /published_revision_id VARCHAR\(255\)/i);
      assert.match(sqlContent, /status VARCHAR\(50\) NOT NULL DEFAULT 'draft'/i);

      // Verify check constraint
      const checkMatch = sqlContent.match(/CONSTRAINT chk_workflow_definitions_status CHECK\s*\(\s*status IN\s*\(([^)]+)\)\s*\)/i);
      assert.ok(checkMatch, 'chk_workflow_definitions_status constraint must exist');
      assert.ok(checkMatch[1].includes("'draft'"));
      assert.ok(checkMatch[1].includes("'published'"));
      assert.ok(checkMatch[1].includes("'archived'"));

      // Verify index
      assert.match(sqlContent, /CREATE INDEX IF NOT EXISTS idx_workflow_definitions_tenant_status\s+ON workflow_definitions\(tenant_id, status\)/i);
    });

    test('1.3: Defines workflow_revisions table with immutable unique constraint and status check', () => {
      assert.match(sqlContent, /CREATE TABLE IF NOT EXISTS workflow_revisions/i);
      assert.match(sqlContent, /revision_number INTEGER NOT NULL/i);
      assert.match(sqlContent, /dag_graph JSONB NOT NULL/i);
      assert.match(sqlContent, /spec_hash VARCHAR\(64\) NOT NULL/i);
      assert.match(sqlContent, /limits JSONB NOT NULL/i);

      // Verify composite uniqueness per tenant and workflow
      assert.match(
        sqlContent,
        /CONSTRAINT uq_workflow_revisions_tenant_workflow_rev UNIQUE\s*\(tenant_id,\s*workflow_id,\s*revision_number\)/i
      );

      // Verify check constraint
      const checkMatch = sqlContent.match(/CONSTRAINT chk_workflow_revisions_status CHECK\s*\(\s*status IN\s*\(([^)]+)\)\s*\)/i);
      assert.ok(checkMatch, 'chk_workflow_revisions_status constraint must exist');
      assert.ok(checkMatch[1].includes("'draft'"));
      assert.ok(checkMatch[1].includes("'published'"));
      assert.ok(checkMatch[1].includes("'archived'"));

      // Verify index
      assert.match(sqlContent, /CREATE INDEX IF NOT EXISTS idx_workflow_revisions_tenant_workflow\s+ON workflow_revisions\(tenant_id, workflow_id, revision_number\)/i);
    });

    test('1.4: Creates foreign key from workflow_definitions to workflow_revisions with DEFERRED', () => {
      assert.match(sqlContent, /fk_workflow_definitions_published_rev/i);
      assert.match(sqlContent, /FOREIGN KEY\s*\(published_revision_id\)\s*REFERENCES workflow_revisions\(id\)/i);
      assert.match(sqlContent, /DEFERRABLE INITIALLY DEFERRED/i);
    });

    test('1.5: Defines workflow_runs table with temporal binding, correlation index, and trigger types', () => {
      assert.match(sqlContent, /CREATE TABLE IF NOT EXISTS workflow_runs/i);
      assert.match(sqlContent, /revision_id VARCHAR\(255\) NOT NULL REFERENCES workflow_revisions\(id\) ON DELETE RESTRICT/i);
      assert.match(sqlContent, /temporal_workflow_id VARCHAR\(255\) NOT NULL/i);
      assert.match(sqlContent, /temporal_run_id VARCHAR\(255\)/i);
      assert.match(sqlContent, /correlation_id TEXT NOT NULL/i);

      // Unique temporal workflow per tenant
      assert.match(sqlContent, /CONSTRAINT uq_workflow_runs_temporal UNIQUE\s*\(tenant_id,\s*temporal_workflow_id\)/i);

      // Check trigger types
      const triggerCheck = sqlContent.match(/CONSTRAINT chk_workflow_runs_trigger_type CHECK\s*\(\s*trigger_type IN\s*\(([^)]+)\)\s*\)/i);
      assert.ok(triggerCheck, 'chk_workflow_runs_trigger_type constraint must exist');
      assert.ok(triggerCheck[1].includes("'webhook'"));
      assert.ok(triggerCheck[1].includes("'schedule'"));
      assert.ok(triggerCheck[1].includes("'event'"));
      assert.ok(triggerCheck[1].includes("'manual'"));
      assert.ok(triggerCheck[1].includes("'channel.message'"));

      // Check statuses
      const statusCheck = sqlContent.match(/CONSTRAINT chk_workflow_runs_status CHECK\s*\(\s*status IN\s*\(([^)]+)\)\s*\)/i);
      assert.ok(statusCheck, 'chk_workflow_runs_status constraint must exist');
      assert.ok(statusCheck[1].includes("'queued'"));
      assert.ok(statusCheck[1].includes("'running'"));
      assert.ok(statusCheck[1].includes("'waiting_timer'"));
      assert.ok(statusCheck[1].includes("'waiting_approval'"));
      assert.ok(statusCheck[1].includes("'completed'"));
      assert.ok(statusCheck[1].includes("'failed'"));
      assert.ok(statusCheck[1].includes("'cancelled'"));

      // Indices
      assert.match(sqlContent, /CREATE INDEX IF NOT EXISTS idx_workflow_runs_tenant_status\s+ON workflow_runs\(tenant_id, status\)/i);
      assert.match(sqlContent, /CREATE INDEX IF NOT EXISTS idx_workflow_runs_correlation\s+ON workflow_runs\(tenant_id, correlation_id\)/i);
    });

    test('1.6: Defines workflow_triggers table for channel-less business triggers (UC-06)', () => {
      assert.match(sqlContent, /CREATE TABLE IF NOT EXISTS workflow_triggers/i);
      assert.match(sqlContent, /endpoint_key VARCHAR\(255\) UNIQUE/i);
      assert.match(sqlContent, /auth_token_hash VARCHAR\(255\)/i);
      assert.match(sqlContent, /cron_expression VARCHAR\(100\)/i);
      assert.match(sqlContent, /is_active BOOLEAN NOT NULL DEFAULT true/i);

      const typeCheck = sqlContent.match(/CONSTRAINT chk_workflow_triggers_type CHECK\s*\(\s*type IN\s*\(([^)]+)\)\s*\)/i);
      assert.ok(typeCheck, 'chk_workflow_triggers_type constraint must exist');
      assert.ok(typeCheck[1].includes("'webhook'"));
      assert.ok(typeCheck[1].includes("'schedule'"));
      assert.ok(typeCheck[1].includes("'event'"));

      assert.match(sqlContent, /CREATE INDEX IF NOT EXISTS idx_workflow_triggers_tenant_type\s+ON workflow_triggers\(tenant_id, type, is_active\)/i);
    });

    test('1.7: Enables and forces RLS on all 4 tables with AS PERMISSIVE isolation policies', () => {
      const tables = ['workflow_definitions', 'workflow_revisions', 'workflow_runs', 'workflow_triggers'];
      for (const table of tables) {
        assert.match(sqlContent, new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`, 'i'));
        assert.match(sqlContent, new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`, 'i'));
        assert.match(
          sqlContent,
          new RegExp(
            `CREATE POLICY tenant_isolation_policy ON ${table}\\s+AS PERMISSIVE\\s+USING\\s*\\(tenant_id = NULLIF\\(current_setting\\('app\\.current_tenant_id', true\\), ''\\)::integer\\)`,
            'i'
          )
        );
      }
      assert.doesNotMatch(sqlContent, /AS RESTRICTIVE/i, 'Must not contain AS RESTRICTIVE policies');
    });

    test('1.8: Documents rollback / revert statements in migration comment block', () => {
      assert.match(sqlContent, /REVERT \/ ROLLBACK SPECIFICATION/i);
      assert.match(sqlContent, /DROP TABLE IF EXISTS workflow_triggers CASCADE/i);
      assert.match(sqlContent, /DROP TABLE IF EXISTS workflow_runs CASCADE/i);
      assert.match(sqlContent, /DROP TABLE IF EXISTS workflow_revisions CASCADE/i);
      assert.match(sqlContent, /DROP TABLE IF EXISTS workflow_definitions CASCADE/i);
    });
  });

  // ---------------------------------------------------------------------------
  // Suite 2: Multi-Tenant RLS Dynamic Isolation
  // ---------------------------------------------------------------------------
  describe('Suite 2: Multi-Tenant RLS Dynamic Isolation', () => {
    let mockDb: ReturnType<typeof createMockWorkflowsDb>;
    let clientState: MockClientState;

    beforeEach(() => {
      mockDb = createMockWorkflowsDb();
      clientState = {
        sessionTenantId: null,
        inTransaction: false,
        queries: [],
      };
    });

    test('2.1: Fail-closed isolation: Unauthenticated query returns 0 rows', async () => {
      // Direct query without setting sessionTenantId
      const res = await mockDb.executeQuery(clientState, 'SELECT * FROM workflow_definitions');
      assert.strictEqual(res.rows.length, 0);
    });

    test('2.2: Cross-tenant isolation: Tenant 1 cannot access Tenant 2 workflow definitions', async () => {
      // 1. Insert for Tenant 1
      clientState.sessionTenantId = 1;
      await mockDb.executeQuery(
        clientState,
        'INSERT INTO workflow_definitions (id, tenant_id, workspace_id, name, description, published_revision_id, status) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        ['wf-101', 1, null, 'Tenant 1 Onboarding', 'Welcome flow', null, 'published']
      );

      // 2. Insert for Tenant 2
      clientState.sessionTenantId = 2;
      await mockDb.executeQuery(
        clientState,
        'INSERT INTO workflow_definitions (id, tenant_id, workspace_id, name, description, published_revision_id, status) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        ['wf-201', 2, null, 'Tenant 2 Billing Reminder', 'Invoicing flow', null, 'published']
      );

      // 3. Query as Tenant 1
      clientState.sessionTenantId = 1;
      const resT1 = await mockDb.executeQuery(clientState, 'SELECT * FROM workflow_definitions');
      assert.strictEqual(resT1.rows.length, 1);
      assert.strictEqual(resT1.rows[0].id, 'wf-101');

      // 4. Query as Tenant 2
      clientState.sessionTenantId = 2;
      const resT2 = await mockDb.executeQuery(clientState, 'SELECT * FROM workflow_definitions');
      assert.strictEqual(resT2.rows.length, 1);
      assert.strictEqual(resT2.rows[0].id, 'wf-201');
    });

    test('2.3: Cross-tenant insert rejected by RLS policy', async () => {
      clientState.sessionTenantId = 1;
      await assert.rejects(
        async () => {
          await mockDb.executeQuery(
            clientState,
            'INSERT INTO workflow_definitions (id, tenant_id, workspace_id, name, description, published_revision_id, status) VALUES ($1, $2, $3, $4, $5, $6, $7)',
            ['wf-spoofed', 2, null, 'Spoofed Workflow', null, null, 'draft']
          );
        },
        /violates row-level security policy/
      );
    });

    test('2.4: Enforces composite uniqueness of revision number per tenant and workflow', async () => {
      clientState.sessionTenantId = 1;
      // Revision 1
      await mockDb.executeQuery(
        clientState,
        'INSERT INTO workflow_revisions (id, tenant_id, workflow_id, revision_number, status, dag_graph, spec_hash, limits) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        ['rev-101-1', 1, 'wf-101', 1, 'published', { nodes: [] }, 'hash1', {}]
      );

      // Attempt duplicate Revision 1 for same workflow
      await assert.rejects(
        async () => {
          await mockDb.executeQuery(
            clientState,
            'INSERT INTO workflow_revisions (id, tenant_id, workflow_id, revision_number, status, dag_graph, spec_hash, limits) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
            ['rev-101-1-dup', 1, 'wf-101', 1, 'draft', { nodes: [] }, 'hash2', {}]
          );
        },
        /unique constraint "uq_workflow_revisions_tenant_workflow_rev"/
      );
    });

    test('2.5: Enforces uniqueness of temporal_workflow_id per tenant in workflow_runs', async () => {
      clientState.sessionTenantId = 1;
      await mockDb.executeQuery(
        clientState,
        'INSERT INTO workflow_runs (id, tenant_id, workspace_id, workflow_id, revision_id, temporal_workflow_id, temporal_run_id, correlation_id, trigger_type, trigger_payload, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)',
        ['run-1', 1, null, 'wf-101', 'rev-101-1', 'wf_1_key100', 'temporal-run-1', 'corr-1', 'webhook', {}, 'running']
      );

      // Attempt duplicate temporal workflow id
      await assert.rejects(
        async () => {
          await mockDb.executeQuery(
            clientState,
            'INSERT INTO workflow_runs (id, tenant_id, workspace_id, workflow_id, revision_id, temporal_workflow_id, temporal_run_id, correlation_id, trigger_type, trigger_payload, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)',
            ['run-2', 1, null, 'wf-101', 'rev-101-1', 'wf_1_key100', 'temporal-run-2', 'corr-2', 'webhook', {}, 'running']
          );
        },
        /unique constraint "uq_workflow_runs_temporal"/
      );
    });

    test('2.6: Channel-less webhook endpoint uniqueness is enforced', async () => {
      clientState.sessionTenantId = 1;
      await mockDb.executeQuery(
        clientState,
        'INSERT INTO workflow_triggers (id, tenant_id, workflow_id, type, endpoint_key, auth_token_hash, cron_expression, is_active, metadata) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
        ['trig-1', 1, 'wf-101', 'webhook', 'crm-inbound-v1', 'hash-token-1', null, true, {}]
      );

      // Attempt duplicate endpoint_key
      await assert.rejects(
        async () => {
          await mockDb.executeQuery(
            clientState,
            'INSERT INTO workflow_triggers (id, tenant_id, workflow_id, type, endpoint_key, auth_token_hash, cron_expression, is_active, metadata) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
            ['trig-2', 1, 'wf-101', 'webhook', 'crm-inbound-v1', 'hash-token-2', null, true, {}]
          );
        },
        /unique constraint "workflow_triggers_endpoint_key_key"/
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Suite 3: Immutable Revisions & Atomic Rollback Simulation
  // ---------------------------------------------------------------------------
  describe('Suite 3: Immutable Revisions & Atomic Rollback Simulation', () => {
    let mockDb: ReturnType<typeof createMockWorkflowsDb>;
    let clientState: MockClientState;

    beforeEach(async () => {
      mockDb = createMockWorkflowsDb();
      clientState = {
        sessionTenantId: 1,
        inTransaction: false,
        queries: [],
      };

      // Seed Definition and Revision 1 (published)
      await mockDb.executeQuery(
        clientState,
        'INSERT INTO workflow_definitions (id, tenant_id, workspace_id, name, description, published_revision_id, status) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        ['wf-billing', 1, null, 'Billing Pipeline', 'Handles invoice reminders', 'rev-1', 'published']
      );

      await mockDb.executeQuery(
        clientState,
        'INSERT INTO workflow_revisions (id, tenant_id, workflow_id, revision_number, status, dag_graph, spec_hash, limits) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        ['rev-1', 1, 'wf-billing', 1, 'published', { nodes: [{ id: 'step-1', type: 'send-email' }] }, 'hash-v1', {}]
      );
    });

    test('3.1: Execution run is pinned to immutable revision', async () => {
      // Create an in-flight execution run pinned to rev-1
      await mockDb.executeQuery(
        clientState,
        'INSERT INTO workflow_runs (id, tenant_id, workspace_id, workflow_id, revision_id, temporal_workflow_id, temporal_run_id, correlation_id, trigger_type, trigger_payload, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)',
        ['run-billing-001', 1, null, 'wf-billing', 'rev-1', 'temporal-billing-001', 'trun-1', 'corr-billing', 'webhook', {}, 'running']
      );

      // Now create Revision 2 (draft with altered graph)
      await mockDb.executeQuery(
        clientState,
        'INSERT INTO workflow_revisions (id, tenant_id, workflow_id, revision_number, status, dag_graph, spec_hash, limits) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        ['rev-2', 1, 'wf-billing', 2, 'draft', { nodes: [{ id: 'step-1-modified' }, { id: 'step-2' }] }, 'hash-v2', {}]
      );

      // Verify the active run continues referencing Revision 1 without alteration
      const runs = await mockDb.executeQuery(clientState, 'SELECT * FROM workflow_runs');
      assert.strictEqual(runs.rows.length, 1);
      assert.strictEqual(runs.rows[0].revision_id, 'rev-1');
    });

    test('3.2: Atomic rollback swaps published_revision_id without touching in-flight runs', async () => {
      // 1. Publish Revision 2
      await mockDb.executeQuery(
        clientState,
        'INSERT INTO workflow_revisions (id, tenant_id, workflow_id, revision_number, status, dag_graph, spec_hash, limits) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        ['rev-2', 1, 'wf-billing', 2, 'published', { nodes: [{ id: 'step-faulty' }] }, 'hash-v2', {}]
      );
      await mockDb.executeQuery(
        clientState,
        'UPDATE workflow_definitions SET published_revision_id = $1 WHERE id = $2 AND tenant_id = $3',
        ['rev-2', 'wf-billing', 1]
      );

      // Start run on Revision 2
      await mockDb.executeQuery(
        clientState,
        'INSERT INTO workflow_runs (id, tenant_id, workspace_id, workflow_id, revision_id, temporal_workflow_id, temporal_run_id, correlation_id, trigger_type, trigger_payload, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)',
        ['run-rev2-active', 1, null, 'wf-billing', 'rev-2', 'temporal-rev2-active', 'trun-rev2', 'corr-rev2', 'schedule', {}, 'running']
      );

      // 2. Perform atomic rollback back to Revision 1
      const rollbackStartTime = Date.now();
      const updateRes = await mockDb.executeQuery(
        clientState,
        'UPDATE workflow_definitions SET published_revision_id = $1 WHERE id = $2 AND tenant_id = $3',
        ['rev-1', 'wf-billing', 1]
      );
      const rollbackDuration = Date.now() - rollbackStartTime;

      assert.strictEqual(updateRes.rowCount, 1);
      assert.ok(rollbackDuration < 1000, 'Rollback pointer swap must execute in < 1 second (PROD-006)');

      // Verify workflow definition points to rev-1
      const defRes = await mockDb.executeQuery(clientState, 'SELECT * FROM workflow_definitions WHERE id = $1', ['wf-billing']);
      assert.strictEqual(defRes.rows[0].published_revision_id, 'rev-1');

      // Verify in-flight run on Revision 2 was NOT mutated
      const runsRes = await mockDb.executeQuery(clientState, 'SELECT * FROM workflow_runs');
      const activeRun = runsRes.rows.find((r) => r.id === 'run-rev2-active');
      assert.ok(activeRun);
      assert.strictEqual(activeRun.revision_id, 'rev-2', 'In-flight run must remain pinned to Revision 2');
    });
  });
});
