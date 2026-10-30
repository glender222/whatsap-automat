-- Sprint 6 v3 F5 - Pasarela Mercado Pago.
-- Additive-only. Indices para busqueda rapida de vouchers por gateway_payment_id
-- y tracking de webhooks recibidos.

CREATE INDEX IF NOT EXISTS idx_payment_vouchers_gateway_payment_id
  ON payment_vouchers(company_id, gateway_payment_id)
  WHERE gateway_payment_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS payment_webhook_events (
  id BIGSERIAL PRIMARY KEY,
  company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  gateway_id BIGINT REFERENCES payment_gateways(id) ON DELETE SET NULL,
  provider VARCHAR(40) NOT NULL,
  gateway_payment_id VARCHAR(200),
  signature_valid BOOLEAN NOT NULL DEFAULT false,
  status VARCHAR(40) NOT NULL DEFAULT 'received',
  payload_json JSONB NOT NULL DEFAULT '{}',
  processed_at TIMESTAMPTZ,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_payment_webhook_status CHECK (status IN ('received','processed','rejected','duplicate'))
);

CREATE INDEX IF NOT EXISTS idx_payment_webhook_events_company_created
  ON payment_webhook_events(company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_payment_webhook_events_provider_payment
  ON payment_webhook_events(provider, gateway_payment_id)
  WHERE gateway_payment_id IS NOT NULL;
