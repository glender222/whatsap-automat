-- A WhatsApp binding pins an evaluated provider publication, independently of later publications.
CREATE UNIQUE INDEX IF NOT EXISTS strict_whatsapp_publication_pin
  ON agent_studio_publications (tenant_id, graph_id, execution_mode, version, spec_hash);
CREATE UNIQUE INDEX IF NOT EXISTS strict_whatsapp_message_source
  ON messages (company_id, id, conversation_id);
CREATE UNIQUE INDEX IF NOT EXISTS strict_whatsapp_job_source
  ON processing_outbox (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS strict_whatsapp_ledger_source
  ON ai_token_cost_ledger (tenant_id, id);

CREATE TABLE IF NOT EXISTS strict_whatsapp_bindings (
  tenant_id integer PRIMARY KEY REFERENCES tenants(id),
  revision uuid NOT NULL,
  graph_id text NOT NULL,
  graph_version integer NOT NULL,
  spec_hash text NOT NULL,
  execution_mode text NOT NULL DEFAULT 'provider' CHECK (execution_mode = 'provider'),
  mode text NOT NULL CHECK (mode IN ('suggest', 'auto')),
  bound_by bigint NOT NULL CHECK (bound_by > 0),
  bound_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, graph_id, execution_mode, graph_version, spec_hash)
    REFERENCES agent_studio_publications (tenant_id, graph_id, execution_mode, version, spec_hash)
);

CREATE TABLE IF NOT EXISTS strict_whatsapp_runs (
  tenant_id integer NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL,
  job_id uuid NOT NULL,
  inbound_message_id bigint NOT NULL,
  conversation_id bigint NOT NULL,
  attempt_id uuid NOT NULL,
  graph_id text NOT NULL,
  graph_version integer NOT NULL,
  spec_hash text NOT NULL,
  execution_mode text NOT NULL DEFAULT 'provider' CHECK (execution_mode = 'provider'),
  binding_mode text NOT NULL CHECK (binding_mode IN ('suggest', 'auto')),
  binding_revision uuid NOT NULL,
  bound_by bigint NOT NULL CHECK (bound_by > 0),
  bound_at timestamptz NOT NULL,
  input_hash text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  timeout_ms integer NOT NULL CHECK (timeout_ms BETWEEN 1 AND 30000),
  state text NOT NULL DEFAULT 'prepared' CHECK (state IN ('prepared', 'ready', 'completed', 'uncertain')),
  ledger_id bigint,
  output_encrypted text,
  output_hash text CHECK (output_hash ~ '^[0-9a-f]{64}$'),
  output_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, job_id),
  UNIQUE (tenant_id, inbound_message_id),
  UNIQUE (tenant_id, attempt_id),
  FOREIGN KEY (tenant_id, graph_id, execution_mode, graph_version, spec_hash)
    REFERENCES agent_studio_publications (tenant_id, graph_id, execution_mode, version, spec_hash),
  FOREIGN KEY (tenant_id, inbound_message_id, conversation_id)
    REFERENCES messages (company_id, id, conversation_id),
  FOREIGN KEY (tenant_id, job_id) REFERENCES processing_outbox (tenant_id, id),
  FOREIGN KEY (tenant_id, ledger_id) REFERENCES ai_token_cost_ledger (tenant_id, id),
  CONSTRAINT strict_whatsapp_run_output CHECK (
    (state = 'ready' AND output_encrypted IS NOT NULL AND ledger_id IS NOT NULL AND output_hash IS NOT NULL)
    OR (state <> 'ready' AND output_encrypted IS NULL)
  ),
  CONSTRAINT strict_whatsapp_output_ttl CHECK (output_expires_at <= created_at + interval '1 hour')
);

CREATE INDEX IF NOT EXISTS strict_whatsapp_expired_output
  ON strict_whatsapp_runs (tenant_id, output_expires_at, id) WHERE state IN ('prepared', 'ready');

ALTER TABLE strict_whatsapp_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE strict_whatsapp_bindings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS strict_whatsapp_bindings_tenant ON strict_whatsapp_bindings;
CREATE POLICY strict_whatsapp_bindings_tenant ON strict_whatsapp_bindings
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);

ALTER TABLE strict_whatsapp_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE strict_whatsapp_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS strict_whatsapp_runs_tenant ON strict_whatsapp_runs;
CREATE POLICY strict_whatsapp_runs_tenant ON strict_whatsapp_runs
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);
