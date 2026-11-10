CREATE TABLE IF NOT EXISTS ai_quota_reservations (
  tenant_id INTEGER NOT NULL REFERENCES tenant_ai_quotas(tenant_id) ON DELETE CASCADE,
  id UUID NOT NULL,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  operation VARCHAR(50) NOT NULL CHECK (operation IN ('completion', 'embedding', 'eval', 'tool_reasoning')),
  provider VARCHAR(60) NOT NULL,
  model VARCHAR(120) NOT NULL,
  max_cost_micro_usd BIGINT NOT NULL CHECK (max_cost_micro_usd >= 0),
  max_tokens INTEGER NOT NULL CHECK (max_tokens > 0),
  period_start TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  status TEXT NOT NULL DEFAULT 'reserved',
  claim_token UUID,
  claimed_at TIMESTAMPTZ,
  ledger_id BIGINT UNIQUE REFERENCES ai_token_cost_ledger(id),
  settlement_hash TEXT CHECK (settlement_hash ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT chk_ai_quota_reservation_state CHECK (
    (status IN ('reserved', 'released') AND claim_token IS NULL AND claimed_at IS NULL AND ledger_id IS NULL AND settlement_hash IS NULL)
    OR (status = 'claimed' AND claim_token IS NOT NULL AND claimed_at IS NOT NULL AND ledger_id IS NULL AND settlement_hash IS NULL)
    OR (status = 'settled' AND claim_token IS NOT NULL AND claimed_at IS NOT NULL AND ledger_id IS NOT NULL AND settlement_hash IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_ai_quota_reservations_active_period
  ON ai_quota_reservations(tenant_id, period_start)
  WHERE status IN ('reserved', 'claimed');

ALTER TABLE ai_quota_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_quota_reservations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_policy ON ai_quota_reservations;
CREATE POLICY tenant_isolation_policy ON ai_quota_reservations
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);
