import type { EvalScenarioV1 } from '@whatsap-automat/contracts';
import type { CatalogEvaluationEvidence } from './CatalogEvaluationEvidence';
import { catalogScenarioChecks } from './CatalogEvaluationAssertions';

export interface ScenarioResult {
  scenarioId: string;
  runtimeRunId: string;
  outcome: 'passed' | 'assertion_failed' | 'blocked' | 'uncertain';
  ledgerIds: number[];
  tokens: number;
  costMicroUsd: number;
  latencyMs?: number;
  failedAssertions?: string[];
  executedTools?: string[];
  rounds?: Array<{ slot: 'router' | 'answer'; roundId: string; requestHash: string; outputHash: string; ledgerId: number }>;
  tool?: { name: string; schemaVersion: number; nodeId: string; invocationId: string; inputHash: string; outputHash: string; authorizationHash: string };
}
export function measuredCatalogScenario(scenario: EvalScenarioV1, runtimeRunId: string,
  proof: Awaited<ReturnType<CatalogEvaluationEvidence['verify']>>): ScenarioResult {
  const failedAssertions = catalogScenarioChecks(scenario).filter(({ check }) => !check(proof)).map(({ id }) => id);
  return { scenarioId: scenario.id, runtimeRunId, outcome: failedAssertions.length ? 'assertion_failed' : 'passed',
    ledgerIds: proof.ledgerIds, tokens: proof.tokens, costMicroUsd: proof.costMicroUsd, latencyMs: proof.latencyMs,
    executedTools: proof.tools, failedAssertions, rounds: proof.rounds, ...(proof.tool ? { tool: proof.tool } : {}) };
}
