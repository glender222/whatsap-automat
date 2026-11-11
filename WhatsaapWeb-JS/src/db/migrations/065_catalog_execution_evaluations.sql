-- Preserve all existing text/fixture suites and evidence; tools require an explicit distinct profile.
ALTER TABLE agent_eval_suites ADD COLUMN execution_profile text NOT NULL DEFAULT 'linear-text-v1'
  CHECK (execution_profile IN ('linear-text-v1', 'catalog-router-v1'));
ALTER TABLE agent_eval_runs ADD COLUMN execution_profile text NOT NULL DEFAULT 'linear-text-v1'
  CHECK (execution_profile IN ('linear-text-v1', 'catalog-router-v1'));

CREATE INDEX agent_eval_runs_profile_lookup
  ON agent_eval_runs (tenant_id, agent_graph_id, graph_version, execution_profile, id);
