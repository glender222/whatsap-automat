import { z } from 'zod';
import { agentGraphVersionV1Schema } from './schemas';

/**
 * Deterministic Assertion Types for Scenario Validation
 */
export const EVAL_ASSERTION_TYPES = [
  'expected_tool_called',
  'forbidden_tool_not_called',
  'expected_text_matched',
  'forbidden_text_absent',
  'max_steps',
  'max_cost_micro_usd',
  'max_latency_ms',
  'approval_triggered',
] as const;

export type EvalAssertionType = (typeof EVAL_ASSERTION_TYPES)[number];
export const evalAssertionTypeSchema = z.enum(EVAL_ASSERTION_TYPES);

export const evalAssertionV1Schema = z.object({
  id: z.string().min(1),
  type: evalAssertionTypeSchema,
  target: z.string().optional(), // Tool name, regex pattern, or field name
  expectedValue: z.unknown().optional(),
  description: z.string().optional(),
});
export type EvalAssertionV1 = z.infer<typeof evalAssertionV1Schema>;

export const evalAssertionResultV1Schema = z.object({
  assertionId: z.string().min(1),
  type: evalAssertionTypeSchema,
  passed: z.boolean(),
  expected: z.unknown().optional(),
  actual: z.unknown().optional(),
  message: z.string(),
});
export type EvalAssertionResultV1 = z.infer<typeof evalAssertionResultV1Schema>;

/**
 * Single Deterministic Evaluation Scenario
 */
export const evalScenarioV1Schema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(120),
  description: z.string().max(1024).optional(),
  mockInput: z.string().min(1),
  mockConversationState: z.record(z.unknown()).default({}),
  expectedTools: z.array(z.string().min(1)).default([]),
  forbiddenTools: z.array(z.string().min(1)).default([]),
  expectedTextPatterns: z.array(z.string().min(1)).default([]),
  forbiddenTextPatterns: z.array(z.string().min(1)).default([]),
  assertions: z.array(evalAssertionV1Schema).default([]),
});
export type EvalScenarioV1 = z.infer<typeof evalScenarioV1Schema>;

/**
 * Suite of Benchmark Scenarios for an Agent
 */
export const evalSuiteV1Schema = z.object({
  id: z.string().min(1),
  tenantId: z.union([z.string().min(1), z.number().int().positive()]),
  agentGraphId: z.string().min(1),
  name: z.string().min(1).max(120),
  description: z.string().max(1024).optional(),
  scenarios: z.array(evalScenarioV1Schema).min(1, 'An evaluation suite must have at least one scenario'),
  baselineVersion: z.number().int().positive().optional(),
  passThresholdPercent: z.number().min(0).max(100).default(95.0),
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
});
export type EvalSuiteV1 = z.infer<typeof evalSuiteV1Schema>;

/**
 * Granular Step Trace during Dry-Run Playback
 */
export const evalTraceStepV1Schema = z.object({
  step: z.number().int().positive(),
  nodeId: z.string().min(1),
  nodeKind: z.string().min(1),
  status: z.enum(['completed', 'failed', 'skipped', 'awaiting_approval']),
  durationMs: z.number().nonnegative(),
  tokensUsed: z.number().int().nonnegative().default(0),
  costMicroUsd: z.number().int().nonnegative().default(0),
  inputPayload: z.record(z.unknown()).optional(),
  outputPayload: z.record(z.unknown()).optional(),
  toolCallsProposed: z.array(z.string()).default([]),
  error: z.string().optional(),
});
export type EvalTraceStepV1 = z.infer<typeof evalTraceStepV1Schema>;

/**
 * Execution Result of a Single Scenario
 */
export const evalRunResultV1Schema = z.object({
  scenarioId: z.string().min(1),
  scenarioName: z.string().min(1),
  passed: z.boolean(),
  durationMs: z.number().nonnegative(),
  tokensUsed: z.number().int().nonnegative(),
  costMicroUsd: z.number().int().nonnegative(),
  traceSteps: z.array(evalTraceStepV1Schema),
  executedTools: z.array(z.string()),
  assertionsResults: z.array(evalAssertionResultV1Schema),
  finalResponseText: z.string().optional(),
  failureReasons: z.array(z.string()).default([]),
  diffFromBaseline: z
    .object({
      baselinePassed: z.boolean().optional(),
      baselineDurationMs: z.number().optional(),
      statusChanged: z.enum(['none', 'regressed', 'fixed']),
    })
    .optional(),
});
export type EvalRunResultV1 = z.infer<typeof evalRunResultV1Schema>;

/**
 * Comprehensive Evaluation Scorecard
 */
export const evalScorecardV1Schema = z.object({
  suiteId: z.string().min(1),
  suiteName: z.string().min(1),
  agentGraphId: z.string().min(1),
  graphVersion: z.number().int().positive(),
  passRatePercent: z.number().min(0).max(100),
  totalScenarios: z.number().int().nonnegative(),
  passedCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative(),
  p50LatencyMs: z.number().nonnegative(),
  p95LatencyMs: z.number().nonnegative(),
  totalCostMicroUsd: z.number().int().nonnegative(),
  totalTokensUsed: z.number().int().nonnegative(),
  regressionDetected: z.boolean(),
  securityToolLeaks: z.array(z.string()).default([]),
  baselineVersion: z.number().int().positive().optional(),
  baselineComparison: z
    .object({
      passRateDelta: z.number(),
      p95LatencyDeltaMs: z.number(),
      costDeltaMicroUsd: z.number(),
      newFailures: z.array(z.string()),
      resolvedFailures: z.array(z.string()),
    })
    .optional(),
  scenarioResults: z.array(evalRunResultV1Schema),
  timestamp: z.string().datetime(),
});
export type EvalScorecardV1 = z.infer<typeof evalScorecardV1Schema>;

/**
 * Publication Gate Blocker Contract
 */
export const PUBLICATION_BLOCKER_CODES = [
  'PASS_RATE_BELOW_THRESHOLD',
  'SECURITY_TOOL_LEAK',
  'GRAPH_CYCLE_DETECTED',
  'SPEC_HASH_MISMATCH',
  'ORPHAN_NODES_DETECTED',
  'MISSING_ENTRY_TRIGGER',
] as const;

export type PublicationBlockerCode = (typeof PUBLICATION_BLOCKER_CODES)[number];
export const publicationBlockerCodeSchema = z.enum(PUBLICATION_BLOCKER_CODES);

export const publicationBlockerV1Schema = z.object({
  code: publicationBlockerCodeSchema,
  message: z.string().min(1),
  details: z.unknown().optional(),
  remediation: z.string().min(1),
});
export type PublicationBlockerV1 = z.infer<typeof publicationBlockerV1Schema>;

export const publicationGateResultV1Schema = z.object({
  allowed: z.boolean(),
  blockers: z.array(publicationBlockerV1Schema),
  computedSpecHash: z.string().min(1),
  declaredSpecHash: z.string().min(1),
  passRatePercent: z.number().optional(),
  securityToolLeaksCount: z.number().int().nonnegative(),
  cycleDetected: z.boolean(),
  evaluatedAt: z.string().datetime(),
});
export type PublicationGateResultV1 = z.infer<typeof publicationGateResultV1Schema>;

/**
 * Simulation API Request
 */
export const evalSimulateRequestV1Schema = z.object({
  graph: agentGraphVersionV1Schema,
  suite: evalSuiteV1Schema.optional(),
  scenarios: z.array(evalScenarioV1Schema).optional(),
  baselineVersion: z.number().int().positive().optional(),
});
export type EvalSimulateRequestV1 = z.infer<typeof evalSimulateRequestV1Schema>;
