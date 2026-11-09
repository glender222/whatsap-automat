-- Ingress may resolve one opaque endpoint before a tenant is known.
DROP POLICY IF EXISTS workflow_ingress_endpoint_lookup ON workflow_triggers;
CREATE POLICY workflow_ingress_endpoint_lookup ON workflow_triggers FOR SELECT
  USING (type = 'webhook' AND endpoint_key = NULLIF(current_setting('app.workflow_endpoint_key', true), ''));

-- Workers need discovery metadata to poll tenants without a BYPASSRLS role.
CREATE TABLE IF NOT EXISTS workflow_dispatch_tenants (
  tenant_id integer PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE
);

ALTER TABLE workflow_dispatch_tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_dispatch_tenants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workflow_dispatch_tenants_read ON workflow_dispatch_tenants;
CREATE POLICY workflow_dispatch_tenants_read ON workflow_dispatch_tenants FOR SELECT USING (true);
DROP POLICY IF EXISTS workflow_dispatch_tenants_insert ON workflow_dispatch_tenants;
CREATE POLICY workflow_dispatch_tenants_insert ON workflow_dispatch_tenants FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);

ALTER TABLE processing_outbox ADD COLUMN IF NOT EXISTS lease_token uuid;

CREATE INDEX IF NOT EXISTS idx_processing_outbox_workflow_poll
  ON processing_outbox (tenant_id, next_retry_at, created_at)
  WHERE event_type = 'workflow.trigger.webhook'
    AND status IN ('pending', 'processing', 'delivery_unknown');

CREATE OR REPLACE FUNCTION preserve_workflow_revision_snapshot() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW.tenant_id, NEW.workflow_id, NEW.revision_number, NEW.dag_graph, NEW.spec_hash, NEW.limits)
      IS DISTINCT FROM
     ROW(OLD.id, OLD.tenant_id, OLD.workflow_id, OLD.revision_number, OLD.dag_graph, OLD.spec_hash, OLD.limits) THEN
    RAISE EXCEPTION 'Workflow revisions are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS workflow_revision_snapshot_immutable ON workflow_revisions;
CREATE TRIGGER workflow_revision_snapshot_immutable BEFORE UPDATE ON workflow_revisions
  FOR EACH ROW EXECUTE FUNCTION preserve_workflow_revision_snapshot();

CREATE OR REPLACE FUNCTION preserve_workflow_run_binding() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW.tenant_id, NEW.workflow_id, NEW.revision_id, NEW.temporal_workflow_id)
      IS DISTINCT FROM ROW(OLD.id, OLD.tenant_id, OLD.workflow_id, OLD.revision_id, OLD.temporal_workflow_id) THEN
    RAISE EXCEPTION 'The workflow run revision is pinned' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS workflow_run_binding_immutable ON workflow_runs;
CREATE TRIGGER workflow_run_binding_immutable BEFORE UPDATE ON workflow_runs
  FOR EACH ROW EXECUTE FUNCTION preserve_workflow_run_binding();

CREATE OR REPLACE FUNCTION record_workflow_dispatch_failure() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE workflow_runs
  SET status = 'failed', current_step = 'dispatch_unconfirmed', completed_at = clock_timestamp(),
      error_details = jsonb_build_object(
        'code', 'TEMPORAL_DISPATCH_UNCONFIRMED',
        'message', 'The workflow dispatch could not be confirmed.'
      )
  WHERE tenant_id = NEW.tenant_id AND id = NEW.payload->>'runId' AND status = 'queued';
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS workflow_dispatch_failure ON processing_outbox;
CREATE TRIGGER workflow_dispatch_failure AFTER UPDATE OF status ON processing_outbox
  FOR EACH ROW WHEN (
    NEW.event_type = 'workflow.trigger.webhook' AND NEW.status = 'dead_letter'
    AND OLD.status IS DISTINCT FROM NEW.status
  ) EXECUTE FUNCTION record_workflow_dispatch_failure();
