CREATE INDEX IF NOT EXISTS idx_refresh_tokens_usuario_id ON refresh_tokens(usuario_id);

ALTER TABLE refresh_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE refresh_tokens FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON refresh_tokens;
CREATE POLICY tenant_isolation_policy ON refresh_tokens
  USING (EXISTS (
    SELECT 1 FROM usuarios u WHERE u.id = refresh_tokens.usuario_id
      AND u.company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM usuarios u WHERE u.id = refresh_tokens.usuario_id
      AND u.company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer
  ));
