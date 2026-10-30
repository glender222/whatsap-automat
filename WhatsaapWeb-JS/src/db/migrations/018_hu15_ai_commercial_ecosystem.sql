-- HU15 - Ecosistema IA comercial, catalogo, handoff y trazabilidad.
-- Additive and backward-compatible with products/customer_orders/operational_actions.

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS price_mode VARCHAR(20) NOT NULL DEFAULT 'fixed';

UPDATE products
SET price_mode = CASE
  WHEN price IS NULL THEN 'consult'
  WHEN price = 0 THEN 'free'
  ELSE COALESCE(NULLIF(price_mode, ''), 'fixed')
END
WHERE price_mode IS NULL OR price_mode = 'fixed';

ALTER TABLE products
  DROP CONSTRAINT IF EXISTS chk_products_item_type,
  ADD CONSTRAINT chk_products_item_type CHECK (
    item_type IN ('physical_product', 'digital_product', 'service', 'course', 'subscription', 'custom')
  );

ALTER TABLE products
  DROP CONSTRAINT IF EXISTS chk_products_availability_type,
  ADD CONSTRAINT chk_products_availability_type CHECK (
    availability_type IN ('stock', 'unlimited', 'capacity', 'manual', 'schedule')
  );

ALTER TABLE products
  DROP CONSTRAINT IF EXISTS chk_products_price_mode,
  ADD CONSTRAINT chk_products_price_mode CHECK (price_mode IN ('fixed', 'from', 'free', 'consult'));

CREATE TABLE IF NOT EXISTS product_images (
  id BIGSERIAL PRIMARY KEY,
  company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  image_url TEXT NOT NULL,
  image_alt_text VARCHAR(180),
  sort_order INT NOT NULL DEFAULT 0,
  is_primary BOOLEAN NOT NULL DEFAULT false,
  mime_type VARCHAR(120),
  size_bytes INT,
  metadata_json JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_product_images_primary
ON product_images(company_id, product_id)
WHERE is_primary = true;

CREATE INDEX IF NOT EXISTS idx_product_images_product_order
ON product_images(company_id, product_id, is_primary DESC, sort_order ASC, id ASC);

INSERT INTO product_images (company_id, product_id, image_url, image_alt_text, sort_order, is_primary)
SELECT p.company_id, p.id, p.image_url, p.image_alt_text, 0, true
FROM products p
WHERE p.image_url IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM product_images pi
    WHERE pi.company_id = p.company_id
      AND pi.product_id = p.id
  );

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS commercial_stage VARCHAR(40) NOT NULL DEFAULT 'new',
  ADD COLUMN IF NOT EXISTS commercial_substatus VARCHAR(60) NOT NULL DEFAULT 'new',
  ADD COLUMN IF NOT EXISTS commercial_state_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS commercial_state_metadata_json JSONB NOT NULL DEFAULT '{}';

ALTER TABLE conversations
  DROP CONSTRAINT IF EXISTS chk_conversations_commercial_stage,
  ADD CONSTRAINT chk_conversations_commercial_stage CHECK (
    commercial_stage IN ('new', 'ai_assisting', 'catalog', 'preorder', 'handoff', 'payment', 'closed')
  );

ALTER TABLE conversations
  DROP CONSTRAINT IF EXISTS chk_conversations_commercial_substatus,
  ADD CONSTRAINT chk_conversations_commercial_substatus CHECK (
    commercial_substatus IN (
      'new',
      'intent_detected',
      'needs_clarification',
      'catalog_matched',
      'product_recommended',
      'quoted',
      'no_match',
      'out_of_stock',
      'preorder_open',
      'handoff_pending',
      'human_attending',
      'payment_pending',
      'voucher_received',
      'sale_confirmed',
      'completed',
      'lost_cancelled'
    )
  );

CREATE INDEX IF NOT EXISTS idx_conversations_commercial_state
ON conversations(company_id, commercial_stage, commercial_substatus, commercial_state_updated_at DESC);

ALTER TABLE handoff_tickets
  ADD COLUMN IF NOT EXISTS priority VARCHAR(20) NOT NULL DEFAULT 'medium',
  ADD COLUMN IF NOT EXISTS outcome VARCHAR(40),
  ADD COLUMN IF NOT EXISTS closed_by BIGINT REFERENCES usuarios(id) ON DELETE SET NULL;

ALTER TABLE handoff_tickets
  DROP CONSTRAINT IF EXISTS chk_handoff_priority,
  ADD CONSTRAINT chk_handoff_priority CHECK (priority IN ('low', 'medium', 'high'));

ALTER TABLE handoff_tickets
  DROP CONSTRAINT IF EXISTS chk_handoff_outcome,
  ADD CONSTRAINT chk_handoff_outcome CHECK (
    outcome IS NULL OR outcome IN (
      'sale_confirmed',
      'no_sale',
      'follow_up_required',
      'support_resolved',
      'duplicate',
      'cancelled'
    )
  );

CREATE INDEX IF NOT EXISTS idx_handoff_tickets_priority_status
ON handoff_tickets(company_id, status, priority, created_at DESC);

ALTER TABLE ai_agents
  DROP CONSTRAINT IF EXISTS chk_ai_agents_purpose,
  ADD CONSTRAINT chk_ai_agents_purpose CHECK (
    purpose IN ('router', 'sales_assistant', 'support', 'order_tracking', 'booking', 'operations', 'general')
  );

ALTER TABLE ai_agents
  ADD COLUMN IF NOT EXISTS tool_access_json JSONB NOT NULL DEFAULT '{}';

ALTER TABLE agent_runtime_logs
  ADD COLUMN IF NOT EXISTS tool_name VARCHAR(120),
  ADD COLUMN IF NOT EXISTS tool_result_status VARCHAR(40),
  ADD COLUMN IF NOT EXISTS related_order_id BIGINT REFERENCES customer_orders(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS related_handoff_id BIGINT REFERENCES handoff_tickets(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_agent_runtime_logs_tool
ON agent_runtime_logs(company_id, tool_name, created_at DESC)
WHERE tool_name IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_operational_actions_metadata_gin
ON operational_actions USING GIN (metadata_json);
