// Invariants before config load
process.env.JWT_SECRET = 'test-only-jwt-secret-with-at-least-32-characters-for-testing';
process.env.DB_PASSWORD = 'test-only-database-password';

import assert from 'node:assert/strict';
import { describe, test, beforeEach } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

// =============================================================================
// PostgreSQL Relational & RLS Simulation Engine for Adversarial Testing
// Models PostgreSQL Engine Behavior:
//   - AS PERMISSIVE tenant_isolation_policy
//   - NULLIF(current_setting('app.current_tenant_id', true), '')::integer
//   - FORCE ROW LEVEL SECURITY
//   - FOREIGN KEY ... DEFERRABLE INITIALLY DEFERRED
//   - Composite UNIQUE constraints
//   - ON DELETE RESTRICT vs ON DELETE SET NULL vs ON DELETE CASCADE
//   - Check constraints
// =============================================================================

export interface WorkflowDefinitionRow {
  id: string;
  tenant_id: number;
  workspace_id: number | null;
  name: string;
  description: string | null;
  published_revision_id: string | null;
  status: 'draft' | 'published' | 'archived';
  created_at: Date;
  updated_at: Date;
}

export interface WorkflowRevisionRow {
  id: string;
  tenant_id: number;
  workflow_id: string;
  revision_number: number;
  status: 'draft' | 'published' | 'archived';
  dag_graph: Record<string, unknown>;
  spec_hash: string;
  limits: Record<string, unknown>;
  published_at: Date | null;
  created_at: Date;
}

export interface WorkflowRunRow {
  id: string;
  tenant_id: number;
  workspace_id: number | null;
  workflow_id: string;
  revision_id: string;
  temporal_workflow_id: string;
  temporal_run_id: string | null;
  correlation_id: string;
  trigger_type: 'webhook' | 'schedule' | 'event' | 'manual' | 'channel.message';
  trigger_payload: Record<string, unknown>;
  status: 'queued' | 'running' | 'waiting_timer' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled';
  current_step: string | null;
  step_count: number;
  state_snapshot: Record<string, unknown>;
  started_at: Date;
  completed_at: Date | null;
  error_details: Record<string, unknown> | null;
}

export interface WorkflowTriggerRow {
  id: string;
  tenant_id: number;
  workflow_id: string;
  type: 'webhook' | 'schedule' | 'event';
  endpoint_key: string | null;
  auth_token_hash: string | null;
  cron_expression: string | null;
  is_active: boolean;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export class PostgresError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
    this.name = 'PostgresError';
  }
}

export interface AdversarialClientState {
  rawTenantSetting: string | null;
  inTransaction: boolean;
  deferredChecks: Array<() => void>;
  txUndoSnapshot: {
    workflow_definitions: WorkflowDefinitionRow[];
    workflow_revisions: WorkflowRevisionRow[];
    workflow_runs: WorkflowRunRow[];
    workflow_triggers: WorkflowTriggerRow[];
  } | null;
}

export function createAdversarialDbEngine() {
  const tables = {
    workflow_definitions: [] as WorkflowDefinitionRow[],
    workflow_revisions: [] as WorkflowRevisionRow[],
    workflow_runs: [] as WorkflowRunRow[],
    workflow_triggers: [] as WorkflowTriggerRow[],
  };

  function cloneTables() {
    return {
      workflow_definitions: tables.workflow_definitions.map((r) => ({ ...r })),
      workflow_revisions: tables.workflow_revisions.map((r) => ({ ...r })),
      workflow_runs: tables.workflow_runs.map((r) => ({ ...r })),
      workflow_triggers: tables.workflow_triggers.map((r) => ({ ...r })),
    };
  }

  function resolveEffectiveTenant(raw: string | null): number | null {
    if (raw === null || raw === undefined) return null;
    const trimmed = String(raw).trim();
    if (trimmed === '') return null; // NULLIF('', '') => NULL
    if (!/^-?\d+$/.test(trimmed)) {
      // In PostgreSQL: NULLIF('abc', '')::integer throws 22P02 invalid input syntax
      throw new PostgresError(`invalid input syntax for type integer: "${raw}"`, '22P02');
    }
    const val = parseInt(trimmed, 10);
    if (val <= 0) return null; // Non-positive tenant IDs cannot match any valid tenant
    return val;
  }

  const engine = {
    tables,
    createClient(): AdversarialClientState {
      return {
        rawTenantSetting: null,
        inTransaction: false,
        deferredChecks: [],
        txUndoSnapshot: null,
      };
    },

    begin(client: AdversarialClientState) {
      if (client.inTransaction) {
        throw new PostgresError('cannot start transaction within transaction (no savepoint)', '25001');
      }
      client.inTransaction = true;
      client.deferredChecks = [];
      client.txUndoSnapshot = cloneTables();
    },

    commit(client: AdversarialClientState) {
      if (!client.inTransaction) {
        throw new PostgresError('no transaction in progress', '25P01');
      }
      // Execute all DEFERRED foreign key and integrity checks!
      try {
        for (const check of client.deferredChecks) {
          check();
        }
      } catch (err) {
        // Rollback on deferred constraint failure!
        this.rollback(client);
        throw err;
      }
      client.inTransaction = false;
      client.deferredChecks = [];
      client.txUndoSnapshot = null;
      client.rawTenantSetting = null; // SET LOCAL expires at COMMIT
    },

    rollback(client: AdversarialClientState) {
      if (!client.inTransaction && !client.txUndoSnapshot) {
        return;
      }
      if (client.txUndoSnapshot) {
        tables.workflow_definitions = client.txUndoSnapshot.workflow_definitions;
        tables.workflow_revisions = client.txUndoSnapshot.workflow_revisions;
        tables.workflow_runs = client.txUndoSnapshot.workflow_runs;
        tables.workflow_triggers = client.txUndoSnapshot.workflow_triggers;
      }
      client.inTransaction = false;
      client.deferredChecks = [];
      client.txUndoSnapshot = null;
      client.rawTenantSetting = null; // SET LOCAL expires at ROLLBACK
    },

    setLocalTenant(client: AdversarialClientState, tenantId: string | number | null) {
      client.rawTenantSetting = tenantId !== null && tenantId !== undefined ? String(tenantId) : null;
    },

    resetTenant(client: AdversarialClientState) {
      client.rawTenantSetting = null;
    },

    // -------------------------------------------------------------------------
    // 1. workflow_definitions operations
    // -------------------------------------------------------------------------
    insertDefinition(client: AdversarialClientState, row: {
      id: string;
      tenant_id: number;
      workspace_id?: number | null;
      name: string;
      description?: string | null;
      published_revision_id?: string | null;
      status?: string;
    }): WorkflowDefinitionRow {
      const effectiveTenant = resolveEffectiveTenant(client.rawTenantSetting);

      // RLS WITH CHECK policy
      if (!effectiveTenant || effectiveTenant !== row.tenant_id) {
        throw new PostgresError('new row violates row-level security policy for table "workflow_definitions"', '44501');
      }

      // Status check constraint
      const status = row.status ?? 'draft';
      if (!['draft', 'published', 'archived'].includes(status)) {
        throw new PostgresError('new row violates check constraint "chk_workflow_definitions_status"', '23514');
      }

      // PK uniqueness
      if (tables.workflow_definitions.some((r) => r.id === row.id)) {
        throw new PostgresError('duplicate key value violates unique constraint "workflow_definitions_pkey"', '23505');
      }

      // Deferred Foreign Key check: fk_workflow_definitions_published_rev
      if (row.published_revision_id) {
        const deferredCheck = () => {
          const revExists = tables.workflow_revisions.some((rev) => rev.id === row.published_revision_id);
          if (!revExists) {
            throw new PostgresError(
              `insert or update on table "workflow_definitions" violates foreign key constraint "fk_workflow_definitions_published_rev"`,
              '23503'
            );
          }
        };

        if (client.inTransaction) {
          client.deferredChecks.push(deferredCheck);
        } else {
          // Outside transaction, deferred constraints evaluate at statement end
          deferredCheck();
        }
      }

      const newRow: WorkflowDefinitionRow = {
        id: row.id,
        tenant_id: row.tenant_id,
        workspace_id: row.workspace_id ?? null,
        name: row.name,
        description: row.description ?? null,
        published_revision_id: row.published_revision_id ?? null,
        status: status as 'draft' | 'published' | 'archived',
        created_at: new Date(),
        updated_at: new Date(),
      };
      tables.workflow_definitions.push(newRow);
      return newRow;
    },

    selectDefinitions(client: AdversarialClientState, filter?: { id?: string }): WorkflowDefinitionRow[] {
      const effectiveTenant = resolveEffectiveTenant(client.rawTenantSetting);
      // RLS USING policy: tenant_id = NULLIF(...)
      if (!effectiveTenant) return [];
      let res = tables.workflow_definitions.filter((r) => r.tenant_id === effectiveTenant);
      if (filter?.id) res = res.filter((r) => r.id === filter.id);
      return res;
    },

    updateDefinition(
      client: AdversarialClientState,
      id: string,
      updates: Partial<Pick<WorkflowDefinitionRow, 'name' | 'published_revision_id' | 'status'>>
    ): number {
      const effectiveTenant = resolveEffectiveTenant(client.rawTenantSetting);
      if (!effectiveTenant) return 0;

      const row = tables.workflow_definitions.find((r) => r.id === id && r.tenant_id === effectiveTenant);
      if (!row) return 0;

      if (updates.status && !['draft', 'published', 'archived'].includes(updates.status)) {
        throw new PostgresError('new row violates check constraint "chk_workflow_definitions_status"', '23514');
      }

      if (updates.published_revision_id !== undefined) {
        if (updates.published_revision_id !== null) {
          const deferredCheck = () => {
            const revExists = tables.workflow_revisions.some((rev) => rev.id === updates.published_revision_id);
            if (!revExists) {
              throw new PostgresError(
                `insert or update on table "workflow_definitions" violates foreign key constraint "fk_workflow_definitions_published_rev"`,
                '23503'
              );
            }
          };
          if (client.inTransaction) {
            client.deferredChecks.push(deferredCheck);
          } else {
            deferredCheck();
          }
        }
        row.published_revision_id = updates.published_revision_id;
      }

      if (updates.name !== undefined) row.name = updates.name;
      if (updates.status !== undefined) row.status = updates.status;
      row.updated_at = new Date();
      return 1;
    },

    deleteDefinition(client: AdversarialClientState, id: string): number {
      const effectiveTenant = resolveEffectiveTenant(client.rawTenantSetting);
      if (!effectiveTenant) return 0;

      const idx = tables.workflow_definitions.findIndex((r) => r.id === id && r.tenant_id === effectiveTenant);
      if (idx === -1) return 0;

      // CASCADE to revisions and triggers
      const defId = tables.workflow_definitions[idx].id;
      tables.workflow_revisions = tables.workflow_revisions.filter((r) => r.workflow_id !== defId);
      tables.workflow_triggers = tables.workflow_triggers.filter((r) => r.workflow_id !== defId);
      tables.workflow_runs = tables.workflow_runs.filter((r) => r.workflow_id !== defId);

      tables.workflow_definitions.splice(idx, 1);
      return 1;
    },

    // -------------------------------------------------------------------------
    // 2. workflow_revisions operations
    // -------------------------------------------------------------------------
    insertRevision(client: AdversarialClientState, row: {
      id: string;
      tenant_id: number;
      workflow_id: string;
      revision_number: number;
      status?: string;
      dag_graph?: Record<string, unknown>;
      spec_hash: string;
      limits?: Record<string, unknown>;
      published_at?: Date | null;
    }): WorkflowRevisionRow {
      const effectiveTenant = resolveEffectiveTenant(client.rawTenantSetting);

      // RLS WITH CHECK policy
      if (!effectiveTenant || effectiveTenant !== row.tenant_id) {
        throw new PostgresError('new row violates row-level security policy for table "workflow_revisions"', '44501');
      }

      // Check constraint: chk_workflow_revisions_status
      const status = row.status ?? 'draft';
      if (!['draft', 'published', 'archived'].includes(status)) {
        throw new PostgresError('new row violates check constraint "chk_workflow_revisions_status"', '23514');
      }

      // PK uniqueness
      if (tables.workflow_revisions.some((r) => r.id === row.id)) {
        throw new PostgresError('duplicate key value violates unique constraint "workflow_revisions_pkey"', '23505');
      }

      // FK: workflow_id REFERENCES workflow_definitions(id) ON DELETE CASCADE
      const wfExists = tables.workflow_definitions.some((w) => w.id === row.workflow_id);
      if (!wfExists) {
        throw new PostgresError('insert on table "workflow_revisions" violates foreign key constraint', '23503');
      }

      // Composite UNIQUE (tenant_id, workflow_id, revision_number)
      const duplicate = tables.workflow_revisions.find(
        (r) => r.tenant_id === row.tenant_id && r.workflow_id === row.workflow_id && r.revision_number === row.revision_number
      );
      if (duplicate) {
        throw new PostgresError(
          'duplicate key value violates unique constraint "uq_workflow_revisions_tenant_workflow_rev"',
          '23505'
        );
      }

      const newRow: WorkflowRevisionRow = {
        id: row.id,
        tenant_id: row.tenant_id,
        workflow_id: row.workflow_id,
        revision_number: row.revision_number,
        status: status as 'draft' | 'published' | 'archived',
        dag_graph: row.dag_graph ?? { nodes: [], edges: [] },
        spec_hash: row.spec_hash,
        limits: row.limits ?? { maxSteps: 100, maxDurationSeconds: 86400 },
        published_at: row.published_at ?? null,
        created_at: new Date(),
      };
      tables.workflow_revisions.push(newRow);
      return newRow;
    },

    selectRevisions(client: AdversarialClientState, filter?: { workflow_id?: string }): WorkflowRevisionRow[] {
      const effectiveTenant = resolveEffectiveTenant(client.rawTenantSetting);
      if (!effectiveTenant) return [];
      let res = tables.workflow_revisions.filter((r) => r.tenant_id === effectiveTenant);
      if (filter?.workflow_id) res = res.filter((r) => r.workflow_id === filter.workflow_id);
      return res;
    },

    deleteRevision(client: AdversarialClientState, id: string): number {
      const effectiveTenant = resolveEffectiveTenant(client.rawTenantSetting);
      if (!effectiveTenant) return 0;

      const idx = tables.workflow_revisions.findIndex((r) => r.id === id && r.tenant_id === effectiveTenant);
      if (idx === -1) return 0;

      // Check ON DELETE RESTRICT on workflow_runs(revision_id)
      const hasActiveRuns = tables.workflow_runs.some((run) => run.revision_id === id);
      if (hasActiveRuns) {
        throw new PostgresError(
          'update or delete on table "workflow_revisions" violates foreign key constraint on table "workflow_runs"',
          '23503'
        );
      }

      // ON DELETE SET NULL on workflow_definitions.published_revision_id
      for (const def of tables.workflow_definitions) {
        if (def.published_revision_id === id) {
          def.published_revision_id = null;
        }
      }

      tables.workflow_revisions.splice(idx, 1);
      return 1;
    },

    // -------------------------------------------------------------------------
    // 3. workflow_runs operations
    // -------------------------------------------------------------------------
    insertRun(client: AdversarialClientState, row: {
      id: string;
      tenant_id: number;
      workspace_id?: number | null;
      workflow_id: string;
      revision_id: string;
      temporal_workflow_id: string;
      temporal_run_id?: string | null;
      correlation_id: string;
      trigger_type: string;
      trigger_payload?: Record<string, unknown>;
      status?: string;
    }): WorkflowRunRow {
      const effectiveTenant = resolveEffectiveTenant(client.rawTenantSetting);

      // RLS WITH CHECK
      if (!effectiveTenant || effectiveTenant !== row.tenant_id) {
        throw new PostgresError('new row violates row-level security policy for table "workflow_runs"', '44501');
      }

      // Check constraints
      const allowedTriggerTypes = ['webhook', 'schedule', 'event', 'manual', 'channel.message'];
      if (!allowedTriggerTypes.includes(row.trigger_type)) {
        throw new PostgresError('new row violates check constraint "chk_workflow_runs_trigger_type"', '23514');
      }

      const status = row.status ?? 'queued';
      const allowedStatuses = ['queued', 'running', 'waiting_timer', 'waiting_approval', 'completed', 'failed', 'cancelled'];
      if (!allowedStatuses.includes(status)) {
        throw new PostgresError('new row violates check constraint "chk_workflow_runs_status"', '23514');
      }

      // PK uniqueness
      if (tables.workflow_runs.some((r) => r.id === row.id)) {
        throw new PostgresError('duplicate key value violates unique constraint "workflow_runs_pkey"', '23505');
      }

      // FK: workflow_id REFERENCES workflow_definitions(id)
      if (!tables.workflow_definitions.some((w) => w.id === row.workflow_id)) {
        throw new PostgresError('insert on table "workflow_runs" violates foreign key constraint', '23503');
      }

      // FK: revision_id REFERENCES workflow_revisions(id)
      if (!tables.workflow_revisions.some((rev) => rev.id === row.revision_id)) {
        throw new PostgresError('insert on table "workflow_runs" violates foreign key constraint', '23503');
      }

      // UNIQUE (tenant_id, temporal_workflow_id)
      const duplicateTemporal = tables.workflow_runs.find(
        (r) => r.tenant_id === row.tenant_id && r.temporal_workflow_id === row.temporal_workflow_id
      );
      if (duplicateTemporal) {
        throw new PostgresError(
          'duplicate key value violates unique constraint "uq_workflow_runs_temporal"',
          '23505'
        );
      }

      const newRow: WorkflowRunRow = {
        id: row.id,
        tenant_id: row.tenant_id,
        workspace_id: row.workspace_id ?? null,
        workflow_id: row.workflow_id,
        revision_id: row.revision_id,
        temporal_workflow_id: row.temporal_workflow_id,
        temporal_run_id: row.temporal_run_id ?? null,
        correlation_id: row.correlation_id,
        trigger_type: row.trigger_type as WorkflowRunRow['trigger_type'],
        trigger_payload: row.trigger_payload ?? {},
        status: status as WorkflowRunRow['status'],
        current_step: null,
        step_count: 0,
        state_snapshot: {},
        started_at: new Date(),
        completed_at: null,
        error_details: null,
      };
      tables.workflow_runs.push(newRow);
      return newRow;
    },

    selectRuns(client: AdversarialClientState, filter?: { workflow_id?: string }): WorkflowRunRow[] {
      const effectiveTenant = resolveEffectiveTenant(client.rawTenantSetting);
      if (!effectiveTenant) return [];
      let res = tables.workflow_runs.filter((r) => r.tenant_id === effectiveTenant);
      if (filter?.workflow_id) res = res.filter((r) => r.workflow_id === filter.workflow_id);
      return res;
    },

    // -------------------------------------------------------------------------
    // 4. workflow_triggers operations
    // -------------------------------------------------------------------------
    insertTrigger(client: AdversarialClientState, row: {
      id: string;
      tenant_id: number;
      workflow_id: string;
      type: string;
      endpoint_key?: string | null;
      auth_token_hash?: string | null;
      cron_expression?: string | null;
      is_active?: boolean;
      metadata?: Record<string, unknown>;
    }): WorkflowTriggerRow {
      const effectiveTenant = resolveEffectiveTenant(client.rawTenantSetting);

      // RLS WITH CHECK
      if (!effectiveTenant || effectiveTenant !== row.tenant_id) {
        throw new PostgresError('new row violates row-level security policy for table "workflow_triggers"', '44501');
      }

      // Check constraint: chk_workflow_triggers_type
      const allowedTypes = ['webhook', 'schedule', 'event'];
      if (!allowedTypes.includes(row.type)) {
        throw new PostgresError('new row violates check constraint "chk_workflow_triggers_type"', '23514');
      }

      // PK uniqueness
      if (tables.workflow_triggers.some((r) => r.id === row.id)) {
        throw new PostgresError('duplicate key value violates unique constraint "workflow_triggers_pkey"', '23505');
      }

      // FK: workflow_id REFERENCES workflow_definitions(id)
      if (!tables.workflow_definitions.some((w) => w.id === row.workflow_id)) {
        throw new PostgresError('insert on table "workflow_triggers" violates foreign key constraint', '23503');
      }

      // Global UNIQUE on endpoint_key (PostgreSQL UNIQUE allows multiple NULLs, rejects duplicate non-nulls)
      const endpointKey = row.endpoint_key !== undefined && row.endpoint_key !== null ? String(row.endpoint_key) : null;
      if (endpointKey !== null) {
        const dupEndpoint = tables.workflow_triggers.find((r) => r.endpoint_key === endpointKey);
        if (dupEndpoint) {
          throw new PostgresError(
            'duplicate key value violates unique constraint "workflow_triggers_endpoint_key_key"',
            '23505'
          );
        }
      }

      const newRow: WorkflowTriggerRow = {
        id: row.id,
        tenant_id: row.tenant_id,
        workflow_id: row.workflow_id,
        type: row.type as WorkflowTriggerRow['type'],
        endpoint_key: endpointKey,
        auth_token_hash: row.auth_token_hash ?? null,
        cron_expression: row.cron_expression ?? null,
        is_active: row.is_active !== undefined ? row.is_active : true,
        metadata: row.metadata ?? {},
        created_at: new Date(),
        updated_at: new Date(),
      };
      tables.workflow_triggers.push(newRow);
      return newRow;
    },

    selectTriggers(client: AdversarialClientState): WorkflowTriggerRow[] {
      const effectiveTenant = resolveEffectiveTenant(client.rawTenantSetting);
      if (!effectiveTenant) return [];
      return tables.workflow_triggers.filter((r) => r.tenant_id === effectiveTenant);
    },

    deleteTrigger(client: AdversarialClientState, id: string): number {
      const effectiveTenant = resolveEffectiveTenant(client.rawTenantSetting);
      if (!effectiveTenant) return 0;
      const idx = tables.workflow_triggers.findIndex((r) => r.id === id && r.tenant_id === effectiveTenant);
      if (idx === -1) return 0;
      tables.workflow_triggers.splice(idx, 1);
      return 1;
    },
  };

  return engine;
}

// =============================================================================
// Adversarial Challenger Test Suite
// =============================================================================

describe('PR-F4-01 Challenger: Migration 026 DDL & RLS Empirical Stress Verification', () => {
  const migrationPath = path.join(__dirname, '../db/migrations/026_create_workflows_and_revisions.sql');
  let ddlSql: string;

  beforeEach(() => {
    assert.ok(fs.existsSync(migrationPath), `Migration file must exist at ${migrationPath}`);
    ddlSql = fs.readFileSync(migrationPath, 'utf8');
  });

  // ---------------------------------------------------------------------------
  // Suite 1: Static DDL & Integrity Contract Adversarial Audit
  // ---------------------------------------------------------------------------
  describe('Suite 1: Static DDL & Integrity Contract Adversarial Audit', () => {
    test('1.1: Schema definition invariants: table columns and primary keys', () => {
      // 1. workflow_definitions
      assert.match(ddlSql, /CREATE TABLE IF NOT EXISTS workflow_definitions\s*\(/i);
      assert.match(ddlSql, /id VARCHAR\(255\) PRIMARY KEY/i);
      assert.match(ddlSql, /tenant_id INTEGER NOT NULL REFERENCES tenants\(id\) ON DELETE CASCADE/i);
      assert.match(ddlSql, /workspace_id INTEGER REFERENCES workspaces\(id\) ON DELETE SET NULL/i);
      assert.match(ddlSql, /name VARCHAR\(255\) NOT NULL/i);
      assert.match(ddlSql, /published_revision_id VARCHAR\(255\)/i);
      assert.match(ddlSql, /status VARCHAR\(50\) NOT NULL DEFAULT 'draft'/i);

      // 2. workflow_revisions
      assert.match(ddlSql, /CREATE TABLE IF NOT EXISTS workflow_revisions\s*\(/i);
      assert.match(ddlSql, /workflow_id VARCHAR\(255\) NOT NULL REFERENCES workflow_definitions\(id\) ON DELETE CASCADE/i);
      assert.match(ddlSql, /revision_number INTEGER NOT NULL/i);
      assert.match(ddlSql, /status VARCHAR\(50\) NOT NULL DEFAULT 'draft'/i);
      assert.match(ddlSql, /dag_graph JSONB NOT NULL DEFAULT '\{"nodes":\[\],"edges":\[\]\}'::jsonb/i);
      assert.match(ddlSql, /spec_hash VARCHAR\(64\) NOT NULL/i);

      // 3. workflow_runs
      assert.match(ddlSql, /CREATE TABLE IF NOT EXISTS workflow_runs\s*\(/i);
      assert.match(ddlSql, /workflow_id VARCHAR\(255\) NOT NULL REFERENCES workflow_definitions\(id\) ON DELETE CASCADE/i);
      assert.match(ddlSql, /revision_id VARCHAR\(255\) NOT NULL REFERENCES workflow_revisions\(id\) ON DELETE RESTRICT/i);
      assert.match(ddlSql, /temporal_workflow_id VARCHAR\(255\) NOT NULL/i);
      assert.match(ddlSql, /correlation_id TEXT NOT NULL/i);
      assert.match(ddlSql, /trigger_type VARCHAR\(50\) NOT NULL/i);
      assert.match(ddlSql, /status VARCHAR\(50\) NOT NULL DEFAULT 'queued'/i);

      // 4. workflow_triggers
      assert.match(ddlSql, /CREATE TABLE IF NOT EXISTS workflow_triggers\s*\(/i);
      assert.match(ddlSql, /endpoint_key VARCHAR\(255\) UNIQUE/i);
      assert.match(ddlSql, /auth_token_hash VARCHAR\(255\)/i);
      assert.match(ddlSql, /is_active BOOLEAN NOT NULL DEFAULT true/i);
    });

    test('1.2: Circular Foreign Key declaration is DEFERRABLE INITIALLY DEFERRED with ON DELETE SET NULL', () => {
      // Must be conditional via pg_constraint query
      assert.match(ddlSql, /SELECT 1 FROM pg_constraint WHERE conname = 'fk_workflow_definitions_published_rev'/i);
      assert.match(ddlSql, /ALTER TABLE workflow_definitions\s+ADD CONSTRAINT fk_workflow_definitions_published_rev/i);
      assert.match(ddlSql, /FOREIGN KEY\s*\(published_revision_id\)\s*REFERENCES workflow_revisions\(id\)/i);
      assert.match(ddlSql, /ON DELETE SET NULL/i);
      assert.match(ddlSql, /DEFERRABLE INITIALLY DEFERRED/i);
    });

    test('1.3: Uniqueness constraints are properly scoped (composite vs global)', () => {
      // Revisions: composite UNIQUE per tenant, workflow, and revision number
      assert.match(
        ddlSql,
        /CONSTRAINT uq_workflow_revisions_tenant_workflow_rev UNIQUE\s*\(tenant_id,\s*workflow_id,\s*revision_number\)/i
      );

      // Runs: composite UNIQUE per tenant and temporal_workflow_id
      assert.match(
        ddlSql,
        /CONSTRAINT uq_workflow_runs_temporal UNIQUE\s*\(tenant_id,\s*temporal_workflow_id\)/i
      );

      // Triggers: GLOBAL UNIQUE on endpoint_key for channel-less ingress routing (UC-06)
      assert.match(
        ddlSql,
        /endpoint_key VARCHAR\(255\) UNIQUE/i
      );
    });

    test('1.4: Check constraints enforce strict whitelist of enum strings', () => {
      // chk_workflow_definitions_status
      assert.match(ddlSql, /CONSTRAINT chk_workflow_definitions_status CHECK\s*\(\s*status IN\s*\('draft',\s*'published',\s*'archived'\)\s*\)/i);

      // chk_workflow_revisions_status
      assert.match(ddlSql, /CONSTRAINT chk_workflow_revisions_status CHECK\s*\(\s*status IN\s*\('draft',\s*'published',\s*'archived'\)\s*\)/i);

      // chk_workflow_runs_trigger_type
      assert.match(
        ddlSql,
        /CONSTRAINT chk_workflow_runs_trigger_type CHECK\s*\(\s*trigger_type IN\s*\('webhook',\s*'schedule',\s*'event',\s*'manual',\s*'channel\.message'\)\s*\)/i
      );

      // chk_workflow_runs_status
      assert.match(
        ddlSql,
        /CONSTRAINT chk_workflow_runs_status CHECK\s*\(\s*status IN\s*\('queued',\s*'running',\s*'waiting_timer',\s*'waiting_approval',\s*'completed',\s*'failed',\s*'cancelled'\)\s*\)/i
      );

      // chk_workflow_triggers_type
      assert.match(
        ddlSql,
        /CONSTRAINT chk_workflow_triggers_type CHECK\s*\(\s*type IN\s*\('webhook',\s*'schedule',\s*'event'\)\s*\)/i
      );
    });

    test('1.5: RLS policies enforce AS PERMISSIVE with FORCE ROW LEVEL SECURITY on all 4 tables', () => {
      const requiredTables = [
        'workflow_definitions',
        'workflow_revisions',
        'workflow_runs',
        'workflow_triggers',
      ];

      for (const table of requiredTables) {
        assert.match(ddlSql, new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`, 'i'));
        assert.match(ddlSql, new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`, 'i'));
        assert.match(ddlSql, new RegExp(`DROP POLICY IF EXISTS tenant_isolation_policy ON ${table};`, 'i'));
        assert.match(
          ddlSql,
          new RegExp(
            `CREATE POLICY tenant_isolation_policy ON ${table}\\s+AS PERMISSIVE\\s+USING\\s*\\(tenant_id = NULLIF\\(current_setting\\('app\\.current_tenant_id', true\\), ''\\)::integer\\)\\s+WITH CHECK\\s*\\(tenant_id = NULLIF\\(current_setting\\('app\\.current_tenant_id', true\\), ''\\)::integer\\);`,
            'i'
          )
        );
      }

      // Security requirement: ZERO RESTRICTIVE policies
      assert.doesNotMatch(ddlSql, /AS RESTRICTIVE/i, 'Must never use AS RESTRICTIVE without permissive base');
    });

    test('1.6: Down-migration revert script is fully idempotent and honors reverse topological order', () => {
      assert.match(ddlSql, /-- REVERT \/ ROLLBACK SPECIFICATION/i);

      // Topological drop order:
      // 1. workflow_triggers
      // 2. workflow_runs
      // 3. ALTER TABLE workflow_definitions DROP CONSTRAINT IF EXISTS fk_workflow_definitions_published_rev
      // 4. workflow_revisions
      // 5. workflow_definitions
      const triggersPos = ddlSql.indexOf('DROP TABLE IF EXISTS workflow_triggers CASCADE');
      const runsPos = ddlSql.indexOf('DROP TABLE IF EXISTS workflow_runs CASCADE');
      const dropFkPos = ddlSql.indexOf('ALTER TABLE workflow_definitions DROP CONSTRAINT IF EXISTS fk_workflow_definitions_published_rev');
      const revisionsPos = ddlSql.indexOf('DROP TABLE IF EXISTS workflow_revisions CASCADE');
      const definitionsPos = ddlSql.indexOf('DROP TABLE IF EXISTS workflow_definitions CASCADE');

      assert.ok(triggersPos > 0, 'Revert must drop workflow_triggers');
      assert.ok(runsPos > triggersPos, 'workflow_runs dropped after workflow_triggers');
      assert.ok(dropFkPos > runsPos, 'fk_workflow_definitions_published_rev dropped before revisions');
      assert.ok(revisionsPos > dropFkPos, 'workflow_revisions dropped after circular FK is removed');
      assert.ok(definitionsPos > revisionsPos, 'workflow_definitions dropped last');
    });
  });

  // ---------------------------------------------------------------------------
  // Suite 2: Multi-Tenant Isolation & Adversarial Attack Simulation
  // ---------------------------------------------------------------------------
  describe('Suite 2: Multi-Tenant Isolation & Adversarial Attack Simulation', () => {
    let db: ReturnType<typeof createAdversarialDbEngine>;
    let clientA: AdversarialClientState;
    let clientB: AdversarialClientState;
    let unauthClient: AdversarialClientState;

    beforeEach(() => {
      db = createAdversarialDbEngine();
      clientA = db.createClient();
      db.setLocalTenant(clientA, 1);

      clientB = db.createClient();
      db.setLocalTenant(clientB, 2);

      unauthClient = db.createClient(); // rawTenantSetting = null
    });

    test('2.1: Fail-closed isolation: Unauthenticated queries return 0 rows across all tables', () => {
      // Seed Tenant 1 data
      db.insertDefinition(clientA, { id: 'wf-t1', tenant_id: 1, name: 'T1 Flow' });
      db.insertRevision(clientA, { id: 'rev-t1-1', tenant_id: 1, workflow_id: 'wf-t1', revision_number: 1, spec_hash: 'h1' });
      db.insertRun(clientA, {
        id: 'run-t1-1',
        tenant_id: 1,
        workflow_id: 'wf-t1',
        revision_id: 'rev-t1-1',
        temporal_workflow_id: 'wf_1_run1',
        correlation_id: 'c1',
        trigger_type: 'manual',
      });
      db.insertTrigger(clientA, { id: 'trig-t1-1', tenant_id: 1, workflow_id: 'wf-t1', type: 'webhook', endpoint_key: 't1-hook' });

      // Query without tenant setting
      assert.strictEqual(db.selectDefinitions(unauthClient).length, 0);
      assert.strictEqual(db.selectRevisions(unauthClient).length, 0);
      assert.strictEqual(db.selectRuns(unauthClient).length, 0);
      assert.strictEqual(db.selectTriggers(unauthClient).length, 0);
    });

    test('2.2: Malformed tenant context values fail-closed or throw cast error', () => {
      const clientBad = db.createClient();

      // Empty string: NULLIF('', '') => NULL => 0 rows
      db.setLocalTenant(clientBad, '');
      assert.strictEqual(db.selectDefinitions(clientBad).length, 0);

      // Non-numeric string: throws 22P02 invalid input syntax
      db.setLocalTenant(clientBad, 'malicious_tenant_id');
      assert.throws(() => db.selectDefinitions(clientBad), {
        code: '22P02',
      });

      // Negative tenant ID: returns 0 rows
      db.setLocalTenant(clientBad, -99);
      assert.strictEqual(db.selectDefinitions(clientBad).length, 0);

      // SQL injection payload: throws 22P02 invalid input syntax
      db.setLocalTenant(clientBad, "1 OR 1=1; DROP TABLE workflow_definitions;--");
      assert.throws(() => db.selectDefinitions(clientBad), {
        code: '22P02',
      });
    });

    test('2.3: Cross-tenant unauthorized reads are blocked across all 4 tables', () => {
      // Seed Tenant 1 and Tenant 2 data
      db.insertDefinition(clientA, { id: 'wf-t1', tenant_id: 1, name: 'Tenant 1 Top Secret Workflow' });
      db.insertRevision(clientA, { id: 'rev-t1-1', tenant_id: 1, workflow_id: 'wf-t1', revision_number: 1, spec_hash: 'hash-t1' });
      db.insertRun(clientA, {
        id: 'run-t1-1',
        tenant_id: 1,
        workflow_id: 'wf-t1',
        revision_id: 'rev-t1-1',
        temporal_workflow_id: 'wf_1_exec_100',
        correlation_id: 'corr-t1',
        trigger_type: 'webhook',
      });
      db.insertTrigger(clientA, { id: 'trig-t1-1', tenant_id: 1, workflow_id: 'wf-t1', type: 'webhook', endpoint_key: 't1-crm' });

      // Tenant 2 queries
      const t2Defs = db.selectDefinitions(clientB);
      const t2Revs = db.selectRevisions(clientB);
      const t2Runs = db.selectRuns(clientB);
      const t2Trigs = db.selectTriggers(clientB);

      assert.strictEqual(t2Defs.length, 0, 'Tenant 2 must see 0 definitions from Tenant 1');
      assert.strictEqual(t2Revs.length, 0, 'Tenant 2 must see 0 revisions from Tenant 1');
      assert.strictEqual(t2Runs.length, 0, 'Tenant 2 must see 0 runs from Tenant 1');
      assert.strictEqual(t2Trigs.length, 0, 'Tenant 2 must see 0 triggers from Tenant 1');
    });

    test('2.4: Cross-tenant unauthorized inserts are blocked by RLS WITH CHECK (44501)', () => {
      // Tenant 1 attempts to insert into Tenant 2 namespace
      assert.throws(
        () => {
          db.insertDefinition(clientA, { id: 'wf-spoofed', tenant_id: 2, name: 'Spoofed Definition' });
        },
        { code: '44501' }
      );

      // Seed valid definition for Tenant 1
      db.insertDefinition(clientA, { id: 'wf-t1', tenant_id: 1, name: 'Valid T1' });

      assert.throws(
        () => {
          db.insertRevision(clientA, { id: 'rev-spoofed', tenant_id: 2, workflow_id: 'wf-t1', revision_number: 1, spec_hash: 'h' });
        },
        { code: '44501' }
      );

      assert.throws(
        () => {
          db.insertRun(clientA, {
            id: 'run-spoofed',
            tenant_id: 2,
            workflow_id: 'wf-t1',
            revision_id: 'rev-t1',
            temporal_workflow_id: 'wf_2_spoof',
            correlation_id: 'c',
            trigger_type: 'manual',
          });
        },
        { code: '44501' }
      );

      assert.throws(
        () => {
          db.insertTrigger(clientA, {
            id: 'trig-spoofed',
            tenant_id: 2,
            workflow_id: 'wf-t1',
            type: 'webhook',
            endpoint_key: 'spoofed-key',
          });
        },
        { code: '44501' }
      );
    });

    test('2.5: Cross-tenant update and delete attempts produce 0 rows affected', () => {
      // Seed Tenant 2 workflow
      db.insertDefinition(clientB, { id: 'wf-t2', tenant_id: 2, name: 'Tenant 2 Sensitive Pipeline', status: 'published' });

      // Tenant 1 attempts to update Tenant 2's workflow
      const updatedCount = db.updateDefinition(clientA, 'wf-t2', { name: 'Compromised Name' });
      assert.strictEqual(updatedCount, 0, 'Tenant 1 cannot update Tenant 2 definition');

      // Verify Tenant 2 definition is intact
      const t2Defs = db.selectDefinitions(clientB, { id: 'wf-t2' });
      assert.strictEqual(t2Defs[0].name, 'Tenant 2 Sensitive Pipeline');

      // Tenant 1 attempts to delete Tenant 2's workflow
      const deletedCount = db.deleteDefinition(clientA, 'wf-t2');
      assert.strictEqual(deletedCount, 0, 'Tenant 1 cannot delete Tenant 2 definition');

      // Verify still exists in Tenant 2
      assert.strictEqual(db.selectDefinitions(clientB).length, 1);
    });

    test('2.6: Connection context cleanup: COMMIT/ROLLBACK expires SET LOCAL preventing context leakage', () => {
      const client = db.createClient();
      db.begin(client);
      db.setLocalTenant(client, 1);
      db.insertDefinition(client, { id: 'wf-tx', tenant_id: 1, name: 'Tx Flow' });
      db.commit(client);

      // After commit, rawTenantSetting must be reset to null (simulating SET LOCAL scope expiration)
      assert.strictEqual(client.rawTenantSetting, null);
      // Query without resetting tenant setting returns 0 rows (fail-closed)
      assert.strictEqual(db.selectDefinitions(client).length, 0);
    });
  });

  // ---------------------------------------------------------------------------
  // Suite 3: Unique Constraint Stress Testing
  // ---------------------------------------------------------------------------
  describe('Suite 3: Unique Constraint Stress Testing', () => {
    let db: ReturnType<typeof createAdversarialDbEngine>;
    let clientA: AdversarialClientState;
    let clientB: AdversarialClientState;

    beforeEach(() => {
      db = createAdversarialDbEngine();
      clientA = db.createClient();
      db.setLocalTenant(clientA, 1);

      clientB = db.createClient();
      db.setLocalTenant(clientB, 2);

      // Seed workflow definitions
      db.insertDefinition(clientA, { id: 'wf-alpha', tenant_id: 1, name: 'Flow Alpha' });
      db.insertDefinition(clientA, { id: 'wf-beta', tenant_id: 1, name: 'Flow Beta' });
      db.insertDefinition(clientB, { id: 'wf-gamma', tenant_id: 2, name: 'Flow Gamma' });
    });

    test('3.1: Revision uniqueness: duplicate revision number for same tenant and workflow throws 23505', () => {
      // Revision 1 for wf-alpha
      db.insertRevision(clientA, {
        id: 'rev-alpha-1',
        tenant_id: 1,
        workflow_id: 'wf-alpha',
        revision_number: 1,
        spec_hash: 'hash-alpha-1',
      });

      // Attempt duplicate Revision 1 for wf-alpha -> REJECTED
      assert.throws(
        () => {
          db.insertRevision(clientA, {
            id: 'rev-alpha-1-conflict',
            tenant_id: 1,
            workflow_id: 'wf-alpha',
            revision_number: 1,
            spec_hash: 'hash-alpha-1-dup',
          });
        },
        { code: '23505' }
      );

      // Revision 1 for wf-beta (same tenant, different workflow) -> ALLOWED
      const revBeta1 = db.insertRevision(clientA, {
        id: 'rev-beta-1',
        tenant_id: 1,
        workflow_id: 'wf-beta',
        revision_number: 1,
        spec_hash: 'hash-beta-1',
      });
      assert.ok(revBeta1);

      // Revision 1 for wf-gamma (different tenant) -> ALLOWED
      const revGamma1 = db.insertRevision(clientB, {
        id: 'rev-gamma-1',
        tenant_id: 2,
        workflow_id: 'wf-gamma',
        revision_number: 1,
        spec_hash: 'hash-gamma-1',
      });
      assert.ok(revGamma1);

      // Monotonic increment: Revision 2 for wf-alpha -> ALLOWED
      const revAlpha2 = db.insertRevision(clientA, {
        id: 'rev-alpha-2',
        tenant_id: 1,
        workflow_id: 'wf-alpha',
        revision_number: 2,
        spec_hash: 'hash-alpha-2',
      });
      assert.ok(revAlpha2);
    });

    test('3.2: Temporal workflow run uniqueness: scoped to (tenant_id, temporal_workflow_id)', () => {
      // Seed revision
      db.insertRevision(clientA, { id: 'rev-a1', tenant_id: 1, workflow_id: 'wf-alpha', revision_number: 1, spec_hash: 'h' });
      db.insertRevision(clientB, { id: 'rev-g1', tenant_id: 2, workflow_id: 'wf-gamma', revision_number: 1, spec_hash: 'h' });

      // Run 1 for Tenant 1
      db.insertRun(clientA, {
        id: 'run-101',
        tenant_id: 1,
        workflow_id: 'wf-alpha',
        revision_id: 'rev-a1',
        temporal_workflow_id: 'wf_shared_temporal_id',
        correlation_id: 'corr-101',
        trigger_type: 'webhook',
      });

      // Duplicate temporal_workflow_id for Tenant 1 -> REJECTED (23505)
      assert.throws(
        () => {
          db.insertRun(clientA, {
            id: 'run-102-conflict',
            tenant_id: 1,
            workflow_id: 'wf-alpha',
            revision_id: 'rev-a1',
            temporal_workflow_id: 'wf_shared_temporal_id',
            correlation_id: 'corr-102',
            trigger_type: 'schedule',
          });
        },
        { code: '23505' }
      );

      // Same temporal_workflow_id for Tenant 2 -> ALLOWED (composite key includes tenant_id)
      const runT2 = db.insertRun(clientB, {
        id: 'run-201',
        tenant_id: 2,
        workflow_id: 'wf-gamma',
        revision_id: 'rev-g1',
        temporal_workflow_id: 'wf_shared_temporal_id',
        correlation_id: 'corr-201',
        trigger_type: 'event',
      });
      assert.ok(runT2);
    });

    test('3.3: Channel-less webhook endpoint uniqueness (UC-06): global uniqueness across tenants', () => {
      // Tenant 1 registers global webhook endpoint
      db.insertTrigger(clientA, {
        id: 'trig-t1-erp',
        tenant_id: 1,
        workflow_id: 'wf-alpha',
        type: 'webhook',
        endpoint_key: 'erp-inbound-lead-sync',
      });

      // Tenant 2 attempts to register the EXACT SAME endpoint_key -> REJECTED (23505)
      assert.throws(
        () => {
          db.insertTrigger(clientB, {
            id: 'trig-t2-collision',
            tenant_id: 2,
            workflow_id: 'wf-gamma',
            type: 'webhook',
            endpoint_key: 'erp-inbound-lead-sync',
          });
        },
        { code: '23505' }
      );

      // Tenant 1 attempts to register duplicate on different workflow -> REJECTED (23505)
      assert.throws(
        () => {
          db.insertTrigger(clientA, {
            id: 'trig-t1-dup',
            tenant_id: 1,
            workflow_id: 'wf-beta',
            type: 'webhook',
            endpoint_key: 'erp-inbound-lead-sync',
          });
        },
        { code: '23505' }
      );

      // Multiple triggers with endpoint_key = null (e.g. schedules or internal events) -> ALLOWED
      const sched1 = db.insertTrigger(clientA, {
        id: 'trig-sched-1',
        tenant_id: 1,
        workflow_id: 'wf-alpha',
        type: 'schedule',
        endpoint_key: null,
        cron_expression: '0 9 * * *',
      });
      const sched2 = db.insertTrigger(clientB, {
        id: 'trig-sched-2',
        tenant_id: 2,
        workflow_id: 'wf-gamma',
        type: 'schedule',
        endpoint_key: null,
        cron_expression: '0 18 * * *',
      });

      assert.ok(sched1);
      assert.ok(sched2);
    });
  });

  // ---------------------------------------------------------------------------
  // Suite 4: Circular Deferred Foreign Key Resolution & Integrity Lifecycle
  // ---------------------------------------------------------------------------
  describe('Suite 4: Circular Deferred Foreign Key Resolution & Integrity Lifecycle', () => {
    let db: ReturnType<typeof createAdversarialDbEngine>;
    let client: AdversarialClientState;

    beforeEach(() => {
      db = createAdversarialDbEngine();
      client = db.createClient();
    });

    test('4.1: Atomic insertion: workflow definition and initial revision resolve deferred circular FK on COMMIT', () => {
      db.begin(client);
      db.setLocalTenant(client, 1);

      // 1. Insert definition referencing revision that DOES NOT YET EXIST in workflow_revisions
      const def = db.insertDefinition(client, {
        id: 'wf-circular-01',
        tenant_id: 1,
        name: 'Atomic Circular Workflow',
        published_revision_id: 'rev-circular-01', // Forward-reference!
        status: 'published',
      });
      assert.strictEqual(def.published_revision_id, 'rev-circular-01');

      // 2. Insert revision referencing definition (which now exists)
      const rev = db.insertRevision(client, {
        id: 'rev-circular-01',
        tenant_id: 1,
        workflow_id: 'wf-circular-01',
        revision_number: 1,
        status: 'published',
        spec_hash: 'spec-hash-initial',
      });
      assert.strictEqual(rev.id, 'rev-circular-01');

      // 3. COMMIT evaluates deferred constraint: both exist -> SUCCESS!
      assert.doesNotThrow(() => {
        db.commit(client);
      });

      // Verify persisted state
      db.setLocalTenant(client, 1);
      const definitions = db.selectDefinitions(client, { id: 'wf-circular-01' });
      assert.strictEqual(definitions.length, 1);
      assert.strictEqual(definitions[0].published_revision_id, 'rev-circular-01');

      const revisions = db.selectRevisions(client, { workflow_id: 'wf-circular-01' });
      assert.strictEqual(revisions.length, 1);
      assert.strictEqual(revisions[0].id, 'rev-circular-01');
    });

    test('4.2: Broken deferred foreign key: committing without creating referenced revision rolls back transaction (23503)', () => {
      db.begin(client);
      db.setLocalTenant(client, 1);

      // Insert definition with non-existent published_revision_id
      db.insertDefinition(client, {
        id: 'wf-broken',
        tenant_id: 1,
        name: 'Broken Circular Workflow',
        published_revision_id: 'rev-phantom',
        status: 'published',
      });

      // Attempt COMMIT without inserting 'rev-phantom' -> fails with 23503
      assert.throws(
        () => {
          db.commit(client);
        },
        { code: '23503' }
      );

      // Verify automatic rollback took place
      assert.strictEqual(client.inTransaction, false);
      db.setLocalTenant(client, 1);
      const defs = db.selectDefinitions(client);
      assert.strictEqual(defs.length, 0, 'Broken transaction must be completely rolled back');
    });

    test('4.3: Two-phase publishing lifecycle (draft without revision -> revision added -> published)', () => {
      db.setLocalTenant(client, 1);

      // Phase 1: Draft workflow created without revision (published_revision_id = null)
      const def = db.insertDefinition(client, {
        id: 'wf-2phase',
        tenant_id: 1,
        name: 'Two Phase Workflow',
        published_revision_id: null,
        status: 'draft',
      });
      assert.strictEqual(def.status, 'draft');
      assert.strictEqual(def.published_revision_id, null);

      // Phase 2: Revision 1 created in draft
      db.insertRevision(client, {
        id: 'rev-2phase-1',
        tenant_id: 1,
        workflow_id: 'wf-2phase',
        revision_number: 1,
        status: 'draft',
        spec_hash: 'hash-draft',
      });

      // Phase 3: Publish revision pointer
      const updated = db.updateDefinition(client, 'wf-2phase', {
        published_revision_id: 'rev-2phase-1',
        status: 'published',
      });
      assert.strictEqual(updated, 1);

      const publishedDef = db.selectDefinitions(client, { id: 'wf-2phase' })[0];
      assert.strictEqual(publishedDef.status, 'published');
      assert.strictEqual(publishedDef.published_revision_id, 'rev-2phase-1');
    });

    test('4.4: Deletion constraints: ON DELETE RESTRICT on runs vs ON DELETE SET NULL on published revision', () => {
      db.setLocalTenant(client, 1);

      // 1. Setup definition and published revision 1
      db.insertDefinition(client, { id: 'wf-del', tenant_id: 1, name: 'Deletion Test Flow', published_revision_id: null });
      db.insertRevision(client, { id: 'rev-del-1', tenant_id: 1, workflow_id: 'wf-del', revision_number: 1, spec_hash: 'h1' });
      db.updateDefinition(client, 'wf-del', { published_revision_id: 'rev-del-1' });

      // 2. Attach an execution run to Revision 1
      db.insertRun(client, {
        id: 'run-locked',
        tenant_id: 1,
        workflow_id: 'wf-del',
        revision_id: 'rev-del-1',
        temporal_workflow_id: 'wf_1_lock_exec',
        correlation_id: 'corr-lock',
        trigger_type: 'event',
      });

      // 3. Attempt to delete Revision 1: MUST FAIL due to ON DELETE RESTRICT on workflow_runs
      assert.throws(
        () => {
          db.deleteRevision(client, 'rev-del-1');
        },
        { code: '23503' }
      );

      // 4. Create Revision 2 (without runs), publish it, and delete Revision 2
      db.insertRevision(client, { id: 'rev-del-2', tenant_id: 1, workflow_id: 'wf-del', revision_number: 2, spec_hash: 'h2' });
      db.updateDefinition(client, 'wf-del', { published_revision_id: 'rev-del-2' });

      // Deleting Revision 2 (which has no runs) must succeed and trigger ON DELETE SET NULL on definition
      const del2Result = db.deleteRevision(client, 'rev-del-2');
      assert.strictEqual(del2Result, 1);

      const defAfter = db.selectDefinitions(client, { id: 'wf-del' })[0];
      assert.strictEqual(defAfter.published_revision_id, null, 'published_revision_id must be SET NULL');
    });
  });
});
