-- Sprint 5 HU15 refinement: commercial order tracing with company inventory.
-- Keeps customer_orders / operational_actions as the public trace and adds
-- product stock, order items, and stock movement audit records.

ALTER TABLE customer_orders
  ADD COLUMN IF NOT EXISTS order_type VARCHAR(50) NOT NULL DEFAULT 'service',
  ADD COLUMN IF NOT EXISTS agent_id BIGINT REFERENCES ai_agents(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reserved_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS products (
  id BIGSERIAL PRIMARY KEY,
  company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name VARCHAR(180) NOT NULL,
  description TEXT,
  sku VARCHAR(80),
  price NUMERIC(12,2),
  currency VARCHAR(3) NOT NULL DEFAULT 'PEN',
  status VARCHAR(30) NOT NULL DEFAULT 'active',
  stock_available INT NOT NULL DEFAULT 0,
  stock_reserved INT NOT NULL DEFAULT 0,
  metadata_json JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_products_status CHECK (status IN ('active', 'inactive')),
  CONSTRAINT chk_products_stock_non_negative CHECK (stock_available >= 0 AND stock_reserved >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_products_company_sku
ON products(company_id, LOWER(sku))
WHERE sku IS NOT NULL AND sku <> '';

CREATE INDEX IF NOT EXISTS idx_products_company_status_name
ON products(company_id, status, LOWER(name));

CREATE TABLE IF NOT EXISTS order_items (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES customer_orders(id) ON DELETE CASCADE,
  company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  product_id BIGINT REFERENCES products(id) ON DELETE SET NULL,
  product_name VARCHAR(180) NOT NULL,
  sku VARCHAR(80),
  quantity INT NOT NULL DEFAULT 1,
  unit_price NUMERIC(12,2),
  currency VARCHAR(3) NOT NULL DEFAULT 'PEN',
  status VARCHAR(40) NOT NULL DEFAULT 'quoted',
  metadata_json JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_order_items_quantity_positive CHECK (quantity > 0),
  CONSTRAINT chk_order_items_status CHECK (status IN ('draft', 'quoted', 'confirmed', 'cancelled', 'completed', 'out_of_stock'))
);

CREATE INDEX IF NOT EXISTS idx_order_items_order
ON order_items(order_id, id);

CREATE INDEX IF NOT EXISTS idx_order_items_company_product
ON order_items(company_id, product_id, status)
WHERE product_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS stock_movements (
  id BIGSERIAL PRIMARY KEY,
  company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  order_id BIGINT REFERENCES customer_orders(id) ON DELETE SET NULL,
  order_item_id BIGINT REFERENCES order_items(id) ON DELETE SET NULL,
  actor_user_id BIGINT REFERENCES usuarios(id) ON DELETE SET NULL,
  movement_type VARCHAR(40) NOT NULL,
  quantity INT NOT NULL,
  stock_available_after INT NOT NULL,
  stock_reserved_after INT NOT NULL,
  notes TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}',
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_stock_movements_quantity_nonzero CHECK (quantity <> 0),
  CONSTRAINT chk_stock_movements_type CHECK (movement_type IN ('adjustment', 'reservation', 'release', 'completion'))
);

CREATE INDEX IF NOT EXISTS idx_stock_movements_company_product_occurred
ON stock_movements(company_id, product_id, occurred_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_stock_movements_order
ON stock_movements(order_id, occurred_at DESC)
WHERE order_id IS NOT NULL;
