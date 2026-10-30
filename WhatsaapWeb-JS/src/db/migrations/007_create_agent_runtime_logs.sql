-- Durable trace for automatic agent handling of WhatsApp conversations.

CREATE TABLE IF NOT EXISTS agent_runtime_logs (
  id BIGSERIAL PRIMARY KEY,
  company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  agent_id BIGINT REFERENCES ai_agents(id) ON DELETE SET NULL,
  provider VARCHAR(60) NOT NULL DEFAULT 'meta-cloud',
  chat_id VARCHAR(120),
  inbound_provider_message_id VARCHAR(255),
  outbound_provider_message_id VARCHAR(255),
  stage VARCHAR(80) NOT NULL,
  level VARCHAR(20) NOT NULL DEFAULT 'info',
  status VARCHAR(40) NOT NULL DEFAULT 'ok',
  summary TEXT NOT NULL DEFAULT '',
  error_code VARCHAR(120),
  error_message TEXT,
  payload_json JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_agent_runtime_logs_level CHECK (level IN ('debug', 'info', 'warn', 'error')),
  CONSTRAINT chk_agent_runtime_logs_status CHECK (status IN ('ok', 'skipped', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_agent_runtime_logs_company_created
ON agent_runtime_logs(company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_runtime_logs_chat_created
ON agent_runtime_logs(company_id, chat_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_runtime_logs_inbound_message
ON agent_runtime_logs(company_id, inbound_provider_message_id, created_at DESC);
