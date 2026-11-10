ALTER TABLE customer_orders
  ADD COLUMN IF NOT EXISTS reservation_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS reservation_expired_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_customer_orders_due_reservations
  ON customer_orders (company_id, reservation_expires_at, id)
  WHERE order_type = 'commercial' AND status = 'reserved' AND reservation_expires_at IS NOT NULL;

ALTER TABLE payment_vouchers
  ADD COLUMN IF NOT EXISTS order_reconciliation_required boolean NOT NULL DEFAULT false;
