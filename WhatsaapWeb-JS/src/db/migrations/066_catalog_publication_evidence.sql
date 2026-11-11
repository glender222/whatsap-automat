-- Existing evaluations are history, not retroactive approval under a new verifier.
ALTER TABLE agent_eval_runs ADD COLUMN execution_evidence_version text
  CHECK (execution_evidence_version IS NULL OR
    (execution_profile = 'catalog-router-v1' AND execution_evidence_version = 'catalog-evaluation-v1'));

-- Keep the immutable publication trigger and tenant RLS inherited from 057.
ALTER TABLE agent_studio_publications
  ADD COLUMN execution_profile text NOT NULL DEFAULT 'linear-text-v1'
    CHECK (execution_profile IN ('linear-text-v1', 'catalog-router-v1')),
  ADD COLUMN evidence_version text,
  ADD COLUMN evidence_hash text,
  ADD COLUMN evidence_manifest jsonb,
  ADD CONSTRAINT catalog_publication_evidence CHECK (
    (execution_profile = 'linear-text-v1' AND evidence_version IS NULL AND evidence_hash IS NULL AND evidence_manifest IS NULL)
    OR (execution_profile = 'catalog-router-v1' AND execution_mode = 'provider'
      AND evidence_version IS NOT NULL AND evidence_version = 'catalog-publication-v1'
      AND evidence_hash IS NOT NULL AND evidence_hash ~ '^[0-9a-f]{64}$'
      AND evidence_manifest IS NOT NULL AND jsonb_typeof(evidence_manifest) = 'object')
  );
