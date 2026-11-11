ALTER TABLE approval_requests
  ADD COLUMN IF NOT EXISTS historical_effect_key_conflict boolean NOT NULL DEFAULT false;

-- Keep both historical requests and their decisions. The ALTER lock and the
-- migrator transaction isolate the backfill from concurrent application writes.
ALTER TABLE approval_requests NO FORCE ROW LEVEL SECURITY;
WITH duplicate_keys AS (
  SELECT tenant_id, effect_key FROM approval_requests
  GROUP BY tenant_id, effect_key
  HAVING COUNT(*) > 1
)
UPDATE approval_requests AS request
SET historical_effect_key_conflict = true
FROM duplicate_keys
WHERE request.tenant_id = duplicate_keys.tenant_id
  AND request.effect_key = duplicate_keys.effect_key
  AND NOT request.historical_effect_key_conflict;
ALTER TABLE approval_requests FORCE ROW LEVEL SECURITY;

CREATE UNIQUE INDEX IF NOT EXISTS uq_approval_requests_unambiguous_effect
  ON approval_requests (tenant_id, effect_key)
  WHERE NOT historical_effect_key_conflict;
