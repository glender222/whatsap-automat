ALTER TABLE whatsapp_business_accounts
  ADD COLUMN IF NOT EXISTS diagnostic_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS diagnostic_error_code text CHECK (diagnostic_error_code IN (
    'META_AUTH_ERROR', 'META_PERMISSION_ERROR', 'META_ACCOUNT_MISMATCH',
    'META_PROVIDER_UNAVAILABLE', 'META_CREDENTIAL_UNREADABLE'
  ));

CREATE INDEX IF NOT EXISTS idx_channel_connections_tenant_id_cursor ON channel_connections (tenant_id, id);

-- Keep a stable canonical connection for the legacy company configuration.
-- Existing canonical IDs and their operational status remain authoritative.
CREATE OR REPLACE FUNCTION register_whatsapp_channel_connection() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO channel_connections (id, tenant_id, channel, account_id, created_at, updated_at)
  SELECT 'wa-meta-' || NEW.company_id || '-' || NEW.phone_number_id,
         NEW.company_id, 'whatsapp-cloud', NEW.phone_number_id, NEW.created_at, NEW.updated_at
  WHERE EXISTS (SELECT 1 FROM tenants WHERE id = NEW.company_id)
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS register_whatsapp_channel_connection ON whatsapp_business_accounts;
CREATE TRIGGER register_whatsapp_channel_connection
AFTER INSERT OR UPDATE OF company_id, provider, phone_number_id, access_token_encrypted, status
ON whatsapp_business_accounts
FOR EACH ROW WHEN (NEW.provider = 'meta-cloud')
EXECUTE FUNCTION register_whatsapp_channel_connection();

CREATE OR REPLACE FUNCTION reset_whatsapp_connection_diagnostic() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.diagnostic_checked_at := NULL;
  NEW.diagnostic_error_code := NULL;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS reset_whatsapp_connection_diagnostic ON whatsapp_business_accounts;
CREATE TRIGGER reset_whatsapp_connection_diagnostic
BEFORE UPDATE OF company_id, provider, phone_number_id, graph_version, access_token_encrypted, status
ON whatsapp_business_accounts
FOR EACH ROW WHEN (
  (OLD.company_id, OLD.provider, OLD.phone_number_id, OLD.graph_version, OLD.access_token_encrypted, OLD.status)
  IS DISTINCT FROM
  (NEW.company_id, NEW.provider, NEW.phone_number_id, NEW.graph_version, NEW.access_token_encrypted, NEW.status)
)
EXECUTE FUNCTION reset_whatsapp_connection_diagnostic();

-- Backfill using the normal tenant scope, including for a migration owner subject to FORCE RLS.
DO $$
DECLARE
  company integer;
  prior_tenant text := current_setting('app.current_tenant_id', true);
BEGIN
  FOR company IN SELECT id FROM companies LOOP
    PERFORM set_config('app.current_tenant_id', company::text, true);
    INSERT INTO channel_connections (id, tenant_id, channel, account_id, created_at, updated_at)
    SELECT 'wa-meta-' || a.company_id || '-' || a.phone_number_id,
           a.company_id, 'whatsapp-cloud', a.phone_number_id, a.created_at, a.updated_at
    FROM whatsapp_business_accounts a
    JOIN tenants t ON t.id = a.company_id
    WHERE a.company_id = company AND a.provider = 'meta-cloud'
    ON CONFLICT DO NOTHING;
  END LOOP;
  PERFORM set_config('app.current_tenant_id', COALESCE(prior_tenant, ''), true);
END;
$$;
