import { createHash } from 'node:crypto';
import { evalSuiteV1Schema, type EvalScenarioV1 } from '@whatsap-automat/contracts';
import type { Queryable } from '../../../shared/UnitOfWorkPort';
import { compileEvalTextPattern, SimulationInputError } from '../eval/AgentEvalService';

export type ExecutionMode = 'verification' | 'provider';
export type ExecutionProfile = 'linear-text-v1' | 'catalog-router-v1';
export const executionRunIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export async function listExecutionSuites(db: Queryable, tenantId: number, graphId: string, profile: ExecutionProfile) {
  const { rows } = await db.query(`
    SELECT id, name, execution_profile, jsonb_array_length(scenarios) AS count FROM agent_eval_suites
    WHERE tenant_id = $1 AND agent_graph_id = $2 AND execution_profile = $3 AND jsonb_typeof(scenarios) = 'array'
    ORDER BY created_at DESC, id DESC LIMIT 20
  `, [tenantId, graphId, profile]);
  return rows.map(({ id, name, count, execution_profile }) => ({ id, name, scenarioCount: count,
    ...(execution_profile === 'catalog-router-v1' ? { profile: execution_profile as ExecutionProfile } : {}) }));
}

export async function saveExecutionSuite(db: Queryable, command: {
  tenantId: number; graphId: string; id: string; name: string; scenarios: EvalScenarioV1[]; profile?: ExecutionProfile;
}) {
  const { tenantId, graphId, id, name, scenarios, profile = 'linear-text-v1' } = command;
  for (const scenario of scenarios) {
    const patterns = profile === 'catalog-router-v1'
      ? [...scenario.expectedTextPatterns, ...scenario.forbiddenTextPatterns,
        ...scenario.assertions.filter(({ type }) => type === 'expected_text_matched' || type === 'forbidden_text_absent')
          .map(({ target }) => target ?? '')]
      : scenario.expectedTextPatterns;
    for (const pattern of patterns) compileEvalTextPattern(pattern);
  }
  const { rows: [stored] } = await db.query(`
    INSERT INTO agent_eval_suites (id, tenant_id, agent_graph_id, name, scenarios, execution_profile)
    VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING RETURNING id
  `, [id, tenantId, graphId, name, JSON.stringify(scenarios), profile]);
  if (!stored) {
    const { rows: [existing] } = await db.query(`
      SELECT id FROM agent_eval_suites WHERE id = $1 AND tenant_id = $2 AND agent_graph_id = $3
        AND name = $4 AND scenarios = $5::jsonb AND execution_profile = $6
    `, [id, tenantId, graphId, name, JSON.stringify(scenarios), profile]);
    if (!existing) return null;
  }
  return { id, name, scenarioCount: scenarios.length, ...(profile === 'catalog-router-v1' ? { profile } : {}) };
}

export async function loadExecutionSuite(db: Queryable, tenantId: number, graphId: string, suiteId: string) {
  const { rows: [source] } = await db.query(`
    SELECT name, scenarios, pass_threshold_percent, execution_profile FROM agent_eval_suites
    WHERE tenant_id = $1 AND agent_graph_id = $2 AND id = $3
    FOR SHARE
  `, [tenantId, graphId, suiteId]);
  if (!source) return null;
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
  const profile: ExecutionProfile = source.execution_profile;
  if (profile !== 'linear-text-v1' && profile !== 'catalog-router-v1') {
    throw new SimulationInputError('The stored suite contains an unsupported execution profile');
  }
  // Existing text publications retain their original suite digest. Catalog evidence binds the new profile explicitly.
  const identity = profile === 'linear-text-v1' ? suite : { profile, suite };
  return { suite, profile, suiteHash: createHash('sha256').update(JSON.stringify(identity)).digest('hex') };
}

/** Derive a stable reservation UUID so the ledger can be traced back to this exact run and scenario. */
export function executionAttemptId(runId: string, scenarioId: string): string {
  const bytes = createHash('sha256').update(JSON.stringify(['studio-evaluation', runId, scenarioId])).digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const value = bytes.subarray(0, 16).toString('hex');
  return [value.slice(0, 8), value.slice(8, 12), value.slice(12, 16), value.slice(16, 20), value.slice(20)].join('-');
}
