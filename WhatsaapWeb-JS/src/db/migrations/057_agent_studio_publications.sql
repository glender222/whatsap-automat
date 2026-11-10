ALTER TABLE agent_eval_runs
  ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'verification'
    CHECK (execution_mode IN ('verification', 'provider')),
  ADD CONSTRAINT agent_eval_runs_tenant_id_unique UNIQUE (tenant_id, id);

CREATE TABLE agent_studio_publications (
  tenant_id INTEGER NOT NULL,
  graph_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  execution_mode TEXT NOT NULL CHECK (execution_mode IN ('verification', 'provider')),
  evaluation_id VARCHAR(255) NOT NULL,
  spec_hash VARCHAR(64) NOT NULL CHECK (spec_hash ~ '^[0-9a-f]{64}$'),
  suite_hash VARCHAR(64) NOT NULL CHECK (suite_hash ~ '^[0-9a-f]{64}$'),
  published_by BIGINT NOT NULL CHECK (published_by > 0),
  published_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, graph_id, execution_mode, version),
  UNIQUE (tenant_id, evaluation_id),
  FOREIGN KEY (tenant_id, graph_id, version) REFERENCES agent_studio_revisions (tenant_id, graph_id, version),
  FOREIGN KEY (tenant_id, evaluation_id) REFERENCES agent_eval_runs (tenant_id, id)
);

ALTER TABLE agent_studio_publications ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_studio_publications FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_studio_publications_tenant ON agent_studio_publications
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);

CREATE TRIGGER agent_studio_publication_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON agent_studio_publications
FOR EACH STATEMENT EXECUTE FUNCTION reject_agent_studio_revision_mutation();
