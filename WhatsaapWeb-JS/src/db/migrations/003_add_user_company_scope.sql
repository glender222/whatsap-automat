-- Scope authenticated users to a company for WhatsApp inbox isolation.
-- Existing installs keep using company_id=1 until the product adds a
-- self-service WhatsApp Business connection flow.
-- Guard: the usuarios table is created by the legacy User model at boot,
-- so on a fresh DB this migration may run before that init. Use DO block
-- to skip gracefully when the table does not exist yet.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'usuarios') THEN
    ALTER TABLE usuarios
      ADD COLUMN IF NOT EXISTS company_id INT REFERENCES companies(id) ON DELETE SET NULL;

    UPDATE usuarios
    SET company_id = COALESCE(company_id, 1)
    WHERE company_id IS NULL;

    CREATE INDEX IF NOT EXISTS idx_usuarios_company_id
    ON usuarios(company_id);
  END IF;
END $$;
