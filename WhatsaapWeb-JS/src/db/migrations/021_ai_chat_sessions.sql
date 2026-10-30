-- Sesiones IA SaaS por chat y eventos internos auditables.

CREATE TABLE IF NOT EXISTS ai_chat_sessions (
  id BIGSERIAL PRIMARY KEY,
  company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  domain_key VARCHAR(60) NOT NULL,
  conversation_id INT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  chat_id VARCHAR(100) NOT NULL,
  agent_id BIGINT REFERENCES ai_agents(id) ON DELETE SET NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  last_inbound_provider_message_id VARCHAR(200),
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata_json JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_ai_chat_sessions_scope UNIQUE (company_id, domain_key, conversation_id),
  CONSTRAINT chk_ai_chat_sessions_domain CHECK (
    domain_key IN ('gestion_web', 'inventory_stock', 'commercial_catalog', 'orders', 'support', 'payments')
  ),
  CONSTRAINT chk_ai_chat_sessions_status CHECK (status IN ('active', 'paused', 'handoff', 'closed'))
);

CREATE INDEX IF NOT EXISTS idx_ai_chat_sessions_company_chat
ON ai_chat_sessions(company_id, chat_id);

CREATE INDEX IF NOT EXISTS idx_ai_chat_sessions_domain_status
ON ai_chat_sessions(company_id, domain_key, status, last_activity_at DESC);

CREATE TABLE IF NOT EXISTS ai_session_turns (
  id BIGSERIAL PRIMARY KEY,
  company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  session_id BIGINT NOT NULL REFERENCES ai_chat_sessions(id) ON DELETE CASCADE,
  domain_key VARCHAR(60) NOT NULL,
  conversation_id INT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  chat_id VARCHAR(100) NOT NULL,
  agent_id BIGINT REFERENCES ai_agents(id) ON DELETE SET NULL,
  inbound_provider_message_id VARCHAR(200),
  mode VARCHAR(20) NOT NULL,
  is_test BOOLEAN NOT NULL DEFAULT false,
  status VARCHAR(20) NOT NULL DEFAULT 'running',
  final_action VARCHAR(40),
  final_reply_preview TEXT,
  command_count INT NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT chk_ai_session_turns_mode CHECK (mode IN ('suggest', 'auto')),
  CONSTRAINT chk_ai_session_turns_status CHECK (status IN ('running', 'ok', 'skipped', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_ai_session_turns_session_started
ON ai_session_turns(session_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_session_turns_domain_started
ON ai_session_turns(company_id, domain_key, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_session_turns_agent_started
ON ai_session_turns(company_id, agent_id, started_at DESC);

CREATE TABLE IF NOT EXISTS ai_session_events (
  id BIGSERIAL PRIMARY KEY,
  company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  session_id BIGINT NOT NULL REFERENCES ai_chat_sessions(id) ON DELETE CASCADE,
  turn_id BIGINT REFERENCES ai_session_turns(id) ON DELETE CASCADE,
  domain_key VARCHAR(60) NOT NULL,
  conversation_id INT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  chat_id VARCHAR(100) NOT NULL,
  agent_id BIGINT REFERENCES ai_agents(id) ON DELETE SET NULL,
  kind VARCHAR(30) NOT NULL,
  title VARCHAR(160) NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  status VARCHAR(20) NOT NULL DEFAULT 'ok',
  tool_name VARCHAR(80),
  tool_call_id VARCHAR(120),
  duration_ms INT,
  input_sanitized_json JSONB NOT NULL DEFAULT '{}',
  output_sanitized_json JSONB NOT NULL DEFAULT '{}',
  related_order_id BIGINT REFERENCES customer_orders(id) ON DELETE SET NULL,
  related_handoff_id BIGINT REFERENCES handoff_tickets(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_ai_session_events_kind CHECK (
    kind IN ('session', 'tool', 'state', 'preorder', 'handoff', 'suggestion', 'delivery', 'error')
  ),
  CONSTRAINT chk_ai_session_events_status CHECK (status IN ('running', 'ok', 'skipped', 'failed', 'forbidden'))
);

CREATE INDEX IF NOT EXISTS idx_ai_session_events_turn_created
ON ai_session_events(turn_id, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_ai_session_events_domain_created
ON ai_session_events(company_id, domain_key, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_session_events_tool_created
ON ai_session_events(company_id, tool_name, created_at DESC)
WHERE tool_name IS NOT NULL;
