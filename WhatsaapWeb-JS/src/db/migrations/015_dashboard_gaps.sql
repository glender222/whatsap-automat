-- Sprint 6 - Dashboard Operaciones v2.
-- Cierra brechas para panel administrativo: stock minimo, SLA configurable y
-- comprobantes de pago (modulo payments).

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS min_stock INT NOT NULL DEFAULT 0;

ALTER TABLE company_settings
  ADD COLUMN IF NOT EXISTS sla_threshold_minutes INT NOT NULL DEFAULT 5;

ALTER TABLE company_settings
  ADD COLUMN IF NOT EXISTS business_hours JSONB NOT NULL DEFAULT '{"enabled":false}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_products_low_stock
ON products(company_id, min_stock, stock_available)
WHERE min_stock > 0 AND status = 'active';

CREATE TABLE IF NOT EXISTS payment_vouchers (
  id BIGSERIAL PRIMARY KEY,
  company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  order_id BIGINT REFERENCES customer_orders(id) ON DELETE SET NULL,
  chat_id VARCHAR(255),
  contact_id INT REFERENCES contacts(id) ON DELETE SET NULL,
  conversation_id INT REFERENCES conversations(id) ON DELETE SET NULL,
  source_message_id INT REFERENCES messages(id) ON DELETE SET NULL,
  file_url TEXT NOT NULL,
  mime_type VARCHAR(120),
  file_size BIGINT,
  payment_method VARCHAR(40) NOT NULL DEFAULT 'other',
  amount NUMERIC(12,2),
  currency VARCHAR(3) NOT NULL DEFAULT 'PEN',
  sender_reference VARCHAR(120),
  status VARCHAR(40) NOT NULL DEFAULT 'pending',
  rejection_reason TEXT,
  uploaded_by BIGINT REFERENCES usuarios(id) ON DELETE SET NULL,
  validated_by BIGINT REFERENCES usuarios(id) ON DELETE SET NULL,
  validated_at TIMESTAMPTZ,
  notes TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}',
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_payment_vouchers_status CHECK (status IN ('pending','validated','rejected')),
  CONSTRAINT chk_payment_vouchers_method CHECK (
    payment_method IN ('yape','plin','bank_transfer','cash','other')
  )
);

CREATE INDEX IF NOT EXISTS idx_payment_vouchers_company_status_uploaded
  ON payment_vouchers(company_id, status, uploaded_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_payment_vouchers_order
  ON payment_vouchers(order_id) WHERE order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payment_vouchers_chat
  ON payment_vouchers(company_id, chat_id) WHERE chat_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payment_vouchers_conversation
  ON payment_vouchers(company_id, conversation_id) WHERE conversation_id IS NOT NULL;
