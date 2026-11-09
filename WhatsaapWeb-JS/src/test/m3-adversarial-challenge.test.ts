// Test environment variables before config load
process.env.JWT_SECRET = 'test-only-jwt-secret-with-at-least-32-characters-for-testing';
process.env.DB_PASSWORD = 'test-only-database-password';
process.env.META_TOKEN_ENCRYPTION_KEY = 'test-encryption-key-with-at-least-32-chars-for-aes256';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PublicationGate } from '../services/ai/eval/PublicationGate';
import { AgentEvalService } from '../services/ai/eval/AgentEvalService';
import {
  AgentGraphVersionV1,
  EvalScorecardV1,
  EvalSuiteV1,
  EvalScenarioV1,
  computeAgentSpecHash,
} from '@whatsap-automat/contracts';
import { computeStudioSpecHash } from '../../../Frontend_py_whatsaapweb/src/components/agent-studio/sync/AgentStudioSyncEngine';

describe('PR-F5-03 Adversarial Stress Verification: Publication Gate, Spec Hash & Eval Simulator', () => {
  const evalService = new AgentEvalService();

  const createCleanGraph = (): AgentGraphVersionV1 => {
    const base: Omit<AgentGraphVersionV1, 'specHash'> = {
      schemaVersion: 1,
      graphId: 'graph_adv_challenge',
      version: 1,
      tenantId: '1',
      entryNodeId: 'node_trigger',
      nodes: [
        { id: 'node_trigger', kind: 'agent', config: { channel: 'whatsapp' } },
        { id: 'node_guard', kind: 'condition', config: { policy: 'business_hours' } },
        { id: 'node_memory', kind: 'subgraph', config: { collection: 'kb_catalog' } },
        { id: 'node_reasoner', kind: 'agent', config: { model: 'gpt-4o', temperature: 0.2, prompt: 'Tu eres un asistente de soporte.' } },
        { id: 'node_tool', kind: 'tool', config: { toolName: 'catalog.search' } },
        { id: 'node_end', kind: 'end', config: {} },
      ],
      edges: [
        { id: 'e1', from: 'node_trigger', to: 'node_guard' },
        { id: 'e2', from: 'node_guard', to: 'node_memory' },
        { id: 'e3', from: 'node_memory', to: 'node_reasoner' },
        { id: 'e4', from: 'node_reasoner', to: 'node_tool' },
        { id: 'e5', from: 'node_tool', to: 'node_end' },
      ],
      policyRef: 'policy_standard_v1',
      limits: {
        maxSteps: 15,
        maxDelegations: 3,
        maxParallelNodes: 2,
        maxDurationSeconds: 60,
        maxModelTokens: 4000,
        maxCostMicroUsd: 500000,
      },
      status: 'draft',
    };
    const hash = computeAgentSpecHash(base);
    return { ...base, specHash: hash };
  };

  const createPassingScorecard = (passRate = 95.0): EvalScorecardV1 => ({
    suiteId: 'suite_adv_1',
    suiteName: 'Adversarial Verification Suite',
    agentGraphId: 'graph_adv_challenge',
    graphVersion: 1,
    passRatePercent: passRate,
    totalScenarios: 20,
    passedCount: Math.round(20 * (passRate / 100)),
    failedCount: 20 - Math.round(20 * (passRate / 100)),
    p50LatencyMs: 85,
    p95LatencyMs: 210,
    totalCostMicroUsd: 12000,
    totalTokensUsed: 5000,
    regressionDetected: false,
    securityToolLeaks: [],
    scenarioResults: [],
    timestamp: new Date().toISOString(),
  });

  // =========================================================================
  // 1. PublicationGate 4-Rule Boundary Testing
  // =========================================================================
  describe('1. PublicationGate 4-Rule Boundary Testing', () => {

    describe('1.1 Threshold Cliff Boundary (94.9% vs 95.0%)', () => {
      it('rejects passRate = 94.9% with PASS_RATE_BELOW_THRESHOLD', () => {
        const graph = createCleanGraph();
        const scorecard = createPassingScorecard(94.9);
        const result = PublicationGate.validate(graph, scorecard);

        assert.equal(result.allowed, false);
        const blocker = result.blockers.find((b) => b.code === 'PASS_RATE_BELOW_THRESHOLD');
        assert.ok(blocker, 'Expected PASS_RATE_BELOW_THRESHOLD blocker');
        assert.ok(blocker.message.includes('94.9%'));
        assert.equal(result.passRatePercent, 94.9);
      });

      it('rejects passRate = 94.99% with PASS_RATE_BELOW_THRESHOLD', () => {
        const graph = createCleanGraph();
        const scorecard = createPassingScorecard(94.99);
        const result = PublicationGate.validate(graph, scorecard);

        assert.equal(result.allowed, false);
        assert.ok(result.blockers.some((b) => b.code === 'PASS_RATE_BELOW_THRESHOLD'));
      });

      it('rejects passRate = 94.9999% with PASS_RATE_BELOW_THRESHOLD', () => {
        const graph = createCleanGraph();
        const scorecard = createPassingScorecard(94.9999);
        const result = PublicationGate.validate(graph, scorecard);

        assert.equal(result.allowed, false);
        assert.ok(result.blockers.some((b) => b.code === 'PASS_RATE_BELOW_THRESHOLD'));
      });

      it('permits passRate = 95.0% strictly on the boundary cliff', () => {
        const graph = createCleanGraph();
        const scorecard = createPassingScorecard(95.0);
        const result = PublicationGate.validate(graph, scorecard);

        assert.equal(result.allowed, true);
        assert.equal(result.blockers.length, 0);
        assert.equal(result.passRatePercent, 95.0);
      });

      it('permits passRate = 95.0001% and 100.0%', () => {
        const graph = createCleanGraph();
        const res95_01 = PublicationGate.validate(graph, createPassingScorecard(95.0001));
        assert.equal(res95_01.allowed, true);

        const res100 = PublicationGate.validate(graph, createPassingScorecard(100.0));
        assert.equal(res100.allowed, true);
      });

      it('rejects missing or null scorecard with PASS_RATE_BELOW_THRESHOLD', () => {
        const graph = createCleanGraph();
        const resNull = PublicationGate.validate(graph, null);
        assert.equal(resNull.allowed, false);
        assert.ok(resNull.blockers.some((b) => b.code === 'PASS_RATE_BELOW_THRESHOLD'));

        const resUndefined = PublicationGate.validate(graph, undefined);
        assert.equal(resUndefined.allowed, false);
        assert.ok(resUndefined.blockers.some((b) => b.code === 'PASS_RATE_BELOW_THRESHOLD'));
      });
    });

    describe('1.2 Security Tool Leak Rejection', () => {
      it('rejects scorecard with single security tool leak with SECURITY_TOOL_LEAK', () => {
        const graph = createCleanGraph();
        const leakingScorecard: EvalScorecardV1 = {
          ...createPassingScorecard(98.0),
          securityToolLeaks: ['system_shell_exec'],
        };
        const result = PublicationGate.validate(graph, leakingScorecard);

        assert.equal(result.allowed, false);
        assert.equal(result.securityToolLeaksCount, 1);
        const blocker = result.blockers.find((b) => b.code === 'SECURITY_TOOL_LEAK');
        assert.ok(blocker, 'Expected SECURITY_TOOL_LEAK blocker');
        assert.ok(blocker.message.includes('system_shell_exec'));
      });

      it('rejects scorecard with multiple high-risk security tool leaks', () => {
        const graph = createCleanGraph();
        const multiLeakScorecard: EvalScorecardV1 = {
          ...createPassingScorecard(100.0),
          securityToolLeaks: ['database_drop_table', 'credit_card_charge', 'delete_tenant_backup'],
        };
        const result = PublicationGate.validate(graph, multiLeakScorecard);

        assert.equal(result.allowed, false);
        assert.equal(result.securityToolLeaksCount, 3);
        const blocker = result.blockers.find((b) => b.code === 'SECURITY_TOOL_LEAK');
        assert.ok(blocker);
        assert.ok(blocker.message.includes('database_drop_table'));
        assert.ok(blocker.message.includes('credit_card_charge'));
        assert.ok(blocker.message.includes('delete_tenant_backup'));
      });

      it('propagates leak end-to-end: simulation forbidden tool execution triggers SECURITY_TOOL_LEAK gate rejection', async () => {
        const graph = createCleanGraph();
        const hostileScenario: EvalScenarioV1 = {
          id: 'scen_hostile_01',
          name: 'Hostile tool invoke scenario',
          mockInput: 'Tienen stock?',
          mockConversationState: {},
          expectedTools: [],
          forbiddenTools: ['catalog.search'], // catalog.search is in graph!
          expectedTextPatterns: [],
          forbiddenTextPatterns: [],
          assertions: [],
        };
        const suite: EvalSuiteV1 = {
          id: 'suite_hostile',
          tenantId: 1,
          agentGraphId: graph.graphId,
          name: 'Hostile Suite',
          passThresholdPercent: 95.0,
          scenarios: [hostileScenario],
        };

        const simulatedScorecard = await evalService.simulateSuite(1, graph, suite);
        assert.ok(
          simulatedScorecard.securityToolLeaks.some((l) => l.includes('catalog.search')),
          'Expected securityToolLeaks to include reference to forbidden catalog.search'
        );

        const gateResult = PublicationGate.validate(graph, simulatedScorecard);
        assert.equal(gateResult.allowed, false);
        assert.ok(gateResult.blockers.some((b) => b.code === 'SECURITY_TOOL_LEAK'));
      });
    });

    describe('1.3 Complex Multi-Node Topological Cycle Detection (DFS 3-Coloring)', () => {
      it('detects indirect loop with leading non-cyclic tail: A -> B -> C -> D -> B', () => {
        const graphWithTailAndCycle = {
          nodes: [
            { id: 'A' },
            { id: 'B' },
            { id: 'C' },
            { id: 'D' },
          ],
          edges: [
            { id: 'e1', from: 'A', to: 'B' },
            { id: 'e2', from: 'B', to: 'C' },
            { id: 'e3', from: 'C', to: 'D' },
            { id: 'e4', from: 'D', to: 'B' }, // cycle back to B
          ],
        } as any;

        const cycleRes = PublicationGate.detectCycles(graphWithTailAndCycle);
        assert.equal(cycleRes.hasCycle, true);
        assert.ok(cycleRes.path.includes('B'));
        assert.ok(cycleRes.path.includes('C'));
        assert.ok(cycleRes.path.includes('D'));
        // Node A is outside the cycle loop
        assert.equal(cycleRes.path[0], 'B');
        assert.equal(cycleRes.path[cycleRes.path.length - 1], 'B');
      });

      it('detects deep 15-node cyclic ring: N1 -> N2 -> ... -> N15 -> N1', () => {
        const nodes = Array.from({ length: 15 }, (_, i) => ({ id: `N${i + 1}` }));
        const edges = nodes.map((n, i) => ({
          id: `e${i + 1}`,
          from: n.id,
          to: nodes[(i + 1) % nodes.length].id,
        }));

        const cycleRes = PublicationGate.detectCycles({ nodes, edges } as any);
        assert.equal(cycleRes.hasCycle, true);
        assert.equal(cycleRes.path.length, 16); // N1 -> N2 ... -> N15 -> N1
      });

      it('detects self-loop: A -> A', () => {
        const graphSelfLoop = {
          nodes: [{ id: 'A' }],
          edges: [{ id: 'e1', from: 'A', to: 'A' }],
        } as any;

        const cycleRes = PublicationGate.detectCycles(graphSelfLoop);
        assert.equal(cycleRes.hasCycle, true);
        assert.deepEqual(cycleRes.path, ['A', 'A']);
      });

      it('detects disconnected cycle when entry component is clean', () => {
        // Component 1: entry A -> B -> C (DAG)
        // Component 2: disconnected X -> Y -> Z -> X (Cycle)
        const disconnectedGraph = {
          nodes: [
            { id: 'A' }, { id: 'B' }, { id: 'C' },
            { id: 'X' }, { id: 'Y' }, { id: 'Z' },
          ],
          edges: [
            { id: 'e1', from: 'A', to: 'B' },
            { id: 'e2', from: 'B', to: 'C' },
            { id: 'e3', from: 'X', to: 'Y' },
            { id: 'e4', from: 'Y', to: 'Z' },
            { id: 'e5', from: 'Z', to: 'X' },
          ],
        } as any;

        const cycleRes = PublicationGate.detectCycles(disconnectedGraph);
        assert.equal(cycleRes.hasCycle, true);
        assert.ok(cycleRes.path.includes('X'));
      });

      it('does NOT flag cycle in a complex feedforward diamond DAG', () => {
        // A -> B -> D, A -> C -> D, D -> E
        const diamondDag = {
          nodes: [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }, { id: 'E' }],
          edges: [
            { id: 'e1', from: 'A', to: 'B' },
            { id: 'e2', from: 'A', to: 'C' },
            { id: 'e3', from: 'B', to: 'D' },
            { id: 'e4', from: 'C', to: 'D' },
            { id: 'e5', from: 'D', to: 'E' },
          ],
        } as any;

        const cycleRes = PublicationGate.detectCycles(diamondDag);
        assert.equal(cycleRes.hasCycle, false);
        assert.equal(cycleRes.path.length, 0);
      });

      it('blocks publication gate with GRAPH_CYCLE_DETECTED when cycle is present', () => {
        const clean = createCleanGraph();
        const cyclicGraph: AgentGraphVersionV1 = {
          ...clean,
          edges: [
            ...clean.edges,
            { id: 'e_cycle', from: 'node_tool', to: 'node_reasoner' },
          ],
        };
        const validHashForCyclic = computeAgentSpecHash(cyclicGraph);
        const cyclicWithValidHash = { ...cyclicGraph, specHash: validHashForCyclic };

        const result = PublicationGate.validate(cyclicWithValidHash, createPassingScorecard(100.0));
        assert.equal(result.allowed, false);
        assert.equal(result.cycleDetected, true);
        const blocker = result.blockers.find((b) => b.code === 'GRAPH_CYCLE_DETECTED');
        assert.ok(blocker, 'Expected GRAPH_CYCLE_DETECTED blocker');
        assert.ok(blocker.message.includes('node_reasoner'));
      });
    });

    describe('1.4 Multi-Blocker Simultaneous Detection Stress', () => {
      it('surfaces all blockers simultaneously when multiple conditions fail (no early return truncation)', () => {
        const clean = createCleanGraph();
        // Cause:
        // 1. SPEC_HASH_MISMATCH
        // 2. GRAPH_CYCLE_DETECTED
        // 3. MISSING_ENTRY_TRIGGER
        // 4. PASS_RATE_BELOW_THRESHOLD
        // 5. SECURITY_TOOL_LEAK
        const heavilyBrokenGraph: AgentGraphVersionV1 = {
          ...clean,
          entryNodeId: 'non_existent_trigger',
          specHash: 'tampered_sha256_hash_value_that_does_not_match',
          edges: [
            ...clean.edges,
            { id: 'e_rev', from: 'node_end', to: 'node_guard' },
          ],
        };

        const heavilyBrokenScorecard: EvalScorecardV1 = {
          ...createPassingScorecard(70.0),
          securityToolLeaks: ['forbidden_shell_leak'],
        };

        const result = PublicationGate.validate(heavilyBrokenGraph, heavilyBrokenScorecard);

        assert.equal(result.allowed, false);
        assert.ok(result.blockers.length >= 4);

        const blockerCodes = result.blockers.map((b) => b.code);
        assert.ok(blockerCodes.includes('SPEC_HASH_MISMATCH'));
        assert.ok(blockerCodes.includes('GRAPH_CYCLE_DETECTED'));
        assert.ok(blockerCodes.includes('MISSING_ENTRY_TRIGGER'));
        assert.ok(blockerCodes.includes('PASS_RATE_BELOW_THRESHOLD'));
        assert.ok(blockerCodes.includes('SECURITY_TOOL_LEAK'));
      });
    });
  });

  // =========================================================================
  // 2. Cryptographic Spec Hash Integrity & Visual Layout Invariance
  // =========================================================================
  describe('2. Cryptographic Spec Hash Integrity & Visual Layout Invariance', () => {

    describe('2.1 Semantic Mutation Sensitivity (computeAgentSpecHash)', () => {
      const baseGraph = createCleanGraph();
      const baseHash = computeAgentSpecHash(baseGraph);

      it('changes hash when LLM model changes', () => {
        const mutated = JSON.parse(JSON.stringify(baseGraph));
        mutated.nodes.find((n: any) => n.id === 'node_reasoner').config.model = 'claude-3-5-sonnet';
        const mutatedHash = computeAgentSpecHash(mutated);
        assert.notEqual(mutatedHash, baseHash);
      });

      it('changes hash when system prompt changes', () => {
        const mutated = JSON.parse(JSON.stringify(baseGraph));
        mutated.nodes.find((n: any) => n.id === 'node_reasoner').config.prompt = 'Nuevo prompt alterado.';
        const mutatedHash = computeAgentSpecHash(mutated);
        assert.notEqual(mutatedHash, baseHash);
      });

      it('changes hash when node kind changes', () => {
        const mutated = JSON.parse(JSON.stringify(baseGraph));
        mutated.nodes.find((n: any) => n.id === 'node_tool').kind = 'agent';
        const mutatedHash = computeAgentSpecHash(mutated);
        assert.notEqual(mutatedHash, baseHash);
      });

      it('changes hash when entryNodeId changes', () => {
        const mutated = { ...baseGraph, entryNodeId: 'node_guard' };
        const mutatedHash = computeAgentSpecHash(mutated);
        assert.notEqual(mutatedHash, baseHash);
      });

      it('changes hash when edge condition changes', () => {
        const mutated = JSON.parse(JSON.stringify(baseGraph));
        mutated.edges[0].condition = 'state.isVIP === true';
        const mutatedHash = computeAgentSpecHash(mutated);
        assert.notEqual(mutatedHash, baseHash);
      });

      it('changes hash when policyRef changes', () => {
        const mutated = { ...baseGraph, policyRef: 'policy_strict_enterprise' };
        const mutatedHash = computeAgentSpecHash(mutated);
        assert.notEqual(mutatedHash, baseHash);
      });

      it('changes hash when operational limits change (maxSteps, maxCostMicroUsd, etc.)', () => {
        const mutatedSteps = {
          ...baseGraph,
          limits: { ...baseGraph.limits, maxSteps: 30 },
        };
        assert.notEqual(computeAgentSpecHash(mutatedSteps), baseHash);

        const mutatedCost = {
          ...baseGraph,
          limits: { ...baseGraph.limits, maxCostMicroUsd: 1000000 },
        };
        assert.notEqual(computeAgentSpecHash(mutatedCost), baseHash);

        const mutatedTokens = {
          ...baseGraph,
          limits: { ...baseGraph.limits, maxModelTokens: 8000 },
        };
        assert.notEqual(computeAgentSpecHash(mutatedTokens), baseHash);
      });

      it('fails publication gate with SPEC_HASH_MISMATCH when graph was modified without recomputing hash', () => {
        const staleGraph = {
          ...baseGraph,
          policyRef: 'policy_altered_silently',
          specHash: baseHash, // Stale!
        };
        const result = PublicationGate.validate(staleGraph, createPassingScorecard(100.0));
        assert.equal(result.allowed, false);
        const blocker = result.blockers.find((b) => b.code === 'SPEC_HASH_MISMATCH');
        assert.ok(blocker);
        assert.ok(blocker.message.includes(baseHash));
      });
    });

    describe('2.2 Visual Layout Invariance (computeAgentSpecHash & computeStudioSpecHash)', () => {
      const baseGraph = createCleanGraph();
      const baseHash = computeAgentSpecHash(baseGraph);

      it('preserves exact backend specHash when altering visual UI coordinates and labels', () => {
        const layoutAlteredGraph: any = {
          ...baseGraph,
          nodes: baseGraph.nodes.map((n, i) => ({
            ...n,
            label: `UI Label ${i} (Altered)`,
            position: { x: (i + 1) * 350, y: (i + 1) * 180 },
            selected: true,
            isDraftModified: true,
          })),
        };

        const alteredHash = computeAgentSpecHash(layoutAlteredGraph);
        assert.equal(alteredHash, baseHash, 'specHash must remain invariant under UI visual layout changes');
      });

      it('preserves exact backend specHash regardless of node and edge array ordering', () => {
        const shuffledGraph: AgentGraphVersionV1 = {
          ...baseGraph,
          nodes: [...baseGraph.nodes].reverse(),
          edges: [...baseGraph.edges].reverse(),
        };

        const shuffledHash = computeAgentSpecHash(shuffledGraph);
        assert.equal(shuffledHash, baseHash, 'specHash must remain invariant under node/edge array ordering');
      });

      it('preserves frontend computeStudioSpecHash when node canvas coordinates (x, y) move', () => {
        const studioDocBase: any = {
          entryNodeId: 'node_trigger',
          nodes: [
            { id: 'node_trigger', kind: 'trigger', position: { x: 100, y: 150 }, config: { channel: 'whatsapp' } },
            { id: 'node_reasoner', kind: 'llm_reasoner', position: { x: 400, y: 150 }, config: { model: 'gpt-4o' } },
          ],
          edges: [
            { id: 'e1', sourceNodeId: 'node_trigger', targetNodeId: 'node_reasoner' },
          ],
          policyRef: 'policy_std',
          limits: { maxSteps: 15 },
        };

        const hash1 = computeStudioSpecHash(studioDocBase);

        // Move cards across canvas
        const studioDocMoved: any = {
          ...studioDocBase,
          nodes: [
            { id: 'node_trigger', kind: 'trigger', position: { x: 9999, y: 8888 }, config: { channel: 'whatsapp' } },
            { id: 'node_reasoner', kind: 'llm_reasoner', position: { x: -500, y: -200 }, config: { model: 'gpt-4o' } },
          ],
        };

        const hash2 = computeStudioSpecHash(studioDocMoved);
        assert.equal(hash1, hash2, 'computeStudioSpecHash must remain identical after dragging cards');

        // But mutating config must alter the studio spec hash
        const studioDocMutated: any = {
          ...studioDocBase,
          nodes: [
            { id: 'node_trigger', kind: 'trigger', position: { x: 100, y: 150 }, config: { channel: 'whatsapp' } },
            { id: 'node_reasoner', kind: 'llm_reasoner', position: { x: 400, y: 150 }, config: { model: 'claude-3-opus' } },
          ],
        };
        const hash3 = computeStudioSpecHash(studioDocMutated);
        assert.notEqual(hash1, hash3, 'computeStudioSpecHash must change when reasoning config is modified');
      });
    });
  });

  // =========================================================================
  // 3. Eval Simulator Sandbox Stress Testing
  // =========================================================================
  describe('3. Eval Simulator Sandbox Stress Testing', () => {

    describe('3.1 Trace Capture & Step Telemetry', () => {
      it('captures full sequential trace with durations, token budgets, and step metrics', async () => {
        const graph = createCleanGraph();
        const scenario: EvalScenarioV1 = {
          id: 'scen_trace_test',
          name: 'Trace verification scenario',
          mockInput: 'Buscar catalogo de vestidos',
          mockConversationState: {},
          expectedTools: ['catalog.search'],
          forbiddenTools: [],
          expectedTextPatterns: ['Respuesta simulada'],
          forbiddenTextPatterns: [],
          assertions: [],
        };

        const result = await evalService.simulateScenario(1, graph, scenario);

        assert.equal(result.passed, true);
        assert.equal(result.scenarioId, 'scen_trace_test');
        assert.deepEqual(result.traceSteps.map(({ nodeKind, status }) => [nodeKind, status]), [
          ['agent', 'completed'],
          ['condition', 'skipped'],
          ['subgraph', 'skipped'],
          ['agent', 'completed'],
          ['tool', 'completed'],
          ['end', 'completed'],
        ]);

        // Verify sequential monotonic step indexing
        result.traceSteps.forEach((step, idx) => {
          assert.equal(step.step, idx + 1);
          assert.ok(step.nodeId);
          assert.ok(step.nodeKind);
          if (step.status === 'skipped') {
            assert.deepEqual(step.outputPayload, { behavior: 'traversal_only' });
            assert.equal(step.costMicroUsd, 0);
            assert.equal(step.tokensUsed, 0);
          }
          assert.ok(step.durationMs >= 1);
          assert.ok(step.costMicroUsd >= 0);
          assert.ok(step.tokensUsed >= 0);
          assert.ok(typeof step.outputPayload === 'object');
        });

        assert.ok(result.tokensUsed > 0);
        assert.ok(result.costMicroUsd > 0);
        assert.ok(result.durationMs >= 1);
      });
    });

    describe('3.2 Step Limit Budget Exhaustion & Sandbox Infinite Loop Containment', () => {
      it('terminates cleanly within bounded maxSteps without hanging when graph contains a loop', async () => {
        const clean = createCleanGraph();
        const loopingGraph: AgentGraphVersionV1 = {
          ...clean,
          limits: { ...clean.limits, maxSteps: 5 }, // Strict 5-step limit
          edges: [
            { id: 'e1', from: 'node_trigger', to: 'node_guard' },
            { id: 'e2', from: 'node_guard', to: 'node_memory' },
            { id: 'e3', from: 'node_memory', to: 'node_guard' }, // Cycle between guard & memory!
          ],
        };

        const scenario: EvalScenarioV1 = {
          id: 'scen_loop_containment',
          name: 'Infinite loop containment test',
          mockInput: 'Loop test message',
          mockConversationState: {},
          expectedTools: [],
          forbiddenTools: [],
          expectedTextPatterns: [],
          forbiddenTextPatterns: [],
          assertions: [],
        };

        const startTime = Date.now();
        const result = await evalService.simulateScenario(1, loopingGraph, scenario);
        const elapsed = Date.now() - startTime;

        assert.ok(elapsed < 2000, `Execution should finish immediately, took ${elapsed}ms`);
        assert.equal(result.passed, false);
        assert.equal(result.traceSteps.length, 5, 'Trace steps should be strictly bounded by maxSteps = 5');
        assert.ok(
          result.failureReasons.some((r) => r.includes('exceeded maximum budget of 5 steps')),
          'Expected budget exhaustion failure reason'
        );
      });
    });

    describe('3.3 Latency Distribution & Suite Cost Aggregation', () => {
      it('accurately computes P50, P95, and aggregates token/cost metrics across 10 scenarios', async () => {
        const graph = createCleanGraph();
        const scenarios: EvalScenarioV1[] = Array.from({ length: 10 }, (_, i) => ({
          id: `scen_${i + 1}`,
          name: `Scenario ${i + 1}`,
          mockInput: i % 2 === 0 ? 'buscar catalogo' : 'saludo general',
          mockConversationState: {},
          expectedTools: i % 2 === 0 ? ['catalog.search'] : [],
          forbiddenTools: ['unauthorized_tool'],
          expectedTextPatterns: ['simulada'],
          forbiddenTextPatterns: ['password_leak'],
          assertions: [],
        }));

        const suite: EvalSuiteV1 = {
          id: 'suite_latency_10',
          tenantId: 1,
          agentGraphId: graph.graphId,
          name: '10-Scenario Stress Suite',
          passThresholdPercent: 95.0,
          scenarios,
        };

        const scorecard = await evalService.simulateSuite(1, graph, suite);

        assert.equal(scorecard.totalScenarios, 10);
        assert.equal(scorecard.passedCount, 10);
        assert.equal(scorecard.failedCount, 0);
        assert.equal(scorecard.passRatePercent, 100);

        assert.ok(scorecard.p50LatencyMs >= 1);
        assert.ok(scorecard.p95LatencyMs >= scorecard.p50LatencyMs);

        const sumCost = scorecard.scenarioResults.reduce((acc, s) => acc + s.costMicroUsd, 0);
        const sumTokens = scorecard.scenarioResults.reduce((acc, s) => acc + s.tokensUsed, 0);

        assert.equal(scorecard.totalCostMicroUsd, sumCost);
        assert.equal(scorecard.totalTokensUsed, sumTokens);
      });
    });

    describe('3.4 Dry-Run Sandbox Isolation & Immutability', () => {
      it('does NOT mutate the input graph, nodes, or scenarios during simulation', async () => {
        const originalGraph = createCleanGraph();
        const snapshotGraph = JSON.parse(JSON.stringify(originalGraph));

        const scenario: EvalScenarioV1 = {
          id: 'scen_iso_test',
          name: 'Isolation check scenario',
          mockInput: 'buscar articulos',
          mockConversationState: { key: 'initial' },
          expectedTools: ['catalog.search'],
          forbiddenTools: [],
          expectedTextPatterns: [],
          forbiddenTextPatterns: [],
          assertions: [],
        };
        const snapshotScenario = JSON.parse(JSON.stringify(scenario));

        // Execute simulation
        await evalService.simulateScenario(1, originalGraph, scenario);

        // Verify deep equality post-execution
        assert.deepEqual(originalGraph, snapshotGraph, 'Input graph must not be mutated');
        assert.deepEqual(scenario, snapshotScenario, 'Input scenario must not be mutated');
      });

      it('guarantees statelessness across repeated consecutive runs', async () => {
        const graph = createCleanGraph();
        const scenario: EvalScenarioV1 = {
          id: 'scen_stateless',
          name: 'Stateless check',
          mockInput: 'buscar stock',
          mockConversationState: {},
          expectedTools: ['catalog.search'],
          forbiddenTools: [],
          expectedTextPatterns: [],
          forbiddenTextPatterns: [],
          assertions: [],
        };

        const run1 = await evalService.simulateScenario(1, graph, scenario);
        const run2 = await evalService.simulateScenario(1, graph, scenario);

        assert.equal(run1.passed, run2.passed);
        assert.equal(run1.tokensUsed, run2.tokensUsed);
        assert.equal(run1.costMicroUsd, run2.costMicroUsd);
        assert.equal(run1.traceSteps.length, run2.traceSteps.length);
        assert.deepEqual(run1.executedTools, run2.executedTools);
      });
    });
  });
});
