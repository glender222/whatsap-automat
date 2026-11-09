CREATE TABLE IF NOT EXISTS marketplace_extensions (
  id text PRIMARY KEY,
  extension_id text NOT NULL UNIQUE,
  name text NOT NULL UNIQUE,
  publisher_tenant_id integer NOT NULL REFERENCES tenants(id),
  listing jsonb NOT NULL,
  published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((listing->>'id' = id AND listing->>'extensionId' = extension_id AND listing->>'name' = name) IS TRUE)
);

CREATE INDEX IF NOT EXISTS marketplace_extensions_published_idx
  ON marketplace_extensions (published_at, id);

-- A single namespace prevents a listing's ID, extension ID and name from
-- being used as an alias by a concurrent publisher.
CREATE TABLE IF NOT EXISTS marketplace_extension_aliases (
  alias text PRIMARY KEY,
  listing_id text NOT NULL REFERENCES marketplace_extensions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS marketplace_ratings (
  id uuid NOT NULL UNIQUE,
  listing_id text NOT NULL REFERENCES marketplace_extensions(id) ON DELETE CASCADE,
  tenant_id integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id bigint NOT NULL CHECK (user_id > 0),
  score smallint NOT NULL CHECK (score BETWEEN 1 AND 5),
  review text CHECK (char_length(review) <= 1000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (listing_id, tenant_id, user_id)
);

CREATE TABLE IF NOT EXISTS marketplace_rating_totals (
  listing_id text PRIMARY KEY REFERENCES marketplace_extensions(id) ON DELETE CASCADE,
  rating_count bigint NOT NULL DEFAULT 0 CHECK (rating_count >= 0),
  score_total bigint NOT NULL DEFAULT 0 CHECK (score_total BETWEEN rating_count AND rating_count * 5),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

ALTER TABLE marketplace_extensions ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketplace_extensions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS marketplace_catalog_read ON marketplace_extensions;
CREATE POLICY marketplace_catalog_read ON marketplace_extensions FOR SELECT
  USING (listing->>'status' = 'published');
DROP POLICY IF EXISTS marketplace_catalog_insert ON marketplace_extensions;
CREATE POLICY marketplace_catalog_insert ON marketplace_extensions FOR INSERT
  WITH CHECK (publisher_tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);
DROP POLICY IF EXISTS marketplace_catalog_update ON marketplace_extensions;
CREATE POLICY marketplace_catalog_update ON marketplace_extensions FOR UPDATE
  USING (publisher_tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (publisher_tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);

ALTER TABLE marketplace_extension_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketplace_extension_aliases FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS marketplace_alias_read ON marketplace_extension_aliases;
CREATE POLICY marketplace_alias_read ON marketplace_extension_aliases FOR SELECT USING (true);
DROP POLICY IF EXISTS marketplace_alias_insert ON marketplace_extension_aliases;
CREATE POLICY marketplace_alias_insert ON marketplace_extension_aliases FOR INSERT
  WITH CHECK (pg_trigger_depth() > 0 AND EXISTS (
    SELECT 1 FROM marketplace_extensions AS extension
    WHERE extension.id = listing_id
      AND extension.publisher_tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer
  ));

ALTER TABLE marketplace_ratings ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketplace_ratings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS marketplace_rating_tenant ON marketplace_ratings;
CREATE POLICY marketplace_rating_tenant ON marketplace_ratings FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer);

ALTER TABLE marketplace_rating_totals ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketplace_rating_totals FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS marketplace_totals_read ON marketplace_rating_totals;
CREATE POLICY marketplace_totals_read ON marketplace_rating_totals FOR SELECT USING (true);
DROP POLICY IF EXISTS marketplace_totals_insert ON marketplace_rating_totals;
CREATE POLICY marketplace_totals_insert ON marketplace_rating_totals FOR INSERT
  WITH CHECK (pg_trigger_depth() > 0);
DROP POLICY IF EXISTS marketplace_totals_update ON marketplace_rating_totals;
CREATE POLICY marketplace_totals_update ON marketplace_rating_totals FOR UPDATE
  USING (pg_trigger_depth() > 0) WITH CHECK (pg_trigger_depth() > 0);

CREATE OR REPLACE FUNCTION marketplace_claim_listing() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.id, NEW.extension_id, NEW.name, NEW.publisher_tenant_id, NEW.published_at)
        IS DISTINCT FROM ROW(OLD.id, OLD.extension_id, OLD.name, OLD.publisher_tenant_id, OLD.published_at) THEN
      RAISE EXCEPTION 'Marketplace listing identity is immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  INSERT INTO marketplace_extension_aliases (alias, listing_id)
  SELECT DISTINCT alias, NEW.id FROM unnest(ARRAY[NEW.id, NEW.extension_id, NEW.name]) AS keys(alias)
  ORDER BY alias;

  INSERT INTO marketplace_rating_totals (listing_id) VALUES (NEW.id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS marketplace_claim_listing_trigger ON marketplace_extensions;
CREATE TRIGGER marketplace_claim_listing_trigger AFTER INSERT OR UPDATE ON marketplace_extensions
  FOR EACH ROW EXECUTE FUNCTION marketplace_claim_listing();

-- Every rating change updates the same totals row in its own transaction. No
-- cross-tenant read of marketplace_ratings is required to compute the aggregate.
CREATE OR REPLACE FUNCTION marketplace_apply_rating_delta() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  affected_listing text;
  count_delta integer;
  score_delta integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    affected_listing := NEW.listing_id;
    count_delta := 1;
    score_delta := NEW.score;
  ELSIF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.listing_id, NEW.tenant_id, NEW.user_id, NEW.id, NEW.created_at)
        IS DISTINCT FROM ROW(OLD.listing_id, OLD.tenant_id, OLD.user_id, OLD.id, OLD.created_at) THEN
      RAISE EXCEPTION 'Marketplace rating identity is immutable' USING ERRCODE = '23514';
    END IF;
    affected_listing := NEW.listing_id;
    count_delta := 0;
    score_delta := NEW.score - OLD.score;
  ELSE
    affected_listing := OLD.listing_id;
    count_delta := -1;
    score_delta := -OLD.score;
  END IF;

  UPDATE marketplace_rating_totals
  SET rating_count = rating_count + count_delta,
      score_total = score_total + score_delta,
      updated_at = clock_timestamp()
  WHERE listing_id = affected_listing;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS marketplace_rating_delta_trigger ON marketplace_ratings;
CREATE TRIGGER marketplace_rating_delta_trigger AFTER INSERT OR UPDATE OR DELETE ON marketplace_ratings
  FOR EACH ROW EXECUTE FUNCTION marketplace_apply_rating_delta();
