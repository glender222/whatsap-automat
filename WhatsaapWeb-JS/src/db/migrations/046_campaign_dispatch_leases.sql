ALTER TABLE campaigns
  ADD COLUMN dispatch_run_id uuid,
  ADD COLUMN dispatch_lease_expires_at timestamptz,
  ADD CONSTRAINT chk_campaign_dispatch_lease CHECK (
    (dispatch_lease_expires_at IS NOT NULL) = (status = 'dispatching' AND dispatch_run_id IS NOT NULL)
  );

CREATE INDEX idx_campaign_expiring_dispatches
  ON campaigns (tenant_id, dispatch_lease_expires_at)
  WHERE status = 'dispatching' AND dispatch_lease_expires_at IS NOT NULL;
