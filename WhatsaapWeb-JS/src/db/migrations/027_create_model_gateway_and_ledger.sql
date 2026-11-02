-- Migration 027: ModelGateway BYOK & Token Cost Ledger
-- Specification: Milestone M1 / PR-F5-01 (WAA-012, PROD-009, PROD-017, ADR-011, ADR-021)
-- Description: Establishes tenant-scoped AI provider configurations (BYOK),
--              monthly spending quotas and budget limits with micro-USD arithmetic,
--              and immutable token/cost accounting event ledger with engine-level
--              PostgreSQL Row-Level Security (RLS).

-- -----------------------------------------------------------------------------
-- 1. Table Definitions
-- -----------------------------------------------------------------------------

-- 1.1 tenant_ai_providers: Tenant BYOK LLM credentials and endpoints
CREATE TABLE IF NOT EXISTS tenant_ai_providers (
  id BIGSERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider VARCHAR(60) NOT NULL,
  encrypted_api_key TEXT,
  key_fingerprint VARCHAR(32),
  base_url VARCHAR(500),
  default_model VARCHAR(120),
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_tenant_ai_providers UNIQUE (tenant_id, provider),
  CONSTRAINT chk_tenant_ai_providers_provider CHECK (
    provider IN ('openai', 'anthropic', 'local_openai', 'ollama', 'vllm')
  )
);

CREATE INDEX IF NOT EXISTS idx_tenant_ai_providers_lookup
ON tenant_ai_providers(tenant_id, provider, is_active);

-- 1.2 tenant_ai_quotas: Monthly token and micro-USD budget limits
CREATE TABLE IF NOT EXISTS tenant_ai_quotas (
  tenant_id INTEGER PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  monthly_cost_limit_micro_usd BIGINT NOT NULL DEFAULT 100000000, -- Default $100.00 USD (100M micro-USD)
  monthly_token_limit BIGINT NOT NULL DEFAULT 10000000,          -- Default 10M tokens
  current_month_cost_micro_usd BIGINT NOT NULL DEFAULT 0,
  current_month_tokens_used BIGINT NOT NULL DEFAULT 0,
  hard_limit_enabled BOOLEAN NOT NULL DEFAULT true,
  hard_limit_action VARCHAR(50) NOT NULL DEFAULT 'block',
  period_start TIMESTAMPTZ NOT NULL DEFAULT date_trunc('month', NOW()),
  reset_at TIMESTAMPTZ NOT NULL DEFAULT (date_trunc('month', NOW()) + INTERVAL '1 month'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_tenant_ai_quotas_non_negative CHECK (
    monthly_cost_limit_micro_usd >= 0 AND
    current_month_cost_micro_usd >= 0 AND
    monthly_token_limit >= 0 AND
    current_month_tokens_used >= 0
  ),
  CONSTRAINT chk_tenant_ai_quotas_action CHECK (
    hard_limit_action IN ('block', 'fallback_local', 'warn')
  )
);

-- 1.3 ai_token_cost_ledger: Immutable token & cost accounting audit log
CREATE TABLE IF NOT EXISTS ai_token_cost_ledger (
  id BIGSERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id INTEGER REFERENCES workspaces(id) ON DELETE SET NULL,
  agent_id VARCHAR(255),
  agent_run_id VARCHAR(255),
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  provider VARCHAR(60) NOT NULL,
  model VARCHAR(120) NOT NULL,
  operation VARCHAR(50) NOT NULL DEFAULT 'completion',
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cost_micro_usd BIGINT NOT NULL DEFAULT 0,
  is_byok BOOLEAN NOT NULL DEFAULT false,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  status VARCHAR(30) NOT NULL DEFAULT 'success',
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_ai_ledger_tokens_non_negative CHECK (
    prompt_tokens >= 0 AND
    completion_tokens >= 0 AND
    total_tokens >= 0 AND
    cost_micro_usd >= 0
  ),
  CONSTRAINT chk_ai_ledger_operation CHECK (
    operation IN ('completion', 'embedding', 'eval', 'tool_reasoning')
  ),
  CONSTRAINT chk_ai_ledger_status CHECK (
    status IN ('success', 'failed', 'timeout', 'rate_limited', 'budget_exhausted')
  )
);

CREATE INDEX IF NOT EXISTS idx_ai_token_cost_ledger_tenant_time
ON ai_token_cost_ledger(tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_token_cost_ledger_run
ON ai_token_cost_ledger(tenant_id, agent_run_id)
WHERE agent_run_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ai_token_cost_ledger_conversation
ON ai_token_cost_ledger(tenant_id, conversation_id)
WHERE conversation_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 2. Seed & Backfill Logic (Executed BEFORE RLS is forced)
-- -----------------------------------------------------------------------------

DO $$
BEGIN
  -- Backfill default tenant_ai_quotas for existing tenants
  INSERT INTO tenant_ai_quotas (
    tenant_id,
    monthly_cost_limit_micro_usd,
    monthly_token_limit,
    current_month_cost_micro_usd,
    current_month_tokens_used,
    hard_limit_enabled,
    hard_limit_action,
    period_start,
    reset_at,
    updated_at
  )
  SELECT
    t.id,
    100000000,
    10000000,
    0,
    0,
    true,
    'block',
    date_trunc('month', NOW()),
    (date_trunc('month', NOW()) + INTERVAL '1 month'),
    NOW()
  FROM tenants t
  ON CONFLICT (tenant_id) DO NOTHING;
END $$;

-- -----------------------------------------------------------------------------
-- 3. Row-Level Security (RLS) Enablement & Policy Creation
-- -----------------------------------------------------------------------------

-- 3.1 tenant_ai_providers RLS
ALTER TABLE tenant_ai_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_ai_providers FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_policy ON tenant_ai_providers;
CREATE POLICY tenant_isolation_policy ON tenant_ai_providers
  AS PERMISSIVE
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);

-- 3.2 tenant_ai_quotas RLS
ALTER TABLE tenant_ai_quotas ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_ai_quotas FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_policy ON tenant_ai_quotas;
CREATE POLICY tenant_isolation_policy ON tenant_ai_quotas
  AS PERMISSIVE
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);

-- 3.3 ai_token_cost_ledger RLS
ALTER TABLE ai_token_cost_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_token_cost_ledger FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_policy ON ai_token_cost_ledger;
CREATE POLICY tenant_isolation_policy ON ai_token_cost_ledger
  AS PERMISSIVE
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);

-- =============================================================================
-- REVERT / ROLLBACK SPECIFICATION (Reference for idempotent down-migration):
--
-- DROP POLICY IF EXISTS tenant_isolation_policy ON ai_token_cost_ledger;
-- ALTER TABLE ai_token_cost_ledger NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE ai_token_cost_ledger DISABLE ROW LEVEL SECURITY;
-- DROP TABLE IF EXISTS ai_token_cost_ledger CASCADE;
--
-- DROP POLICY IF EXISTS tenant_isolation_policy ON tenant_ai_quotas;
-- ALTER TABLE tenant_ai_quotas NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE tenant_ai_quotas DISABLE ROW LEVEL SECURITY;
-- DROP TABLE IF EXISTS tenant_ai_quotas CASCADE;
--
-- DROP POLICY IF EXISTS tenant_isolation_policy ON tenant_ai_providers;
-- ALTER TABLE tenant_ai_providers NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE tenant_ai_providers DISABLE ROW LEVEL SECURITY;
-- DROP TABLE IF EXISTS tenant_ai_providers CASCADE;
-- =============================================================================
