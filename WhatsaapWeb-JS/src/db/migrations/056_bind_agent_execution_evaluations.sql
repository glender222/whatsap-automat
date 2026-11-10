ALTER TABLE agent_eval_runs
  ADD COLUMN execution_spec_hash VARCHAR(64),
  ADD COLUMN execution_suite_hash VARCHAR(64),
  ADD COLUMN execution_deadline_at TIMESTAMPTZ,
  ADD CONSTRAINT agent_eval_runs_execution_identity CHECK (
    (execution_spec_hash IS NULL AND execution_suite_hash IS NULL AND execution_deadline_at IS NULL)
    OR
    (execution_spec_hash IS NOT NULL AND execution_spec_hash ~ '^[0-9a-f]{64}$'
     AND execution_suite_hash IS NOT NULL AND execution_suite_hash ~ '^[0-9a-f]{64}$'
     AND execution_deadline_at IS NOT NULL)
  );
