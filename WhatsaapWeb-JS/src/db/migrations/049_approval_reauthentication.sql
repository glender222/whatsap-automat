CREATE TABLE IF NOT EXISTS approval_reauth_attempts (
  tenant_id integer NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  actor_id bigint NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  attempts integer NOT NULL CHECK (attempts BETWEEN 1 AND 5),
  window_ends_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, actor_id)
);

ALTER TABLE approval_reauth_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_reauth_attempts FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON approval_reauth_attempts;
CREATE POLICY tenant_isolation_policy ON approval_reauth_attempts
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);
