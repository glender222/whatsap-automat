import { isDeepStrictEqual } from 'node:util';
import { catalogEvaluationEvidenceVersion } from './CatalogEvidenceVersions';
import { measuredCatalogScenario, type ScenarioResult } from './CatalogScenarioResult';
import type { EvalScenarioV1 } from '@whatsap-automat/contracts';
import { TenantScopedUoW } from '../../../db/TenantScopedUoW';
import type { Queryable } from '../../../shared/UnitOfWorkPort';
import { SimulationInputError } from '../eval/AgentEvalService';
import { CatalogRouterCheckpointRuntime, type CatalogRouterCheckpointCommand } from '../runtime/CatalogRouterCheckpointRuntime';
import { CatalogRouterCheckpointStore } from '../runtime/CatalogRouterCheckpointStore';
import { loadDraft } from './AgentStudioDrafts';
import { executionRunIdPattern, loadExecutionSuite, type ExecutionMode } from './AgentExecutionEvidence';
import { compileCatalogRouterExecutionProfile, catalogReadTimeoutMs, type CatalogRouterExecutionPlan } from './CatalogRouterExecutionProfile';
import { catalogScenarioChecks } from './CatalogEvaluationAssertions';
import { CatalogEvaluationEvidence, CatalogEvidenceIncomplete, catalogEvaluationScenarioRunId } from './CatalogEvaluationEvidence';

export type { ScenarioResult } from './CatalogScenarioResult';

interface EvaluationCommand { tenantId: number; graphId: string; version: number; suiteId: string; runId: string; timeoutMs: number }
interface EvaluationRow {
  id: string; suite_id: string; agent_graph_id: string; graph_version: number; execution_spec_hash: string;
  execution_evidence_version: string | null; execution_suite_hash: string; execution_mode: ExecutionMode; status: 'running' | 'completed' | 'failed' | 'cancelled';
  passed: boolean; total_tokens_used: number; total_cost_micro_usd: string;
  scorecard: { timeoutMs: number; scenarios?: ScenarioResult[]; admittedScenarioId?: string; admittedDeadlineAt?: string; failureCode?: string };
}
function summary(row: EvaluationRow) {
  return { runId: row.id, suiteId: row.suite_id, graphId: row.agent_graph_id, version: row.graph_version,
    specHash: row.execution_spec_hash, suiteHash: row.execution_suite_hash, mode: row.execution_mode,
    profile: 'catalog-router-v1' as const, evidenceVersion: row.execution_evidence_version, publicationEvidence: false, publicationAllowed: false,
    publicationBlocker: 'CATALOG_PUBLICATION_EVIDENCE' as string | null,
    status: row.status, passed: row.passed, scenarios: row.scorecard.scenarios ?? [],
    admittedScenarioId: row.scorecard.admittedScenarioId ?? null, totalTokensUsed: row.total_tokens_used,
    totalCostMicroUsd: Number(row.total_cost_micro_usd),
    ...(row.scorecard.failureCode ? { failureCode: row.scorecard.failureCode } : {}) };
}
function isEvidenceDenial(error: unknown): boolean {
  return error instanceof CatalogEvidenceIncomplete || typeof error === 'object' && error !== null && 'code' in error &&
    typeof error.code === 'string' && /^(CATALOG_|AI_ADMISSION_)/.test(error.code);
}

/** Normal Studio evaluation flow only. It returns scorecards, never model text or delivery authority. */
export class CatalogExecutionEvaluator {
  private readonly evidence;
  private readonly checkpoints;
  constructor(private readonly uow: TenantScopedUoW, private readonly runtime: Pick<CatalogRouterCheckpointRuntime, 'execute'>,
    private readonly mode: ExecutionMode = 'provider') {
    this.evidence = new CatalogEvaluationEvidence(uow);
    this.checkpoints = new CatalogRouterCheckpointStore(uow);
  }

  read(tenantId: number, graphId: string, version: number, runId: string) { return this.observe(tenantId, graphId, version, runId, false); }
  cancel(tenantId: number, graphId: string, version: number, runId: string) { return this.observe(tenantId, graphId, version, runId, true); }

  private async observe(tenantId: number, graphId: string, version: number, runId: string, cancel: boolean) {
    await this.checkpoints.eraseExpired(tenantId);
    const row = await this.transaction(tenantId, async (db) => {
      const scope = `tenant_id=$1 AND agent_graph_id=$2 AND graph_version=$3 AND id=$4 AND execution_mode=$5
        AND execution_profile='catalog-router-v1' AND execution_deadline_at IS NOT NULL`;
      const identity = [tenantId, graphId, version, runId, this.mode];
      const { rows: [changed] } = await db.query(`UPDATE agent_eval_runs
        SET status=CASE WHEN execution_deadline_at<=clock_timestamp() THEN 'failed' ELSE 'cancelled' END,
          passed=false,completed_at=clock_timestamp()
        WHERE ${scope} AND status='running' AND ($6::boolean OR execution_deadline_at<=clock_timestamp()) RETURNING *`, [...identity, cancel]);
      if (changed) return changed;
      return (await db.query(`SELECT * FROM agent_eval_runs WHERE ${scope}`, identity)).rows[0];
    });
    return row ? summary(row) : null;
  }

  async evaluate(command: EvaluationCommand) {
    const { tenantId, graphId, version, suiteId, runId, timeoutMs } = command;
    if (this.mode !== 'provider' || !Number.isSafeInteger(version) || version < 1 || version > 2_147_483_647 ||
        !/^[a-zA-Z0-9_-]{1,128}$/.test(graphId) || !/^[a-zA-Z0-9_-]{1,128}$/.test(suiteId) ||
        !executionRunIdPattern.test(runId) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) {
      throw new SimulationInputError('Catalog evaluations require a provider profile, explicit revision, suite and run UUID');
    }
    await this.checkpoints.eraseExpired(tenantId);
    const admission = await this.transaction(tenantId, async (db) => {
      const graph = await loadDraft(db, tenantId, graphId, version);
      const source = await loadExecutionSuite(db, tenantId, graphId, suiteId);
      if (!graph || !source || source.profile !== 'catalog-router-v1') throw new SimulationInputError('The catalog suite and revision must belong to this company');
      const compiled = compileCatalogRouterExecutionProfile(graph);
      if (!compiled.compatible) throw new SimulationInputError('The revision is incompatible with the catalog execution profile');
      const { plan } = compiled;
      for (const scenario of source.suite.scenarios) catalogScenarioChecks(scenario);
      if (timeoutMs < plan.router.timeoutMs + plan.answer.timeoutMs + catalogReadTimeoutMs ||
          timeoutMs * source.suite.scenarios.length > plan.limits.maxDurationSeconds * 1000 ||
          plan.maxTokens * source.suite.scenarios.length > plan.limits.maxModelTokens ||
          plan.maxCostMicroUsd * source.suite.scenarios.length > plan.limits.maxCostMicroUsd) {
        throw new SimulationInputError('The full catalog suite must fit both model budgets and the declared scenario timeouts');
      }
      await db.query(`INSERT INTO agent_eval_runs(id,tenant_id,suite_id,agent_graph_id,graph_version,status,scorecard,
          execution_spec_hash,execution_suite_hash,execution_deadline_at,execution_mode,execution_profile,execution_evidence_version)
        VALUES($1,$2,$3,$4,$5,'running',jsonb_build_object('timeoutMs',$6::integer),$7,$8,
          clock_timestamp()+$9::integer*interval '1 second',$10,'catalog-router-v1',$11) ON CONFLICT(id) DO NOTHING`,
      [runId,tenantId,suiteId,graphId,version,timeoutMs,graph.specHash,source.suiteHash,plan.limits.maxDurationSeconds,this.mode,catalogEvaluationEvidenceVersion]);
      const { rows: [row] } = await db.query('SELECT * FROM agent_eval_runs WHERE tenant_id=$1 AND id=$2', [tenantId,runId]);
      if (!row || row.execution_profile !== 'catalog-router-v1' || row.execution_mode !== this.mode || row.suite_id !== suiteId ||
          row.agent_graph_id !== graphId || row.graph_version !== version || row.execution_spec_hash !== graph.specHash ||
          row.execution_suite_hash !== source.suiteHash || row.scorecard.timeoutMs !== timeoutMs) {
        throw new SimulationInputError('The evaluation UUID is bound to another execution');
      }
      return { plan, scenarios: source.suite.scenarios, threshold: Math.max(95, source.suite.passThresholdPercent) };
    });

    for (const scenario of admission.scenarios) {
      const active = await this.read(tenantId, graphId, version, runId);
      if (!active || active.status !== 'running') return active!;
      if (active.scenarios.some((result) => result.scenarioId === scenario.id)) continue;
      const admitted = await this.admit(command, scenario.id);
      if (!admitted) return (await this.read(tenantId, graphId, version, runId))!;
      const runtimeCommand = this.runtimeCommand(command, admission.plan, scenario);
      const guard = async (db: Queryable) => {
        const { rowCount } = await db.query(`SELECT id FROM agent_eval_runs WHERE tenant_id=$1 AND id=$2
          AND execution_profile='catalog-router-v1' AND status='running' AND execution_deadline_at>clock_timestamp()
          AND scorecard->>'admittedScenarioId'=$3 AND (scorecard->>'admittedDeadlineAt')::timestamptz>clock_timestamp() FOR SHARE`,
        [tenantId,runId,scenario.id]);
        if (!rowCount) throw Object.assign(new Error('Catalog evaluation is no longer admitted'), { code: 'CHECKPOINT_EVALUATION_STOPPED' });
      };
      const result = await this.runtime.execute(runtimeCommand, guard);
      if (result.status === 'in_progress') return (await this.read(tenantId, graphId, version, runId))!;
      const saved = await this.checkpoint(command, admission.plan, scenario, admission.scenarios.length, runtimeCommand,
        result.status === 'completed' ? 'completed' : result.status === 'uncertain' ? 'uncertain' : 'blocked');
      if (saved.status !== 'running' || saved.scenarios.some((item) => item.outcome === 'blocked' || item.outcome === 'uncertain')) return saved;
    }
    return this.finish(command, admission.plan, admission.scenarios, admission.threshold);
  }

  private transaction<T>(tenantId: number, work: (db: Queryable) => Promise<T>): Promise<T> {
    return this.uow.run(tenantId, async (db) => {
      await db.query("SET LOCAL statement_timeout='1000ms'");
      await db.query("SET LOCAL lock_timeout='1000ms'");
      return work(db);
    });
  }

  private runtimeCommand(command: EvaluationCommand, plan: CatalogRouterExecutionPlan, scenario: EvalScenarioV1): CatalogRouterCheckpointCommand {
    return { tenantId: command.tenantId, runId: catalogEvaluationScenarioRunId(command.tenantId, command.runId, scenario.id),
      graphId: plan.graphId, version: plan.version, specHash: plan.specHash, input: scenario.mockInput };
  }

  private async admit(command: EvaluationCommand, scenarioId: string) {
    return this.transaction(command.tenantId, async (db) => {
      const { rows: [row] } = await db.query(`SELECT * FROM agent_eval_runs WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [command.tenantId,command.runId]);
      if (row.status !== 'running' || row.scorecard.scenarios?.some((entry: ScenarioResult) => entry.scenarioId === scenarioId)) return false;
      if (row.scorecard.admittedScenarioId) return row.scorecard.admittedScenarioId === scenarioId;
      return (await db.query(`UPDATE agent_eval_runs SET scorecard=scorecard||jsonb_build_object(
        'admittedScenarioId',$3::text,'admittedDeadlineAt',LEAST(execution_deadline_at,clock_timestamp()+$4::integer*interval '1 millisecond'))
        WHERE tenant_id=$1 AND id=$2 AND status='running' AND execution_deadline_at>clock_timestamp() RETURNING id`,
      [command.tenantId,command.runId,scenarioId,command.timeoutMs])).rowCount === 1;
    });
  }

  private async checkpoint(command: EvaluationCommand, plan: CatalogRouterExecutionPlan, scenario: EvalScenarioV1, total: number,
    runtimeCommand: CatalogRouterCheckpointCommand, status: 'completed' | 'blocked' | 'uncertain') {
    return this.transaction(command.tenantId, async (db) => {
      // Lock order matches runtime: child checkpoint first, then the evaluation admission row.
      const partial = await this.evidence.inspect(db, runtimeCommand);
      let result: ScenarioResult = { scenarioId: scenario.id, runtimeRunId: runtimeCommand.runId,
        outcome: status === 'uncertain' ? 'uncertain' : 'blocked', ledgerIds: partial.ledgerIds,
        tokens: partial.tokens, costMicroUsd: partial.costMicroUsd };
      if (status === 'completed') {
        try { result = measuredCatalogScenario(scenario, runtimeCommand.runId, await this.evidence.verify(db, runtimeCommand, plan)); }
        catch (error) { if (!isEvidenceDenial(error)) throw error; }
      }
      const { rows: [row] } = await db.query('SELECT * FROM agent_eval_runs WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [command.tenantId,command.runId]);
      if (row.scorecard.scenarios?.some((entry: ScenarioResult) => entry.scenarioId === scenario.id)) return summary(row);
      if (row.scorecard.admittedScenarioId !== scenario.id) throw new CatalogEvidenceIncomplete();
      if (row.status !== 'running') result.outcome = 'blocked';
      const results: ScenarioResult[] = [...(row.scorecard.scenarios ?? []), result];
      const latencies = results.map((value) => value.latencyMs ?? 0).sort((a,b) => a-b);
      const percentile = (value: number) => latencies[Math.ceil(latencies.length*value)-1] ?? 0;
      const failed = result.outcome === 'blocked' || result.outcome === 'uncertain';
      const { rows: [saved] } = await db.query(`UPDATE agent_eval_runs SET
          scorecard=(scorecard-'admittedScenarioId'-'admittedDeadlineAt')||jsonb_build_object('scenarios',$3::jsonb),
          pass_rate_percent=$4,total_tokens_used=$5,total_cost_micro_usd=$6,p50_latency_ms=$7,p95_latency_ms=$8,
          status=CASE WHEN status='running' AND $9 THEN 'failed' ELSE status END,
          completed_at=CASE WHEN status='running' AND $9 THEN clock_timestamp() ELSE completed_at END
        WHERE tenant_id=$1 AND id=$2 RETURNING *`, [command.tenantId,command.runId,JSON.stringify(results),
        Math.floor(results.filter((value) => value.outcome === 'passed').length/total*10000)/100,
        results.reduce((sum,value) => sum+value.tokens,0),results.reduce((sum,value) => sum+value.costMicroUsd,0),
        percentile(.5),percentile(.95),failed]);
      return summary(saved);
    });
  }

  private async finish(command: EvaluationCommand, plan: CatalogRouterExecutionPlan, scenarios: EvalScenarioV1[], threshold: number) {
    return this.transaction(command.tenantId, async (db) => {
      let valid = true;
      const results: ScenarioResult[] = [];
      try {
        for (const scenario of scenarios) {
          const input = this.runtimeCommand(command, plan, scenario);
          results.push(measuredCatalogScenario(scenario,input.runId,await this.evidence.verify(db,input,plan)));
        }
      } catch (error) { if (!isEvidenceDenial(error)) throw error; valid = false; }
      const { rows: [row] } = await db.query('SELECT * FROM agent_eval_runs WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [command.tenantId,command.runId]);
      if (row.status !== 'running') return summary(row);
      valid = valid && isDeepStrictEqual(results, row.scorecard.scenarios) && !row.scorecard.admittedScenarioId;
      const leaks = scenarios.flatMap((scenario,index) => {
        const forbidden = [...scenario.forbiddenTools, ...scenario.assertions.filter((item) => item.type === 'forbidden_tool_not_called').map((item) => item.target!)];
        return (results[index]?.executedTools ?? []).filter((name) => forbidden.includes(name));
      });
      const { rows: [saved] } = await db.query(`UPDATE agent_eval_runs SET
        status=CASE WHEN $3 AND execution_deadline_at>clock_timestamp() THEN 'completed' ELSE 'failed' END,
        passed=$3 AND pass_rate_percent>=$4 AND execution_deadline_at>clock_timestamp() AND cardinality($5::text[])=0,
        security_tool_leaks=$5,completed_at=clock_timestamp(),
        scorecard=CASE WHEN $3 THEN scorecard ELSE scorecard||'{"failureCode":"CATALOG_EVIDENCE_INCOMPLETE"}'::jsonb END
        WHERE tenant_id=$1 AND id=$2 RETURNING *`, [command.tenantId,command.runId,valid,threshold,[...new Set(leaks)]]);
      return summary(saved);
    });
  }
}
