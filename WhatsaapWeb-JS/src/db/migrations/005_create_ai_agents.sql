-- Company-scoped AI agents for WhatsApp assistance.
-- This is separate from the legacy "bots" rules module.

CREATE TABLE IF NOT EXISTS ai_agents (
  id BIGSERIAL PRIMARY KEY,
  company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name VARCHAR(160) NOT NULL,
  status VARCHAR(40) NOT NULL DEFAULT 'draft',
  mode VARCHAR(40) NOT NULL DEFAULT 'suggest',
  provider VARCHAR(60) NOT NULL DEFAULT 'opencode',
  model VARCHAR(120),
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_by BIGINT REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_ai_agents_status CHECK (status IN ('draft', 'active', 'paused', 'archived')),
  CONSTRAINT chk_ai_agents_mode CHECK (mode IN ('disabled', 'suggest', 'auto'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_agents_default_company
ON ai_agents(company_id)
WHERE is_default = true AND status <> 'archived';

CREATE INDEX IF NOT EXISTS idx_ai_agents_company_status
ON ai_agents(company_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS agent_prompt_profiles (
  agent_id BIGINT PRIMARY KEY REFERENCES ai_agents(id) ON DELETE CASCADE,
  business_description TEXT NOT NULL DEFAULT '',
  communication_style TEXT NOT NULL DEFAULT '',
  selling_scope TEXT NOT NULL DEFAULT '',
  forbidden_claims TEXT NOT NULL DEFAULT '',
  language VARCHAR(80) NOT NULL DEFAULT 'es',
  tone VARCHAR(120) NOT NULL DEFAULT 'amable, claro y profesional',
  style TEXT NOT NULL DEFAULT '',
  welcome_message TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_knowledge_sources (
  id BIGSERIAL PRIMARY KEY,
  agent_id BIGINT NOT NULL REFERENCES ai_agents(id) ON DELETE CASCADE,
  source_type VARCHAR(40) NOT NULL,
  title VARCHAR(220) NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  url TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}',
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_agent_knowledge_type CHECK (
    source_type IN ('faq', 'product', 'pricing', 'policy', 'schedule', 'document', 'url', 'catalog')
  )
);

CREATE INDEX IF NOT EXISTS idx_agent_knowledge_agent_enabled
ON agent_knowledge_sources(agent_id, enabled, source_type);

CREATE TABLE IF NOT EXISTS agent_rules (
  agent_id BIGINT PRIMARY KEY REFERENCES ai_agents(id) ON DELETE CASCADE,
  auto_reply_when TEXT NOT NULL DEFAULT '',
  suggest_when TEXT NOT NULL DEFAULT '',
  handoff_when TEXT NOT NULL DEFAULT '',
  business_hours_json JSONB NOT NULL DEFAULT '{}',
  confidence_threshold NUMERIC(4, 2) NOT NULL DEFAULT 0.75,
  blocked_topics TEXT[] NOT NULL DEFAULT '{}',
  sensitive_topics TEXT[] NOT NULL DEFAULT '{}',
  max_context_messages INT NOT NULL DEFAULT 12,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_test_runs (
  id BIGSERIAL PRIMARY KEY,
  agent_id BIGINT REFERENCES ai_agents(id) ON DELETE SET NULL,
  company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  input_message TEXT NOT NULL,
  output_json JSONB NOT NULL DEFAULT '{}',
  created_by BIGINT REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_test_runs_agent_created
ON agent_test_runs(agent_id, created_at DESC);
