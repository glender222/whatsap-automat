import type { Queryable } from '../../../shared/UnitOfWorkPort';
import type { TenantScopedUoW } from '../../../db/TenantScopedUoW';
import { boundedTextCapability } from '../gateway/BoundedTextCompletion';
import { loadDraft } from '../studio/AgentStudioDrafts';
import { catalogManifestHash } from '../studio/CatalogPublicationGate';
import { catalogEvaluationEvidenceVersion, catalogPublicationEvidenceVersion, catalogReadAdapterVersion } from '../studio/CatalogEvidenceVersions';
import { compileCatalogRouterExecutionProfile } from '../studio/CatalogRouterExecutionProfile';
import { CatalogReadDeniedError, StrictCatalogSearchTool } from './StrictCatalogSearchTool';

export interface CatalogWhatsappPin {
  graphId: string;
  version: number;
  specHash: string;
  profile?: 'catalog-router-v1';
  evidenceVersion?: string;
  evidenceHash?: string;
}

/** The receipt is historical evidence. Its plaintext TTL is not a new execution permission or a binding TTL. */
export async function loadCatalogWhatsappPublication(db: Queryable, uow: TenantScopedUoW, tenantId: number, pin: CatalogWhatsappPin) {
  if (pin.profile !== 'catalog-router-v1' || pin.evidenceVersion !== catalogPublicationEvidenceVersion ||
      !/^[0-9a-f]{64}$/.test(pin.evidenceHash ?? '')) throw new CatalogReadDeniedError();
  const { rows: [published] } = await db.query(`SELECT evaluation_id,suite_hash,evidence_manifest FROM agent_studio_publications
    WHERE tenant_id=$1 AND graph_id=$2 AND version=$3 AND spec_hash=$4 AND execution_mode='provider'
      AND execution_profile='catalog-router-v1' AND evidence_version=$5 AND evidence_hash=$6`,
  [tenantId,pin.graphId,pin.version,pin.specHash,pin.evidenceVersion,pin.evidenceHash]);
  const manifest = published?.evidence_manifest;
  if (!manifest || catalogManifestHash(manifest) !== pin.evidenceHash ||
      manifest.evidenceVersion !== catalogPublicationEvidenceVersion || manifest.evaluationEvidenceVersion !== catalogEvaluationEvidenceVersion ||
      manifest.profile !== pin.profile || manifest.capabilityId !== boundedTextCapability.id ||
      manifest.provider !== boundedTextCapability.provider || manifest.model !== boundedTextCapability.model ||
      manifest.toolAdapterVersion !== catalogReadAdapterVersion || manifest.toolSchemaVersion !== 1 ||
      manifest.tenantId !== tenantId || manifest.graphId !== pin.graphId || manifest.version !== pin.version ||
      manifest.specHash !== pin.specHash || manifest.evaluationId !== published.evaluation_id || manifest.suiteHash !== published.suite_hash) {
    throw new CatalogReadDeniedError();
  }
  const graph = await loadDraft(db,tenantId,pin.graphId,pin.version);
  const compiled = graph && compileCatalogRouterExecutionProfile(graph);
  if (!graph || graph.specHash !== pin.specHash || !compiled?.compatible) throw new CatalogReadDeniedError();
  // Current grants and scope are intersected with the approved graph, never expanded by this receipt.
  await new StrictCatalogSearchTool(uow,compiled.plan).assertAuthorized(tenantId,db);
  return { graph: { ...graph, status: 'published' as const }, plan: compiled.plan };
}
