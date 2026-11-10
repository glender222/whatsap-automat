CREATE TABLE payment_checkout_reconciliations (
  company_id integer NOT NULL,
  intent_id uuid PRIMARY KEY,
  lookup_version integer NOT NULL DEFAULT 1 CHECK (lookup_version > 0),
  state text NOT NULL DEFAULT 'awaiting_observation'
    CHECK (state IN ('awaiting_observation', 'unpaid', 'pending', 'failed', 'partial', 'settled', 'review_required')),
  provider_status text,
  provider_status_detail text,
  amount_paid numeric(12,2) CHECK (amount_paid >= 0 AND amount_paid <> 'NaN'::numeric),
  observed_at timestamptz,
  settled_at timestamptz,
  review_code text CHECK (review_code IN (
    'provider_inconsistent', 'provider_credit_decreased', 'settled_payment_changed', 'intent_changed',
    'order_changed', 'gateway_changed', 'voucher_pending', 'voucher_validated', 'checkout_expired'
  )),
  CHECK ((state = 'review_required') = (review_code IS NOT NULL)),
  CHECK (state <> 'settled' OR settled_at IS NOT NULL),
  CHECK (settled_at IS NULL OR state IN ('settled', 'review_required')),
  CHECK ((state = 'awaiting_observation') = (observed_at IS NULL)),
  CHECK (observed_at IS NULL OR (provider_status IS NOT NULL AND provider_status_detail IS NOT NULL AND amount_paid IS NOT NULL)),
  FOREIGN KEY (company_id, intent_id) REFERENCES payment_checkout_dispatches (company_id, intent_id) ON DELETE RESTRICT
);

ALTER TABLE payment_checkout_reconciliations ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_checkout_reconciliations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_policy ON payment_checkout_reconciliations
  USING (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);

CREATE FUNCTION guard_payment_voucher_after_checkout_settlement() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.order_id IS NULL OR NEW.status NOT IN ('pending', 'validated') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.company_id = OLD.company_id AND NEW.order_id IS NOT DISTINCT FROM OLD.order_id AND NEW.status = OLD.status THEN
      RETURN NEW;
    END IF;
  END IF;

  PERFORM c.id FROM public.customer_orders o
    JOIN public.conversations c ON c.company_id = o.company_id AND c.id = o.conversation_id
    WHERE o.company_id = NEW.company_id AND o.id = NEW.order_id FOR UPDATE OF c;
  PERFORM id FROM public.customer_orders
    WHERE company_id = NEW.company_id AND id = NEW.order_id FOR UPDATE;
  IF EXISTS (
    SELECT 1
    FROM public.payment_checkout_dispatches d
    JOIN public.payment_checkout_reconciliations r USING (company_id, intent_id)
    WHERE d.company_id = NEW.company_id AND d.order_id = NEW.order_id AND r.settled_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'PWA01', MESSAGE = 'Order already settled through Mercado Pago';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER payment_vouchers_checkout_settlement
BEFORE INSERT OR UPDATE OF status, company_id, order_id ON payment_vouchers
FOR EACH ROW EXECUTE FUNCTION guard_payment_voucher_after_checkout_settlement();
