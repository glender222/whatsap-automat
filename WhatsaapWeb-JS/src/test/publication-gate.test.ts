// Test environment variables before config load
process.env.JWT_SECRET = 'test-only-jwt-secret-with-at-least-32-characters-for-testing';
process.env.DB_PASSWORD = 'test-only-database-password';
process.env.META_TOKEN_ENCRYPTION_KEY = 'test-encryption-key-with-at-least-32-chars-for-aes256';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PublicationGate } from '../services/ai/eval/PublicationGate';
import {
  AgentGraphVersionV1,
  EvalScorecardV1,
  computeAgentSpecHash,
} from '@whatsap-automat/contracts';
import createAiRoutes from '../routes/ai.routes';
import jwt from 'jsonwebtoken';

async function invokeRoute(
  router: any,
  method: 'get' | 'post' | 'delete',
  path: string,
  options: {
    body?: any;
    query?: any;
    params?: any;
    token?: string;
  } = {}
) {
  const layer = router.stack.find(
    (candidate: any) =>
      candidate.route?.path === path && candidate.route?.methods?.[method.toLowerCase()]
  );
  if (!layer) {
    throw new Error(`Route ${method.toUpperCase()} ${path} not found in router stack`);
  }

  let statusCode = 200;
  let jsonBody: any = null;

  const req: any = {
    method: method.toUpperCase(),
    params: options.params || {},
    query: options.query || {},
    body: options.body || {},
    headers: options.token ? { authorization: `Bearer ${options.token}` } : {},
    originalUrl: `/api/v1/ai${path}`,
  };

  const res: any = {
    setHeader() { return res; },
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(data: any) {
      jsonBody = data;
      return res;
    },
  };

  for (const mw of layer.route.stack) {
    let calledNext = false;
    let nextErr: any = null;
    try {
      await mw.handle(req, res, (err: any) => {
        calledNext = true;
        nextErr = err;
      });
    } catch (caughtErr) {
      nextErr = caughtErr;
    }

    if (nextErr) {
      return {
        status: nextErr.statusCode || (nextErr.name === 'JsonWebTokenError' ? 401 : 500),
        body: { error: nextErr.code || 'ERROR', message: nextErr.message },
      };
    }

    if (!calledNext) {
      break;
    }
  }

  return { status: statusCode, body: jsonBody };
}

describe('PR-F5-03: Pre-Deploy Publication Gate & Security Boundary Tests', () => {
  const { generateAccessToken } = require('../utils/jwt');
  const token = generateAccessToken({ id: 1, sub: 'user_1', tenantId: 1, companyId: 1, role: 'admin', rol: 'ADMIN' });

  const validGraphBase: Omit<AgentGraphVersionV1, 'specHash'> = {
    schemaVersion: 1,
    graphId: 'agent_graph_sales',
    version: 1,
    tenantId: '1',
    entryNodeId: 'node_trigger',
    nodes: [
      { id: 'node_trigger', kind: 'agent', config: { channel: 'whatsapp' } },
      { id: 'node_reasoner', kind: 'agent', config: { model: 'gpt-4o' } },
      { id: 'node_end', kind: 'end', config: {} },
    ],
    edges: [
      { id: 'e1', from: 'node_trigger', to: 'node_reasoner' },
      { id: 'e2', from: 'node_reasoner', to: 'node_end' },
    ],
    policyRef: 'policy_standard',
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

  const validSpecHash = computeAgentSpecHash(validGraphBase);
  const validGraph: AgentGraphVersionV1 = {
    ...validGraphBase,
    specHash: validSpecHash,
  };

  const validScorecard: EvalScorecardV1 = {
    suiteId: 'suite_1',
    suiteName: 'Regression Suite',
    agentGraphId: 'agent_graph_sales',
    graphVersion: 1,
    passRatePercent: 96.5,
    totalScenarios: 20,
    passedCount: 19,
    failedCount: 1,
    p50LatencyMs: 120,
    p95LatencyMs: 340,
    totalCostMicroUsd: 15000,
    totalTokensUsed: 6000,
    regressionDetected: false,
    securityToolLeaks: [],
    scenarioResults: [],
    timestamp: new Date().toISOString(),
  };

  describe('1. Topology Cycle Detection (DFS 3-Coloring)', () => {
    it('detects no cycles in a clean feedforward DAG', () => {
      const cycleRes = PublicationGate.detectCycles(validGraph);
      assert.equal(cycleRes.hasCycle, false);
      assert.equal(cycleRes.path.length, 0);
    });

    it('detects direct circular loop (A -> B -> A)', () => {
      const cyclicGraph = {
        nodes: [{ id: 'A' }, { id: 'B' }],
        edges: [
          { id: 'e1', from: 'A', to: 'B' },
          { id: 'e2', from: 'B', to: 'A' },
        ],
      } as any;

      const cycleRes = PublicationGate.detectCycles(cyclicGraph);
      assert.equal(cycleRes.hasCycle, true);
      assert.ok(cycleRes.path.includes('A'));
      assert.ok(cycleRes.path.includes('B'));
    });

    it('detects indirect loop (A -> B -> C -> D -> B)', () => {
      const cyclicGraph = {
        nodes: [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }],
        edges: [
          { id: 'e1', from: 'A', to: 'B' },
          { id: 'e2', from: 'B', to: 'C' },
          { id: 'e3', from: 'C', to: 'D' },
          { id: 'e4', from: 'D', to: 'B' },
        ],
      } as any;

      const cycleRes = PublicationGate.detectCycles(cyclicGraph);
      assert.equal(cycleRes.hasCycle, true);
      assert.ok(cycleRes.path.length >= 3);
    });
  });

  describe('2. Four Non-Negotiable Publication Conditions', () => {
    it('approves publication when all criteria are satisfied (pass rate >= 95%, 0 leaks, 0 cycles, hash match)', () => {
      const gateResult = PublicationGate.validate(validGraph, validScorecard);
      assert.equal(gateResult.allowed, true);
      assert.equal(gateResult.blockers.length, 0);
      assert.equal(gateResult.cycleDetected, false);
      assert.equal(gateResult.securityToolLeaksCount, 0);
      assert.equal(gateResult.computedSpecHash, validSpecHash);
    });

    it('blocks publication when pass rate is below 95% (e.g. 94.8%)', () => {
      const failingScorecard: EvalScorecardV1 = {
        ...validScorecard,
        passRatePercent: 94.8,
        passedCount: 18,
        failedCount: 2,
      };

      const gateResult = PublicationGate.validate(validGraph, failingScorecard);
      assert.equal(gateResult.allowed, false);
      assert.ok(gateResult.blockers.some((b) => b.code === 'PASS_RATE_BELOW_THRESHOLD'));
    });

    it('blocks publication when security tool leak is detected', () => {
      const leakingScorecard: EvalScorecardV1 = {
        ...validScorecard,
        securityToolLeaks: ['system_shell_exec'],
      };

      const gateResult = PublicationGate.validate(validGraph, leakingScorecard);
      assert.equal(gateResult.allowed, false);
      assert.ok(gateResult.blockers.some((b) => b.code === 'SECURITY_TOOL_LEAK'));
    });

    it('blocks publication on cryptographic spec hash mismatch', () => {
      const tamperedGraph: AgentGraphVersionV1 = {
        ...validGraph,
        specHash: 'hash_tampered_000000000000000000000000000000000000000000000000000000',
      };

      const gateResult = PublicationGate.validate(tamperedGraph, validScorecard);
      assert.equal(gateResult.allowed, false);
      assert.ok(gateResult.blockers.some((b) => b.code === 'SPEC_HASH_MISMATCH'));
    });

    it('blocks publication when graph topology contains an infinite cycle', () => {
      const cyclicGraph: AgentGraphVersionV1 = {
        ...validGraph,
        edges: [
          ...validGraph.edges,
          { id: 'cycle_edge', from: 'node_end', to: 'node_trigger' },
        ],
      };
      const hash = computeAgentSpecHash(cyclicGraph);
      const cyclicGraphWithHash = { ...cyclicGraph, specHash: hash };

      const gateResult = PublicationGate.validate(cyclicGraphWithHash, validScorecard);
      assert.equal(gateResult.allowed, false);
      assert.ok(gateResult.blockers.some((b) => b.code === 'GRAPH_CYCLE_DETECTED'));
    });
  });

  describe('3. REST Route POST /api/v1/ai/agents/:id/publish', () => {
    const router = createAiRoutes();

    it('returns 200 OK and publishes when publication gate validates successfully', async () => {
      const res = await invokeRoute(router, 'post', '/agents/:id/publish', {
        token,
        params: { id: 'agent_graph_sales' },
        body: {
          graph: validGraph,
          scorecard: validScorecard,
        },
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.data.agentGraphId, 'agent_graph_sales');
      assert.equal(res.body.data.specHash, validSpecHash);
    });

    it('returns 422 PUBLICATION_GATE_BLOCKED when publication gate conditions are violated', async () => {
      const failingScorecard = {
        ...validScorecard,
        passRatePercent: 91.0,
      };

      const res = await invokeRoute(router, 'post', '/agents/:id/publish', {
        token,
        params: { id: 'agent_graph_sales' },
        body: {
          graph: validGraph,
          scorecard: failingScorecard,
        },
      });

      assert.equal(res.status, 422);
      assert.equal(res.body.success, false);
      assert.equal(res.body.error, 'PUBLICATION_GATE_BLOCKED');
      assert.equal(res.body.gateResult.allowed, false);
      assert.ok(res.body.gateResult.blockers.length >= 1);
    });
  });
});
