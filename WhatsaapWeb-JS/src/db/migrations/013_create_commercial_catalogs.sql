-- Commercial catalogs group sellable items for admin views and AI visibility.

CREATE TABLE IF NOT EXISTS catalogs (
  id BIGSERIAL PRIMARY KEY,
  company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  description TEXT,
  status VARCHAR(30) NOT NULL DEFAULT 'active',
  ai_enabled BOOLEAN NOT NULL DEFAULT true,
  sort_order INT NOT NULL DEFAULT 0,
  metadata_json JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_catalogs_status CHECK (status IN ('active', 'inactive', 'archived'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_catalogs_company_name
ON catalogs(company_id, LOWER(name))
WHERE status <> 'archived';

CREATE INDEX IF NOT EXISTS idx_catalogs_company_status_order
ON catalogs(company_id, status, sort_order, LOWER(name));

CREATE TABLE IF NOT EXISTS catalog_items (
  id BIGSERIAL PRIMARY KEY,
  company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  catalog_id BIGINT NOT NULL REFERENCES catalogs(id) ON DELETE CASCADE,
  commercial_item_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_catalog_items_catalog_item UNIQUE (catalog_id, commercial_item_id)
);

CREATE INDEX IF NOT EXISTS idx_catalog_items_company_catalog
ON catalog_items(company_id, catalog_id, sort_order, commercial_item_id);

CREATE INDEX IF NOT EXISTS idx_catalog_items_company_item
ON catalog_items(company_id, commercial_item_id, catalog_id);

INSERT INTO catalogs (company_id, name, description, status, ai_enabled, sort_order)
SELECT DISTINCT p.company_id, 'Catalogo principal', 'Ofertas visibles para ventas por WhatsApp', 'active', true, 0
FROM products p
WHERE NOT EXISTS (
  SELECT 1
  FROM catalogs c
  WHERE c.company_id = p.company_id
    AND LOWER(c.name) = LOWER('Catalogo principal')
    AND c.status <> 'archived'
);

INSERT INTO catalog_items (company_id, catalog_id, commercial_item_id, sort_order)
SELECT p.company_id, c.id, p.id, 0
FROM products p
JOIN catalogs c
  ON c.company_id = p.company_id
 AND LOWER(c.name) = LOWER('Catalogo principal')
 AND c.status <> 'archived'
WHERE NOT EXISTS (
  SELECT 1
  FROM catalog_items ci
  WHERE ci.catalog_id = c.id
    AND ci.commercial_item_id = p.id
);
