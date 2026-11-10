-- Keep only proven manual connections routable after the cutover.
-- Server-managed connections are re-established by the new startup path.
DO $$
DECLARE
  company integer;
  prior_tenant text := current_setting('app.current_tenant_id', true);
BEGIN
  FOR company IN SELECT id FROM companies LOOP
    PERFORM set_config('app.current_tenant_id', company::text, true);
    UPDATE whatsapp_business_accounts
    SET status = 'verification_required'
    WHERE company_id = company AND provider = 'meta-cloud'
      AND status IN ('configured', 'connected') AND disconnected_at IS NULL
      AND NOT (
        access_token_encrypted IS NOT NULL AND diagnostic_checked_at IS NOT NULL
        AND diagnostic_error_code IS NULL AND diagnostic_checked_at >= updated_at
      );
  END LOOP;
  PERFORM set_config('app.current_tenant_id', COALESCE(prior_tenant, ''), true);
END;
$$;

DROP INDEX uq_whatsapp_accounts_provider_phone_active;
CREATE UNIQUE INDEX uq_whatsapp_accounts_provider_phone_active
ON whatsapp_business_accounts(provider, phone_number_id)
WHERE status IN ('configured', 'connected') AND disconnected_at IS NULL;

DROP POLICY meta_webhook_phone_lookup ON whatsapp_business_accounts;
CREATE POLICY meta_webhook_phone_lookup ON whatsapp_business_accounts FOR SELECT
  USING (
    provider = 'meta-cloud' AND status IN ('configured', 'connected') AND disconnected_at IS NULL
    AND phone_number_id = NULLIF(current_setting('app.verified_meta_phone_number', true), '')
  );
