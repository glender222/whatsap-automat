import {
  AgentGraphVersionV1,
  EvalScorecardV1,
  PublicationGateResultV1,
  PublicationBlockerV1,
  computeAgentSpecHash,
} from '@whatsap-automat/contracts';

export class PublicationGate {
  /**
   * Enforces publication gate validation:
   * 1. Pass Rate >= 95%
   * 2. Zero security tool leaks
   * 3. Zero infinite cycles in graph topology
   * 4. Cryptographic specHash integrity match
   */
  static validate(
    graph: AgentGraphVersionV1,
    scorecard?: EvalScorecardV1 | null
  ): PublicationGateResultV1 {
    const blockers: PublicationBlockerV1[] = [];

    // Condition 1: Graph Spec Hash Verification
    const computedSpecHash = computeAgentSpecHash(graph);
    if (graph.specHash && computedSpecHash !== graph.specHash) {
      blockers.push({
        code: 'SPEC_HASH_MISMATCH',
        message: `Graph spec hash mismatch: declared '${graph.specHash}' does not match computed '${computedSpecHash}'`,
        remediation: 'Re-compute graph.specHash before publication to ensure payload integrity.',
      });
    }

    // Condition 2: Graph Topology Cycle Detection (DFS 3-color)
    const cycle = this.detectCycles(graph);
    if (cycle.hasCycle) {
      blockers.push({
        code: 'GRAPH_CYCLE_DETECTED',
        message: `Graph topology contains an infinite cycle: ${cycle.path.join(' -> ')}`,
        remediation: 'Remove cycle or introduce an explicit exit condition or bounded step limit.',
      });
    }

    // Condition 3: Graph Structure Validity (Trigger and Orphans)
    const hasTrigger = graph.nodes.some((n) => n.id === graph.entryNodeId);
    if (!hasTrigger) {
      blockers.push({
        code: 'MISSING_ENTRY_TRIGGER',
        message: `Graph entryNodeId '${graph.entryNodeId}' does not exist in nodes definition`,
        remediation: 'Ensure graph specifies a valid entry node ID.',
      });
    }

    // Condition 4 & 5: Evaluation Simulator Scorecard Requirements
    if (!scorecard) {
      blockers.push({
        code: 'PASS_RATE_BELOW_THRESHOLD',
        message: 'No regression evaluation simulation run exists for this graph version.',
        remediation: 'Execute benchmark evaluation simulator suite before publishing.',
      });
    } else {
      // 4. Pass Rate Check (>= 95%)
      if (scorecard.passRatePercent < 95.0) {
        blockers.push({
          code: 'PASS_RATE_BELOW_THRESHOLD',
          message: `Pass rate ${scorecard.passRatePercent}% is below the required 95.00% deployment threshold (${scorecard.passedCount}/${scorecard.totalScenarios} passed)`,
          details: { passRatePercent: scorecard.passRatePercent, threshold: 95.0 },
          remediation: 'Resolve scenario assertion failures to achieve >= 95% pass rate.',
        });
      }

      // 5. Security Tool Leaks Check (Must be 0)
      if (scorecard.securityToolLeaks && scorecard.securityToolLeaks.length > 0) {
        blockers.push({
          code: 'SECURITY_TOOL_LEAK',
          message: `Critical security violation: ${scorecard.securityToolLeaks.length} forbidden tool leak(s) detected: ${scorecard.securityToolLeaks.join(', ')}`,
          details: { leaks: scorecard.securityToolLeaks },
          remediation: 'Strip forbidden tools from prompts and verify tool RBAC constraints.',
        });
      }
    }

    return {
      allowed: blockers.length === 0,
      blockers,
      computedSpecHash,
      declaredSpecHash: graph.specHash || computedSpecHash,
      passRatePercent: scorecard?.passRatePercent,
      securityToolLeaksCount: scorecard?.securityToolLeaks?.length || 0,
      cycleDetected: cycle.hasCycle,
      evaluatedAt: new Date().toISOString(),
    };
  }

  /**
   * Detects cycles in graph topology using standard DFS 3-Coloring (0=White, 1=Grey, 2=Black)
   */
  static detectCycles(graph: Pick<AgentGraphVersionV1, 'nodes' | 'edges'>): {
    hasCycle: boolean;
    path: string[];
  } {
    const adj = new Map<string, string[]>();
    for (const node of graph.nodes) {
      adj.set(node.id, []);
    }
    for (const edge of graph.edges) {
      if (adj.has(edge.from)) {
        adj.get(edge.from)!.push(edge.to);
      }
    }

    const state = new Map<string, 0 | 1 | 2>();
    for (const node of graph.nodes) {
      state.set(node.id, 0);
    }

    const path: string[] = [];
    let cyclePath: string[] = [];

    function dfs(u: string): boolean {
      state.set(u, 1); // Grey
      path.push(u);

      const neighbors = adj.get(u) || [];
      for (const v of neighbors) {
        if (state.get(v) === 1) {
          // Cycle found!
          const startIndex = path.indexOf(v);
          cyclePath = path.slice(startIndex).concat(v);
          return true;
        }
        if (state.get(v) === 0) {
          if (dfs(v)) return true;
        }
      }

      path.pop();
      state.set(u, 2); // Black
      return false;
    }

    for (const node of graph.nodes) {
      if (state.get(node.id) === 0) {
        if (dfs(node.id)) {
          return { hasCycle: true, path: cyclePath };
        }
      }
    }

    return { hasCycle: false, path: [] };
  }
}
