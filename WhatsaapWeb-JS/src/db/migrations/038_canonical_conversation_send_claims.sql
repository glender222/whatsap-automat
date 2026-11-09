-- A claim consumes an idempotency key before any external request. An unresolved
-- claim blocks new canonical sends for that conversation, including after a restart.
CREATE TABLE IF NOT EXISTS conversation_send_claims (
  tenant_id integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  request_key varchar(128) NOT NULL CHECK (request_key ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  conversation_id integer NOT NULL CHECK (conversation_id > 0),
  actor_id integer NOT NULL CHECK (actor_id > 0),
  expected_version integer NOT NULL CHECK (expected_version >= 0),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  connection_id varchar(255) NOT NULL,
  phone_number_id varchar(100) NOT NULL CHECK (phone_number_id ~ '^[0-9]+$'),
  recipient_id varchar(15) NOT NULL CHECK (recipient_id ~ '^[1-9][0-9]{6,14}$'),
  message_id integer REFERENCES messages(id) ON DELETE SET NULL,
  state text NOT NULL DEFAULT 'unknown_delivery'
    CHECK (state IN ('unknown_delivery', 'provider_accepted', 'failed')),
  provider_message_id varchar(255),
  claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at timestamptz,
  PRIMARY KEY (tenant_id, request_key),
  UNIQUE (message_id),
  CHECK ((state = 'provider_accepted') = (provider_message_id IS NOT NULL)),
  CHECK ((state = 'unknown_delivery') = (resolved_at IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_conversation_send_unresolved
ON conversation_send_claims (tenant_id, conversation_id)
WHERE state = 'unknown_delivery';

CREATE UNIQUE INDEX IF NOT EXISTS uq_conversation_send_provider_receipt
ON conversation_send_claims (tenant_id, provider_message_id)
WHERE provider_message_id IS NOT NULL;

ALTER TABLE conversation_send_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_send_claims FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS conversation_send_claim_tenant ON conversation_send_claims;
CREATE POLICY conversation_send_claim_tenant ON conversation_send_claims
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (
    tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer
    AND (message_id IS NULL OR EXISTS (
      SELECT 1 FROM messages m WHERE m.id = message_id
        AND m.company_id = conversation_send_claims.tenant_id
        AND m.conversation_id = conversation_send_claims.conversation_id
        AND m.client_request_id = conversation_send_claims.request_key
        AND m.provider = 'meta-cloud' AND m.direction = 'outbound'
    ))
  );
