-- Migration 026: Create Workflows, Immutable Revisions, Runs, and Channel-less Triggers
-- Specification: Fase F4 (WAA-011, WAA-014, PROD-001, PROD-006, ADR-001, ADR-006, ADR-010, ADR-022)
-- Description: Establishes durable workflow definitions with published revision pointers,
--              immutable workflow DAG revision history, workflow execution instances
--              pinned to immutable revisions, and channel-less triggers (UC-06)
--              with engine-level PostgreSQL Row-Level Security (RLS).

-- -----------------------------------------------------------------------------
-- 1. Table Definitions
-- -----------------------------------------------------------------------------

-- 1.1 workflow_definitions: Logical entity anchor
CREATE TABLE IF NOT EXISTS workflow_definitions (
  id VARCHAR(255) PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id INTEGER REFERENCES workspaces(id) ON DELETE SET NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  published_revision_id VARCHAR(255),
  status VARCHAR(50) NOT NULL DEFAULT 'draft',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_workflow_definitions_status CHECK (
    status IN ('draft', 'published', 'archived')
  )
);

CREATE INDEX IF NOT EXISTS idx_workflow_definitions_tenant_status
ON workflow_definitions(tenant_id, status);

-- 1.2 workflow_revisions: Immutable graph snapshots
CREATE TABLE IF NOT EXISTS workflow_revisions (
  id VARCHAR(255) PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workflow_id VARCHAR(255) NOT NULL REFERENCES workflow_definitions(id) ON DELETE CASCADE,
  revision_number INTEGER NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'draft',
  dag_graph JSONB NOT NULL DEFAULT '{"nodes":[],"edges":[]}'::jsonb,
  spec_hash VARCHAR(64) NOT NULL,
  limits JSONB NOT NULL DEFAULT '{"maxSteps":100,"maxDurationSeconds":86400}'::jsonb,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_workflow_revisions_tenant_workflow_rev UNIQUE (tenant_id, workflow_id, revision_number),
  CONSTRAINT chk_workflow_revisions_status CHECK (
    status IN ('draft', 'published', 'archived')
  )
);

CREATE INDEX IF NOT EXISTS idx_workflow_revisions_tenant_workflow
ON workflow_revisions(tenant_id, workflow_id, revision_number);

-- Add foreign key from definition to published revision
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_workflow_definitions_published_rev'
  ) THEN
    ALTER TABLE workflow_definitions
      ADD CONSTRAINT fk_workflow_definitions_published_rev
      FOREIGN KEY (published_revision_id) REFERENCES workflow_revisions(id)
      ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

-- 1.3 workflow_runs: Execution instances bound to immutable revisions
CREATE TABLE IF NOT EXISTS workflow_runs (
  id VARCHAR(255) PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id INTEGER REFERENCES workspaces(id) ON DELETE SET NULL,
  workflow_id VARCHAR(255) NOT NULL REFERENCES workflow_definitions(id) ON DELETE CASCADE,
  revision_id VARCHAR(255) NOT NULL REFERENCES workflow_revisions(id) ON DELETE RESTRICT,
  temporal_workflow_id VARCHAR(255) NOT NULL,
  temporal_run_id VARCHAR(255),
  correlation_id TEXT NOT NULL,
  trigger_type VARCHAR(50) NOT NULL,
  trigger_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status VARCHAR(50) NOT NULL DEFAULT 'queued',
  current_step VARCHAR(255),
  step_count INTEGER NOT NULL DEFAULT 0,
  state_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  error_details JSONB,
  CONSTRAINT uq_workflow_runs_temporal UNIQUE (tenant_id, temporal_workflow_id),
  CONSTRAINT chk_workflow_runs_trigger_type CHECK (
    trigger_type IN ('webhook', 'schedule', 'event', 'manual', 'channel.message')
  ),
  CONSTRAINT chk_workflow_runs_status CHECK (
    status IN ('queued', 'running', 'waiting_timer', 'waiting_approval', 'completed', 'failed', 'cancelled')
  )
);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_tenant_status
ON workflow_runs(tenant_id, status);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_correlation
ON workflow_runs(tenant_id, correlation_id);

-- 1.4 workflow_triggers: Universal channel-less triggers (UC-06)
CREATE TABLE IF NOT EXISTS workflow_triggers (
  id VARCHAR(255) PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workflow_id VARCHAR(255) NOT NULL REFERENCES workflow_definitions(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL,
  endpoint_key VARCHAR(255) UNIQUE,
  auth_token_hash VARCHAR(255),
  cron_expression VARCHAR(100),
  is_active BOOLEAN NOT NULL DEFAULT true,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_workflow_triggers_type CHECK (
    type IN ('webhook', 'schedule', 'event')
  )
);

CREATE INDEX IF NOT EXISTS idx_workflow_triggers_tenant_type
ON workflow_triggers(tenant_id, type, is_active);

-- -----------------------------------------------------------------------------
-- 2. Row-Level Security (RLS) Enablement & Policy Creation
-- -----------------------------------------------------------------------------

-- 2.1 workflow_definitions RLS
ALTER TABLE workflow_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_definitions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_policy ON workflow_definitions;
CREATE POLICY tenant_isolation_policy ON workflow_definitions
  AS PERMISSIVE
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);

-- 2.2 workflow_revisions RLS
ALTER TABLE workflow_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_revisions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_policy ON workflow_revisions;
CREATE POLICY tenant_isolation_policy ON workflow_revisions
  AS PERMISSIVE
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);

-- 2.3 workflow_runs RLS
ALTER TABLE workflow_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_policy ON workflow_runs;
CREATE POLICY tenant_isolation_policy ON workflow_runs
  AS PERMISSIVE
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);

-- 2.4 workflow_triggers RLS
ALTER TABLE workflow_triggers ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_triggers FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_policy ON workflow_triggers;
CREATE POLICY tenant_isolation_policy ON workflow_triggers
  AS PERMISSIVE
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);

-- =============================================================================
-- REVERT / ROLLBACK SPECIFICATION (Reference for idempotent down-migration):
--
-- DROP POLICY IF EXISTS tenant_isolation_policy ON workflow_triggers;
-- ALTER TABLE workflow_triggers NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE workflow_triggers DISABLE ROW LEVEL SECURITY;
-- DROP TABLE IF EXISTS workflow_triggers CASCADE;
--
-- DROP POLICY IF EXISTS tenant_isolation_policy ON workflow_runs;
-- ALTER TABLE workflow_runs NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE workflow_runs DISABLE ROW LEVEL SECURITY;
-- DROP TABLE IF EXISTS workflow_runs CASCADE;
--
-- ALTER TABLE workflow_definitions DROP CONSTRAINT IF EXISTS fk_workflow_definitions_published_rev;
--
-- DROP POLICY IF EXISTS tenant_isolation_policy ON workflow_revisions;
-- ALTER TABLE workflow_revisions NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE workflow_revisions DISABLE ROW LEVEL SECURITY;
-- DROP TABLE IF EXISTS workflow_revisions CASCADE;
--
-- DROP POLICY IF EXISTS tenant_isolation_policy ON workflow_definitions;
-- ALTER TABLE workflow_definitions NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE workflow_definitions DISABLE ROW LEVEL SECURITY;
-- DROP TABLE IF EXISTS workflow_definitions CASCADE;
-- =============================================================================
