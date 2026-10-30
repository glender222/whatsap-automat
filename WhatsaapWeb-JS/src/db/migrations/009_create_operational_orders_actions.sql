-- Sprint 5 HU15: durable business-level orders and operational actions.
-- Audit logs remain technical/support traces; these tables are user-facing
-- operational history for customer context and reports.

CREATE TABLE IF NOT EXISTS customer_orders (
  id BIGSERIAL PRIMARY KEY,
  company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  contact_id INT REFERENCES contacts(id) ON DELETE SET NULL,
  conversation_id INT REFERENCES conversations(id) ON DELETE SET NULL,
  source_message_id INT REFERENCES messages(id) ON DELETE SET NULL,
  created_by BIGINT REFERENCES usuarios(id) ON DELETE SET NULL,
  title VARCHAR(255) NOT NULL DEFAULT 'Servicio registrado',
  service_type VARCHAR(80) NOT NULL DEFAULT 'whatsapp_service',
  status VARCHAR(50) NOT NULL DEFAULT 'registered',
  notes TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}',
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customer_orders_company_occurred
ON customer_orders(company_id, occurred_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_customer_orders_contact_occurred
ON customer_orders(company_id, contact_id, occurred_at DESC, id DESC)
WHERE contact_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_customer_orders_conversation
ON customer_orders(company_id, conversation_id, occurred_at DESC)
WHERE conversation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_customer_orders_status
ON customer_orders(company_id, status, occurred_at DESC);

CREATE TABLE IF NOT EXISTS operational_actions (
  id BIGSERIAL PRIMARY KEY,
  company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  order_id BIGINT REFERENCES customer_orders(id) ON DELETE SET NULL,
  contact_id INT REFERENCES contacts(id) ON DELETE SET NULL,
  conversation_id INT REFERENCES conversations(id) ON DELETE SET NULL,
  message_id INT REFERENCES messages(id) ON DELETE SET NULL,
  actor_user_id BIGINT REFERENCES usuarios(id) ON DELETE SET NULL,
  action_type VARCHAR(80) NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'completed',
  description TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}',
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_operational_actions_company_occurred
ON operational_actions(company_id, occurred_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_operational_actions_contact_occurred
ON operational_actions(company_id, contact_id, occurred_at DESC, id DESC)
WHERE contact_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_operational_actions_conversation
ON operational_actions(company_id, conversation_id, occurred_at DESC)
WHERE conversation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_operational_actions_order
ON operational_actions(order_id, occurred_at DESC)
WHERE order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_operational_actions_actor
ON operational_actions(company_id, actor_user_id, occurred_at DESC)
WHERE actor_user_id IS NOT NULL;
