-- HU15: assisted commercial catalog with human handoff.
-- Adds catalog sections, product primary image, pending handoff orders, and
-- agent routing metadata without breaking the existing commercial catalog.

ALTER TABLE catalogs
  ADD COLUMN IF NOT EXISTS ai_instructions TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS sales_policy TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS catalog_sections (
  id BIGSERIAL PRIMARY KEY,
  company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  catalog_id BIGINT NOT NULL REFERENCES catalogs(id) ON DELETE CASCADE,
  name VARCHAR(140) NOT NULL,
  description TEXT,
  status VARCHAR(30) NOT NULL DEFAULT 'active',
  ai_enabled BOOLEAN NOT NULL DEFAULT true,
  ai_instructions TEXT NOT NULL DEFAULT '',
  sort_order INT NOT NULL DEFAULT 0,
  metadata_json JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_catalog_sections_status CHECK (status IN ('active', 'inactive', 'archived'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_catalog_sections_catalog_name
ON catalog_sections(catalog_id, LOWER(name))
WHERE status <> 'archived';

CREATE INDEX IF NOT EXISTS idx_catalog_sections_company_catalog
ON catalog_sections(company_id, catalog_id, status, sort_order, LOWER(name));

ALTER TABLE catalog_items
  ADD COLUMN IF NOT EXISTS section_id BIGINT REFERENCES catalog_sections(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_catalog_items_company_section
ON catalog_items(company_id, section_id, sort_order, commercial_item_id)
WHERE section_id IS NOT NULL;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS image_url TEXT,
  ADD COLUMN IF NOT EXISTS image_alt_text VARCHAR(180);

ALTER TABLE customer_orders
  DROP CONSTRAINT IF EXISTS chk_customer_orders_status_hu15;

ALTER TABLE order_items
  DROP CONSTRAINT IF EXISTS chk_order_items_status,
  ADD CONSTRAINT chk_order_items_status CHECK (
    status IN ('draft', 'quoted', 'pending_handoff', 'pending_approval', 'confirmed', 'reserved', 'cancelled', 'completed', 'out_of_stock', 'unavailable')
  );

ALTER TABLE ai_agents
  ADD COLUMN IF NOT EXISTS purpose VARCHAR(60) NOT NULL DEFAULT 'support',
  ADD COLUMN IF NOT EXISTS module_access_json JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS trigger_rules_json JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS catalog_scope_json JSONB NOT NULL DEFAULT '{}';

ALTER TABLE ai_agents
  DROP CONSTRAINT IF EXISTS chk_ai_agents_purpose,
  ADD CONSTRAINT chk_ai_agents_purpose CHECK (
    purpose IN ('sales_assistant', 'support', 'booking', 'operations', 'general')
  );

UPDATE ai_agents
SET module_access_json = jsonb_build_object(
      'catalog', true,
      'orders', true,
      'customerHistory', true,
      'tags', true
    ),
    trigger_rules_json = jsonb_build_object(
      'commercialIntent', true,
      'handoffForPayment', true
    )
WHERE module_access_json = '{}'::jsonb
  AND purpose IN ('sales_assistant', 'general', 'support');
