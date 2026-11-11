import type { AgentGraphVersionV1 } from '@whatsap-automat/contracts';
import type { Queryable } from '../../../shared/UnitOfWorkPort';
import type { TenantScopedUoW } from '../../../db/TenantScopedUoW';
import { boundedTextCapability } from '../gateway/BoundedTextCompletion';
import { loadDraft } from './AgentStudioDrafts';
import { executionAttemptId, executionRunIdPattern, loadExecutionSuite, type ExecutionMode } from './AgentExecutionEvidence';
import { preflightBoundedAgentDispatch, type BoundedAgentDispatch } from './BoundedAgentDispatch';
import { compileCatalogRouterExecutionProfile } from './CatalogRouterExecutionProfile';
import { CatalogPublicationGate, catalogManifestHash, catalogPublicationBlocker } from './CatalogPublicationGate';
import { catalogPublicationEvidenceVersion } from './CatalogEvidenceVersions';

interface PublicationRow {
  graph_id: string;
  version: number;
  evaluation_id: string;
  execution_mode: ExecutionMode;
  spec_hash: string;
  suite_hash: string;
  published_at: Date;
  execution_profile?: 'linear-text-v1' | 'catalog-router-v1';
  evidence_version?: string;
  evidence_hash?: string;
  evidence_manifest?: { authorizationHash: string; evidenceVersion: string };
}

export async function dispatchPublishedAgent(
  uow: TenantScopedUoW,
  publications: AgentStudioPublications,
  dispatcher: Pick<BoundedAgentDispatch, 'dispatch'>,
  command: { tenantId: number; graphId: string; version?: number; attemptId: string; input: string; timeoutMs: number },
) {
  const { tenantId, graphId, attemptId, input, timeoutMs } = command;
  const active = await uow.run(tenantId, (db) => publications.loadActive(db, tenantId, graphId));
  if (!active) return null;
  if (command.version !== undefined && command.version !== active.publication.version) {
    throw new AgentPublicationConflict('The selected revision is no longer the active publication');
  }
  if (active.publication.profile === 'catalog-router-v1') {
    throw new AgentPublicationConflict('CATALOG_CANONICAL_ADMISSION_REQUIRED');
  }
  const execution = await dispatcher.dispatch({
    tenantId, graph: active.graph, attemptId, input, timeoutMs, operation: 'completion',
  });
  return { publication: active.publication, execution };
}

interface PublishCommand {
  tenantId: number;
  actorId: number;
  graphId: string;
  version: number;
  evaluationId: string;
}

interface EvaluationScenarioEvidence {
  scenarioId: string;
  outcome: 'passed' | 'assertion_failed';
  ledgerId: number;
  tokens: number;
  costMicroUsd: number;
  timeoutMs: number;
}

export class AgentPublicationConflict extends Error {
  readonly code = 'CONFLICT';
}

function publication(row: PublicationRow) {
  return {
    graphId: row.graph_id, version: row.version, evaluationId: row.evaluation_id,
    mode: row.execution_mode, specHash: row.spec_hash, suiteHash: row.suite_hash,
    publishedAt: row.published_at.toISOString(),
    ...(row.execution_profile === 'catalog-router-v1' ? {
      profile: row.execution_profile, evidenceVersion: row.evidence_version!, evidenceHash: row.evidence_hash!,
      authorizationHash: row.evidence_manifest!.authorizationHash, executionAllowed: false, whatsappBindingAllowed: false,
    } : {}),
  };
}

function invalidEvidence(): never {
  throw new AgentPublicationConflict('A matching, completed execution evaluation is required');
}

export class AgentStudioPublications {
  constructor(
    private readonly mode: ExecutionMode,
    private readonly authorize?: (db: Queryable, tenantId: number) => Promise<void>,
    private readonly catalog?: CatalogPublicationGate,
  ) {}

  /** Call inside a tenant transaction. Publication is immutable and versions advance monotonically. */
  async publish(db: Queryable, command: PublishCommand) {
    const { tenantId, actorId, graphId, version, evaluationId } = command;
    if (![tenantId, actorId, version].every((value) => Number.isSafeInteger(value) && value > 0) ||
        version > 2_147_483_647 || !/^[a-zA-Z0-9_-]{1,128}$/.test(graphId) || !executionRunIdPattern.test(evaluationId)) {
      throw new AgentPublicationConflict('Publication requires an explicit revision and evaluation UUID');
    }
    await this.authorize?.(db, tenantId);
    const { rows: [locked] } = await db.query(
      'SELECT graph_id FROM agent_studio_graphs WHERE tenant_id = $1 AND graph_id = $2 FOR UPDATE', [tenantId, graphId],
    );
    if (!locked) return null;
    const graph = await loadDraft(db, tenantId, graphId, version);
    if (!graph) return null;
    const { rows: [active] } = await db.query(`
      SELECT * FROM agent_studio_publications
      WHERE tenant_id = $1 AND graph_id = $2 AND execution_mode = $3
      ORDER BY version DESC LIMIT 1
    `, [tenantId, graphId, this.mode]);
    const replay = active?.version === version && active.evaluation_id === evaluationId;
    // A future compiler/capability change must not turn a catalog replay into the legacy text shortcut.
    const catalog = compileCatalogRouterExecutionProfile(graph).compatible ||
      replay && active.execution_profile === 'catalog-router-v1';
    if (replay && !catalog) return publication(active);
    if (!replay && active && active.version >= version) {
      throw new AgentPublicationConflict('This revision cannot supersede the active publication');
    }

    if (catalog) {
      const evidence = await this.catalogEvidence(db, tenantId, graph, evaluationId);
      if (replay) {
        if (active.execution_profile !== 'catalog-router-v1' || active.evidence_hash !== evidence.evidenceHash) {
          throw new AgentPublicationConflict('CATALOG_PUBLICATION_EVIDENCE');
        }
        return publication(active);
      }
      const { rows: [created] } = await db.query(`INSERT INTO agent_studio_publications
        (tenant_id,graph_id,version,execution_mode,evaluation_id,spec_hash,suite_hash,published_by,
          execution_profile,evidence_version,evidence_hash,evidence_manifest)
        VALUES($1,$2,$3,'provider',$4,$5,$6,$7,'catalog-router-v1',$8,$9,$10::jsonb) RETURNING *`,
      [tenantId,graphId,version,evaluationId,graph.specHash,evidence.suiteHash,actorId,
        catalogPublicationEvidenceVersion,evidence.evidenceHash,JSON.stringify(evidence.manifest)]);
      return publication(created);
    }

    const suiteHash = await this.verifyEvidence(db, tenantId, graph, evaluationId);
    const { rows: [created] } = await db.query(`
      INSERT INTO agent_studio_publications (
        tenant_id, graph_id, version, execution_mode, evaluation_id, spec_hash, suite_hash, published_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `, [tenantId, graphId, version, this.mode, evaluationId, graph.specHash, suiteHash, actorId]);
    return publication(created);
  }

  async loadActive(db: Queryable, tenantId: number, graphId: string) {
    const { rows: [active] } = await db.query(`
      SELECT * FROM agent_studio_publications
      WHERE tenant_id = $1 AND graph_id = $2 AND execution_mode = $3
      ORDER BY version DESC LIMIT 1
    `, [tenantId, graphId, this.mode]);
    if (!active) return null;
    const graph = await loadDraft(db, tenantId, graphId, active.version);
    if (!graph || graph.specHash !== active.spec_hash) return null;
    if (active.execution_profile === 'catalog-router-v1' &&
        (!active.evidence_manifest || active.evidence_version !== active.evidence_manifest.evidenceVersion ||
         catalogManifestHash(active.evidence_manifest) !== active.evidence_hash)) return null;
    return { publication: publication(active), graph: { ...graph, status: 'published' as const } };
  }

  /** Advisory UI state. publish rechecks this in its own write transaction, including exact replays. */
  async catalogReadiness(db: Queryable, tenantId: number, graphId: string, version: number, evaluationId: string) {
    try {
      await this.authorize?.(db, tenantId);
      const graph = await loadDraft(db, tenantId, graphId, version);
      if (!graph) throw new AgentPublicationConflict('CATALOG_PUBLICATION_EVIDENCE');
      await this.catalogEvidence(db,tenantId,graph,evaluationId);
      const { rows: [active] } = await db.query(`SELECT version,evaluation_id FROM agent_studio_publications
        WHERE tenant_id=$1 AND graph_id=$2 AND execution_mode=$3 ORDER BY version DESC LIMIT 1`, [tenantId,graphId,this.mode]);
      if (active && (active.version > version || active.version === version && active.evaluation_id !== evaluationId)) {
        return { publicationAllowed: false, publicationEvidence: true, publicationBlocker: 'CATALOG_PUBLICATION_SUPERSEDED' };
      }
      return { publicationAllowed: true, publicationEvidence: true, publicationBlocker: null };
    } catch (error) {
      const code = error instanceof AgentPublicationConflict ? error.message : catalogPublicationBlocker(error);
      if (!code) throw error;
      return { publicationAllowed: false, publicationEvidence: false, publicationBlocker: code };
    }
  }

  private async catalogEvidence(db: Queryable, tenantId: number, graph: AgentGraphVersionV1, evaluationId: string) {
    if (this.mode !== 'provider' || !this.catalog) throw new AgentPublicationConflict('CATALOG_PUBLICATION_EVIDENCE');
    try { return await this.catalog.verify(db,tenantId,graph,evaluationId); }
    catch (error) {
      const code = catalogPublicationBlocker(error);
      if (!code) throw error;
      throw new AgentPublicationConflict(code);
    }
  }

  private async verifyEvidence(db: Queryable, tenantId: number, graph: AgentGraphVersionV1, evaluationId: string) {
    const { rows: [run] } = await db.query(`
      SELECT suite_id, execution_suite_hash, scorecard FROM agent_eval_runs
      WHERE tenant_id = $1 AND id = $2 AND agent_graph_id = $3 AND graph_version = $4
        AND execution_spec_hash = $5 AND execution_mode = $6
        AND execution_profile = 'linear-text-v1'
        AND status = 'completed' AND passed AND pass_rate_percent >= 95
        AND completed_at <= execution_deadline_at AND NOT regression_detected
        AND cardinality(security_tool_leaks) = 0
      FOR SHARE
    `, [tenantId, evaluationId, graph.graphId, graph.version, graph.specHash, this.mode]);
    if (!run) return invalidEvidence();

    const current = await loadExecutionSuite(db, tenantId, graph.graphId, run.suite_id);
    const outcomes: EvaluationScenarioEvidence[] = run.scorecard?.scenarios;
    const timeout = run.scorecard?.timeoutMs;
    if (!current || current.suiteHash !== run.execution_suite_hash ||
        !Array.isArray(outcomes) || outcomes.length !== current.suite.scenarios.length ||
        !Number.isSafeInteger(timeout) || timeout < 1) return invalidEvidence();

    const expected = current.suite.scenarios.map((scenario, index) => {
      const result = outcomes[index];
      if (!result || result.scenarioId !== scenario.id ||
          (result.outcome !== 'passed' && result.outcome !== 'assertion_failed') ||
          !Number.isSafeInteger(result.ledgerId) || result.ledgerId < 1 ||
          !Number.isSafeInteger(result.timeoutMs) || result.timeoutMs < 1 || result.timeoutMs > timeout) {
        return invalidEvidence();
      }
      const plan = preflightBoundedAgentDispatch({ tenantId, graph, input: scenario.mockInput, timeoutMs: result.timeoutMs });
      if (!plan.ok) return invalidEvidence();
      return { ...result, attemptId: executionAttemptId(evaluationId, scenario.id), requestHash: plan.requestHash };
    });
    const passRate = expected.filter(({ outcome }) => outcome === 'passed').length / expected.length * 100;
    const ledgerIds = expected.map(({ ledgerId }) => ledgerId);
    if (passRate < Math.max(95, current.suite.passThresholdPercent) || new Set(ledgerIds).size !== ledgerIds.length) {
      return invalidEvidence();
    }

    const { rows } = await db.query(`
      SELECT ledger.id, ledger.total_tokens, ledger.cost_micro_usd, reservation.id AS attempt_id, reservation.request_hash
      FROM ai_token_cost_ledger ledger
      JOIN ai_quota_reservations reservation ON reservation.tenant_id = ledger.tenant_id AND reservation.ledger_id = ledger.id
      WHERE ledger.tenant_id = $1 AND ledger.id = ANY($2::bigint[]) AND ledger.operation = 'eval'
        AND ledger.status = 'success' AND ledger.provider = $3 AND ledger.model = $4
        AND reservation.status = 'settled' AND reservation.operation = 'eval'
    `, [tenantId, ledgerIds, boundedTextCapability.provider, boundedTextCapability.model]);
    const ledger = new Map(rows.map((row) => [Number(row.id), row]));
    if (!expected.every((result) => {
      const entry = ledger.get(result.ledgerId);
      return entry && entry.attempt_id === result.attemptId && entry.request_hash === result.requestHash &&
        Number(entry.total_tokens) === result.tokens && Number(entry.cost_micro_usd) === result.costMicroUsd;
    })) return invalidEvidence();

    return current.suiteHash;
  }
}
