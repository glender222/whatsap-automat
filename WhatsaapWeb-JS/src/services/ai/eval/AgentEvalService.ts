import type {
  AgentGraphVersionV1,
  EvalSuiteV1,
  EvalScenarioV1,
  EvalRunResultV1,
  EvalScorecardV1,
  EvalTraceStepV1,
  EvalAssertionResultV1,
} from '@whatsap-automat/contracts';

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
    const startTime = Date.now();
    const traceSteps: EvalTraceStepV1[] = [];
    const executedTools: string[] = [];
    const failureReasons: string[] = [];
    let currentTokens = 0;
    let currentCost = 0;
    let currentNodeId: string | null = graph.entryNodeId;
    let stepCount = 0;
    let finalResponseText = '';

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
      const nodeKind: string = node.kind;
      let nodeTokens = 0;
      let nodeCost = 0;
      let proposedTools: string[] = [];
      let outputPayload: Record<string, unknown> = {};

      // Simulated node execution by kind
      switch (nodeKind) {
        case 'trigger':
          outputPayload = { message: scenario.mockInput, state: scenario.mockConversationState };
          break;

        case 'policy_guard':
          outputPayload = { status: 'passed', allowed: true };
          break;

        case 'memory_retrieval':
          nodeTokens = 80;
          nodeCost = 100;
          outputPayload = {
            chunksRetrieved: [
              { id: 'chk_1', text: 'Documentación de catálogo para pruebas de regresión.' },
            ],
          };
          break;

        case 'llm_reasoner':
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

        case 'tool_call':
        case 'tool': {
          const toolName = (node.config?.toolName as string) || (node.config?.name as string) || 'catalog.search';
          executedTools.push(toolName);

          // Check for security tool leaks
          if (scenario.forbiddenTools && scenario.forbiddenTools.includes(toolName)) {
            failureReasons.push(`SECURITY_LEAK: Forbidden tool '${toolName}' was executed`);
          }

          outputPayload = { result: `Simulated output for ${toolName}`, success: true };
          break;
        }

        case 'approval':
          outputPayload = { requiresApproval: true, risk: node.config?.risk || 'high' };
          break;

        case 'dispatch':
          outputPayload = { dispatched: true, channel: node.config?.channel || 'whatsapp' };
          break;

        case 'handoff':
          outputPayload = { handoffCreated: true, reason: node.config?.reason || 'human_requested' };
          break;

        case 'end':
          outputPayload = { state: 'completed' };
          break;

        default:
          outputPayload = { executed: true };
      }

      currentTokens += nodeTokens;
      currentCost += nodeCost;
      const nodeDuration = Math.max(1, Date.now() - nodeStart);

      traceSteps.push({
        step: stepCount,
        nodeId: node.id,
        nodeKind: node.kind,
        status: 'completed',
        durationMs: nodeDuration,
        tokensUsed: nodeTokens,
        costMicroUsd: nodeCost,
        outputPayload,
        toolCallsProposed: proposedTools,
      });

      if (nodeKind === 'end' || nodeKind === 'handoff') break;

      // Find next node via edges
      const edge = graph.edges.find((e) => e.from === currentNodeId);
      currentNodeId = edge ? edge.to : null;
    }

    if (stepCount >= maxSteps && currentNodeId && nodeMap.get(currentNodeId)?.kind !== 'end') {
      failureReasons.push(`Execution exceeded maximum budget of ${maxSteps} steps`);
    }

    // Verify Assertions
    const assertionsResults: EvalAssertionResultV1[] = [];

    // 1. Expected Tools
    for (const expTool of scenario.expectedTools || []) {
      const called = executedTools.includes(expTool) || traceSteps.some((s) => s.toolCallsProposed.includes(expTool));
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
      const regex = new RegExp(pattern, 'i');
      const matched = regex.test(finalResponseText);
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
      const regex = new RegExp(pattern, 'i');
      const matched = regex.test(finalResponseText);
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
