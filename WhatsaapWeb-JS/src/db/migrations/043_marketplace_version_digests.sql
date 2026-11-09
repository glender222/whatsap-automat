CREATE TABLE marketplace_version_digests (
  listing_id text NOT NULL REFERENCES marketplace_extensions(id),
  version text NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (listing_id, version)
);

-- The prior catalog retained only the current publication. Reserve every digest
-- that it can still prove for a publicly visible version at migration time.
INSERT INTO marketplace_version_digests (listing_id, version, sha256)
SELECT id, listing->>'version', lower(listing->>'tarballSha256')
FROM marketplace_extensions
WHERE listing->>'status' = 'published'
  AND listing->>'version' IS NOT NULL
  AND listing->>'tarballSha256' ~ '^[a-fA-F0-9]{64}$';

ALTER TABLE marketplace_version_digests ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketplace_version_digests FORCE ROW LEVEL SECURITY;

CREATE POLICY marketplace_digest_owner_read ON marketplace_version_digests FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM marketplace_extensions AS extension
    WHERE extension.id = marketplace_version_digests.listing_id
      AND extension.publisher_tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer
  ));

CREATE POLICY marketplace_digest_owner_insert ON marketplace_version_digests FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM marketplace_extensions AS extension
    WHERE extension.id = marketplace_version_digests.listing_id
      AND extension.publisher_tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer
      AND extension.withdrawn_at IS NULL
  ));
