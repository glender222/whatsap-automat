-- Migration 024: Create Processing Outbox, Idempotency Ledger and Channel Capabilities Snapshots
-- Specification: PR-F2-02 (WAA-006, WAA-007, SEC-005, PROD-004, PROD-012, ADR-005, ADR-007)
-- Description: Establishes transactional outbox with delivery_unknown status semantics,
--              idempotency ledger for webhook and dispatch deduplication,
--              and capability snapshot persistence with engine-level PostgreSQL RLS.

-- -----------------------------------------------------------------------------
-- 1. Table Definitions
-- -----------------------------------------------------------------------------

-- 1.1 processing_outbox: Guaranteed at-least-once transactional dispatch
CREATE TABLE IF NOT EXISTS processing_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id INTEGER REFERENCES workspaces(id) ON DELETE SET NULL,
  event_type VARCHAR(255) NOT NULL,
  event_id UUID NOT NULL,
  correlation_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload JSONB NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'pending',
  retry_count INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 5,
  next_retry_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_processing_outbox_tenant_idempotency UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT chk_outbox_status CHECK (
    status IN ('pending', 'processing', 'dispatched', 'completed', 'failed', 'delivery_unknown', 'dead_letter')
  )
);

CREATE INDEX IF NOT EXISTS idx_processing_outbox_tenant_status
ON processing_outbox(tenant_id, status);

CREATE INDEX IF NOT EXISTS idx_processing_outbox_dispatch_poll
ON processing_outbox(status, next_retry_at)
WHERE status IN ('pending', 'processing', 'delivery_unknown');

CREATE INDEX IF NOT EXISTS idx_processing_outbox_correlation
ON processing_outbox(tenant_id, correlation_id);

-- 1.2 idempotency_ledger: Webhook & command deduplication ledger (SEC-005)
CREATE TABLE IF NOT EXISTS idempotency_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  source VARCHAR(100) NOT NULL,
  request_hash TEXT,
  response_status INTEGER,
  response_body JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_idempotency_ledger UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_idempotency_ledger_tenant_key
ON idempotency_ledger(tenant_id, idempotency_key);

CREATE INDEX IF NOT EXISTS idx_idempotency_ledger_created_at
ON idempotency_ledger(created_at);

-- 1.2.1 idempotency_keys compatibility view
CREATE OR REPLACE VIEW idempotency_keys AS
SELECT * FROM idempotency_ledger;

-- 1.3 channel_capabilities_snapshots: Persisted capability matrices per connection (PROD-012)
CREATE TABLE IF NOT EXISTS channel_capabilities_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connection_id VARCHAR(255) NOT NULL,
  channel VARCHAR(50) NOT NULL,
  matrix JSONB NOT NULL,
  health_status VARCHAR(50) NOT NULL DEFAULT 'healthy',
  last_evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_channel_capabilities_connection UNIQUE (tenant_id, connection_id)
);

CREATE INDEX IF NOT EXISTS idx_channel_capabilities_tenant_conn
ON channel_capabilities_snapshots(tenant_id, connection_id);

-- -----------------------------------------------------------------------------
-- 2. Row-Level Security (RLS) Enablement & Policy Creation
-- -----------------------------------------------------------------------------

-- 2.1 processing_outbox RLS
ALTER TABLE processing_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE processing_outbox FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_policy ON processing_outbox;
CREATE POLICY tenant_isolation_policy ON processing_outbox
  AS PERMISSIVE
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);

-- 2.2 idempotency_ledger RLS
ALTER TABLE idempotency_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_ledger FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_policy ON idempotency_ledger;
CREATE POLICY tenant_isolation_policy ON idempotency_ledger
  AS PERMISSIVE
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);

-- 2.3 channel_capabilities_snapshots RLS
ALTER TABLE channel_capabilities_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_capabilities_snapshots FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_policy ON channel_capabilities_snapshots;
CREATE POLICY tenant_isolation_policy ON channel_capabilities_snapshots
  AS PERMISSIVE
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);

-- =============================================================================
-- REVERT / ROLLBACK SPECIFICATION (Reference for idempotent down-migration):
--
-- DROP POLICY IF EXISTS tenant_isolation_policy ON channel_capabilities_snapshots;
-- ALTER TABLE channel_capabilities_snapshots NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE channel_capabilities_snapshots DISABLE ROW LEVEL SECURITY;
-- DROP TABLE IF EXISTS channel_capabilities_snapshots CASCADE;
--
-- DROP POLICY IF EXISTS tenant_isolation_policy ON idempotency_ledger;
-- ALTER TABLE idempotency_ledger NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE idempotency_ledger DISABLE ROW LEVEL SECURITY;
-- DROP VIEW IF EXISTS idempotency_keys CASCADE;
-- DROP TABLE IF EXISTS idempotency_ledger CASCADE;
--
-- DROP POLICY IF EXISTS tenant_isolation_policy ON processing_outbox;
-- ALTER TABLE processing_outbox NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE processing_outbox DISABLE ROW LEVEL SECURITY;
-- DROP TABLE IF EXISTS processing_outbox CASCADE;
-- =============================================================================
