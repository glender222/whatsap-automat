-- Migration 030: Campaigns, Audiences, Dynamic Segmentation and Verifiable Consent Records
-- Specification: Phase F6 (WAA-016, WAA-017, SEC-008, PROD-007, ADR-020)
-- Description: Establishes consent_records (auditable opt-in/suppression ledger), segments (dynamic
--              audience rule evaluation), campaigns (broadcast orchestrator with rate limits and
--              circuit breaker), and campaign_deliveries with strict PostgreSQL RLS.

-- -----------------------------------------------------------------------------
-- 1. Table consent_records (Verifiable Opt-In & Suppression List)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS consent_records (
  id VARCHAR(255) PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  channel_type VARCHAR(50) NOT NULL,
  destination VARCHAR(255) NOT NULL,
  purpose VARCHAR(100) NOT NULL DEFAULT 'marketing',
  status VARCHAR(50) NOT NULL DEFAULT 'opted_in',
  evidence_type VARCHAR(100) NOT NULL DEFAULT 'manual',
  evidence_proof JSONB NOT NULL DEFAULT '{}'::jsonb,
  opted_in_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_consent_records_tenant_channel_dest_purpose
    UNIQUE (tenant_id, channel_type, destination, purpose),
  CONSTRAINT chk_consent_records_status
    CHECK (status IN ('opted_in', 'opted_out', 'suppressed', 'revoked')),
  CONSTRAINT chk_consent_records_purpose
    CHECK (purpose IN ('marketing', 'transactional', 'support', 'broadcast', 'all')),
  CONSTRAINT chk_consent_records_evidence
    CHECK (evidence_type IN ('web_form', 'chat_inbound', 'contract', 'import', 'right_to_be_forgotten', 'unsubscribe_link', 'keyword', 'manual'))
);

CREATE INDEX IF NOT EXISTS idx_consent_records_lookup
ON consent_records(tenant_id, channel_type, destination, purpose, status);

CREATE INDEX IF NOT EXISTS idx_consent_records_contact
ON consent_records(tenant_id, contact_id)
WHERE contact_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_consent_records_suppressed
ON consent_records(tenant_id, channel_type, destination)
WHERE status IN ('opted_out', 'suppressed', 'revoked');

-- RLS for consent_records
ALTER TABLE consent_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE consent_records FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON consent_records;
CREATE POLICY tenant_isolation_policy ON consent_records
  AS PERMISSIVE
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);

-- -----------------------------------------------------------------------------
-- 2. Table segments (Dynamic & Static Audience Definitions)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS segments (
  id VARCHAR(255) PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id INTEGER REFERENCES workspaces(id) ON DELETE SET NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  target_channel VARCHAR(50) NOT NULL DEFAULT 'any',
  criteria_json JSONB NOT NULL DEFAULT '{"combinator": "AND", "rules": []}'::jsonb,
  dynamic BOOLEAN NOT NULL DEFAULT TRUE,
  static_contact_ids INTEGER[] NOT NULL DEFAULT ARRAY[]::integer[],
  calculated_count INTEGER NOT NULL DEFAULT 0,
  last_calculated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_segments_tenant_name UNIQUE (tenant_id, name)
);

CREATE INDEX IF NOT EXISTS idx_segments_tenant_channel
ON segments(tenant_id, target_channel);

-- RLS for segments
ALTER TABLE segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE segments FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON segments;
CREATE POLICY tenant_isolation_policy ON segments
  AS PERMISSIVE
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);

-- -----------------------------------------------------------------------------
-- 3. Table campaigns (Broadcast Orchestrator)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS campaigns (
  id VARCHAR(255) PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id INTEGER REFERENCES workspaces(id) ON DELETE SET NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  channel VARCHAR(50) NOT NULL,
  connection_id VARCHAR(255) REFERENCES channel_connections(id) ON DELETE SET NULL,
  segment_id VARCHAR(255) REFERENCES segments(id) ON DELETE SET NULL,
  purpose VARCHAR(100) NOT NULL DEFAULT 'marketing',
  template_id VARCHAR(255),
  template_variables JSONB NOT NULL DEFAULT '{}'::jsonb,
  content_subject VARCHAR(255),
  content_body TEXT,
  status VARCHAR(50) NOT NULL DEFAULT 'draft',
  rate_limit_per_minute INTEGER NOT NULL DEFAULT 50,
  failure_pause_threshold_percent NUMERIC(5,2) NOT NULL DEFAULT 5.00,
  pause_reason TEXT,
  scheduled_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  stats_total INTEGER NOT NULL DEFAULT 0,
  stats_dispatched INTEGER NOT NULL DEFAULT 0,
  stats_delivered INTEGER NOT NULL DEFAULT 0,
  stats_failed INTEGER NOT NULL DEFAULT 0,
  stats_suppressed INTEGER NOT NULL DEFAULT 0,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_campaigns_status
    CHECK (status IN ('draft', 'scheduled', 'queued', 'dispatching', 'paused', 'completed', 'cancelled', 'failed')),
  CONSTRAINT chk_campaigns_rate_limit
    CHECK (rate_limit_per_minute > 0 AND rate_limit_per_minute <= 1000),
  CONSTRAINT chk_campaigns_threshold
    CHECK (failure_pause_threshold_percent >= 0.00 AND failure_pause_threshold_percent <= 100.00)
);

CREATE INDEX IF NOT EXISTS idx_campaigns_tenant_status
ON campaigns(tenant_id, status, scheduled_at);

CREATE INDEX IF NOT EXISTS idx_campaigns_tenant_segment
ON campaigns(tenant_id, segment_id);

-- RLS for campaigns
ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaigns FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON campaigns;
CREATE POLICY tenant_isolation_policy ON campaigns
  AS PERMISSIVE
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);

-- -----------------------------------------------------------------------------
-- 4. Table campaign_deliveries (Per-Recipient Audit & Queue Item)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS campaign_deliveries (
  id VARCHAR(255) PRIMARY KEY,
  campaign_id VARCHAR(255) NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  destination VARCHAR(255) NOT NULL,
  idempotency_key VARCHAR(255) NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'pending',
  suppression_reason VARCHAR(100),
  provider_message_id VARCHAR(255),
  error_code VARCHAR(100),
  error_message TEXT,
  rendered_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  dispatched_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_campaign_deliveries_idempotency UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT uq_campaign_deliveries_campaign_dest UNIQUE (campaign_id, destination),
  CONSTRAINT chk_campaign_deliveries_status
    CHECK (status IN ('pending', 'suppressed', 'dispatched', 'delivered', 'failed', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_campaign_deliveries_campaign_status
ON campaign_deliveries(campaign_id, status, created_at);

CREATE INDEX IF NOT EXISTS idx_campaign_deliveries_tenant_dest
ON campaign_deliveries(tenant_id, destination);

-- RLS for campaign_deliveries
ALTER TABLE campaign_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_deliveries FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON campaign_deliveries;
CREATE POLICY tenant_isolation_policy ON campaign_deliveries
  AS PERMISSIVE
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);
