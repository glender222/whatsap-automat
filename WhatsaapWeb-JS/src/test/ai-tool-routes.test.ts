// Invariants before config load
process.env.JWT_SECRET = 'test-only-jwt-secret-with-at-least-32-characters-for-testing';
process.env.DB_PASSWORD = 'test-only-database-password';
process.env.META_TOKEN_ENCRYPTION_KEY = 'test-encryption-key-with-at-least-32-chars-for-aes256';

import assert from 'node:assert/strict';
import { describe, test, beforeEach } from 'node:test';
const jwt = require('jsonwebtoken');

const createAiRoutes = require('../routes/ai.routes').default as typeof import('../routes/ai.routes').default;
const { createBrokerFixtureRegistry } = require('./fixtures/brokerTools') as typeof import('./fixtures/brokerTools');
const {
  ToolBroker,
  ToolRegistry,
  HitlApprovalService,
  EffectCache,
} = require('../services/ai/broker') as typeof import('../services/ai/broker');
const { ConversationCasService } = require('../services/conversations/ConversationCasService') as typeof import('../services/conversations/ConversationCasService');
import type { Queryable } from '../shared/UnitOfWorkPort';
import type { TenantScopedUoW } from '../db/TenantScopedUoW';

function createMockUow() {
  const store = {
    conversations: new Map<string, any>(),
    approvals: new Map<string, any>(),
    effects: new Map<string, any>(),
    grants: new Map<string, any>(),
  };

  const mockClient: Queryable = {
    async query(sql: string, params: any[] = []): Promise<any> {
      if (sql.includes('JOIN memberships m')) {
        const rows = params[0] === 1 && params[1] === 42
          ? [{ tenant_name: 'Fixture', id: 1, name: 'Principal', slug: 'default', role: 'owner', user_role: 'ADMIN' }]
          : [];
        return { rowCount: rows.length, rows };
      }
      // 1. SELECT conversation state
      if (sql.includes('FROM conversations')) {
        const convId = String(params[0]);
        const tenantId = Number(params[1]);
        const conv = store.conversations.get(`${tenantId}:${convId}`);
        if (!conv) return { rowCount: 0, rows: [] };
        return {
          rowCount: 1,
          rows: [{
            id: conv.id,
            version: conv.version,
            ownership_epoch: conv.ownership_epoch,
            owner_type: conv.owner_type,
            owner_id: conv.owner_id,
            ia_paused: conv.ia_paused,
          }],
        };
      }

      // 2. INSERT into approval_requests
      if (sql.includes('INSERT INTO approval_requests')) {
        const approval = {
          id: params[0],
          tenant_id: params[1],
          run_id: params[2],
          agent_graph_id: params[3],
          node_id: params[4],
          tool_name: params[5],
          effect_key: params[6],
          proposed_action_hash: params[7],
          risk: params[8],
          status: 'pending',
          input_payload: typeof params[9] === 'string' ? JSON.parse(params[9]) : params[9],
          redacted_details: typeof params[10] === 'string' ? JSON.parse(params[10]) : params[10],
          conversation_id: params[11],
          expected_conversation_version: params[12],
          version: 1,
          expires_at: params[13],
          created_at: new Date().toISOString(),
        };
        store.approvals.set(`${approval.tenant_id}:${approval.id}`, approval);
        store.approvals.set(`effect:${approval.tenant_id}:${approval.effect_key}`, approval);
        return { rowCount: 1, rows: [approval] };
      }

      // 3. SELECT from approval_requests by effect_key
      if (sql.includes('FROM approval_requests') && sql.includes('effect_key = $2')) {
        const tenantId = params[0];
        const effectKey = params[1];
        const app = store.approvals.get(`effect:${tenantId}:${effectKey}`);
        if (!app) return { rowCount: 0, rows: [] };
        return { rowCount: 1, rows: [app] };
      }

      // 4. SELECT from approval_requests by id
      if (sql.includes('FROM approval_requests') && (sql.includes(' id = $1') || sql.includes(' id = $2'))) {
        let tenantId: number;
        let id: string;
        if (sql.includes(' id = $1')) {
          id = String(params[0]);
          tenantId = Number(params[1]);
        } else {
          tenantId = Number(params[0]);
          id = String(params[1]);
        }
        const app = store.approvals.get(`${tenantId}:${id}`);
        if (!app) return { rowCount: 0, rows: [] };
        return { rowCount: 1, rows: [app] };
      }

      // 5. SELECT all pending approval_requests for tenant
      if (sql.includes('FROM approval_requests') && sql.includes("status = 'pending'")) {
        const tenantId = params[0];
        const uniqueApprovals = Array.from(new Map(Array.from(store.approvals.values()).map((a) => [a.id, a])).values());
        const rows = uniqueApprovals.filter((a) => a.tenant_id === tenantId && a.status === 'pending');
        return { rowCount: rows.length, rows };
      }

      // 6. UPDATE approval_requests (CAS decision)
      if (sql.includes('UPDATE approval_requests')) {
        const decision = params[0];
        const actorId = params[1];
        const reason = params[2];
        const approvalId = params[3];
        const tenantId = params[4];
        const expectedVer = params[5];

        const app = store.approvals.get(`${tenantId}:${approvalId}`);
        if (!app || app.version !== expectedVer || app.status !== 'pending') {
          return { rowCount: 0, rows: [] };
        }

        app.status = decision;
        app.decided_by = actorId;
        app.decision_reason = reason;
        app.decided_at = new Date().toISOString();
        app.version += 1;

        return { rowCount: 1, rows: [app] };
      }

      // 7. SELECT / INSERT tool_execution_effects
      if (sql.includes('FROM tool_execution_effects')) {
        const tenantId = params[0];
        const effectKey = params[1];
        const eff = store.effects.get(`${tenantId}:${effectKey}`);
        if (!eff) return { rowCount: 0, rows: [] };
        return { rowCount: 1, rows: [eff] };
      }

      if (sql.includes('INSERT INTO tool_execution_effects')) {
        const record = {
          tenant_id: params[0],
          effect_key: params[1],
          run_id: params[2],
          tool_name: params[3],
          status: params[4],
          output: typeof params[5] === 'string' ? JSON.parse(params[5]) : params[5],
        };
        store.effects.set(`${record.tenant_id}:${record.effect_key}`, record);
        return { rowCount: 1, rows: [record] };
      }

      // 8. SELECT agent_tool_grants
      if (sql.includes('FROM agent_tool_grants')) {
        const tenantId = params[0];
        const toolName = params[1];
        const grant = store.grants.get(`${tenantId}:${toolName}`);
        if (!grant) return { rowCount: 0, rows: [] };
        return { rowCount: 1, rows: [grant] };
      }

      return { rowCount: 0, rows: [] };
    },
  };

  return {
    store,
    async run<T>(tenantId: any, work: (client: Queryable) => Promise<T>): Promise<T> {
      return work(mockClient);
    },
  } as unknown as TenantScopedUoW & { store: typeof store };
}

async function invokeExpressRoute(
  router: any,
  method: 'get' | 'post',
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
  assert.ok(layer, `Route ${method.toUpperCase()} ${path} must exist in router stack`);

  let statusCode = 200;
  let jsonBody: any = null;
  const resHeaders: Record<string, string> = {};

  const req: any = {
    method: method.toUpperCase(),
    params: options.params || {},
    query: options.query || {},
    body: options.body || {},
    headers: options.token ? { authorization: `Bearer ${options.token}` } : {},
    originalUrl: `/api/v1/ai${path}`,
  };

  const res: any = {
    setHeader(name: string, value: string) {
      resHeaders[name.toLowerCase()] = value;
      return res;
    },
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
        error: nextErr,
      };
    }

    if (!calledNext) {
      break;
    }
  }

  return { status: statusCode, headers: resHeaders, body: jsonBody };
}

describe('PR-F5-02: AI ToolBroker Express Routes Integration (/api/v1/ai/tools & /approvals)', () => {
  const JWT_SECRET = process.env.JWT_SECRET!;
  let mockUow: any;
  let registry: any;
  let hitlService: any;
  let casService: any;
  let effectCache: any;
  let broker: any;
  let router: any;

  function createValidToken(tenantId: number = 1, role: string = 'agent', userId: number = 42): string {
    return jwt.sign(
      {
        userId,
        tenantId,
        companyId: tenantId,
        role,
        roles: [role],
      },
      JWT_SECRET,
      { expiresIn: '1h' }
    );
  }

  beforeEach(() => {
    mockUow = createMockUow();
    registry = createBrokerFixtureRegistry(mockUow);
    hitlService = new HitlApprovalService(mockUow);
    casService = new ConversationCasService(mockUow);
    effectCache = new EffectCache(mockUow);
    broker = new ToolBroker({
      uow: mockUow,
      registry,
      hitlService,
      casService,
      effectCache,
    });

    router = createAiRoutes({
      toolBroker: broker,
      toolRegistry: registry,
      hitlApprovalService: hitlService,
    });
  });

  describe('Route: GET /tools', () => {
    test('requires JWT authentication (401 when missing)', async () => {
      const res = await invokeExpressRoute(router, 'get', '/tools');
      assert.equal(res.status, 401);
    });

    test('returns 200 with all 4 standard tools and 5-tier risk levels', async () => {
      const token = createValidToken(1, 'agent');
      const res = await invokeExpressRoute(router, 'get', '/tools', { token });

      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.ok(Array.isArray(res.body.data));

      const toolNames = res.body.data.map((t: any) => t.name);
      assert.ok(toolNames.includes('http_request'));
      assert.ok(toolNames.includes('search_knowledge'));
      assert.ok(toolNames.includes('send_whatsapp_message'));
      assert.ok(toolNames.includes('create_invoice'));

      const invoiceTool = res.body.data.find((t: any) => t.name === 'create_invoice');
      assert.equal(invoiceTool.riskLevel, 'financial');
      assert.equal(invoiceTool.requiresApproval, true);
    });
  });

  describe('Route: POST /tools/execute', () => {
    test('rejects caller-supplied actor roles for a restricted tool', async () => {
      const token = createValidToken(1, 'operator');
      const res = await invokeExpressRoute(router, 'post', '/tools/execute', {
        token,
        body: {
          agentGraphId: 'graph_01',
          runId: 'run_01',
          toolName: 'http_request',
          input: { url: 'https://example.invalid' },
          actorId: 'pretend_admin',
          actorRoles: ['admin'],
        },
      });

      assert.equal(res.status, 403);
      assert.equal(res.body.data.status, 'unauthorized');
    });

    test('returns 400 VALIDATION_ERROR on malformed request body', async () => {
      const token = createValidToken(1, 'agent');
      const res = await invokeExpressRoute(router, 'post', '/tools/execute', {
        token,
        body: { toolName: '' }, // Missing required fields
      });

      assert.equal(res.status, 400);
      assert.equal(res.body.error, 'VALIDATION_ERROR');
    });

    test('returns 200 with executed result on safe search_knowledge invocation', async () => {
      const token = createValidToken(1, 'agent');
      const res = await invokeExpressRoute(router, 'post', '/tools/execute', {
        token,
        body: {
          agentGraphId: 'graph_01',
          runId: 'run_01',
          toolName: 'search_knowledge',
          input: { query: 'política de reembolsos' },
        },
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.data.status, 'executed');
      assert.ok(res.body.data.output);
    });

    test('returns 403 on SSRF blocked destination (169.254.169.254)', async () => {
      const token = createValidToken(1, 'agent');
      const res = await invokeExpressRoute(router, 'post', '/tools/execute', {
        token,
        body: {
          agentGraphId: 'graph_01',
          runId: 'run_01',
          toolName: 'http_request',
          input: { url: 'http://169.254.169.254/latest/meta-data/' },
        },
      });

      assert.equal(res.status, 403);
      assert.equal(res.body.data.status, 'ssrf_blocked');
      assert.equal(res.body.data.error.code, 'SSRF_BLOCKED');
    });

    test('returns 429 when budget limit is exhausted (step > 15)', async () => {
      const token = createValidToken(1, 'agent');
      const res = await invokeExpressRoute(router, 'post', '/tools/execute', {
        token,
        body: {
          agentGraphId: 'graph_01',
          runId: 'run_01',
          toolName: 'search_knowledge',
          input: { query: 'test' },
          currentStep: 16,
        },
      });

      assert.equal(res.status, 429);
      assert.equal(res.body.data.status, 'budget_exhausted');
    });

    test('returns 409 cas_conflict when conversation is taken over by human', async () => {
      mockUow.store.conversations.set('1:201', {
        id: 201,
        version: 4,
        ownership_epoch: 2,
        owner_type: 'human',
        owner_id: 'operator_bob',
        ia_paused: true,
      });

      const token = createValidToken(1, 'agent');
      const res = await invokeExpressRoute(router, 'post', '/tools/execute', {
        token,
        body: {
          agentGraphId: 'graph_01',
          runId: 'run_01',
          toolName: 'send_whatsapp_message',
          conversationId: 201,
          input: {
            conversationId: 201,
            messageText: 'AI automated message',
          },
        },
      });

      assert.equal(res.status, 409);
      assert.equal(res.body.data.status, 'cas_conflict');
      assert.equal(res.body.data.error.code, 'HUMAN_TAKEOVER_ACTIVE');
    });

    test('returns awaiting_approval on financial tool create_invoice', async () => {
      const token = createValidToken(1, 'agent');
      const res = await invokeExpressRoute(router, 'post', '/tools/execute', {
        token,
        body: {
          agentGraphId: 'graph_sales_01',
          runId: 'run_sales_01',
          toolName: 'create_invoice',
          input: {
            customerId: 'cust_8800',
            items: [{ description: 'SaaS Plan', quantity: 1, unitAmountCents: 15000 }],
          },
        },
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.data.status, 'awaiting_approval');
      assert.equal(res.body.data.hitlRequired, true);
      assert.ok(res.body.data.approvalId);
    });
  });

  describe('Route: GET /approvals & POST /approvals/:id/decision', () => {
    test('requires an authorized approver instead of trusting the body', async () => {
      const token = createValidToken(1, 'operator');
      const res = await invokeExpressRoute(router, 'post', '/approvals/:id/decision', {
        token,
        params: { id: 'approval_not_accessible' },
        body: { decision: 'approved', expectedVersion: 1, actorRole: 'admin' },
      });

      assert.equal(res.status, 403);
      assert.equal(res.body.error, 'POLICY_DENIED');
    });

    test('lists pending approvals for tenant', async () => {
      const token = createValidToken(1, 'ADMIN');

      // Create an approval first
      await hitlService.createApprovalRequest({
        tenantId: 1,
        runId: 'run_01',
        toolName: 'create_invoice',
        effectKey: 'eff_test_01',
        proposedActionHash: 'hash01',
        risk: 'financial',
        inputPayload: { amount: 500 },
      });

      const res = await invokeExpressRoute(router, 'get', '/approvals', { token });
      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.data.length, 1);
      assert.equal(res.body.data[0].risk, 'financial');
    });

    test('processes approval decision with CAS expectedVersion', async () => {
      const token = createValidToken(1, 'ADMIN');

      const app = await hitlService.createApprovalRequest({
        tenantId: 1,
        runId: 'run_02',
        toolName: 'create_invoice',
        effectKey: 'eff_test_02',
        proposedActionHash: 'hash02',
        risk: 'write',
        inputPayload: { amount: 999 },
      });

      // Valid decision with expectedVersion = 1
      const res = await invokeExpressRoute(router, 'post', '/approvals/:id/decision', {
        token,
        params: { id: app.id },
        body: {
          decision: 'approved',
          reason: 'Authorized by manager',
          expectedVersion: 1,
        },
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.data.status, 'approved');

      // Second decision attempt with stale expectedVersion 1 returns 409
      const staleRes = await invokeExpressRoute(router, 'post', '/approvals/:id/decision', {
        token,
        params: { id: app.id },
        body: {
          decision: 'approved',
          expectedVersion: 1, // Already at version 2
        },
      });

      assert.equal(staleRes.status, 409);
    });

    test('rejects decision with invalid decision value (400)', async () => {
      const token = createValidToken(1, 'supervisor');
      const res = await invokeExpressRoute(router, 'post', '/approvals/:id/decision', {
        token,
        params: { id: 'appr_123' },
        body: {
          decision: 'maybe', // Invalid
          expectedVersion: 1,
        },
      });

      assert.equal(res.status, 400);
      assert.equal(res.body.error, 'VALIDATION_ERROR');
    });
  });
});
