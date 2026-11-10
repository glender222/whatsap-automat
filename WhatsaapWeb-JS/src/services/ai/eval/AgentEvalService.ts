import type {
  AgentGraphVersionV1,
  EvalSuiteV1,
  EvalScenarioV1,
  EvalRunResultV1,
  EvalScorecardV1,
  EvalTraceStepV1,
  EvalAssertionV1,
  EvalAssertionResultV1,
} from '@whatsap-automat/contracts';
import { RE2JS } from 're2js';

export class SimulationInputError extends Error {
  readonly statusCode = 400;
  readonly code = 'VALIDATION_ERROR';
}

export function compileEvalTextPattern(pattern: string): RE2JS {
  if (pattern.length > 256) throw new SimulationInputError('Text patterns must be at most 256 characters');
  try {
    return RE2JS.compile(pattern, RE2JS.CASE_INSENSITIVE);
  } catch {
    throw new SimulationInputError('Invalid or unsupported simulation text pattern');
  }
}

function matchText(pattern: string, text: string): boolean {
  return compileEvalTextPattern(pattern).matcher(text).find();
}

function checkGraph(tenantId: number, graph: AgentGraphVersionV1): void {
  if (String(tenantId) !== graph.tenantId) throw new SimulationInputError('Simulation graph belongs to a different tenant');
  if (graph.nodes.length > 128 || graph.edges.length > 512 || graph.limits.maxSteps > 128 ||
      graph.nodes.some((node) => node.id.length > 128)) {
    throw new SimulationInputError('Simulation graph exceeds the node, edge or step limit');
  }
}

function checkAssertion(assertion: EvalAssertionV1, result: {
  text: string; tools: string[]; steps: EvalTraceStepV1[]; duration: number; cost: number;
}): EvalAssertionResultV1 {
  const { id, type, target, expectedValue } = assertion;
  let expected: unknown = expectedValue;
  let actual: unknown;
  let passed: boolean;

  switch (type) {
    case 'expected_tool_called':
    case 'forbidden_tool_not_called': {
      if (!target || target.length > 128) throw new SimulationInputError('Tool assertions require a tool name');
      expected = type === 'expected_tool_called';
      actual = result.tools.includes(target) || (type === 'forbidden_tool_not_called' &&
        result.steps.some((step) => step.toolCallsProposed.includes(target)));
      passed = expected === actual;
      break;
    }
    case 'expected_text_matched':
    case 'forbidden_text_absent':
      if (!target) throw new SimulationInputError('Text assertions require a pattern');
      expected = type === 'expected_text_matched';
      actual = matchText(target, result.text);
      passed = expected === actual;
      break;
    case 'approval_triggered':
      if (expectedValue !== undefined && typeof expectedValue !== 'boolean') {
        throw new SimulationInputError('Approval assertions require a boolean value');
      }
      expected = expectedValue ?? true;
      actual = result.steps.some((step) => step.nodeKind === 'approval' && (!target || step.nodeId === target));
      passed = expected === actual;
      break;
    case 'max_steps':
    case 'max_cost_micro_usd':
    case 'max_latency_ms': {
      if (typeof expectedValue !== 'number' || !Number.isSafeInteger(expectedValue) || expectedValue < 0) {
        throw new SimulationInputError('Budget assertions require a nonnegative integer');
      }
      const measured = type === 'max_steps' ? result.steps.length : type === 'max_cost_micro_usd' ? result.cost : result.duration;
      actual = measured;
      passed = measured <= expectedValue;
      break;
    }
  }

  return { assertionId: id, type, passed, expected, actual, message: passed ? 'Assertion passed' : 'Assertion failed' };
}

export class AgentEvalService {
  /**
   * Executes an entire benchmark suite against an agent graph version
   */
  async simulateSuite(
    tenantId: number,
    graph: AgentGraphVersionV1,
    suite: EvalSuiteV1,
    baselineScorecard?: EvalScorecardV1 | null
  ): Promise<EvalScorecardV1> {
    if (String(suite.tenantId) !== String(tenantId) || suite.agentGraphId !== graph.graphId) {
      throw new SimulationInputError('Simulation suite does not match the graph and tenant');
    }
    if (!suite.scenarios.length || suite.scenarios.length > 20) {
      throw new SimulationInputError('A simulation suite must contain between 1 and 20 scenarios');
    }
    const scenarioResults: EvalRunResultV1[] = [];
    const allSecurityLeaks = new Set<string>();

    for (const scenario of suite.scenarios) {
      const result = await this.simulateScenario(tenantId, graph, scenario);

      // Compare with baseline if available
      if (baselineScorecard) {
        const baselineScenario = baselineScorecard.scenarioResults?.find(
          (s) => s.scenarioId === scenario.id
        );
        if (baselineScenario) {
          const statusChanged =
            baselineScenario.passed && !result.passed
              ? 'regressed'
              : !baselineScenario.passed && result.passed
              ? 'fixed'
              : 'none';
          result.diffFromBaseline = {
            baselinePassed: baselineScenario.passed,
            baselineDurationMs: baselineScenario.durationMs,
            statusChanged,
          };
        }
      }

      scenarioResults.push(result);
      for (const reason of result.failureReasons) {
        if (reason.startsWith('SECURITY_LEAK:')) {
          allSecurityLeaks.add(reason.replace('SECURITY_LEAK:', '').trim());
        }
      }
    }

    // Compute aggregate metrics
    const totalScenarios = scenarioResults.length;
    const passedCount = scenarioResults.filter((r) => r.passed).length;
    const failedCount = totalScenarios - passedCount;
    const passRatePercent =
      totalScenarios > 0 ? Math.round((passedCount / totalScenarios) * 10000) / 100 : 0;

    const latencies = scenarioResults.map((r) => r.durationMs).sort((a, b) => a - b);
    const p50LatencyMs = latencies[Math.floor(latencies.length * 0.5)] || 0;
    const p95LatencyMs = latencies[Math.floor(latencies.length * 0.95)] || latencies[latencies.length - 1] || 0;

    const totalCostMicroUsd = scenarioResults.reduce((sum, r) => sum + r.costMicroUsd, 0);
    const totalTokensUsed = scenarioResults.reduce((sum, r) => sum + r.tokensUsed, 0);

    const securityToolLeaks = Array.from(allSecurityLeaks);

    // Regression detection logic
    let regressionDetected = false;
    let baselineComparison = undefined;

    if (baselineScorecard) {
      const newFailures = scenarioResults
        .filter((r) => r.diffFromBaseline?.statusChanged === 'regressed')
        .map((r) => r.scenarioName);
      const resolvedFailures = scenarioResults
        .filter((r) => r.diffFromBaseline?.statusChanged === 'fixed')
        .map((r) => r.scenarioName);

      regressionDetected = newFailures.length > 0 || passRatePercent < baselineScorecard.passRatePercent;

      baselineComparison = {
        passRateDelta: Math.round((passRatePercent - baselineScorecard.passRatePercent) * 100) / 100,
        p95LatencyDeltaMs: p95LatencyMs - baselineScorecard.p95LatencyMs,
        costDeltaMicroUsd: totalCostMicroUsd - baselineScorecard.totalCostMicroUsd,
        newFailures,
        resolvedFailures,
      };
    }

    return {
      suiteId: suite.id,
      suiteName: suite.name,
      agentGraphId: graph.graphId,
      graphVersion: graph.version,
      passRatePercent,
      totalScenarios,
      passedCount,
      failedCount,
      p50LatencyMs,
      p95LatencyMs,
      totalCostMicroUsd,
      totalTokensUsed,
      regressionDetected,
      securityToolLeaks,
      baselineVersion: suite.baselineVersion,
      baselineComparison,
      scenarioResults,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Executes a single scenario in the dry-run sandbox
   */
  async simulateScenario(
    tenantId: number,
    graph: AgentGraphVersionV1,
    scenario: EvalScenarioV1
  ): Promise<EvalRunResultV1> {
    checkGraph(tenantId, graph);
    const stringAssertions = [scenario.expectedTools, scenario.forbiddenTools,
      scenario.expectedTextPatterns, scenario.forbiddenTextPatterns];
    if (scenario.mockInput.length > 2_048 || scenario.assertions.length > 16 ||
        stringAssertions.some((entries) => entries.length > 16 || entries.some((entry) => entry.length > 256)) ||
        scenario.assertions.some((assertion) => assertion.id.length > 128 || (assertion.target?.length ?? 0) > 256)) {
      throw new SimulationInputError('Simulation input or assertion count exceeds the limit');
    }
    const startTime = Date.now();
    const traceSteps: EvalTraceStepV1[] = [];
    const executedTools: string[] = [];
    const failureReasons: string[] = [];
    let currentTokens = 0;
    let currentCost = 0;
    let currentNodeId: string | null = graph.entryNodeId;
    let stepCount = 0;
    let finalResponseText = '';
    let reachedTerminal = false;

    const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));
    const maxSteps = graph.limits?.maxSteps || 15;

    while (currentNodeId && stepCount < maxSteps) {
      stepCount++;
      const node = nodeMap.get(currentNodeId);
      if (!node) {
        failureReasons.push(`Node '${currentNodeId}' not found in graph`);
        break;
      }

      const nodeStart = Date.now();
      const nodeKind = node.kind;
      let nodeTokens = 0;
      let nodeCost = 0;
      let proposedTools: string[] = [];
      let outputPayload: Record<string, unknown> = {};

      let status: EvalTraceStepV1['status'] = 'completed';
      switch (nodeKind) {
        case 'agent':
          nodeTokens = 450;
          nodeCost = 1500;
          if (scenario.mockInput.toLowerCase().includes('stock')) {
            proposedTools = ['inventory.check_stock'];
          } else if (scenario.mockInput.toLowerCase().includes('factura')) {
            proposedTools = ['create_invoice'];
          } else if (scenario.mockInput.toLowerCase().includes('catalogo') || scenario.mockInput.toLowerCase().includes('buscar')) {
            proposedTools = ['catalog.search'];
          } else {
            proposedTools = [];
          }
          finalResponseText = `Respuesta simulada para: ${scenario.mockInput}`;
          outputPayload = { text: finalResponseText, proposedTools };
          break;

        case 'tool': {
          const toolName = node.config.toolName ?? node.config.name;
          if (typeof toolName !== 'string' || !toolName.trim() || toolName.length > 128) {
            status = 'failed';
            failureReasons.push(`Tool node '${node.id}' requires a tool name`);
            break;
          }
          executedTools.push(toolName);

          // Check for security tool leaks
          if (scenario.forbiddenTools && scenario.forbiddenTools.includes(toolName)) {
            failureReasons.push(`SECURITY_LEAK: Forbidden tool '${toolName}' was executed`);
          }

          outputPayload = { result: `Simulated output for ${toolName}`, success: true };
          break;
        }

        case 'approval':
          outputPayload = { requiresApproval: true };
          break;

        case 'handoff':
          outputPayload = { simulatedHandoff: true };
          break;

        case 'end':
          outputPayload = { state: 'completed' };
          break;

        default:
          status = 'skipped';
          outputPayload = { behavior: 'traversal_only' };
      }

      currentTokens += nodeTokens;
      currentCost += nodeCost;
      const nodeDuration = Math.max(1, Date.now() - nodeStart);

      traceSteps.push({
        step: stepCount,
        nodeId: node.id,
        nodeKind: node.kind,
        status,
        durationMs: nodeDuration,
        tokensUsed: nodeTokens,
        costMicroUsd: nodeCost,
        outputPayload,
        toolCallsProposed: proposedTools,
      });

      if (nodeKind === 'end' || nodeKind === 'handoff') {
        reachedTerminal = true;
        break;
      }

      // Find next node via edges
      const edge = graph.edges.find((e) => e.from === currentNodeId);
      currentNodeId = edge ? edge.to : null;
    }

    if (!reachedTerminal && stepCount >= maxSteps && currentNodeId) {
      failureReasons.push(`Execution exceeded maximum budget of ${maxSteps} steps`);
    } else if (!reachedTerminal && !currentNodeId) {
      failureReasons.push('Simulation ended without reaching an end or handoff node');
    }

    // Verify Assertions
    const assertionsResults: EvalAssertionResultV1[] = [];

    // 1. Expected Tools
    for (const expTool of scenario.expectedTools || []) {
      const called = executedTools.includes(expTool);
      assertionsResults.push({
        assertionId: `assert_exp_${expTool}`,
        type: 'expected_tool_called',
        passed: called,
        expected: expTool,
        actual: executedTools,
        message: called ? `Tool '${expTool}' was invoked.` : `Expected tool '${expTool}' was NOT invoked.`,
      });
      if (!called) failureReasons.push(`Expected tool '${expTool}' was missing`);
    }

    // 2. Forbidden Tools
    for (const forbTool of scenario.forbiddenTools || []) {
      const called = executedTools.includes(forbTool) || traceSteps.some((s) => s.toolCallsProposed.includes(forbTool));
      assertionsResults.push({
        assertionId: `assert_forb_${forbTool}`,
        type: 'forbidden_tool_not_called',
        passed: !called,
        expected: `NOT ${forbTool}`,
        actual: called ? forbTool : null,
        message: !called ? `Forbidden tool '${forbTool}' was correctly avoided.` : `SECURITY LEAK: Forbidden tool '${forbTool}' was invoked!`,
      });
      if (called) failureReasons.push(`SECURITY_LEAK: Forbidden tool '${forbTool}' was invoked`);
    }

    // 3. Expected Text Patterns
    for (const pattern of scenario.expectedTextPatterns || []) {
      const matched = matchText(pattern, finalResponseText);
      assertionsResults.push({
        assertionId: `assert_pattern_${pattern}`,
        type: 'expected_text_matched',
        passed: matched,
        expected: pattern,
        actual: finalResponseText,
        message: matched ? `Text pattern '${pattern}' matched.` : `Expected pattern '${pattern}' did not match output.`,
      });
      if (!matched) failureReasons.push(`Output failed to match pattern '${pattern}'`);
    }

    // 4. Forbidden Text Patterns
    for (const pattern of scenario.forbiddenTextPatterns || []) {
      const matched = matchText(pattern, finalResponseText);
      assertionsResults.push({
        assertionId: `assert_forb_pattern_${pattern}`,
        type: 'forbidden_text_absent',
        passed: !matched,
        expected: `NOT ${pattern}`,
        actual: matched ? pattern : null,
        message: !matched ? `Forbidden pattern '${pattern}' was absent.` : `Output contained forbidden pattern '${pattern}'!`,
      });
      if (matched) failureReasons.push(`Forbidden pattern '${pattern}' detected in response`);
    }

    const durationMs = Math.max(1, Date.now() - startTime);
    for (const assertion of scenario.assertions) {
      const result = checkAssertion(assertion, {
        text: finalResponseText, tools: executedTools, steps: traceSteps, duration: durationMs, cost: currentCost,
      });
      assertionsResults.push(result);
      if (!result.passed) {
        const prefix = result.type === 'forbidden_tool_not_called' ? 'SECURITY_LEAK: ' : '';
        failureReasons.push(`${prefix}Assertion '${assertion.id}' failed`);
      }
    }
    const passed = failureReasons.length === 0;

    return {
      scenarioId: scenario.id,
      scenarioName: scenario.name,
      passed,
      durationMs,
      tokensUsed: currentTokens,
      costMicroUsd: currentCost,
      traceSteps,
      executedTools,
      assertionsResults,
      finalResponseText,
      failureReasons,
    };
  }
}

export const agentEvalService = new AgentEvalService();
