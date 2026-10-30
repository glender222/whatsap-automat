-- Company-scoped WhatsApp Business credentials.
-- Tokens are stored encrypted; never expose plaintext to API responses.

ALTER TABLE whatsapp_business_accounts
  ADD COLUMN IF NOT EXISTS access_token_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS token_last_four VARCHAR(16),
  ADD COLUMN IF NOT EXISTS token_configured_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS app_id VARCHAR(100),
  ADD COLUMN IF NOT EXISTS meta_business_id VARCHAR(100),
  ADD COLUMN IF NOT EXISTS webhook_verify_token VARCHAR(255),
  ADD COLUMN IF NOT EXISTS connected_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS disconnected_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_error_message TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_whatsapp_accounts_provider_phone_active
ON whatsapp_business_accounts(provider, phone_number_id)
WHERE status IN ('configured', 'connected', 'missing_token');

CREATE INDEX IF NOT EXISTS idx_whatsapp_accounts_phone_status
ON whatsapp_business_accounts(provider, phone_number_id, status);
