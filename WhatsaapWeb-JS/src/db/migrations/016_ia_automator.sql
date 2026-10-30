-- Sprint 6 v3 - Sistema IA Automatizador + Pasarelas Pago.
-- Additive-only. Cierra brechas de gobernanza IA, handoff, pausa per-chat,
-- multi-pasarela de pagos y auditoría de runtime logs.

ALTER TABLE company_settings
  ADD COLUMN IF NOT EXISTS automator_mode VARCHAR(20) NOT NULL DEFAULT 'normal'
  CHECK (automator_mode IN ('normal','mixed','automator'));

ALTER TABLE ai_agents
  ADD COLUMN IF NOT EXISTS auto_confirm_orders BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_create_vouchers BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_generate_payment_links BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE agent_runtime_logs
  ADD COLUMN IF NOT EXISTS confidence NUMERIC(4,2),
  ADD COLUMN IF NOT EXISTS action VARCHAR(40),
  ADD COLUMN IF NOT EXISTS actor_agent_id BIGINT REFERENCES ai_agents(id) ON DELETE SET NULL;

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS ia_paused BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ia_paused_by BIGINT REFERENCES usuarios(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS ia_paused_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ia_resume_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_conversations_ia_paused
  ON conversations(company_id, ia_paused) WHERE ia_paused = true;

CREATE TABLE IF NOT EXISTS handoff_tickets (
  id BIGSERIAL PRIMARY KEY,
  company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  conversation_id INT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  agent_id BIGINT REFERENCES ai_agents(id) ON DELETE SET NULL,
  order_id BIGINT REFERENCES customer_orders(id) ON DELETE SET NULL,
  reason VARCHAR(200) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'open',
  taken_by BIGINT REFERENCES usuarios(id) ON DELETE SET NULL,
  taken_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  notes TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_handoff_status CHECK (status IN ('open','taken','closed','cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_handoff_tickets_company_status_created
  ON handoff_tickets(company_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_handoff_tickets_conversation
  ON handoff_tickets(conversation_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS payment_gateways (
  id BIGSERIAL PRIMARY KEY,
  company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  provider VARCHAR(40) NOT NULL,
  display_name VARCHAR(100) NOT NULL,
  credentials_json JSONB NOT NULL DEFAULT '{}',
  webhook_secret TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  is_default BOOLEAN NOT NULL DEFAULT false,
  metadata_json JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_payment_gateways_provider CHECK (
    provider IN ('mercadopago','stripe','paypal','manual','other')
  ),
  CONSTRAINT chk_payment_gateways_status CHECK (status IN ('active','inactive','archived'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_gateways_company_default
  ON payment_gateways(company_id) WHERE is_default = true;

CREATE INDEX IF NOT EXISTS idx_payment_gateways_company_status
  ON payment_gateways(company_id, status);

ALTER TABLE payment_vouchers
  ADD COLUMN IF NOT EXISTS gateway_id BIGINT REFERENCES payment_gateways(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS gateway_payment_id VARCHAR(200),
  ADD COLUMN IF NOT EXISTS payment_link_url TEXT,
  ADD COLUMN IF NOT EXISTS payment_link_expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_payment_vouchers_gateway
  ON payment_vouchers(gateway_id) WHERE gateway_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS ia_pause_overrides (
  id BIGSERIAL PRIMARY KEY,
  company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  conversation_id INT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  paused_by BIGINT REFERENCES usuarios(id) ON DELETE SET NULL,
  reason VARCHAR(200),
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_ia_pause_overrides_conversation UNIQUE (conversation_id)
);
