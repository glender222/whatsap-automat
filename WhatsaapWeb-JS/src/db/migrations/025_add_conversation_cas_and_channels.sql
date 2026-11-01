-- Migration 025: Add Conversation CAS Concurrency, Ownership Epoch and Channel Connections
-- Specification: PR-F3-01 (WAA-008, SEC-004, ADR-008, PROD-005)
-- Description: Adds version, ownership_epoch, owner_type, owner_id to conversations table
--              for atomic Compare-And-Swap (CAS) optimistic concurrency and AI fencing tokens.
--              Creates channel_connections table with engine-level PostgreSQL Row-Level Security (RLS).

-- -----------------------------------------------------------------------------
-- 1. Alter Table conversations (CAS Concurrency & AI Epoch Fencing)
-- -----------------------------------------------------------------------------

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS ownership_epoch INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS owner_type VARCHAR(50) NOT NULL DEFAULT 'ai_agent',
  ADD COLUMN IF NOT EXISTS owner_id VARCHAR(255);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_conversations_owner_type'
  ) THEN
    ALTER TABLE conversations
      ADD CONSTRAINT chk_conversations_owner_type
      CHECK (owner_type IN ('none', 'human', 'ai_agent', 'system', 'workflow'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_conversations_company_owner
ON conversations(company_id, owner_type, owner_id);

CREATE INDEX IF NOT EXISTS idx_conversations_epoch_fencing
ON conversations(company_id, id, ownership_epoch);

-- Re-assert Row-Level Security on conversations
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- 2. Create Table channel_connections
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS channel_connections (
  id VARCHAR(255) PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id INTEGER REFERENCES workspaces(id) ON DELETE SET NULL,
  channel VARCHAR(50) NOT NULL,
  account_id VARCHAR(255) NOT NULL,
  name VARCHAR(255),
  status VARCHAR(50) NOT NULL DEFAULT 'active',
  credentials_encrypted JSONB,
  metadata_json JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_channel_connections_tenant_channel_account UNIQUE (tenant_id, channel, account_id),
  CONSTRAINT chk_channel_connections_status CHECK (
    status IN ('active', 'inactive', 'needs_reauthorization', 'error')
  )
);

CREATE INDEX IF NOT EXISTS idx_channel_connections_tenant_channel
ON channel_connections(tenant_id, channel, status);

CREATE INDEX IF NOT EXISTS idx_channel_connections_workspace
ON channel_connections(tenant_id, workspace_id)
WHERE workspace_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 3. Row-Level Security (RLS) on channel_connections
-- -----------------------------------------------------------------------------

ALTER TABLE channel_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_connections FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON channel_connections;
CREATE POLICY tenant_isolation_policy ON channel_connections
  AS PERMISSIVE
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);

-- =============================================================================
-- REVERT / ROLLBACK SPECIFICATION (Reference for idempotent down-migration):
--
-- DROP POLICY IF EXISTS tenant_isolation_policy ON channel_connections;
-- ALTER TABLE channel_connections NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE channel_connections DISABLE ROW LEVEL SECURITY;
-- DROP TABLE IF EXISTS channel_connections CASCADE;
--
-- DROP INDEX IF EXISTS idx_conversations_epoch_fencing;
-- DROP INDEX IF EXISTS idx_conversations_company_owner;
-- ALTER TABLE conversations DROP CONSTRAINT IF EXISTS chk_conversations_owner_type;
-- ALTER TABLE conversations DROP COLUMN IF EXISTS owner_id;
-- ALTER TABLE conversations DROP COLUMN IF EXISTS owner_type;
-- ALTER TABLE conversations DROP COLUMN IF EXISTS ownership_epoch;
-- ALTER TABLE conversations DROP COLUMN IF EXISTS version;
-- =============================================================================
