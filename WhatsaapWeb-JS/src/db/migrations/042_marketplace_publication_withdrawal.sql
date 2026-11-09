-- Keep identities, aliases and ratings when a publisher withdraws a listing.
ALTER TABLE marketplace_extensions
  ADD COLUMN withdrawn_at timestamptz,
  ADD COLUMN withdrawn_by bigint,
  ADD CONSTRAINT marketplace_withdrawal_state_check CHECK ((
    (withdrawn_at IS NULL AND withdrawn_by IS NULL)
    OR (withdrawn_at IS NOT NULL AND withdrawn_by > 0 AND listing->>'status' = 'deprecated')
  ) IS TRUE);

CREATE INDEX marketplace_extensions_publisher_idx
  ON marketplace_extensions (publisher_tenant_id, published_at DESC, id);

-- The public SELECT policy still exposes only listings with status published.
CREATE POLICY marketplace_catalog_owner_read ON marketplace_extensions FOR SELECT
  USING (publisher_tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);
