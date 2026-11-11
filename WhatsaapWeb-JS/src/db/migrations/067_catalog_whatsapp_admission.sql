-- An explicit catalog binding pins the exact immutable publication receipt. Text pins retain their contract.
CREATE UNIQUE INDEX catalog_whatsapp_publication_receipt ON agent_studio_publications
  (tenant_id,graph_id,execution_mode,version,spec_hash,execution_profile,evidence_version,evidence_hash);

ALTER TABLE strict_whatsapp_bindings
  ADD COLUMN execution_profile text NOT NULL DEFAULT 'linear-text-v1',
  ADD COLUMN publication_evidence_version text,
  ADD COLUMN publication_evidence_hash text,
  ADD CONSTRAINT strict_binding_profile CHECK (
    (execution_profile='linear-text-v1' AND publication_evidence_version IS NULL AND publication_evidence_hash IS NULL)
    OR (execution_profile='catalog-router-v1' AND publication_evidence_version IS NOT NULL
      AND publication_evidence_version='catalog-publication-v1' AND publication_evidence_hash IS NOT NULL
      AND publication_evidence_hash ~ '^[0-9a-f]{64}$')),
  ADD FOREIGN KEY (tenant_id,graph_id,execution_mode,graph_version,spec_hash,execution_profile,publication_evidence_version,publication_evidence_hash)
    REFERENCES agent_studio_publications(tenant_id,graph_id,execution_mode,version,spec_hash,execution_profile,evidence_version,evidence_hash);

ALTER TABLE strict_whatsapp_runs
  ADD COLUMN execution_profile text NOT NULL DEFAULT 'linear-text-v1',
  ADD COLUMN publication_evidence_version text,
  ADD COLUMN publication_evidence_hash text,
  ADD CONSTRAINT strict_run_profile CHECK (
    (execution_profile='linear-text-v1' AND publication_evidence_version IS NULL AND publication_evidence_hash IS NULL)
    OR (execution_profile='catalog-router-v1' AND publication_evidence_version IS NOT NULL
      AND publication_evidence_version='catalog-publication-v1' AND publication_evidence_hash IS NOT NULL
      AND publication_evidence_hash ~ '^[0-9a-f]{64}$' AND ownership_epoch IS NOT NULL)),
  ADD FOREIGN KEY (tenant_id,graph_id,execution_mode,graph_version,spec_hash,execution_profile,publication_evidence_version,publication_evidence_hash)
    REFERENCES agent_studio_publications(tenant_id,graph_id,execution_mode,version,spec_hash,execution_profile,evidence_version,evidence_hash);

CREATE UNIQUE INDEX catalog_whatsapp_canonical_run ON strict_whatsapp_runs
  (tenant_id,id,graph_id,graph_version,spec_hash,execution_profile);

-- Evaluation identities/hashes and old checkpoints stay unchanged. Production completion requires a canonical parent.
ALTER TABLE catalog_router_runs
  ADD COLUMN operation text NOT NULL DEFAULT 'eval' CHECK (operation IN ('eval','completion')),
  ADD COLUMN strict_whatsapp_run_id uuid,
  ADD CONSTRAINT catalog_checkpoint_origin CHECK (
    (operation='eval' AND strict_whatsapp_run_id IS NULL)
    OR (operation='completion' AND strict_whatsapp_run_id IS NOT NULL AND strict_whatsapp_run_id=id)),
  ADD FOREIGN KEY (tenant_id,strict_whatsapp_run_id,graph_id,graph_version,spec_hash,profile)
    REFERENCES strict_whatsapp_runs(tenant_id,id,graph_id,graph_version,spec_hash,execution_profile);
