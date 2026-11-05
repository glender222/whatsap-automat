-- Migration 031: Immutable Audit Events Ledger & Envelope-Encrypted Secrets Store
-- Specification: Phase F8 (WAA-023, SEC-006, SEC-011, PROD-014, ADR-013, ADR-021)
-- Description: Establishes audit_events (immutable audit log with trigger-enforced UPDATE/DELETE
--              prohibition) and tenant_secrets (envelope-encrypted credential storage)
--              with strict PostgreSQL Row-Level Security (RLS).

-- -----------------------------------------------------------------------------
-- 1. Table audit_events (Immutable Audit Trail)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  actor_id INTEGER,
  actor_type VARCHAR(50) NOT NULL DEFAULT 'user',
  action VARCHAR(100) NOT NULL,
  resource_type VARCHAR(100) NOT NULL,
  resource_id VARCHAR(100),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip_address VARCHAR(45),
  user_agent TEXT,
  trace_id VARCHAR(100),
  decision VARCHAR(50) NOT NULL DEFAULT 'allow',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Comprehensive indexes for high-throughput compliance queries
CREATE INDEX IF NOT EXISTS idx_audit_events_tenant_created
ON audit_events(tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_events_tenant_resource
ON audit_events(tenant_id, resource_type, resource_id);

CREATE INDEX IF NOT EXISTS idx_audit_events_tenant_action
ON audit_events(tenant_id, action);

CREATE INDEX IF NOT EXISTS idx_audit_events_trace_id
ON audit_events(tenant_id, trace_id)
WHERE trace_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 2. Trigger Function: prevent_audit_events_mutation
-- -----------------------------------------------------------------------------
-- Strictly forbids any UPDATE, DELETE, or TRUNCATE operations against audit_events
-- at the database engine level, returning an uncatchable SQL exception.

CREATE OR REPLACE FUNCTION prevent_audit_events_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_events table is immutable: UPDATE and DELETE operations are forbidden'
    USING ERRCODE = '23000'; -- integrity_constraint_violation
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_audit_events_mutation ON audit_events;
CREATE TRIGGER trg_prevent_audit_events_mutation
BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW
EXECUTE FUNCTION prevent_audit_events_mutation();

DROP TRIGGER IF EXISTS trg_prevent_audit_events_truncate ON audit_events;
CREATE TRIGGER trg_prevent_audit_events_truncate
BEFORE TRUNCATE ON audit_events
FOR EACH STATEMENT
EXECUTE FUNCTION prevent_audit_events_mutation();

-- Row Level Security for audit_events
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON audit_events;
CREATE POLICY tenant_isolation_policy ON audit_events
  AS PERMISSIVE
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);

-- -----------------------------------------------------------------------------
-- 3. Table tenant_secrets (Envelope-Encrypted Credentials Store)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS tenant_secrets (
  id VARCHAR(255) PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  secret_name VARCHAR(255) NOT NULL,
  category VARCHAR(100) NOT NULL DEFAULT 'channel_credential',
  encrypted_dek TEXT NOT NULL,
  encrypted_data TEXT NOT NULL,
  iv VARCHAR(64) NOT NULL,
  tag VARCHAR(64) NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  algorithm VARCHAR(50) NOT NULL DEFAULT 'aes-256-gcm',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_tenant_secrets_tenant_name UNIQUE (tenant_id, secret_name),
  CONSTRAINT chk_tenant_secrets_algorithm
    CHECK (algorithm IN ('aes-256-gcm')),
  CONSTRAINT chk_tenant_secrets_category
    CHECK (category IN ('channel_credential', 'byok', 'webhook_secret', 'oauth_token', 'smtp_credential', 'custom'))
);

CREATE INDEX IF NOT EXISTS idx_tenant_secrets_lookup
ON tenant_secrets(tenant_id, secret_name);

CREATE INDEX IF NOT EXISTS idx_tenant_secrets_category
ON tenant_secrets(tenant_id, category);

CREATE INDEX IF NOT EXISTS idx_tenant_secrets_version
ON tenant_secrets(tenant_id, key_version);

-- Row Level Security for tenant_secrets
ALTER TABLE tenant_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_secrets FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON tenant_secrets;
CREATE POLICY tenant_isolation_policy ON tenant_secrets
  AS PERMISSIVE
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);

-- =============================================================================
-- REVERT / ROLLBACK SPECIFICATION (Reference for idempotent down-migration):
--
-- DROP POLICY IF EXISTS tenant_isolation_policy ON tenant_secrets;
-- ALTER TABLE tenant_secrets NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE tenant_secrets DISABLE ROW LEVEL SECURITY;
-- DROP TABLE IF EXISTS tenant_secrets;
--
-- DROP POLICY IF EXISTS tenant_isolation_policy ON audit_events;
-- ALTER TABLE audit_events NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE audit_events DISABLE ROW LEVEL SECURITY;
-- DROP TRIGGER IF EXISTS trg_prevent_audit_events_mutation ON audit_events;
-- DROP TRIGGER IF EXISTS trg_prevent_audit_events_truncate ON audit_events;
-- DROP FUNCTION IF EXISTS prevent_audit_events_mutation;
-- DROP TABLE IF EXISTS audit_events;
-- =============================================================================
