-- Dominios IA por empresa. Aditivo: no reemplaza ai_agents ni company_settings.

CREATE TABLE IF NOT EXISTS company_ai_domains (
  company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  domain_key VARCHAR(60) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'active',
  agent_id BIGINT REFERENCES ai_agents(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, domain_key),
  CONSTRAINT chk_company_ai_domains_key CHECK (
    domain_key IN ('gestion_web', 'inventory_stock', 'commercial_catalog', 'orders', 'support', 'payments')
  ),
  CONSTRAINT chk_company_ai_domains_status CHECK (
    status IN ('active', 'prepared', 'coming_soon', 'inactive')
  )
);

CREATE INDEX IF NOT EXISTS idx_company_ai_domains_agent
ON company_ai_domains(agent_id)
WHERE agent_id IS NOT NULL;
