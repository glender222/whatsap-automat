CREATE UNIQUE INDEX uq_customer_orders_company_id_id ON customer_orders (company_id, id);
CREATE UNIQUE INDEX uq_payment_gateways_company_id_id ON payment_gateways (company_id, id);

CREATE TABLE payment_checkout_intents (
  id uuid PRIMARY KEY,
  company_id integer NOT NULL,
  order_id bigint NOT NULL,
  gateway_id bigint NOT NULL,
  actor_user_id bigint NOT NULL CHECK (actor_user_id > 0),
  idempotency_key varchar(128) NOT NULL CHECK (idempotency_key <> ''),
  external_reference uuid NOT NULL UNIQUE,
  provider varchar(40) NOT NULL CHECK (provider = 'mercadopago'),
  amount numeric(12,2) NOT NULL CHECK (amount > 0 AND amount <> 'NaN'::numeric),
  currency varchar(3) NOT NULL CHECK (currency = 'PEN'),
  items jsonb NOT NULL CHECK (jsonb_typeof(items) = 'array' AND jsonb_array_length(items) > 0),
  order_status varchar(40) NOT NULL CHECK (order_status IN ('confirmed', 'reserved')),
  order_updated_at timestamptz NOT NULL,
  reservation_expires_at timestamptz,
  gateway_updated_at timestamptz NOT NULL,
  state varchar(20) NOT NULL DEFAULT 'prepared' CHECK (state IN ('prepared', 'voided')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  voided_at timestamptz,
  void_reason varchar(32) CHECK (void_reason IN ('operator_cancelled', 'voucher_validated')),
  CHECK (
    (state = 'prepared' AND voided_at IS NULL AND void_reason IS NULL)
    OR (state = 'voided' AND voided_at IS NOT NULL AND void_reason IS NOT NULL)
  ),
  FOREIGN KEY (company_id, order_id) REFERENCES customer_orders (company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, gateway_id) REFERENCES payment_gateways (company_id, id),
  UNIQUE (company_id, actor_user_id, idempotency_key)
);

CREATE UNIQUE INDEX uq_payment_checkout_intents_prepared_order
  ON payment_checkout_intents (company_id, order_id) WHERE state = 'prepared';
CREATE INDEX idx_payment_checkout_intents_order ON payment_checkout_intents (company_id, order_id);
CREATE INDEX idx_payment_checkout_intents_gateway ON payment_checkout_intents (company_id, gateway_id);

ALTER TABLE payment_checkout_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_checkout_intents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_policy ON payment_checkout_intents
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);
