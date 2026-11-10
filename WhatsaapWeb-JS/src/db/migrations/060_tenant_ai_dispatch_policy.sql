CREATE TABLE tenant_ai_dispatch_policies (
  tenant_id integer PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  mode text NOT NULL DEFAULT 'legacy' CHECK (mode IN ('legacy', 'draining', 'strict', 'paused')),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE tenant_ai_legacy_dispatches (
  tenant_id integer NOT NULL REFERENCES tenant_ai_dispatch_policies(tenant_id) ON DELETE CASCADE,
  id uuid NOT NULL,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id)
);

ALTER TABLE tenant_ai_dispatch_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_ai_dispatch_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY ai_dispatch_policy_scope ON tenant_ai_dispatch_policies
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);

ALTER TABLE tenant_ai_legacy_dispatches ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_ai_legacy_dispatches FORCE ROW LEVEL SECURITY;
CREATE POLICY ai_legacy_dispatch_scope ON tenant_ai_legacy_dispatches
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);
