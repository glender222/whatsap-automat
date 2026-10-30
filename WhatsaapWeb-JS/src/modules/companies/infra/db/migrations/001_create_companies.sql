-- Migración additive-only para el módulo companies (PR2).
-- NO ejecutar en runtime; se aplicará vía migrator en PR3.
-- Coexiste con coreModel.ts: no toca ni redefine tablas existentes.

CREATE TABLE IF NOT EXISTS plans (
  id SERIAL PRIMARY KEY,
  code VARCHAR(50) NOT NULL UNIQUE,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  max_users INT NOT NULL DEFAULT 0,
  max_conversations INT NOT NULL DEFAULT 0,
  max_messages_per_month INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS company_settings (
  company_id INT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  plan_id INT NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
  timezone VARCHAR(50) NOT NULL DEFAULT 'America/Lima',
  locale VARCHAR(10) NOT NULL DEFAULT 'es-PE',
  features JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS company_limits (
  company_id INT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  max_users INT NOT NULL DEFAULT 0,
  max_conversations INT NOT NULL DEFAULT 0,
  max_messages_per_month INT NOT NULL DEFAULT 0
);
