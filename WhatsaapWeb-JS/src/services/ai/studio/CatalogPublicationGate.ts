import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { AgentGraphVersionV1, EvalScenarioV1 } from '@whatsap-automat/contracts';
import type { Queryable } from '../../../shared/UnitOfWorkPort';
import type { TenantScopedUoW } from '../../../db/TenantScopedUoW';
import { boundedTextCapability } from '../gateway/BoundedTextCompletion';
import { loadExecutionSuite } from './AgentExecutionEvidence';
import { CatalogEvaluationEvidence, catalogEvaluationScenarioRunId } from './CatalogEvaluationEvidence';
import { catalogEvaluationEvidenceVersion, catalogPublicationEvidenceVersion, catalogReadAdapterVersion } from './CatalogEvidenceVersions';
import { catalogReadTimeoutMs, compileCatalogRouterExecutionProfile } from './CatalogRouterExecutionProfile';
import { measuredCatalogScenario, type ScenarioResult } from './CatalogScenarioResult';
import { SimulationInputError } from '../eval/AgentEvalService';

export class CatalogPublicationRejected extends Error {
  constructor(readonly code: 'CATALOG_PUBLICATION_EVIDENCE' | 'CATALOG_PUBLICATION_VERSION' | 'CATALOG_PUBLICATION_COVERAGE') {
    super(code);
  }
}

export function catalogPublicationBlocker(error: unknown): string | null {
  if (error instanceof CatalogPublicationRejected) return error.code;
  if (error instanceof SimulationInputError) return 'CATALOG_PUBLICATION_EVIDENCE';
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
  if (code === 'CATALOG_EVIDENCE_INCOMPLETE') return 'CATALOG_PUBLICATION_EVIDENCE';
  if (typeof code === 'string' && /^(CATALOG_|AI_ADMISSION_)/.test(code)) return 'CATALOG_PUBLICATION_AUTHORIZATION';
  return null;
}

/** JSONB changes object key order. Hash a deterministic projection, never raw DB rows or model text. */
export function catalogManifestHash(value: unknown): string {
  const canonical = (input: unknown): string => {
    if (Array.isArray(input)) return '[' + input.map(canonical).join(',') + ']';
    if (input !== null && typeof input === 'object') return '{' + Object.entries(input)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
    return JSON.stringify(input);
  };
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function reject(): never { throw new CatalogPublicationRejected('CATALOG_PUBLICATION_EVIDENCE'); }
function toolAssertion(scenario: EvalScenarioV1, expected: boolean) {
  return (expected ? scenario.expectedTools : scenario.forbiddenTools).includes('catalog.search') ||
    scenario.assertions.some(({ type, target }) => target === 'catalog.search' &&
      type === (expected ? 'expected_tool_called' : 'forbidden_tool_not_called'));
}

/** Must run in the publication transaction. All authorization locks survive until the immutable receipt commits. */
export class CatalogPublicationGate {
  private readonly evidence;
  constructor(uow: TenantScopedUoW) { this.evidence = new CatalogEvaluationEvidence(uow); }

  async verify(db: Queryable, tenantId: number, graph: AgentGraphVersionV1, evaluationId: string) {
    const compiled = compileCatalogRouterExecutionProfile(graph);
    if (!compiled.compatible) return reject();
    const { plan } = compiled;
    // Match runtime lock order: child checkpoint -> authorization -> evaluation row.
    // In particular do not lock the parent evaluation or quota reservations before child checkpoints.
    const { rows: [run] } = await db.query(`SELECT * FROM agent_eval_runs
      WHERE tenant_id=$1 AND id=$2 AND agent_graph_id=$3 AND graph_version=$4
        AND execution_spec_hash=$5 AND execution_mode='provider' AND execution_profile='catalog-router-v1'
        AND status='completed' AND passed AND pass_rate_percent>=95 AND NOT regression_detected
        AND cardinality(security_tool_leaks)=0 AND completed_at<=execution_deadline_at`,
    [tenantId,evaluationId,graph.graphId,graph.version,graph.specHash]);
    if (!run) return reject();
    if (run.execution_evidence_version !== catalogEvaluationEvidenceVersion) {
      throw new CatalogPublicationRejected('CATALOG_PUBLICATION_VERSION');
    }
    const current = await loadExecutionSuite(db, tenantId, graph.graphId, run.suite_id);
    if (!current || current.profile !== plan.profile || current.suiteHash !== run.execution_suite_hash) return reject();
    const { scenarios } = current.suite;
    const timeoutMs = run.scorecard?.timeoutMs;
    if (!scenarios.length || !Number.isSafeInteger(timeoutMs) || timeoutMs > boundedTextCapability.maxTimeoutMs ||
        timeoutMs < plan.router.timeoutMs + plan.answer.timeoutMs + catalogReadTimeoutMs ||
        timeoutMs * scenarios.length > plan.limits.maxDurationSeconds * 1000 ||
        plan.maxTokens * scenarios.length > plan.limits.maxModelTokens ||
        plan.maxCostMicroUsd * scenarios.length > plan.limits.maxCostMicroUsd ||
        run.scorecard.admittedScenarioId || run.scorecard.admittedDeadlineAt || run.scorecard.failureCode) return reject();

    const measured: ScenarioResult[] = [];
    const manifests = [];
    const authorizations = new Set<string>();
    for (const scenario of scenarios) {
      const command = { tenantId, runId: catalogEvaluationScenarioRunId(tenantId,evaluationId,scenario.id),
        graphId: graph.graphId, version: graph.version, specHash: graph.specHash, input: scenario.mockInput };
      const proof = await this.evidence.verify(db, command, plan);
      const finishedAt = proof.run.created_at.getTime() + proof.latencyMs;
      if (proof.run.created_at < run.created_at || finishedAt > run.execution_deadline_at.getTime() ||
          finishedAt > run.completed_at.getTime() + 1 || proof.latencyMs > timeoutMs) return reject();
      const result = measuredCatalogScenario(scenario,command.runId,proof);
      const forbidden = [...scenario.forbiddenTools, ...scenario.assertions
        .filter(({ type }) => type === 'forbidden_tool_not_called').map(({ target }) => target)];
      if (proof.tools.some((name) => forbidden.includes(name))) return reject();
      measured.push(result);
      authorizations.add(proof.run.authorization_hash);
      // Explicit allowlist: no input, prompt, result text, ciphertext, or catalog product data in the receipt.
      manifests.push({ scenarioId: scenario.id, runtimeRunId: command.runId, inputHash: proof.run.input_hash,
        assertionHash: catalogManifestHash({ expectedTools: scenario.expectedTools, forbiddenTools: scenario.forbiddenTools,
          expectedTextPatterns: scenario.expectedTextPatterns, forbiddenTextPatterns: scenario.forbiddenTextPatterns,
          assertions: scenario.assertions }),
        outcome: result.outcome, failedAssertions: result.failedAssertions!, executedTools: proof.tools,
        rounds: proof.rounds, ...(proof.tool ? { tool: proof.tool } : {}), tokens: proof.tokens,
        costMicroUsd: proof.costMicroUsd, latencyMs: proof.latencyMs });
    }
    const { rows: [locked] } = await db.query('SELECT * FROM agent_eval_runs WHERE tenant_id=$1 AND id=$2 FOR SHARE', [tenantId,evaluationId]);
    if (!isDeepStrictEqual(run,locked) || !isDeepStrictEqual(measured,run.scorecard.scenarios) || authorizations.size !== 1) return reject();
    const ledgerIds = measured.flatMap(({ ledgerIds }) => ledgerIds);
    const passed = measured.filter(({ outcome }) => outcome === 'passed').length;
    const percent = Math.floor(passed / scenarios.length * 10000) / 100;
    const tokens = measured.reduce((sum,result) => sum + result.tokens,0);
    const costMicroUsd = measured.reduce((sum,result) => sum + result.costMicroUsd,0);
    const latencies = measured.map(({ latencyMs }) => latencyMs!).sort((a,b) => a-b);
    const percentile = (n: number) => latencies[Math.ceil(latencies.length*n)-1];
    if (new Set(ledgerIds).size !== scenarios.length * 2 || ledgerIds.length !== scenarios.length * 2 ||
        percent < Math.max(95,current.suite.passThresholdPercent) || Number(run.pass_rate_percent) !== percent ||
        Number(run.total_tokens_used) !== tokens || Number(run.total_cost_micro_usd) !== costMicroUsd ||
        Number(run.p50_latency_ms) !== percentile(.5) || Number(run.p95_latency_ms) !== percentile(.95)) return reject();
    const covered = (expected: boolean) => scenarios.some((scenario,index) => measured[index].outcome === 'passed' &&
      toolAssertion(scenario,expected) && (expected ? measured[index].executedTools?.includes('catalog.search') :
        measured[index].executedTools?.length === 0));
    if (!covered(true) || !covered(false)) throw new CatalogPublicationRejected('CATALOG_PUBLICATION_COVERAGE');
    const authorizationHash = [...authorizations][0];
    const manifest = { evidenceVersion: catalogPublicationEvidenceVersion, evaluationEvidenceVersion: catalogEvaluationEvidenceVersion,
      profile: plan.profile, capabilityId: boundedTextCapability.id, provider: boundedTextCapability.provider,
      model: boundedTextCapability.model, toolAdapterVersion: catalogReadAdapterVersion, toolSchemaVersion: 1,
      tenantId, graphId: graph.graphId, version: graph.version, specHash: graph.specHash,
      evaluationId, suiteId: run.suite_id as string, suiteHash: current.suiteHash, authorizationHash,
      limits: plan.limits, timeoutMs: timeoutMs as number, tokens, costMicroUsd, scenarios: manifests };
    return { manifest, evidenceHash: catalogManifestHash(manifest), suiteHash: current.suiteHash, authorizationHash };
  }
}
