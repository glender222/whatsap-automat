-- Later migrations reference usuarios even on an empty installation.
DO $$
BEGIN
  CREATE TYPE rol_enum AS ENUM ('ADMIN', 'EMPLEADO', 'SUPERADMIN');
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;

-- The tenancy backfill also supports installations with the legacy owner role.
ALTER TYPE rol_enum ADD VALUE IF NOT EXISTS 'SUPERADMIN';

CREATE TABLE IF NOT EXISTS usuarios (
  id BIGSERIAL PRIMARY KEY,
  nombre VARCHAR(100) NOT NULL,
  email VARCHAR(100) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  rol rol_enum NOT NULL DEFAULT 'EMPLEADO',
  id_padre BIGINT REFERENCES usuarios(id) ON DELETE CASCADE,
  company_id INT REFERENCES companies(id) ON DELETE SET NULL,
  activo BOOLEAN DEFAULT true,
  fecha_creacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  fecha_actualizacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id BIGSERIAL PRIMARY KEY,
  usuario_id BIGINT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  expira_en TIMESTAMP NOT NULL,
  creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  revocado BOOLEAN DEFAULT false
);
