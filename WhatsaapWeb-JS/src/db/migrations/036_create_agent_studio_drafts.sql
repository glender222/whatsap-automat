-- Agent Studio definitions are authored revisions. Production evaluation and activation
-- have a separate trust boundary and are intentionally absent from this migration.
CREATE TABLE IF NOT EXISTS agent_studio_graphs (
  tenant_id integer NOT NULL REFERENCES tenants(id),
  graph_id text NOT NULL CHECK (graph_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  latest_version integer NOT NULL DEFAULT 1 CHECK (latest_version > 0),
  PRIMARY KEY (tenant_id, graph_id)
);

CREATE TABLE IF NOT EXISTS agent_studio_revisions (
  tenant_id integer NOT NULL,
  graph_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  created_by bigint NOT NULL CHECK (created_by > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  spec_hash text NOT NULL CHECK (spec_hash ~ '^[a-f0-9]{64}$'),
  -- JSON preserves the serialized spec passed to the contract's hashing function.
  spec json NOT NULL CHECK (json_typeof(spec) = 'object'),
  PRIMARY KEY (tenant_id, graph_id, version),
  FOREIGN KEY (tenant_id, graph_id) REFERENCES agent_studio_graphs (tenant_id, graph_id)
);

ALTER TABLE agent_studio_graphs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_studio_graphs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_studio_graphs_tenant ON agent_studio_graphs;
CREATE POLICY agent_studio_graphs_tenant ON agent_studio_graphs
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);

ALTER TABLE agent_studio_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_studio_revisions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_studio_revisions_tenant ON agent_studio_revisions;
CREATE POLICY agent_studio_revisions_tenant ON agent_studio_revisions
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);

CREATE OR REPLACE FUNCTION reject_agent_studio_revision_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Agent Studio revisions are immutable' USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS agent_studio_revision_immutable ON agent_studio_revisions;
CREATE TRIGGER agent_studio_revision_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON agent_studio_revisions
FOR EACH STATEMENT EXECUTE FUNCTION reject_agent_studio_revision_mutation();
