import './fixtures/testEnv';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AgentEvalService } from '../services/ai/eval/AgentEvalService';
import type { AgentGraphVersionV1, EvalSuiteV1, EvalScenarioV1 } from '@whatsap-automat/contracts';
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

describe('PR-F5-03: AgentEvalService Dry-Run Simulator & Regression Harness Tests', () => {
  const evalService = new AgentEvalService();
  const { generateAccessToken } = require('../utils/jwt');
  const token = generateAccessToken({ id: 1, sub: 'user_1', tenantId: 1, companyId: 1, role: 'admin', rol: 'ADMIN' });

  const sampleGraph: AgentGraphVersionV1 = {
    schemaVersion: 1,
    graphId: 'graph_support_agent',
    version: 1,
    tenantId: '1',
    entryNodeId: 'node_trigger',
    nodes: [
      { id: 'node_trigger', kind: 'agent', config: { channel: 'whatsapp' } },
      { id: 'node_guard', kind: 'condition', config: { policy: 'business_hours' } },
      { id: 'node_retrieval', kind: 'subgraph', config: { collection: 'kb_support' } },
      { id: 'node_llm', kind: 'agent', config: { model: 'gpt-4o', temperature: 0.2 } },
      { id: 'node_tool', kind: 'tool', config: { toolName: 'inventory.check_stock' } },
      { id: 'node_end', kind: 'end', config: {} },
    ],
    edges: [
      { id: 'e1', from: 'node_trigger', to: 'node_guard' },
      { id: 'e2', from: 'node_guard', to: 'node_retrieval' },
      { id: 'e3', from: 'node_retrieval', to: 'node_llm' },
      { id: 'e4', from: 'node_llm', to: 'node_tool' },
      { id: 'e5', from: 'node_tool', to: 'node_end' },
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
    specHash: 'hash_test_123',
  };

  describe('1. Scenario Dry-Run Execution & Assertion Validation', () => {
    it('executes scenario and verifies passing assertions', async () => {
      const scenario: EvalScenarioV1 = {
        id: 'scen_01',
        name: 'Consulta de stock válida',
        mockInput: 'Tienen stock del producto PROD-101?',
        mockConversationState: {},
        expectedTools: ['inventory.check_stock'],
        forbiddenTools: ['cancel_order'],
        expectedTextPatterns: ['stock'],
        forbiddenTextPatterns: ['confidencial'],
        assertions: [],
      };

      const result = await evalService.simulateScenario(1, sampleGraph, scenario);

      assert.equal(result.passed, true);
      assert.equal(result.scenarioId, 'scen_01');
      assert.ok(result.traceSteps.length >= 4);
      assert.ok(result.tokensUsed > 0);
      assert.ok(result.costMicroUsd > 0);
      assert.ok(result.executedTools.includes('inventory.check_stock'));
      assert.equal(result.failureReasons.length, 0);
    });

    it('detects missing expected tool and flags assertion failure', async () => {
      const scenario: EvalScenarioV1 = {
        id: 'scen_02',
        name: 'Herramienta esperada faltante',
        mockInput: 'Consulta general de horario',
        mockConversationState: {},
        expectedTools: ['uncalled_custom_tool'],
        forbiddenTools: [],
        expectedTextPatterns: [],
        forbiddenTextPatterns: [],
        assertions: [],
      };

      const result = await evalService.simulateScenario(1, sampleGraph, scenario);

      assert.equal(result.passed, false);
      assert.ok(result.failureReasons.some((r) => r.includes('uncalled_custom_tool')));
    });

    it('flags security leak violation when forbidden tool is executed', async () => {
      const scenario: EvalScenarioV1 = {
        id: 'scen_03',
        name: 'Intento de llamar herramienta prohibida',
        mockInput: 'Consultar stock',
        mockConversationState: {},
        expectedTools: [],
        forbiddenTools: ['inventory.check_stock'],
        expectedTextPatterns: [],
        forbiddenTextPatterns: [],
        assertions: [],
      };

      const result = await evalService.simulateScenario(1, sampleGraph, scenario);

      assert.equal(result.passed, false);
      assert.ok(result.failureReasons.some((r) => r.includes('SECURITY_LEAK')));
    });
  });

  describe('2. Evaluation Suite Aggregation & Regression Detection', () => {
    const suite: EvalSuiteV1 = {
      id: 'suite_regression_1',
      tenantId: 1,
      agentGraphId: 'graph_support_agent',
      name: 'Suite de Regresión Atención al Cliente',
      passThresholdPercent: 95.0,
      scenarios: [
        {
          id: 'scen_stock',
          name: 'Verificar stock',
          mockInput: 'Tienen stock disponible?',
          mockConversationState: {},
          expectedTools: ['inventory.check_stock'],
          forbiddenTools: ['cancel_order'],
          expectedTextPatterns: ['stock'],
          forbiddenTextPatterns: [],
          assertions: [],
        },
        {
          id: 'scen_greeting',
          name: 'Saludo inicial',
          mockInput: 'Hola, buenos días',
          mockConversationState: {},
          expectedTools: [],
          forbiddenTools: ['cancel_order'],
          expectedTextPatterns: ['Respuesta simulada'],
          forbiddenTextPatterns: ['password'],
          assertions: [],
        },
      ],
    };

    it('aggregates scorecard metrics: pass rate %, P50, P95, and cost', async () => {
      const scorecard = await evalService.simulateSuite(1, sampleGraph, suite);

      assert.equal(scorecard.totalScenarios, 2);
      assert.equal(scorecard.passedCount, 2);
      assert.equal(scorecard.failedCount, 0);
      assert.equal(scorecard.passRatePercent, 100);
      assert.ok(scorecard.p50LatencyMs >= 0);
      assert.ok(scorecard.p95LatencyMs >= scorecard.p50LatencyMs);
      assert.ok(scorecard.totalCostMicroUsd > 0);
      assert.equal(scorecard.securityToolLeaks.length, 0);
      assert.equal(scorecard.regressionDetected, false);
    });

    it('detects regression when compared to a baseline scorecard', async () => {
      const baselineScorecard = await evalService.simulateSuite(1, sampleGraph, suite);

      const failingSuite: EvalSuiteV1 = {
        ...suite,
        scenarios: [
          suite.scenarios[0],
          {
            ...suite.scenarios[1],
            expectedTools: ['missing_tool_triggers_failure'],
          },
        ],
      };

      const newScorecard = await evalService.simulateSuite(1, sampleGraph, failingSuite, baselineScorecard);

      assert.equal(newScorecard.passedCount, 1);
      assert.equal(newScorecard.failedCount, 1);
      assert.equal(newScorecard.passRatePercent, 50);
      assert.equal(newScorecard.regressionDetected, true);
      assert.ok(newScorecard.baselineComparison);
      assert.ok(newScorecard.baselineComparison.passRateDelta < 0);
      assert.ok(newScorecard.baselineComparison.newFailures.includes('Saludo inicial'));
    });
  });

  describe('3. Express Route POST /api/v1/ai/eval/simulate', () => {
    const router = createAiRoutes({ evalService });

    it('executes dry-run simulation via REST endpoint and returns 200 with scorecard', async () => {
      const res = await invokeRoute(router, 'post', '/eval/simulate', {
        token,
        body: {
          graph: sampleGraph,
        },
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.mode, 'simulation');
      assert.equal(res.body.publicationEvidence, false);
      assert.equal(res.body.data.agentGraphId, 'graph_support_agent');
      assert.equal(typeof res.body.data.passRatePercent, 'number');
      assert.ok(Array.isArray(res.body.data.scenarioResults));
    });

    it('rejects simulation without JWT with 401', async () => {
      const res = await invokeRoute(router, 'post', '/eval/simulate', {
        body: { graph: sampleGraph },
      });
      assert.equal(res.status, 401);
    });
  });
});
