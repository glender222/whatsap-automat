import { createHash } from 'node:crypto';
import { evalSuiteV1Schema } from '@whatsap-automat/contracts';
import type { Queryable } from '../../../shared/UnitOfWorkPort';
import { SimulationInputError } from '../eval/AgentEvalService';

export type ExecutionMode = 'verification' | 'provider';
export const executionRunIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export async function loadExecutionSuite(db: Queryable, tenantId: number, graphId: string, suiteId: string) {
  const { rows: [source] } = await db.query(`
    SELECT name, scenarios, pass_threshold_percent FROM agent_eval_suites
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
  return { suite, suiteHash: createHash('sha256').update(JSON.stringify(suite)).digest('hex') };
}

/** Derive a stable reservation UUID so the ledger can be traced back to this exact run and scenario. */
export function executionAttemptId(runId: string, scenarioId: string): string {
  const bytes = createHash('sha256').update(JSON.stringify(['studio-evaluation', runId, scenarioId])).digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const value = bytes.subarray(0, 16).toString('hex');
  return [value.slice(0, 8), value.slice(8, 12), value.slice(12, 16), value.slice(16, 20), value.slice(20)].join('-');
}
