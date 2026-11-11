-- Internal catalog-router-v1 verification only: no publication or delivery grant.
CREATE UNIQUE INDEX IF NOT EXISTS catalog_router_revision_pin
  ON agent_studio_revisions (tenant_id, graph_id, version, spec_hash);

CREATE TABLE IF NOT EXISTS catalog_router_runs (
  tenant_id integer NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL CHECK (id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  profile text NOT NULL DEFAULT 'catalog-router-v1' CHECK (profile = 'catalog-router-v1'),
  graph_id text NOT NULL,
  graph_version integer NOT NULL CHECK (graph_version > 0),
  spec_hash text NOT NULL CHECK (spec_hash ~ '^[0-9a-f]{64}$'),
  input_hash text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  authorization_hash text NOT NULL CHECK (authorization_hash ~ '^[0-9a-f]{64}$'),
  max_tokens bigint NOT NULL CHECK (max_tokens BETWEEN 1 AND 9007199254740991),
  max_cost_micro_usd bigint NOT NULL CHECK (max_cost_micro_usd BETWEEN 1 AND 9007199254740991),
  max_duration_seconds integer NOT NULL CHECK (max_duration_seconds BETWEEN 1 AND 60),
  tokens_used bigint NOT NULL DEFAULT 0 CHECK (tokens_used >= 0),
  cost_micro_usd bigint NOT NULL DEFAULT 0 CHECK (cost_micro_usd >= 0),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'blocked', 'expired')),
  deadline_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, graph_id, graph_version, spec_hash)
    REFERENCES agent_studio_revisions (tenant_id, graph_id, version, spec_hash),
  CONSTRAINT catalog_router_deadline CHECK (deadline_at = created_at + max_duration_seconds * interval '1 second'),
  CONSTRAINT catalog_router_ttl CHECK (expires_at > deadline_at AND expires_at <= created_at + interval '1 hour')
);

CREATE TABLE IF NOT EXISTS catalog_router_rounds (
  tenant_id integer NOT NULL,
  run_id uuid NOT NULL,
  slot text NOT NULL CHECK (slot IN ('router', 'answer')),
  round_id uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'prepared' CHECK (state IN ('prepared', 'completed', 'terminal')),
  ledger_id bigint,
  output_hash text CHECK (output_hash ~ '^[0-9a-f]{64}$'),
  output_encrypted text CHECK (length(output_encrypted) <= 22000),
  tokens_used bigint NOT NULL DEFAULT 0 CHECK (tokens_used >= 0),
  cost_micro_usd bigint NOT NULL DEFAULT 0 CHECK (cost_micro_usd >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, run_id, slot),
  UNIQUE (tenant_id, round_id),
  UNIQUE (tenant_id, ledger_id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES catalog_router_runs (tenant_id, id),
  FOREIGN KEY (tenant_id, ledger_id) REFERENCES ai_token_cost_ledger (tenant_id, id),
  CONSTRAINT catalog_router_round_state CHECK (
    (state = 'prepared' AND ledger_id IS NULL AND output_hash IS NULL AND output_encrypted IS NULL
      AND tokens_used = 0 AND cost_micro_usd = 0)
    OR (state IN ('completed', 'terminal') AND ledger_id IS NOT NULL)
  ),
  CONSTRAINT catalog_router_round_cipher CHECK (
    output_encrypted IS NULL OR (state = 'completed' AND output_hash IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS catalog_router_tool_checkpoints (
  tenant_id integer NOT NULL,
  run_id uuid NOT NULL,
  input_hash text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  authorization_hash text NOT NULL CHECK (authorization_hash ~ '^[0-9a-f]{64}$'),
  output_hash text NOT NULL CHECK (output_hash ~ '^[0-9a-f]{64}$'),
  output_encrypted text CHECK (length(output_encrypted) <= 22000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, run_id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES catalog_router_runs (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS catalog_router_expiry
  ON catalog_router_runs (tenant_id, expires_at, id) WHERE state <> 'expired';

ALTER TABLE catalog_router_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog_router_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS catalog_router_runs_tenant ON catalog_router_runs;
CREATE POLICY catalog_router_runs_tenant ON catalog_router_runs
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);

ALTER TABLE catalog_router_rounds ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog_router_rounds FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS catalog_router_rounds_tenant ON catalog_router_rounds;
CREATE POLICY catalog_router_rounds_tenant ON catalog_router_rounds
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);

ALTER TABLE catalog_router_tool_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog_router_tool_checkpoints FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS catalog_router_tool_checkpoints_tenant ON catalog_router_tool_checkpoints;
CREATE POLICY catalog_router_tool_checkpoints_tenant ON catalog_router_tool_checkpoints
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);
