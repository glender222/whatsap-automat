-- Migration 023: Create Tenancy Domain Models (Tenants, Workspaces, Memberships)
-- Specification: PR-F1-03 (WAA-004, ADR-002, ORIGINAL_REQUEST §R1)
-- Description: Establishes formal Tenancy hierarchy (Tenant -> Workspace -> Membership)
--              with full backward-compatibility backfill from legacy company_id.

-- -----------------------------------------------------------------------------
-- 1. Table Definitions
-- -----------------------------------------------------------------------------

-- 1.1 tenants: Primary multi-tenant boundary
CREATE TABLE IF NOT EXISTS tenants (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(255) UNIQUE NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 1.2 workspaces: Sub-tenant organizational division
CREATE TABLE IF NOT EXISTS workspaces (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(255) NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_workspaces_tenant_slug UNIQUE (tenant_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_workspaces_tenant_id
ON workspaces(tenant_id);

CREATE INDEX IF NOT EXISTS idx_workspaces_tenant_default
ON workspaces(tenant_id) WHERE is_default = TRUE;

-- 1.3 memberships: User-to-tenant authorization binding
CREATE TABLE IF NOT EXISTS memberships (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL,
  role VARCHAR(50) NOT NULL DEFAULT 'member',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_memberships_tenant_user UNIQUE (tenant_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_memberships_tenant_id
ON memberships(tenant_id);

CREATE INDEX IF NOT EXISTS idx_memberships_user_id
ON memberships(user_id);

-- -----------------------------------------------------------------------------
-- 2. Seed & Backfill Logic (Executed BEFORE RLS is forced)
-- -----------------------------------------------------------------------------

DO $$
BEGIN
  -- 2.1 Backfill tenants from existing companies table (preserving id for backward compatibility)
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'companies') THEN
    INSERT INTO tenants (id, name, slug, status, created_at, updated_at)
    SELECT
      c.id,
      c.name,
      CASE
        WHEN c.id = 1 THEN 'default-company'
        ELSE
          COALESCE(
            NULLIF(LOWER(REGEXP_REPLACE(REGEXP_REPLACE(TRIM(c.name), '[^a-zA-Z0-9]+', '-', 'g'), '^-+|-+$', '', 'g')), ''),
            'tenant'
          ) || '-' || c.id::text
      END AS slug,
      'active' AS status,
      COALESCE(c.created_at, NOW()) AS created_at,
      NOW() AS updated_at
    FROM companies c
    ON CONFLICT (id) DO NOTHING;
  ELSE
    -- Fallback seed for clean databases where companies table might not be initialized
    INSERT INTO tenants (id, name, slug, status, created_at, updated_at)
    VALUES (1, 'Default Company', 'default-company', 'active', NOW(), NOW())
    ON CONFLICT (id) DO NOTHING;
  END IF;

  -- 2.2 Synchronize tenants_id_seq to prevent sequence collision on future inserts
  PERFORM setval(
    pg_get_serial_sequence('tenants', 'id'),
    GREATEST((SELECT COALESCE(MAX(id), 1) FROM tenants), 1)
  );

  -- 2.3 Backfill default workspace for every tenant
  INSERT INTO workspaces (tenant_id, name, slug, is_default, created_at, updated_at)
  SELECT
    t.id,
    'default',
    'default',
    TRUE,
    t.created_at,
    NOW()
  FROM tenants t
  ON CONFLICT (tenant_id, slug) DO NOTHING;

  -- Synchronize workspaces_id_seq
  PERFORM setval(
    pg_get_serial_sequence('workspaces', 'id'),
    GREATEST((SELECT COALESCE(MAX(id), 1) FROM workspaces), 1)
  );

  -- 2.4 Backfill memberships from legacy usuarios table (if present at migration time)
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'usuarios') THEN
    INSERT INTO memberships (tenant_id, user_id, role, created_at)
    SELECT
      u.company_id,
      u.id,
      CASE
        WHEN u.rol = 'SUPERADMIN' THEN 'owner'
        WHEN u.rol = 'ADMIN' THEN 'admin'
        ELSE 'member'
      END AS role,
      NOW() AS created_at
    FROM usuarios u
    JOIN tenants t ON t.id = u.company_id
    WHERE u.company_id IS NOT NULL
    ON CONFLICT (tenant_id, user_id) DO NOTHING;

    PERFORM setval(
      pg_get_serial_sequence('memberships', 'id'),
      GREATEST((SELECT COALESCE(MAX(id), 1) FROM memberships), 1)
    );
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 3. Row-Level Security (RLS) Enablement & Policy Creation
-- -----------------------------------------------------------------------------

-- 3.1 tenants RLS
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_policy ON tenants;
CREATE POLICY tenant_isolation_policy ON tenants
  AS PERMISSIVE
  USING (id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);

-- 3.2 workspaces RLS
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_policy ON workspaces;
CREATE POLICY tenant_isolation_policy ON workspaces
  AS PERMISSIVE
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);

-- 3.3 memberships RLS
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_policy ON memberships;
CREATE POLICY tenant_isolation_policy ON memberships
  AS PERMISSIVE
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);

-- =============================================================================
-- REVERT / ROLLBACK SPECIFICATION (Reference for idempotent down-migration):
--
-- DROP POLICY IF EXISTS tenant_isolation_policy ON memberships;
-- ALTER TABLE memberships NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE memberships DISABLE ROW LEVEL SECURITY;
--
-- DROP POLICY IF EXISTS tenant_isolation_policy ON workspaces;
-- ALTER TABLE workspaces NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE workspaces DISABLE ROW LEVEL SECURITY;
--
-- DROP POLICY IF EXISTS tenant_isolation_policy ON tenants;
-- ALTER TABLE tenants NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE tenants DISABLE ROW LEVEL SECURITY;
--
-- DROP TABLE IF EXISTS memberships CASCADE;
-- DROP TABLE IF EXISTS workspaces CASCADE;
-- DROP TABLE IF EXISTS tenants CASCADE;
-- =============================================================================
