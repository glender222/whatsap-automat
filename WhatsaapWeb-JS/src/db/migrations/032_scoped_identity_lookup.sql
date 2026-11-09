-- Before a tenant is known, allow only the exact verified lookup key for
-- authentication and signed webhook routing. The application sets each key
-- transaction-locally and ordinary reads and writes still require tenant scope.
DROP POLICY IF EXISTS login_email_lookup ON usuarios;
CREATE POLICY login_email_lookup ON usuarios FOR SELECT
  USING (activo = true AND email = NULLIF(current_setting('app.login_email', true), ''));

DROP POLICY IF EXISTS meta_webhook_phone_lookup ON whatsapp_business_accounts;
CREATE POLICY meta_webhook_phone_lookup ON whatsapp_business_accounts FOR SELECT
  USING (
    provider = 'meta-cloud' AND status <> 'disconnected'
    AND phone_number_id = NULLIF(current_setting('app.verified_meta_phone_number', true), '')
  );

-- Historical bootstrap inserts company 1 explicitly, without moving the sequence.
SELECT setval(
  pg_get_serial_sequence('companies', 'id'),
  GREATEST((SELECT MAX(id) FROM companies), (SELECT last_value FROM companies_id_seq))
);
