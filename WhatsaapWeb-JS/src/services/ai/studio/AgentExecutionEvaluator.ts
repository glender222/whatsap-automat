import {
  type AgentGraphVersionV1, type EvalScenarioV1,
} from '@whatsap-automat/contracts';
import { TenantScopedUoW } from '../../../db/TenantScopedUoW';
import { compileEvalTextPattern, SimulationInputError } from '../eval/AgentEvalService';
import { AiQuotaCapacityError } from '../gateway/AiQuotaReservationStore';
import { AiDispatchUnavailableError } from '../gateway/TenantAiDispatchPolicy';
import { type BoundedAgentDispatch, preflightBoundedAgentDispatch } from './BoundedAgentDispatch';
import { loadDraft } from './AgentStudioDrafts';
import { executionAttemptId, executionRunIdPattern, loadExecutionSuite, type ExecutionMode } from './AgentExecutionEvidence';

interface EvaluationCommand {
  tenantId: number;
  graphId: string;
  version: number;
  suiteId: string;
  runId: string;
  timeoutMs: number;
}

export interface ExecutionResult {
  scenarioId: string;
  outcome: 'passed' | 'assertion_failed' | 'uncertain' | 'blocked';
  ledgerId?: number;
  timeoutMs?: number;
  tokens?: number;
  costMicroUsd?: number;
  latencyMs?: number;
  failedAssertions?: string[];
}

interface EvaluationRow {
  id: string;
  suite_id: string;
  agent_graph_id: string;
  graph_version: number;
  execution_spec_hash: string | null;
  execution_suite_hash: string | null;
  execution_mode: ExecutionMode;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  passed: boolean;
  scorecard: { timeoutMs?: number; scenarios?: ExecutionResult[]; admittedScenarioId?: string };
}

interface Measurement {
  text: string;
  latencyMs: number;
  costMicroUsd: number;
}

type Assertion = { id: string; check: (result: Measurement) => boolean };

function scenarioChecks(scenario: EvalScenarioV1): Assertion[] {
  if (Object.keys(scenario.mockConversationState).length || scenario.expectedTools.length || scenario.forbiddenTools.length) {
    throw new SimulationInputError('The bounded text execution profile only accepts text input and text or budget assertions');
  }
  if (scenario.expectedTextPatterns.length + scenario.forbiddenTextPatterns.length + scenario.assertions.length > 16) {
    throw new SimulationInputError('A scenario may have at most 16 assertions');
  }
  const assertions = [
    ...scenario.expectedTextPatterns.map((target, index) => ({ id: 'expected-' + index, type: 'expected_text_matched', target })),
    ...scenario.forbiddenTextPatterns.map((target, index) => ({ id: 'forbidden-' + index, type: 'forbidden_text_absent', target })),
    ...scenario.assertions,
  ];
  if (!assertions.some((assertion) => assertion.type === 'expected_text_matched') ||
      new Set(assertions.map(({ id }) => id)).size !== assertions.length ||
      assertions.some(({ id }) => id.length > 128)) {
    throw new SimulationInputError('Each scenario must have unique, bounded assertions including an expected text match');
  }
  return assertions.map((assertion): Assertion => {
    const { id, type } = assertion;
    if (type === 'expected_text_matched' || type === 'forbidden_text_absent') {
      if (!assertion.target) throw new SimulationInputError('Text assertions require a pattern');
      const expression = compileEvalTextPattern(assertion.target);
      return { id, check: ({ text }) => expression.matcher(text).find() === (type === 'expected_text_matched') };
    }
    if (type !== 'max_steps' && type !== 'max_cost_micro_usd' && type !== 'max_latency_ms') {
      throw new SimulationInputError('Assertion is unsupported by the bounded text execution profile');
    }
    const limit = 'expectedValue' in assertion ? assertion.expectedValue : undefined;
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 0) {
      throw new SimulationInputError('Budget assertions require a nonnegative integer');
    }
    if (type === 'max_steps') return { id, check: () => 2 <= limit };
    if (type === 'max_cost_micro_usd') return { id, check: ({ costMicroUsd }) => costMicroUsd <= limit };
    return { id, check: ({ latencyMs }) => latencyMs <= limit };
  });
}

function summarize(row: EvaluationRow) {
  return {
    runId: row.id, suiteId: row.suite_id, graphId: row.agent_graph_id, version: row.graph_version,
    specHash: row.execution_spec_hash, suiteHash: row.execution_suite_hash,
    mode: row.execution_mode, status: row.status, passed: row.passed, scenarios: row.scorecard.scenarios ?? [],
    admittedScenarioId: row.scorecard.admittedScenarioId ?? null,
  };
}

export class AgentExecutionEvaluator {
  constructor(
    private readonly uow: TenantScopedUoW,
    private readonly dispatcher: Pick<BoundedAgentDispatch, 'dispatch'>,
    private readonly mode: ExecutionMode = 'verification',
  ) {}

  async read(tenantId: number, graphId: string, version: number, runId: string) {
    return this.observe(tenantId, graphId, version, runId, false);
  }

  async cancel(tenantId: number, graphId: string, version: number, runId: string) {
    return this.observe(tenantId, graphId, version, runId, true);
  }

  private async observe(tenantId: number, graphId: string, version: number, runId: string, cancel: boolean) {
    const identity = [tenantId, graphId, version, runId, this.mode];
    const row = await this.uow.run(tenantId, async (db) => {
      const scope = `tenant_id = $1 AND agent_graph_id = $2 AND graph_version = $3
        AND id = $4 AND execution_mode = $5 AND execution_deadline_at IS NOT NULL
        AND execution_profile = 'linear-text-v1'`;
      const { rows: [stopped] } = await db.query(`
        WITH observed AS (SELECT clock_timestamp() AS at)
        UPDATE agent_eval_runs SET status = CASE WHEN execution_deadline_at <= observed.at THEN 'failed' ELSE 'cancelled' END,
          passed = false, completed_at = observed.at
        FROM observed WHERE ${scope} AND status = 'running'
          AND ($6::boolean OR execution_deadline_at <= observed.at)
        RETURNING agent_eval_runs.*
      `, [...identity, cancel]);
      if (stopped) return stopped;
      const { rows: [existing] } = await db.query(`SELECT * FROM agent_eval_runs WHERE ${scope}`, identity);
      return existing;
    });
    return row ? summarize(row) : null;
  }

  async evaluate(command: EvaluationCommand) {
    const { tenantId, graphId, version, suiteId, runId, timeoutMs } = command;
    if (!Number.isSafeInteger(version) || version < 1 || version > 2_147_483_647 ||
        !/^[a-zA-Z0-9_-]{1,128}$/.test(graphId) || !/^[a-zA-Z0-9_-]{1,128}$/.test(suiteId) ||
        !executionRunIdPattern.test(runId) ||
        !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new SimulationInputError('An explicit revision, stored suite, run UUID and bounded timeout are required');
    }

    const claim = await this.uow.run(tenantId, async (db) => {
      const graph = await loadDraft(db, tenantId, graphId, version);
      const executionSuite = await loadExecutionSuite(db, tenantId, graphId, suiteId);
      if (!graph || !executionSuite) throw new SimulationInputError('Execution suite or revision was not found in this tenant');
      if (executionSuite.profile !== 'linear-text-v1') {
        throw new SimulationInputError('This evaluator only accepts the linear text execution profile');
      }
      const { suite, suiteHash } = executionSuite;
      const deadlineMs = Math.min(graph.limits.maxDurationSeconds * 1000, 60_000);
      let maxTokens = 0;
      let maxCost = 0;
      const scenarios = suite.scenarios.map((scenario) => {
        const plan = preflightBoundedAgentDispatch({ tenantId, graph, input: scenario.mockInput, timeoutMs });
        if (!plan.ok) throw new SimulationInputError('Execution preflight failed: ' + plan.code);
        maxTokens += plan.maxTokens;
        maxCost += plan.maxCostMicroUsd;
        return { scenario, assertions: scenarioChecks(scenario) };
      });
      if (maxTokens > graph.limits.maxModelTokens || maxCost > graph.limits.maxCostMicroUsd ||
          timeoutMs * scenarios.length > deadlineMs) {
        throw new SimulationInputError('The full suite exceeds the revision execution budget');
      }

      const { rows: [created] } = await db.query(`
        INSERT INTO agent_eval_runs (
          id, tenant_id, suite_id, agent_graph_id, graph_version, status, scorecard,
          execution_spec_hash, execution_suite_hash, execution_deadline_at, execution_mode, execution_profile
        )
        VALUES ($1, $2, $3, $4, $5, 'running', jsonb_build_object('timeoutMs', $6::integer),
          $7, $8, clock_timestamp() + $9::integer * interval '1 millisecond', $10, 'linear-text-v1')
        ON CONFLICT (id) DO NOTHING RETURNING id
      `, [runId, tenantId, suiteId, graphId, version, timeoutMs, graph.specHash, suiteHash, deadlineMs, this.mode]);
      if (created) return { kind: 'claimed' as const, graph, scenarios, threshold: Math.max(95, suite.passThresholdPercent) };

      const { rows: [existing] } = await db.query(
        'SELECT * FROM agent_eval_runs WHERE id = $1 AND tenant_id = $2', [runId, tenantId],
      );
      if (!existing || existing.suite_id !== suiteId || existing.agent_graph_id !== graphId ||
          existing.graph_version !== version || existing.execution_spec_hash !== graph.specHash ||
          existing.execution_suite_hash !== suiteHash || existing.execution_mode !== this.mode ||
          existing.execution_profile !== 'linear-text-v1' ||
          existing.scorecard.timeoutMs !== timeoutMs) {
        throw new SimulationInputError('Evaluation run UUID is already bound to a different execution');
      }
      return { kind: 'existing' as const };
    });
    if (claim.kind === 'existing') {
      const existing = await this.read(tenantId, graphId, version, runId);
      if (!existing) throw new Error('Execution evaluation disappeared after replay');
      return existing;
    }

    const results: ExecutionResult[] = [];
    for (const { scenario, assertions } of claim.scenarios) {
      const started = performance.now();
      // Admission and cancellation update the same row. A case admitted before cancellation may settle.
      const { rows: [admission] } = await this.uow.run(tenantId, (db) => db.query(`
        UPDATE agent_eval_runs SET scorecard = scorecard || jsonb_build_object('admittedScenarioId', $3::text)
        WHERE id = $1 AND tenant_id = $2 AND status = 'running'
          AND execution_deadline_at > clock_timestamp() AND NOT (scorecard ? 'admittedScenarioId')
        RETURNING FLOOR(EXTRACT(EPOCH FROM (execution_deadline_at - clock_timestamp())) * 1000)::int AS remaining_ms
      `, [runId, tenantId, scenario.id]));
      if (!admission) break;
      const remaining = Math.min(timeoutMs, admission.remaining_ms - Math.ceil(performance.now() - started));
      const result: ExecutionResult = remaining > 0
        ? await this.execute(tenantId, claim.graph, scenario, assertions, remaining, executionAttemptId(runId, scenario.id))
        : { scenarioId: scenario.id, outcome: 'blocked' };
      results.push(result);
      await this.checkpoint(tenantId, runId, claim.scenarios.length, results, scenario.id);
      if (result.outcome === 'uncertain' || result.outcome === 'blocked') break;
    }
    const executed = results.length === claim.scenarios.length &&
      results.every(({ outcome }) => outcome === 'passed' || outcome === 'assertion_failed');
    const { rows: [finished] } = await this.uow.run(tenantId, (db) => db.query(`
      WITH finished AS (SELECT clock_timestamp() AS at)
      UPDATE agent_eval_runs
      SET status = CASE WHEN $3::boolean AND execution_deadline_at >= finished.at THEN 'completed' ELSE 'failed' END,
          passed = $3::boolean AND pass_rate_percent >= $4 AND execution_deadline_at >= finished.at,
          completed_at = finished.at
      FROM finished WHERE id = $1 AND tenant_id = $2 AND status = 'running'
      RETURNING agent_eval_runs.*
    `, [runId, tenantId, executed, claim.threshold]));
    if (finished) return summarize(finished);
    const stored = await this.read(tenantId, graphId, version, runId);
    if (!stored) throw new Error('Execution evaluation disappeared before finalization');
    return stored;
  }

  private async checkpoint(tenantId: number, runId: string, total: number, results: ExecutionResult[], scenarioId: string) {
    const passRate = Math.floor(results.filter(({ outcome }) => outcome === 'passed').length /
      total * 10_000) / 100;
    const latencies = results.flatMap(({ latencyMs }) => latencyMs === undefined ? [] : [latencyMs]).sort((a, b) => a - b);
    const percentile = (fraction: number) => latencies[Math.ceil(latencies.length * fraction) - 1] ?? 0;
    const stored = await this.uow.run(tenantId, (db) => db.query(`
      UPDATE agent_eval_runs
      SET scorecard = (scorecard - 'admittedScenarioId') || jsonb_build_object('scenarios', $3::jsonb),
          pass_rate_percent = $4, total_tokens_used = $5, total_cost_micro_usd = $6,
          p50_latency_ms = $7, p95_latency_ms = $8
      WHERE id = $1 AND tenant_id = $2 AND scorecard->>'admittedScenarioId' = $9
    `, [runId, tenantId, JSON.stringify(results), passRate,
      results.reduce((sum, result) => sum + (result.tokens ?? 0), 0),
      results.reduce((sum, result) => sum + (result.costMicroUsd ?? 0), 0),
      percentile(0.5), percentile(0.95), scenarioId]));
    if (stored.rowCount !== 1) throw new Error('Execution evaluation lost the admitted scenario');
  }

  private async execute(
    tenantId: number, graph: AgentGraphVersionV1, scenario: EvalScenarioV1, assertions: Assertion[], timeoutMs: number, attemptId: string,
  ): Promise<ExecutionResult> {
    const scenarioId = scenario.id;
    const started = performance.now();
    try {
      const result = await this.dispatcher.dispatch({
        tenantId, graph, input: scenario.mockInput, attemptId, timeoutMs,
      });
      if (result.status !== 'completed') {
        return { scenarioId, outcome: result.status === 'uncertain' ? 'uncertain' : 'blocked',
          ...('ledgerId' in result ? { ledgerId: result.ledgerId } : {}) };
      }
      const latencyMs = Math.ceil(performance.now() - started);
      const tokens = result.usage.promptTokens + result.usage.completionTokens;
      if (result.output.finishReason !== 'stop') {
        return { scenarioId, outcome: 'blocked', ledgerId: result.ledgerId, tokens,
          costMicroUsd: result.costMicroUsd, latencyMs };
      }
      const failedAssertions = assertions.filter(({ check }) => !check({
        text: result.output.text, latencyMs, costMicroUsd: result.costMicroUsd,
      })).map(({ id }) => id);
      return {
        scenarioId, outcome: failedAssertions.length ? 'assertion_failed' : 'passed', ledgerId: result.ledgerId,
        tokens, costMicroUsd: result.costMicroUsd, timeoutMs,
        latencyMs, failedAssertions,
      };
    } catch (error) {
      const blocked = error instanceof AiQuotaCapacityError || error instanceof AiDispatchUnavailableError;
      return { scenarioId, outcome: blocked ? 'blocked' : 'uncertain' };
    }
  }
}
