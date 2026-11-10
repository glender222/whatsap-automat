-- A committed claim must exist before invoking a mutative tool. A timed-out
-- claim is evidence of an uncertain effect, never permission to invoke again.
-- Historical results retain their output and remain unbound (NULL hash).
ALTER TABLE tool_execution_effects
  ADD COLUMN IF NOT EXISTS action_hash varchar(64),
  ADD COLUMN IF NOT EXISTS claim_token uuid,
  ADD COLUMN IF NOT EXISTS dispatch_deadline timestamptz,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_effect_claim_binding'
      AND conrelid = 'tool_execution_effects'::regclass) THEN
    ALTER TABLE tool_execution_effects ADD CONSTRAINT tool_effect_claim_binding CHECK (
      (action_hash IS NULL AND claim_token IS NULL AND dispatch_deadline IS NULL)
      OR (action_hash IS NOT NULL AND action_hash ~ '^[0-9a-f]{64}$'
        AND claim_token IS NOT NULL AND dispatch_deadline IS NOT NULL)
    );
  END IF;
END $$;
