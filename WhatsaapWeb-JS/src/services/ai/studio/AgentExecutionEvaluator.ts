import { createHash, randomUUID } from 'node:crypto';
import {
  evalSuiteV1Schema, type AgentGraphVersionV1, type EvalScenarioV1,
} from '@whatsap-automat/contracts';
import { TenantScopedUoW } from '../../../db/TenantScopedUoW';
import { compileEvalTextPattern, SimulationInputError } from '../eval/AgentEvalService';
import { AiQuotaCapacityError } from '../gateway/AiQuotaReservationStore';
import { type BoundedAgentDispatch, preflightBoundedAgentDispatch } from './BoundedAgentDispatch';
import { loadDraft } from './AgentStudioDrafts';

interface EvaluationCommand {
  tenantId: number;
  graphId: string;
  version: number;
  suiteId: string;
  runId: string;
  timeoutMs: number;
}

interface ExecutionResult {
  scenarioId: string;
  outcome: 'passed' | 'assertion_failed' | 'uncertain' | 'blocked';
  ledgerId?: number;
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
  execution_deadline_at: Date | null;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  passed: boolean;
  scorecard: { timeoutMs?: number; scenarios?: ExecutionResult[] };
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
    status: row.status, passed: row.passed, scenarios: row.scorecard.scenarios ?? [],
  };
}

export class AgentExecutionEvaluator {
  constructor(
    private readonly uow: TenantScopedUoW,
    private readonly dispatcher: Pick<BoundedAgentDispatch, 'dispatch'>,
  ) {}

  async evaluate(command: EvaluationCommand) {
    const { tenantId, graphId, version, suiteId, runId, timeoutMs } = command;
    if (!Number.isSafeInteger(version) || version < 1 || version > 2_147_483_647 ||
        !/^[a-zA-Z0-9_-]{1,128}$/.test(graphId) || !/^[a-zA-Z0-9_-]{1,128}$/.test(suiteId) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(runId) ||
        !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new SimulationInputError('An explicit revision, stored suite, run UUID and bounded timeout are required');
    }

    const claim = await this.uow.run(tenantId, async (db) => {
      const graph = await loadDraft(db, tenantId, graphId, version);
      const { rows: [source] } = await db.query(`
        SELECT name, scenarios, pass_threshold_percent FROM agent_eval_suites
        WHERE tenant_id = $1 AND agent_graph_id = $2 AND id = $3
      `, [tenantId, graphId, suiteId]);
      if (!graph || !source) throw new SimulationInputError('Execution suite or revision was not found in this tenant');
      if (!Array.isArray(source.scenarios) || source.scenarios.length > 20) {
        throw new SimulationInputError('The stored suite contains invalid scenarios');
      }
      const parsed = evalSuiteV1Schema.safeParse({
        id: suiteId, tenantId, agentGraphId: graphId, name: source.name, scenarios: source.scenarios,
        passThresholdPercent: Number(source.pass_threshold_percent),
      });
      if (!parsed.success ||
          new Set(parsed.data.scenarios.map(({ id }) => id)).size !== parsed.data.scenarios.length ||
          parsed.data.scenarios.some(({ id }) => id.length > 128)) {
        throw new SimulationInputError('The stored suite contains invalid scenarios');
      }
      const suite = parsed.data;
      const suiteHash = createHash('sha256').update(JSON.stringify(suite)).digest('hex');
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
          execution_spec_hash, execution_suite_hash, execution_deadline_at
        )
        VALUES ($1, $2, $3, $4, $5, 'running', jsonb_build_object('timeoutMs', $6::integer),
          $7, $8, clock_timestamp() + $9::integer * interval '1 millisecond')
        ON CONFLICT (id) DO NOTHING RETURNING *
      `, [runId, tenantId, suiteId, graphId, version, timeoutMs, graph.specHash, suiteHash, deadlineMs]);
      if (created) return { kind: 'claimed' as const, created: created as EvaluationRow, graph, scenarios, threshold: Math.max(95, suite.passThresholdPercent) };

      const { rows: [existing] } = await db.query(
        'SELECT * FROM agent_eval_runs WHERE id = $1 AND tenant_id = $2', [runId, tenantId],
      );
      if (!existing || existing.suite_id !== suiteId || existing.agent_graph_id !== graphId ||
          existing.graph_version !== version || existing.execution_spec_hash !== graph.specHash ||
          existing.execution_suite_hash !== suiteHash || existing.scorecard.timeoutMs !== timeoutMs) {
        throw new SimulationInputError('Evaluation run UUID is already bound to a different execution');
      }
      const { rows: [expired] } = await db.query(`
        UPDATE agent_eval_runs SET status = 'failed', completed_at = clock_timestamp()
        WHERE id = $1 AND tenant_id = $2 AND status = 'running' AND execution_deadline_at < clock_timestamp()
        RETURNING *
      `, [runId, tenantId]);
      return { kind: 'existing' as const, existing: (expired ?? existing) as EvaluationRow };
    });
    if (claim.kind === 'existing') return summarize(claim.existing);

    const results: ExecutionResult[] = [];
    const deadline = claim.created.execution_deadline_at!.getTime();
    for (const { scenario, assertions } of claim.scenarios) {
      const remaining = Math.min(timeoutMs, deadline - Date.now());
      if (remaining <= 0) break;
      const result = await this.execute(tenantId, claim.graph, scenario, assertions, remaining);
      results.push(result);
      if (result.outcome === 'uncertain' || result.outcome === 'blocked') break;
    }
    const executed = results.length === claim.scenarios.length &&
      results.every(({ outcome }) => outcome === 'passed' || outcome === 'assertion_failed');
    const passRate = Math.floor(results.filter(({ outcome }) => outcome === 'passed').length /
      claim.scenarios.length * 10_000) / 100;
    const latencies = results.flatMap(({ latencyMs }) => latencyMs === undefined ? [] : [latencyMs]).sort((a, b) => a - b);
    const percentile = (fraction: number) => latencies[Math.ceil(latencies.length * fraction) - 1] ?? 0;
    const { rows: [finished] } = await this.uow.run(tenantId, (db) => db.query(`
      UPDATE agent_eval_runs
      SET status = CASE WHEN $3::boolean AND execution_deadline_at >= statement_timestamp() THEN 'completed' ELSE 'failed' END,
          passed = $3::boolean AND $4::boolean AND execution_deadline_at >= statement_timestamp(),
          scorecard = $5, pass_rate_percent = $6, total_tokens_used = $7, total_cost_micro_usd = $8,
          p50_latency_ms = $9, p95_latency_ms = $10, completed_at = clock_timestamp()
      WHERE id = $1 AND tenant_id = $2 AND status = 'running'
      RETURNING *
    `, [runId, tenantId, executed, passRate >= claim.threshold, JSON.stringify({ timeoutMs, scenarios: results }), passRate,
      results.reduce((sum, result) => sum + (result.tokens ?? 0), 0),
      results.reduce((sum, result) => sum + (result.costMicroUsd ?? 0), 0),
      percentile(0.5), percentile(0.95)]));
    if (finished) return summarize(finished);
    const { rows: [stored] } = await this.uow.run(tenantId, (db) => db.query(
      'SELECT * FROM agent_eval_runs WHERE id = $1 AND tenant_id = $2', [runId, tenantId],
    ));
    if (!stored) throw new Error('Execution evaluation disappeared before finalization');
    return summarize(stored);
  }

  private async execute(
    tenantId: number, graph: AgentGraphVersionV1, scenario: EvalScenarioV1, assertions: Assertion[], timeoutMs: number,
  ): Promise<ExecutionResult> {
    const scenarioId = scenario.id;
    const started = performance.now();
    try {
      const result = await this.dispatcher.dispatch({
        tenantId, graph, input: scenario.mockInput, attemptId: randomUUID(), timeoutMs,
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
        tokens, costMicroUsd: result.costMicroUsd,
        latencyMs, failedAssertions,
      };
    } catch (error) {
      return { scenarioId, outcome: error instanceof AiQuotaCapacityError ? 'blocked' : 'uncertain' };
    }
  }
}
