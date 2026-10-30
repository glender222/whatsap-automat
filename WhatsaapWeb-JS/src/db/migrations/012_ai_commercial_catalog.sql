-- AI-first commercial catalog.
-- Keeps the existing products/order_items/stock_movements tables as the
-- compatibility surface, while extending them to represent commercial items.

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS item_type VARCHAR(40) NOT NULL DEFAULT 'physical_product',
  ADD COLUMN IF NOT EXISTS unit_label VARCHAR(40),
  ADD COLUMN IF NOT EXISTS ai_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS ai_description TEXT,
  ADD COLUMN IF NOT EXISTS ai_sales_instructions TEXT,
  ADD COLUMN IF NOT EXISTS requires_human_approval BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS availability_type VARCHAR(40) NOT NULL DEFAULT 'stock',
  ADD COLUMN IF NOT EXISTS capacity INT,
  ADD COLUMN IF NOT EXISTS allow_backorder BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reservation_ttl_minutes INT;

ALTER TABLE products
  DROP CONSTRAINT IF EXISTS chk_products_status,
  ADD CONSTRAINT chk_products_status CHECK (status IN ('draft', 'active', 'inactive', 'archived'));

ALTER TABLE products
  DROP CONSTRAINT IF EXISTS chk_products_item_type,
  ADD CONSTRAINT chk_products_item_type CHECK (item_type IN ('physical_product', 'digital_product', 'service', 'course', 'subscription'));

ALTER TABLE products
  DROP CONSTRAINT IF EXISTS chk_products_availability_type,
  ADD CONSTRAINT chk_products_availability_type CHECK (availability_type IN ('stock', 'unlimited', 'capacity', 'manual'));

ALTER TABLE products
  DROP CONSTRAINT IF EXISTS chk_products_capacity_non_negative,
  ADD CONSTRAINT chk_products_capacity_non_negative CHECK (capacity IS NULL OR capacity >= 0);

ALTER TABLE products
  DROP CONSTRAINT IF EXISTS chk_products_reservation_ttl_positive,
  ADD CONSTRAINT chk_products_reservation_ttl_positive CHECK (reservation_ttl_minutes IS NULL OR reservation_ttl_minutes > 0);

CREATE INDEX IF NOT EXISTS idx_products_company_ai_catalog
ON products(company_id, status, ai_enabled, item_type, LOWER(name));

CREATE INDEX IF NOT EXISTS idx_products_company_availability
ON products(company_id, availability_type, status);

ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS commercial_item_id BIGINT REFERENCES products(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS item_type_snapshot VARCHAR(40) NOT NULL DEFAULT 'physical_product',
  ADD COLUMN IF NOT EXISTS availability_status VARCHAR(40) NOT NULL DEFAULT 'available';

UPDATE order_items
SET commercial_item_id = product_id
WHERE commercial_item_id IS NULL AND product_id IS NOT NULL;

ALTER TABLE order_items
  DROP CONSTRAINT IF EXISTS chk_order_items_status,
  ADD CONSTRAINT chk_order_items_status CHECK (
    status IN ('draft', 'quoted', 'pending_approval', 'confirmed', 'reserved', 'cancelled', 'completed', 'out_of_stock', 'unavailable')
  );

ALTER TABLE order_items
  DROP CONSTRAINT IF EXISTS chk_order_items_item_type_snapshot,
  ADD CONSTRAINT chk_order_items_item_type_snapshot CHECK (
    item_type_snapshot IN ('physical_product', 'digital_product', 'service', 'course', 'subscription')
  );

ALTER TABLE order_items
  DROP CONSTRAINT IF EXISTS chk_order_items_availability_status,
  ADD CONSTRAINT chk_order_items_availability_status CHECK (
    availability_status IN ('available', 'reserved', 'manual_required', 'unlimited', 'unavailable')
  );

CREATE INDEX IF NOT EXISTS idx_order_items_company_commercial_item
ON order_items(company_id, commercial_item_id, status)
WHERE commercial_item_id IS NOT NULL;

ALTER TABLE stock_movements
  ADD COLUMN IF NOT EXISTS commercial_item_id BIGINT REFERENCES products(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS actor_agent_id BIGINT REFERENCES ai_agents(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS delta_available INT,
  ADD COLUMN IF NOT EXISTS delta_reserved INT;

UPDATE stock_movements
SET commercial_item_id = product_id
WHERE commercial_item_id IS NULL AND product_id IS NOT NULL;

ALTER TABLE stock_movements
  DROP CONSTRAINT IF EXISTS chk_stock_movements_type,
  ADD CONSTRAINT chk_stock_movements_type CHECK (
    movement_type IN (
      'adjustment',
      'reservation',
      'release',
      'completion',
      'initial',
      'reserved',
      'reservation_released',
      'confirmed_consumed',
      'cancelled_restored',
      'capacity_reserved',
      'manual_override'
    )
  );

CREATE INDEX IF NOT EXISTS idx_stock_movements_company_commercial_item_occurred
ON stock_movements(company_id, commercial_item_id, occurred_at DESC, id DESC)
WHERE commercial_item_id IS NOT NULL;
