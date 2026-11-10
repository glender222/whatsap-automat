ALTER TABLE payment_checkout_intents
  ADD CONSTRAINT uq_payment_checkout_intent_dispatch_scope UNIQUE (company_id, order_id, id);

CREATE TABLE payment_checkout_dispatches (
  intent_id uuid PRIMARY KEY,
  company_id integer NOT NULL,
  order_id bigint NOT NULL,
  intent_version integer NOT NULL CHECK (intent_version > 0),
  claimed_by_user_id bigint NOT NULL CHECK (claimed_by_user_id > 0),
  planned_at timestamptz NOT NULL,
  valid_until timestamptz NOT NULL,
  state varchar(16) NOT NULL DEFAULT 'claimed'
    CHECK (state IN ('claimed', 'created', 'uncertain', 'rejected', 'not_sent')),
  provider_order_id varchar(32) UNIQUE CHECK (provider_order_id ~ '^ORD(TST)?[0-9A-HJKMNP-TV-Z]{26}$'),
  provider_expires_at timestamptz,
  outcome_code varchar(80),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (company_id, intent_id),
  UNIQUE (company_id, order_id),
  FOREIGN KEY (company_id, order_id, intent_id)
    REFERENCES payment_checkout_intents (company_id, order_id, id),
  CHECK (valid_until > planned_at AND valid_until <= planned_at + INTERVAL '15 minutes'),
  CHECK (
    (state = 'claimed' AND provider_order_id IS NULL AND provider_expires_at IS NULL AND outcome_code IS NULL)
    OR (state = 'created' AND provider_order_id IS NOT NULL AND provider_expires_at IS NOT NULL
      AND provider_expires_at > planned_at AND provider_expires_at <= valid_until AND outcome_code IS NULL)
    OR (state = 'uncertain' AND provider_expires_at IS NULL AND outcome_code IS NOT NULL)
    OR (state IN ('rejected', 'not_sent') AND provider_order_id IS NULL
      AND provider_expires_at IS NULL AND outcome_code IS NOT NULL)
  )
);

ALTER TABLE payment_checkout_dispatches ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_checkout_dispatches FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_policy ON payment_checkout_dispatches
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);
