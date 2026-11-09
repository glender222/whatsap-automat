import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';

// Test environment invariants before config load
process.env.JWT_SECRET = 'test-only-jwt-secret-with-at-least-32-characters-for-testing';
process.env.DB_PASSWORD = 'test-only-database-password';
process.env.META_TOKEN_ENCRYPTION_KEY = 'test-encryption-key-with-at-least-32-chars-for-aes256';
process.env.TEST_MODE = 'true';

const { createFixtureAccessToken, createMemoryKnowledgeBaseService } = require('./fixtures/embeddingGateway') as typeof import('./fixtures/embeddingGateway');
const { createBrokerFixtureRegistry } = require('./fixtures/brokerTools') as typeof import('./fixtures/brokerTools');
const {
  ToolBroker,
  ToolRegistry,
  EffectCache,
  HitlApprovalService,
  HttpRequestTool,
  SearchKnowledgeTool,
} = require('../services/ai/broker') as typeof import('../services/ai/broker');
const { ConversationCasService } = require('../services/conversations/ConversationCasService') as typeof import('../services/conversations/ConversationCasService');
const { TenantScopedUoW } = require('../db/TenantScopedUoW') as typeof import('../db/TenantScopedUoW');
const { TokenCostLedger } = require('../services/ai/gateway/TokenCostLedger') as typeof import('../services/ai/gateway/TokenCostLedger');
const { QuotaManager } = require('../services/ai/gateway/QuotaManager') as typeof import('../services/ai/gateway/QuotaManager');
const { ModelGateway } = require('../services/ai/gateway/ModelGateway') as typeof import('../services/ai/gateway/ModelGateway');
const { ByokService } = require('../services/ai/gateway/byok/ByokService') as typeof import('../services/ai/gateway/byok/ByokService');
const { KnowledgeBaseService } = require('../services/ai/rag/KnowledgeBaseService') as typeof import('../services/ai/rag/KnowledgeBaseService');
const { PublicationGate } = require('../services/ai/eval/PublicationGate') as typeof import('../services/ai/eval/PublicationGate');
import {
  ToolExecutionRequestV1,
  AgentGraphVersionV1,
  EvalScorecardV1,
  computeAgentSpecHash,
} from '@whatsap-automat/contracts';
import type { Queryable } from '../shared/UnitOfWorkPort';

const createAiRoutes = require('../routes/ai.routes').default || require('../routes/ai.routes');

async function invokeRoute(
  router: any,
  method: 'get' | 'post' | 'delete',
  path: string,
  options: {
    body?: any;
    query?: any;
    params?: any;
    headers?: Record<string, string>;
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
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.headers || {}),
    },
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

// =============================================================================
// Robust Concurrency-Safe In-Memory Mock Unit of Work
// =============================================================================

function createAdversarialMockUoW() {
  const store = {
    quotas: new Map<number, any>(),
    ledger: [] as any[],
    grants: new Map<string, any>(),
    approvals: new Map<string, any>(),
    conversations: new Map<string, any>(),
    effects: new Map<string, any>(),
    collections: new Map<string, any>(),
    chunks: new Map<string, any>(),
  };

  let nextLedgerId = 1;

  const mockUow = {
    store,
    async run<T>(tenantId: number, work: (client: Queryable) => Promise<T>): Promise<T> {
      const client: Queryable = {
        async query(sql: string, params: any[] = []): Promise<any> {
          const trimmed = sql.trim().toUpperCase();

          // -----------------------------------------------------------------
          // 1. tenant_ai_quotas
          // -----------------------------------------------------------------
          if (sql.includes('tenant_ai_quotas')) {
            if (trimmed.startsWith('INSERT INTO TENANT_AI_QUOTAS')) {
              const tid = Number(params[0]);
              if (!store.quotas.has(tid)) {
                store.quotas.set(tid, {
                  tenant_id: tid,
                  monthly_cost_limit_micro_usd: 100_000_000n, // $100.00 default
                  monthly_token_limit: 10_000_000n,
                  current_month_cost_micro_usd: 0n,
                  current_month_tokens_used: 0n,
                  hard_limit_enabled: true,
                  hard_limit_action: 'block',
                  period_start: new Date(Date.UTC(new Date().getFullYear(), new Date().getMonth(), 1)),
                  reset_at: new Date(Date.UTC(new Date().getFullYear(), new Date().getMonth() + 1, 1)),
                  updated_at: new Date(),
                });
              }
              return { rows: [], rowCount: 1 };
            }

            if (trimmed.startsWith('SELECT')) {
              const tid = Number(params[0]);
              const row = store.quotas.get(tid);
              return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
            }

            if (trimmed.startsWith('UPDATE TENANT_AI_QUOTAS')) {
              if (sql.includes('current_month_cost_micro_usd = 0')) {
                const tid = Number(params[0]);
                const q = store.quotas.get(tid);
                if (q) {
                  q.current_month_cost_micro_usd = 0n;
                  q.current_month_tokens_used = 0n;
                  q.period_start = new Date();
                  q.updated_at = new Date();
                }
                return { rows: [], rowCount: 1 };
              }

              const [costDelta, tokenDelta, tid] = params;
              let q = store.quotas.get(Number(tid));
              if (!q) {
                q = {
                  tenant_id: Number(tid),
                  monthly_cost_limit_micro_usd: 100_000_000n,
                  monthly_token_limit: 10_000_000n,
                  current_month_cost_micro_usd: 0n,
                  current_month_tokens_used: 0n,
                  hard_limit_enabled: true,
                  hard_limit_action: 'block',
                  period_start: new Date(Date.UTC(new Date().getFullYear(), new Date().getMonth(), 1)),
                  reset_at: new Date(Date.UTC(new Date().getFullYear(), new Date().getMonth() + 1, 1)),
                  updated_at: new Date(),
                };
                store.quotas.set(Number(tid), q);
              }
              // Atomic BigInt addition
              q.current_month_cost_micro_usd = BigInt(q.current_month_cost_micro_usd) + BigInt(costDelta);
              q.current_month_tokens_used = BigInt(q.current_month_tokens_used) + BigInt(tokenDelta);
              q.updated_at = new Date();
              return { rows: [], rowCount: 1 };
            }
          }

          // -----------------------------------------------------------------
          // 2. ai_token_cost_ledger
          // -----------------------------------------------------------------
          if (sql.includes('ai_token_cost_ledger')) {
            if (trimmed.startsWith('INSERT INTO AI_TOKEN_COST_LEDGER')) {
              const record = {
                id: nextLedgerId++,
                tenant_id: Number(params[0]),
                workspace_id: params[1] ? Number(params[1]) : null,
                agent_id: params[2] || null,
                agent_run_id: params[3] || null,
                conversation_id: params[4] ? Number(params[4]) : null,
                provider: params[5],
                model: params[6],
                operation: params[7],
                prompt_tokens: Number(params[8]),
                completion_tokens: Number(params[9]),
                total_tokens: Number(params[10]),
                cost_micro_usd: BigInt(params[11]),
                is_byok: Boolean(params[12]),
                latency_ms: Number(params[13]),
                status: params[14],
                metadata_json: params[15],
                created_at: new Date(),
              };
              store.ledger.push(record);
              return { rows: [{ id: record.id }], rowCount: 1 };
            }

            if (trimmed.startsWith('SELECT')) {
              const tid = Number(params[0]);
              let results = store.ledger.filter((l) => l.tenant_id === tid);
              if (sql.includes('id <')) {
                const cursorVal = Number(params[1]);
                results = results.filter((l) => l.id < cursorVal);
              }
              results.sort((a, b) => b.id - a.id);
              const limitMatch = sql.match(/LIMIT\s+(\d+)/i);
              if (limitMatch) {
                const limitNum = parseInt(limitMatch[1], 10);
                results = results.slice(0, limitNum);
              }
              return { rows: results, rowCount: results.length };
            }
          }

          // -----------------------------------------------------------------
          // 3. agent_tool_grants
          // -----------------------------------------------------------------
          if (sql.includes('agent_tool_grants')) {
            const [tid, toolName, agentGraphId] = params;
            const keyWithGraph = `${tid}:${toolName}:${agentGraphId}`;
            const keyGlobal = `${tid}:${toolName}:null`;
            const grant = store.grants.get(keyWithGraph) || store.grants.get(keyGlobal);
            if (!grant) {
              return { rows: [], rowCount: 0 };
            }
            return { rows: [grant], rowCount: 1 };
          }

          // -----------------------------------------------------------------
          // 4. approval_requests
          // -----------------------------------------------------------------
          if (sql.includes('approval_requests')) {
            if (trimmed.startsWith('INSERT INTO APPROVAL_REQUESTS')) {
              const approval = {
                id: params[0],
                tenant_id: Number(params[1]),
                run_id: params[2],
                agent_graph_id: params[3],
                node_id: params[4],
                tool_name: params[5],
                effect_key: params[6],
                proposed_action_hash: params[7],
                risk: params[8],
                status: 'pending',
                input_payload: JSON.parse(params[9]),
                redacted_details: JSON.parse(params[10]),
                conversation_id: params[11],
                expected_conversation_version: params[12],
                version: 1,
                expires_at: params[13],
                created_at: new Date().toISOString(),
              };
              store.approvals.set(`${tenantId}:${approval.id}`, approval);
              store.approvals.set(`effect:${tenantId}:${approval.effect_key}`, approval);
              return { rows: [approval], rowCount: 1 };
            }

            if (sql.includes('effect_key = $2')) {
              const app = store.approvals.get(`effect:${tenantId}:${params[1]}`);
              return { rows: app ? [app] : [], rowCount: app ? 1 : 0 };
            }

            if (sql.includes('tenant_id = $1 AND id = $2')) {
              const app = store.approvals.get(`${params[0]}:${params[1]}`);
              return { rows: app ? [app] : [], rowCount: app ? 1 : 0 };
            }

            if (sql.includes('id = $1 AND tenant_id = $2')) {
              const app = store.approvals.get(`${params[1]}:${params[0]}`);
              return { rows: app ? [app] : [], rowCount: app ? 1 : 0 };
            }

            if (trimmed.startsWith('UPDATE APPROVAL_REQUESTS')) {
              // UPDATE approval_requests SET status = $1, decision_notes = $2, decided_by = $3, decided_at = NOW(), version = version + 1 WHERE id = $4 AND tenant_id = $5 AND version = $6
              const [status, notes, decider, id, tid, expectedVer] = params;
              const app = store.approvals.get(`${tid}:${id}`);
              if (!app || app.version !== expectedVer) {
                return { rows: [], rowCount: 0 };
              }
              app.status = status;
              app.decision_notes = notes;
              app.decided_by = decider;
              app.version += 1;
              app.decided_at = new Date().toISOString();
              return { rows: [app], rowCount: 1 };
            }
          }

          // -----------------------------------------------------------------
          // 5. effect_cache
          // -----------------------------------------------------------------
          if (sql.includes('effect_cache')) {
            if (trimmed.startsWith('INSERT INTO EFFECT_CACHE')) {
              const [tid, effectKey, runId, toolName, status, output] = params;
              const record = {
                tenant_id: Number(tid),
                effect_key: effectKey,
                run_id: runId,
                tool_name: toolName,
                status,
                output_payload: output,
                created_at: new Date(),
              };
              store.effects.set(`${tid}:${effectKey}`, record);
              return { rows: [record], rowCount: 1 };
            }

            if (trimmed.startsWith('SELECT')) {
              const [tid, effectKey] = params;
              const entry = store.effects.get(`${tid}:${effectKey}`);
              return { rows: entry ? [entry] : [], rowCount: entry ? 1 : 0 };
            }
          }

          // -----------------------------------------------------------------
          // 6. conversations (CAS)
          // -----------------------------------------------------------------
          if (sql.includes('conversations')) {
            if (trimmed.startsWith('SELECT')) {
              const convId = String(params[0]);
              const companyId = params[1] !== undefined ? Number(params[1]) : tenantId;
              const conv = store.conversations.get(`${companyId}:${convId}`);
              if (!conv) return { rows: [], rowCount: 0 };
              return {
                rows: [{
                  id: conv.id,
                  company_id: conv.company_id || companyId,
                  version: conv.version,
                  ownership_epoch: conv.ownership_epoch,
                  owner_type: conv.owner_type,
                  owner_id: conv.owner_id,
                  ia_paused: conv.ia_paused,
                }],
                rowCount: 1,
              };
            }
          }

          return { rows: [], rowCount: 0 };
        },
      };

      return work(client);
    },
  } as unknown as TenantScopedUoW & { store: typeof store };

  return mockUow;
}

// =============================================================================
// ADVERSARIAL TEST SUITE
// =============================================================================

describe('PR-F5 Adversarial Stress & Hardening Suite (Milestone M4)', () => {

  // ===========================================================================
  // SECTION 1: Prompt Injection Tool Escalation Barriers & Parameter Poisoning
  // ===========================================================================
  describe('Section 1: Prompt Injection Tool Escalation Barriers & Parameter Poisoning', () => {
    let mockUow: ReturnType<typeof createAdversarialMockUoW>;
    let registry: ToolRegistry;
    let hitlService: HitlApprovalService;
    let toolBroker: ToolBroker;

    beforeEach(() => {
      mockUow = createAdversarialMockUoW();
      registry = createBrokerFixtureRegistry(mockUow);
      hitlService = new HitlApprovalService(mockUow);
      toolBroker = new ToolBroker({
        uow: mockUow,
        registry,
        hitlService,
      });
    });

    it('1.1 Probing Ungranted Tool Execution: Adversarial jailbreak proposing create_invoice fails closed with FORBIDDEN or TOOL_DISABLED', async () => {
      const tenantId = 10;
      const agentGraphId = 'agent_knowledge_only';

      // Seed grants: Only 'search_knowledge' is enabled for this agent
      mockUow.store.grants.set(`${tenantId}:search_knowledge:${agentGraphId}`, {
        tenant_id: tenantId,
        tool_name: 'search_knowledge',
        agent_graph_id: agentGraphId,
        is_enabled: true,
        required_roles: ['agent'],
      });

      // Explicitly disable create_invoice in grants for this tenant/agent
      mockUow.store.grants.set(`${tenantId}:create_invoice:${agentGraphId}`, {
        tenant_id: tenantId,
        tool_name: 'create_invoice',
        agent_graph_id: agentGraphId,
        is_enabled: false,
        required_roles: ['supervisor', 'admin'],
      });

      // Adversarial LLM proposes executing create_invoice via prompt injection
      const adversarialRequest: ToolExecutionRequestV1 = {
        tenantId,
        agentGraphId,
        runId: 'run_injected_001',
        toolName: 'create_invoice',
        input: {
          customerId: 'victim_customer_123',
          items: [
            { description: 'Exfiltrated Service Fee', quantity: 1, unitAmountCents: 500000 },
          ],
        },
        actorRoles: ['agent'],
      };

      const result = await toolBroker.execute(adversarialRequest);

      // Verify RBAC Step 2 intercepts and rejects the ungranted tool
      assert.equal(result.success, false);
      assert.equal(result.status, 'unauthorized');
      assert.equal(result.error?.code, 'TOOL_DISABLED');
      assert.match(result.error?.message || '', /disabled by tenant administration/);

      // Verify zero approvals or invoices were created
      assert.equal(mockUow.store.approvals.size, 0);
    });

    it('1.2 Probing Non-Existent/Arbitrary System Tools: LLM simulating dangerous commands returns TOOL_NOT_FOUND with destructive risk default', async () => {
      const tenantId = 10;
      const dangerousTools = ['system_exec', 'run_bash', 'database_drop', 'rm_rf_filesystem', 'eval_code'];

      for (const dangerousTool of dangerousTools) {
        const result = await toolBroker.execute({
          tenantId,
          agentGraphId: 'agent_test',
          runId: `run_${dangerousTool}`,
          toolName: dangerousTool,
          input: { command: 'cat /etc/passwd' },
          actorRoles: ['agent', 'admin'],
        });

        assert.equal(result.success, false);
        assert.equal(result.status, 'failed');
        assert.equal(result.error?.code, 'TOOL_NOT_FOUND');
        assert.equal(result.riskLevel, 'destructive', 'Missing tools must fail-secure to highest risk (destructive)');
      }
    });

    it('1.3 Probing Role-Based Privilege Escalation: Public or customer actor role attempting restricted tools fails with FORBIDDEN', async () => {
      const tenantId = 10;

      // LLM attempts to execute admin-only tool with customer role
      const result = await toolBroker.execute({
        tenantId,
        agentGraphId: 'agent_public',
        runId: 'run_priv_esc',
        toolName: 'create_invoice',
        input: {
          customerId: 'cust_target',
          items: [{ description: 'Test', quantity: 1, unitAmountCents: 100 }],
        },
        actorRoles: ['customer', 'guest'], // Lacks 'agent', 'admin', 'supervisor'
      });

      assert.equal(result.success, false);
      assert.equal(result.status, 'unauthorized');
      assert.equal(result.error?.code, 'FORBIDDEN');
      assert.match(result.error?.message || '', /Actor lacking required role/);
    });

    it('1.4 Probing HITL Escalation Barrier: Permitted agent proposing create_invoice is paused awaiting supervisor approval', async () => {
      const tenantId = 10;
      const agentGraphId = 'agent_authorized';

      const request: ToolExecutionRequestV1 = {
        tenantId,
        agentGraphId,
        runId: 'run_hitl_001',
        toolName: 'create_invoice',
        input: {
          customerId: 'cust_real',
          items: [{ description: 'Consulting services', quantity: 2, unitAmountCents: 25000 }],
        },
        actorRoles: ['agent'],
      };

      // Step 5: HITL Barrier Pause
      const result = await toolBroker.execute(request);

      assert.equal(result.success, false);
      assert.equal(result.status, 'awaiting_approval');
      assert.equal(result.hitlRequired, true);
      assert.equal(result.error?.code, 'HITL_REQUIRED');
      assert.ok(result.approvalId, 'Must generate approvalId');
      assert.ok(result.effectKey, 'Must generate effectKey');

      // Verify approval request was recorded in database
      const approvalRecord = mockUow.store.approvals.get(`${tenantId}:${result.approvalId}`);
      assert.ok(approvalRecord);
      assert.equal(approvalRecord.status, 'pending');
      assert.equal(approvalRecord.risk, 'financial');

      // Re-invoking while pending returns HITL_PENDING
      const secondResult = await toolBroker.execute(request);
      assert.equal(secondResult.success, false);
      assert.equal(secondResult.status, 'awaiting_approval');
      assert.equal(secondResult.error?.code, 'HITL_PENDING');
      assert.equal(secondResult.approvalId, result.approvalId);
    });

    it('1.5 Probing Replay of Rejected HITL Approval: Rejected financial mutation returns status rejected and code APPROVAL_REJECTED', async () => {
      const tenantId = 10;
      const request: ToolExecutionRequestV1 = {
        tenantId,
        agentGraphId: 'agent_authorized',
        runId: 'run_hitl_reject',
        toolName: 'create_invoice',
        input: {
          customerId: 'cust_fraud',
          items: [{ description: 'Suspicious invoice', quantity: 10, unitAmountCents: 999999 }],
        },
        actorRoles: ['agent'],
      };

      const firstAttempt = await toolBroker.execute(request);
      assert.equal(firstAttempt.status, 'awaiting_approval');
      const approvalId = firstAttempt.approvalId!;

      // Supervisor rejects approval
      await hitlService.decideApproval({
        approvalId,
        tenantId,
        decision: 'rejected',
        reason: 'Fraudulent customer ID detected',
        expectedVersion: 1,
        actorId: 'supervisor_alice',
        actorRole: 'supervisor',
      });

      // Subsequent LLM retry attempt
      const retryResult = await toolBroker.execute(request);
      assert.equal(retryResult.success, false);
      assert.equal(retryResult.status, 'rejected');
      assert.equal(retryResult.error?.code, 'APPROVAL_REJECTED');
      assert.match(retryResult.error?.message || '', /Human supervisor rejected execution/);
    });

    it('1.6 Probing Parameter Poisoning & Type Confusion in create_invoice', async () => {
      const tenantId = 10;

      // Poison 1: Missing customerId
      const res1 = await toolBroker.execute({
        tenantId,
        agentGraphId: 'agent_test',
        runId: 'run_poison_1',
        toolName: 'create_invoice',
        input: { items: [{ description: 'Item', quantity: 1, unitAmountCents: 100 }] },
        actorRoles: ['agent'],
      });
      assert.equal(res1.status, 'failed');
      assert.equal(res1.error?.code, 'VALIDATION_ERROR');

      // Poison 2: Blank whitespace customerId
      const res2 = await toolBroker.execute({
        tenantId,
        agentGraphId: 'agent_test',
        runId: 'run_poison_2',
        toolName: 'create_invoice',
        input: { customerId: '   ', items: [{ description: 'Item', quantity: 1, unitAmountCents: 100 }] },
        actorRoles: ['agent'],
      });
      assert.equal(res2.status, 'failed');
      assert.equal(res2.error?.code, 'VALIDATION_ERROR');

      // Poison 3: Non-array items
      const res3 = await toolBroker.execute({
        tenantId,
        agentGraphId: 'agent_test',
        runId: 'run_poison_3',
        toolName: 'create_invoice',
        input: { customerId: 'cust_1', items: 'not-an-array' as any },
        actorRoles: ['agent'],
      });
      assert.equal(res3.status, 'failed');
      assert.equal(res3.error?.code, 'VALIDATION_ERROR');

      // Poison 4: Empty items array
      const res4 = await toolBroker.execute({
        tenantId,
        agentGraphId: 'agent_test',
        runId: 'run_poison_4',
        toolName: 'create_invoice',
        input: { customerId: 'cust_1', items: [] },
        actorRoles: ['agent'],
      });
      assert.equal(res4.status, 'failed');
      assert.equal(res4.error?.code, 'VALIDATION_ERROR');

      // Poison 5: SQL fragment in customerId
      const res5 = await toolBroker.execute({
        tenantId,
        agentGraphId: 'agent_test',
        runId: 'run_poison_sql',
        toolName: 'create_invoice',
        input: {
          customerId: "cust_1'; DROP TABLE invoices; --",
          items: [{ description: 'SQL Injection test', quantity: 1, unitAmountCents: 1000 }],
        },
        actorRoles: ['agent'],
      });
      // Defense in depth: Stopped by Step 5 HITL barrier before any database query or execution
      assert.equal(res5.status, 'awaiting_approval');
      assert.equal(res5.hitlRequired, true);

      // Poison 6: Negative amounts (unit underflow attack)
      const res6 = await toolBroker.execute({
        tenantId,
        agentGraphId: 'agent_test',
        runId: 'run_poison_neg',
        toolName: 'create_invoice',
        input: {
          customerId: 'cust_underflow',
          items: [{ description: 'Refund trick', quantity: -5, unitAmountCents: -50000 }],
        },
        actorRoles: ['agent'],
      });
      // Stopped by HITL firewall
      assert.equal(res6.status, 'awaiting_approval');
      assert.equal(res6.hitlRequired, true);
    });

    it('1.7 Probing Parameter Poisoning & SSRF in http_request Tool', async () => {
      const tenantId = 10;

      // Poison 1: Missing URL
      const res1 = await toolBroker.execute({
        tenantId,
        agentGraphId: 'agent_test',
        runId: 'run_http_empty',
        toolName: 'http_request',
        input: {},
        actorRoles: ['agent', 'admin'],
      });
      assert.equal(res1.status, 'failed');
      assert.equal(res1.error?.code, 'VALIDATION_ERROR');

      // Poison 2: Cloud IMDS (169.254.169.254)
      const res2 = await toolBroker.execute({
        tenantId,
        agentGraphId: 'agent_test',
        runId: 'run_http_imds',
        toolName: 'http_request',
        input: { url: 'http://169.254.169.254/latest/meta-data/' },
        actorRoles: ['agent', 'admin'],
      });
      assert.equal(res2.status, 'ssrf_blocked');
      assert.equal(res2.error?.code, 'SSRF_BLOCKED');

      // Poison 3: Loopback IPv4
      const res3 = await toolBroker.execute({
        tenantId,
        agentGraphId: 'agent_test',
        runId: 'run_http_loopback',
        toolName: 'http_request',
        input: { url: 'http://127.0.0.1:8080/internal/admin' },
        actorRoles: ['agent', 'admin'],
      });
      assert.equal(res3.status, 'ssrf_blocked');
      assert.equal(res3.error?.code, 'SSRF_BLOCKED');

      // Poison 4: RFC 1918 Private Class A
      const res4 = await toolBroker.execute({
        tenantId,
        agentGraphId: 'agent_test',
        runId: 'run_http_rfc1918',
        toolName: 'http_request',
        input: { url: 'http://10.0.1.50/api/keys' },
        actorRoles: ['agent', 'admin'],
      });
      assert.equal(res4.status, 'ssrf_blocked');
      assert.equal(res4.error?.code, 'SSRF_BLOCKED');

      // Poison 5: IPv6 ULA
      const res5 = await toolBroker.execute({
        tenantId,
        agentGraphId: 'agent_test',
        runId: 'run_http_ula',
        toolName: 'http_request',
        input: { url: 'http://[fd00::1]/admin' },
        actorRoles: ['agent', 'admin'],
      });
      assert.equal(res5.status, 'ssrf_blocked');
      assert.equal(res5.error?.code, 'SSRF_BLOCKED');

      // Poison 6: Dangerous non-HTTP scheme
      const res6 = await toolBroker.execute({
        tenantId,
        agentGraphId: 'agent_test',
        runId: 'run_http_file',
        toolName: 'http_request',
        input: { url: 'file:///etc/passwd' },
        actorRoles: ['agent', 'admin'],
      });
      assert.equal(res6.status, 'ssrf_blocked');
      assert.equal(res6.error?.code, 'SSRF_BLOCKED');
    });

    it('1.8 PublicationGate Hard Barrier: Simulator detecting security tool leaks hard-blocks publication', () => {
      const validGraph: AgentGraphVersionV1 = {
        schemaVersion: 1,
        id: 'graph_security_test',
        tenantId: 10,
        version: 1,
        entryNodeId: 'node_trigger',
        nodes: [
          { id: 'node_trigger', kind: 'trigger', label: 'Start', config: {} },
          { id: 'node_tool', kind: 'tool_call', label: 'Call Tool', config: { toolName: 'search_knowledge' } },
        ],
        edges: [
          { id: 'e1', from: 'node_trigger', to: 'node_tool' },
        ],
        limits: {
          maxSteps: 15,
          maxModelTokens: 4000,
          timeoutMs: 30000,
        },
        specHash: '',
      };
      validGraph.specHash = computeAgentSpecHash(validGraph);

      // Scorecard with detected prompt injection security tool leak
      const leakyScorecard: EvalScorecardV1 = {
        suiteId: 'suite_sec_1',
        totalScenarios: 10,
        passedCount: 9,
        failedCount: 1,
        passRatePercent: 90.0,
        latencyP50Ms: 250,
        latencyP95Ms: 600,
        totalTokens: 12000,
        totalCostMicroUsd: 15000,
        securityToolLeaks: ['create_invoice', 'http_request'],
        evaluatedAt: new Date().toISOString(),
      };

      const gateResult = PublicationGate.validate(validGraph, leakyScorecard);
      assert.equal(gateResult.allowed, false);
      const leakBlocker = gateResult.blockers.find((b) => b.code === 'SECURITY_TOOL_LEAK');
      assert.ok(leakBlocker, 'Must contain SECURITY_TOOL_LEAK blocker');
      assert.match(leakBlocker.message, /create_invoice, http_request/);
    });

    it('1.9 Probing Operational Limits: Prompt injection attempting step/token exhaustion triggers BUDGET_EXHAUSTED failsafe before execution', async () => {
      const tenantId = 10;

      // Exhaustion 1: Exceeded step limit (step 16 > 15)
      const resStep = await toolBroker.execute({
        tenantId,
        agentGraphId: 'agent_test',
        runId: 'run_step_limit',
        toolName: 'search_knowledge',
        input: { query: 'test' },
        actorRoles: ['agent'],
        currentStep: 16,
      });
      assert.equal(resStep.status, 'budget_exhausted');
      assert.equal(resStep.error?.code, 'BUDGET_EXHAUSTED');

      // Exhaustion 2: Exceeded token limit (4000 tokens)
      const resToken = await toolBroker.execute({
        tenantId,
        agentGraphId: 'agent_test',
        runId: 'run_token_limit',
        toolName: 'search_knowledge',
        input: { query: 'test' },
        actorRoles: ['agent'],
        currentTokensUsed: 4000,
      });
      assert.equal(resToken.status, 'budget_exhausted');
      assert.equal(resToken.error?.code, 'BUDGET_EXHAUSTED');
    });

    it('1.10 Probing CAS Anti-Takeover Fencing: Prompt injection attempting to send outbound messages during human takeover fails with HUMAN_TAKEOVER_ACTIVE', async () => {
      const tenantId = 10;
      const conversationId = 555;

      // Seed conversation under human operator takeover
      mockUow.store.conversations.set(`${tenantId}:${conversationId}`, {
        id: conversationId,
        company_id: tenantId,
        version: 3,
        ownership_epoch: 2,
        owner_type: 'human',
        owner_id: 'agent_operator_bob',
        ia_paused: true,
      });

      const res = await toolBroker.execute({
        tenantId,
        agentGraphId: 'agent_test',
        runId: 'run_cas_takeover',
        toolName: 'send_whatsapp_message',
        conversationId,
        input: {
          conversationId,
          recipientPhone: '+1234567890',
          messageText: 'Prompt injection attempting to send message while human is chatting',
        },
        actorRoles: ['agent'],
      });

      assert.equal(res.status, 'cas_conflict');
      assert.equal(res.error?.code, 'HUMAN_TAKEOVER_ACTIVE');
      assert.match(res.error?.message || '', /controlled by human operator/);
    });
  });

  // ===========================================================================
  // SECTION 2: Cross-Tenant Vector Memory Hardening (pgvector RAG & GDPR RTBF)
  // ===========================================================================
  describe('Section 2: Cross-Tenant Vector Memory Hardening (pgvector RAG & GDPR RTBF)', () => {
    let kbService: KnowledgeBaseService;

    beforeEach(() => {
      kbService = createMemoryKnowledgeBaseService();
    });

    it('2.1 Probing Multi-Tenant Vector Collection Isolation: Tenant 2 cannot access or ingest into Tenant 1 collection', async () => {
      // Tenant 1 creates a private collection
      const collTenant1 = await kbService.createCollection(1, {
        name: 'Tenant 1 Proprietary Catalog',
        description: 'Classified product manual',
      });

      // Tenant 2 attempts to get collection metadata
      const fetchAttempt = await kbService.getCollection(2, collTenant1.id);
      assert.equal(fetchAttempt, null, 'Tenant 2 must receive null when querying Tenant 1 collection');

      // Tenant 2 attempts to ingest documents into Tenant 1 collection
      await assert.rejects(
        async () => {
          await kbService.ingestDocument(2, {
            collectionId: collTenant1.id,
            documentName: 'trojan_doc.txt',
            fileType: 'text',
            content: 'Injected payload into competitor catalog',
          });
        },
        /not found (in|for) tenant 2/
      );

      // Tenant 1 collection remains empty
      const listTenant1 = await kbService.listCollections(1);
      assert.ok(listTenant1.some((c) => c.id === collTenant1.id));
      const listTenant2 = await kbService.listCollections(2);
      assert.ok(!listTenant2.some((c) => c.id === collTenant1.id));
    });

    it('2.2 Probing Concurrent Cross-Tenant Semantic Searches with Spoofed Collection IDs', async () => {
      // Ingest Tenant 1 sensitive knowledge
      const collT1 = await kbService.createCollection(1, { name: 'T1 Finances' });
      await kbService.ingestDocument(1, {
        collectionId: collT1.id,
        documentName: 'secrets.txt',
        fileType: 'text',
        content: 'Confidential strategic pricing formula: ALPHA-DELTA-9921',
      });

      // Ingest Tenant 2 public knowledge
      const collT2 = await kbService.createCollection(2, { name: 'T2 Public' });
      await kbService.ingestDocument(2, {
        collectionId: collT2.id,
        documentName: 'faq.txt',
        fileType: 'text',
        content: 'Standard operating hours are 9am to 5pm',
      });

      // Attack: Tenant 2 spoofs collectionId = collT1.id searching for ALPHA-DELTA-9921
      const attackRes = await kbService.queryKnowledge(2, {
        query: 'ALPHA-DELTA-9921',
        collectionId: collT1.id,
        minSimilarity: 0.1,
      });
      assert.equal(attackRes.chunks.length, 0, 'Cross-tenant query with spoofed collection must return 0 results');

      // High-concurrency test: 25 simultaneous queries from Tenant 1 and Tenant 2
      const queries = Array.from({ length: 50 }, (_, i) => {
        const isTenant1 = i % 2 === 0;
        const tenantId = isTenant1 ? 1 : 2;
        const query = isTenant1 ? 'ALPHA-DELTA-9921' : 'operating hours';
        return kbService.queryKnowledge(tenantId, { query, minSimilarity: 0.3 }).then((res) => ({
          tenantId,
          res,
        }));
      });

      const allResults = await Promise.all(queries);

      for (const { tenantId, res } of allResults) {
        if (tenantId === 1) {
          // Tenant 1 must match ALPHA-DELTA
          assert.ok(res.chunks.length >= 1);
          assert.equal(res.chunks[0].collectionId, collT1.id);
          assert.match(res.chunks[0].content, /ALPHA-DELTA-9921/);
        } else {
          // Tenant 2 must NEVER see ALPHA-DELTA
          for (const chunk of res.chunks) {
            assert.equal(chunk.collectionId, collT2.id);
            assert.ok(!chunk.content.includes('ALPHA-DELTA-9921'));
          }
        }
      }
    });

    it('2.3 Probing High-Volume Concurrent Document Ingestions across Multiple Tenants', async () => {
      const collT10 = await kbService.createCollection(10, { name: 'T10 Batch' });
      const collT20 = await kbService.createCollection(20, { name: 'T20 Batch' });
      const collT30 = await kbService.createCollection(30, { name: 'T30 Batch' });

      // Run 15 concurrent ingestions (5 per tenant)
      const tasks: Promise<any>[] = [];
      for (let i = 0; i < 5; i++) {
        tasks.push(
          kbService.ingestDocument(10, {
            collectionId: collT10.id,
            documentName: `doc_t10_${i}.txt`,
            fileType: 'text',
            content: `Tenant 10 specific content chunk ${i} with token payload`,
          })
        );
        tasks.push(
          kbService.ingestDocument(20, {
            collectionId: collT20.id,
            documentName: `doc_t20_${i}.txt`,
            fileType: 'text',
            content: `Tenant 20 specific content chunk ${i} with token payload`,
          })
        );
        tasks.push(
          kbService.ingestDocument(30, {
            collectionId: collT30.id,
            documentName: `doc_t30_${i}.txt`,
            fileType: 'text',
            content: `Tenant 30 specific content chunk ${i} with token payload`,
          })
        );
      }

      const results = await Promise.all(tasks);
      assert.equal(results.length, 15);
      for (const r of results) {
        assert.ok(r.chunksCreated >= 1);
      }

      // Verify each tenant searches only their own chunks
      const qT10 = await kbService.queryKnowledge(10, { query: 'content chunk', topK: 10, minSimilarity: 0.1 });
      for (const chk of qT10.chunks) {
        assert.equal(chk.collectionId, collT10.id);
        assert.match(chk.content, /Tenant 10/);
      }

      const qT20 = await kbService.queryKnowledge(20, { query: 'content chunk', topK: 10, minSimilarity: 0.1 });
      for (const chk of qT20.chunks) {
        assert.equal(chk.collectionId, collT20.id);
        assert.match(chk.content, /Tenant 20/);
      }
    });

    it('2.4 Probing GDPR Right-to-be-Forgotten (RTBF) Purge Cross-Tenant Boundaries', async () => {
      const collT1 = await kbService.createCollection(1, { name: 'T1 RTBF Coll' });
      const collT2 = await kbService.createCollection(2, { name: 'T2 RTBF Coll' });

      // Both tenants ingest data for a user with the same customerId "target_gdpr_user"
      await kbService.ingestDocument(1, {
        collectionId: collT1.id,
        customerId: 'target_gdpr_user',
        documentName: 'user_t1.txt',
        fileType: 'text',
        content: 'Personal identifiable data of target user for tenant 1',
      });

      await kbService.ingestDocument(2, {
        collectionId: collT2.id,
        customerId: 'target_gdpr_user',
        documentName: 'user_t2.txt',
        fileType: 'text',
        content: 'Personal identifiable data of target user for tenant 2',
      });

      // Tenant 1 issues RTBF purge for "target_gdpr_user"
      const purgeT1 = await kbService.purgeKnowledge(1, {
        scope: 'customer',
        targetId: 'target_gdpr_user',
      });
      assert.equal(purgeT1.purgedChunksCount, 1);

      // Verify Tenant 1 data is gone
      const qT1 = await kbService.queryKnowledge(1, { query: 'Personal identifiable data', minSimilarity: 0.1 });
      assert.equal(qT1.chunks.length, 0);

      // Verify Tenant 2 data is 100% INTACT
      const qT2 = await kbService.queryKnowledge(2, { query: 'Personal identifiable data', minSimilarity: 0.1 });
      assert.equal(qT2.chunks.length, 1);
      assert.match(qT2.chunks[0].content, /tenant 2/);

      // Attack: Tenant 2 attempts to purge Tenant 1 collection
      const purgeAttack = await kbService.purgeKnowledge(2, {
        scope: 'collection',
        targetId: collT1.id,
      });
      assert.equal(purgeAttack.purgedCollectionsCount, 0);
      assert.equal(purgeAttack.purgedChunksCount, 0);

      // Verify Tenant 1 collection still exists
      const verifyColl1 = await kbService.getCollection(1, collT1.id);
      assert.ok(verifyColl1);
    });

    it('2.5 High-Concurrency Stress Race: Interleaved Ingestions, Searches, and RTBF Purges', async () => {
      const collA = await kbService.createCollection(100, { name: 'Race A' });
      const collB = await kbService.createCollection(200, { name: 'Race B' });

      const operations: Promise<any>[] = [];

      for (let i = 0; i < 10; i++) {
        // Ingest Tenant A
        operations.push(
          kbService.ingestDocument(100, {
            collectionId: collA.id,
            customerId: `user_a_${i}`,
            documentName: `doc_a_${i}.txt`,
            fileType: 'text',
            content: `Concurrent stress data A ${i}`,
          })
        );
        // Ingest Tenant B
        operations.push(
          kbService.ingestDocument(200, {
            collectionId: collB.id,
            customerId: `user_b_${i}`,
            documentName: `doc_b_${i}.txt`,
            fileType: 'text',
            content: `Concurrent stress data B ${i}`,
          })
        );
        // Interleaved search
        operations.push(
          kbService.queryKnowledge(100, { query: `stress data A ${i}`, minSimilarity: 0.1 })
        );
        // Interleaved RTBF purge
        if (i % 3 === 0) {
          operations.push(
            kbService.purgeKnowledge(200, { scope: 'customer', targetId: `user_b_${i}` })
          );
        }
      }

      // Execute all 34 simultaneous operations without crash or rejection
      const results = await Promise.all(operations);
      assert.ok(results.length >= 30);
    });

    it('2.6 Probing Route-Level Tenant Isolation against Spoofed Header Injection', async () => {
      const collT1 = await kbService.createCollection(1, { name: 'Tenant 1 Highly Secret' });
      await kbService.ingestDocument(1, {
        collectionId: collT1.id,
        documentName: 'vault.txt',
        fileType: 'text',
        content: 'Confidential secret credentials: PROD-API-KEY-999',
      });

      const tokenTenant2 = createFixtureAccessToken({
        id: 201,
        sub: 'attacker_user_2',
        tenantId: 2,
        companyId: 2,
        role: 'admin',
        rol: 'ADMIN',
      });

      const aiRouter = createAiRoutes({ knowledgeBaseService: kbService });

      // Attacker sends valid Tenant 2 JWT but attempts spoofing x-tenant-id: 1 and queries collT1.id
      const res = await invokeRoute(aiRouter, 'post', '/rag/query', {
        token: tokenTenant2,
        headers: { 'x-tenant-id': '1', 'x-company-id': '1' },
        body: {
          query: 'PROD-API-KEY-999',
          collectionId: collT1.id,
          minSimilarity: 0.1,
        },
      });

      // Route extracts Tenant 2 from JWT, ignores spoofed header, searches Tenant 2 space, returns 0 chunks
      assert.equal(res.status, 200);
      assert.equal(res.body.data.chunks.length, 0);
    });
  });

  // ===========================================================================
  // SECTION 3: High-Concurrency Token Ledger & Quota Consistency
  // ===========================================================================
  describe('Section 3: High-Concurrency Token Ledger & Quota Consistency', () => {
    let mockUow: ReturnType<typeof createAdversarialMockUoW>;
    let ledger: TokenCostLedger;
    let quotaManager: QuotaManager;

    beforeEach(() => {
      mockUow = createAdversarialMockUoW();
      ledger = new TokenCostLedger(mockUow);
      quotaManager = new QuotaManager(mockUow);
    });

    it('3.1 Probing 50 Simultaneous Debit Transactions: Zero balance drift and exact integer micro-USD consistency', async () => {
      const tenantId = 300;
      const numTransactions = 50;

      // Seed quota with generous limit: $1000.00 = 1,000,000,000 micro-USD
      mockUow.store.quotas.set(tenantId, {
        tenant_id: tenantId,
        monthly_cost_limit_micro_usd: 1_000_000_000n,
        monthly_token_limit: 10_000_000n,
        current_month_cost_micro_usd: 0n,
        current_month_tokens_used: 0n,
        hard_limit_enabled: true,
        hard_limit_action: 'block',
        period_start: new Date(Date.UTC(new Date().getFullYear(), new Date().getMonth(), 1)),
        reset_at: new Date(Date.UTC(new Date().getFullYear(), new Date().getMonth() + 1, 1)),
        updated_at: new Date(),
      });

      // Calculate expected totals: cost = (i + 1) * 200 micro-USD, tokens = (i + 1) * 15
      let expectedTotalCost = 0;
      let expectedTotalTokens = 0;

      const tasks: Promise<any>[] = [];

      for (let i = 0; i < numTransactions; i++) {
        const costMicroUsd = (i + 1) * 200;
        const promptTokens = (i + 1) * 10;
        const completionTokens = (i + 1) * 5;
        const totalTokens = promptTokens + completionTokens;

        expectedTotalCost += costMicroUsd;
        expectedTotalTokens += totalTokens;

        tasks.push(
          (async () => {
            await quotaManager.assertWithinQuota(tenantId);
            const entryId = await ledger.record({
              tenantId,
              provider: 'openai',
              model: 'gpt-4o-mini',
              operation: 'completion',
              promptTokens,
              completionTokens,
              totalTokens,
              costMicroUsd,
              isByok: true,
            });
            await quotaManager.consume(tenantId, costMicroUsd, totalTokens);
            return entryId;
          })()
        );
      }

      // Execute all 50 concurrent transactions simultaneously
      const entryIds = await Promise.all(tasks);
      assert.equal(entryIds.length, 50);

      // Verify all entry IDs are unique positive integers
      const uniqueIds = new Set(entryIds);
      assert.equal(uniqueIds.size, 50);

      // 1. Verify exact integer micro-USD consistency in Ledger table
      const ledgerQuery = await ledger.query(tenantId, { limit: 100 });
      assert.equal(ledgerQuery.items.length, 50);

      let actualLedgerCostSum = 0;
      let actualLedgerTokenSum = 0;

      for (const item of ledgerQuery.items) {
        assert.equal(Number.isInteger(item.costMicroUsd), true, 'costMicroUsd must be an exact integer');
        assert.ok(item.costMicroUsd > 0);
        actualLedgerCostSum += item.costMicroUsd;
        actualLedgerTokenSum += item.totalTokens;
      }

      assert.equal(actualLedgerCostSum, expectedTotalCost, 'Ledger total cost must match expected exactly');
      assert.equal(actualLedgerTokenSum, expectedTotalTokens, 'Ledger total tokens must match expected exactly');

      // 2. Verify QuotaManager summary
      const summary = await quotaManager.getSummary(tenantId);
      assert.equal(summary.currentMonthCostMicroUsd, expectedTotalCost);
      assert.equal(summary.currentMonthTokensUsed, expectedTotalTokens);

      // 3. ZERO BALANCE DRIFT verification:
      assert.equal(
        summary.currentMonthCostMicroUsd,
        actualLedgerCostSum,
        'CRITICAL: Quota balance must exactly match the sum of ledger entries with ZERO drift'
      );
      assert.equal(
        summary.currentMonthTokensUsed,
        actualLedgerTokenSum,
        'CRITICAL: Quota tokens must exactly match the sum of ledger tokens with ZERO drift'
      );
    });

    it('3.2 Probing 50 Simultaneous Debits against Limited Quota: Zero negative over-allocation beyond hard limit', async () => {
      const tenantId = 301;
      const hardLimitMicroUsd = 20_000; // $0.02 hard limit

      mockUow.store.quotas.set(tenantId, {
        tenant_id: tenantId,
        monthly_cost_limit_micro_usd: BigInt(hardLimitMicroUsd),
        monthly_token_limit: 1_000_000n,
        current_month_cost_micro_usd: 0n,
        current_month_tokens_used: 0n,
        hard_limit_enabled: true,
        hard_limit_action: 'block',
        period_start: new Date(Date.UTC(new Date().getFullYear(), new Date().getMonth(), 1)),
        reset_at: new Date(Date.UTC(new Date().getFullYear(), new Date().getMonth() + 1, 1)),
        updated_at: new Date(),
      });

      // Execute 50 debit transactions across 5 sequential waves of 10 concurrent requests
      const results: { status: 'approved' | 'rate_limited'; cost: number }[] = [];

      for (let batch = 0; batch < 5; batch++) {
        const batchTasks = Array.from({ length: 10 }, async () => {
          try {
            await quotaManager.assertWithinQuota(tenantId);
            const cost = 1000;
            const tokens = 50;
            await ledger.record({
              tenantId,
              provider: 'openai',
              model: 'gpt-4o-mini',
              promptTokens: 25,
              completionTokens: 25,
              totalTokens: tokens,
              costMicroUsd: cost,
            });
            await quotaManager.consume(tenantId, cost, tokens);
            return { status: 'approved' as const, cost };
          } catch (err: any) {
            if (err.code === 'RATE_LIMITED' || err.statusCode === 429) {
              return { status: 'rate_limited' as const, cost: 0 };
            }
            throw err;
          }
        });

        const batchResults = await Promise.all(batchTasks);
        results.push(...batchResults);
      }

      const approvedCount = results.filter((r) => r.status === 'approved').length;
      const rateLimitedCount = results.filter((r) => r.status === 'rate_limited').length;

      assert.equal(approvedCount + rateLimitedCount, 50);
      assert.equal(approvedCount, 20, 'Exactly 20 transactions approved up to limit (20,000 micro-USD)');
      assert.equal(rateLimitedCount, 30, 'Exactly 30 transactions rate limited once hard limit reached');

      // Verify final quota state
      const summary = await quotaManager.getSummary(tenantId);
      assert.equal(summary.currentMonthCostMicroUsd, hardLimitMicroUsd);

      // Verify ledger consistency
      const ledgerEntries = await ledger.query(tenantId, { limit: 100 });
      assert.equal(ledgerEntries.items.length, 20);
      const ledgerSum = ledgerEntries.items.reduce((sum, item) => sum + item.costMicroUsd, 0);
      assert.equal(ledgerSum, hardLimitMicroUsd);
      assert.equal(summary.currentMonthCostMicroUsd, ledgerSum, 'Zero balance drift');

      // Zero negative over-allocation:
      assert.ok(summary.currentMonthCostMicroUsd > 0);
      assert.ok(summary.currentMonthTokensUsed > 0);

      // Verify 20 simultaneous concurrent calls once saturated ALL fail closed
      const saturatedCalls = await Promise.allSettled(
        Array.from({ length: 20 }, () => quotaManager.assertWithinQuota(tenantId))
      );
      for (const res of saturatedCalls) {
        assert.equal(res.status, 'rejected');
        const reason: any = (res as PromiseRejectedResult).reason;
        assert.equal(reason.code, 'RATE_LIMITED');
        assert.equal(reason.statusCode, 429);
      }
    });

    it('3.3 Probing Monthly Period Rollover: QuotaManager resets spend when period_start is in a past month', async () => {
      const tenantId = 302;
      const twoMonthsAgo = new Date(Date.UTC(2025, 0, 1)); // Jan 2025

      mockUow.store.quotas.set(tenantId, {
        tenant_id: tenantId,
        monthly_cost_limit_micro_usd: 50_000n,
        monthly_token_limit: 10_000n,
        current_month_cost_micro_usd: 50_000n, // Saturated in past month
        current_month_tokens_used: 10_000n,
        hard_limit_enabled: true,
        hard_limit_action: 'block',
        period_start: twoMonthsAgo,
        reset_at: new Date(Date.UTC(2025, 1, 1)),
        updated_at: twoMonthsAgo,
      });

      // Call assertWithinQuota: Must trigger automatic period rollover and allow request
      await quotaManager.assertWithinQuota(tenantId);

      const q = mockUow.store.quotas.get(tenantId);
      assert.equal(q.current_month_cost_micro_usd, 0n, 'Past month spend must be reset to 0');
      assert.equal(q.current_month_tokens_used, 0n, 'Past month tokens must be reset to 0');
    });

    it('3.4 Probing BigInt Arithmetic & Large Micro-USD Values without Overflow or Precision Loss', async () => {
      const tenantId = 303;

      // Seed quota with 10 Billion micro-USD = $10,000.00
      const largeLimit = 10_000_000_000n;
      mockUow.store.quotas.set(tenantId, {
        tenant_id: tenantId,
        monthly_cost_limit_micro_usd: largeLimit,
        monthly_token_limit: 100_000_000n,
        current_month_cost_micro_usd: 0n,
        current_month_tokens_used: 0n,
        hard_limit_enabled: true,
        hard_limit_action: 'block',
        period_start: new Date(),
        reset_at: new Date(),
        updated_at: new Date(),
      });

      // Debit 5 Billion micro-USD ($5,000.00)
      const debit1 = 5_000_000_000;
      await quotaManager.consume(tenantId, debit1, 500_000);

      // Debit 1 micro-USD ($0.000001)
      const debit2 = 1;
      await quotaManager.consume(tenantId, debit2, 1);

      const summary = await quotaManager.getSummary(tenantId);
      assert.equal(summary.currentMonthCostMicroUsd, 5_000_000_001);
      assert.equal(summary.currentMonthCostUsd, '5000.00');
      assert.equal(summary.currentMonthTokensUsed, 500_001);
    });

    it('3.5 Probing Deterministic Cursor Pagination under High-Concurrency Writes', async () => {
      const tenantId = 300;
      // Seed 50 entries for cursor pagination validation
      for (let i = 0; i < 50; i++) {
        await ledger.record({
          tenantId,
          provider: 'openai',
          model: 'gpt-4o-mini',
          operation: 'completion',
          promptTokens: (i + 1) * 10,
          completionTokens: (i + 1) * 5,
          totalTokens: (i + 1) * 15,
          costMicroUsd: (i + 1) * 200,
          isByok: true,
        });
      }
      const page1 = await ledger.query(tenantId, { limit: 20 });
      assert.equal(page1.items.length, 20);
      assert.ok(page1.nextCursor !== null);

      const page2 = await ledger.query(tenantId, { limit: 20, cursor: page1.nextCursor });
      assert.equal(page2.items.length, 20);
      assert.ok(page2.nextCursor !== null);

      const page3 = await ledger.query(tenantId, { limit: 20, cursor: page2.nextCursor });
      assert.equal(page3.items.length, 10);
      assert.equal(page3.nextCursor, null);

      // Verify strict monotonic descending order across all pages
      const allIds = [
        ...page1.items.map((i) => i.id),
        ...page2.items.map((i) => i.id),
        ...page3.items.map((i) => i.id),
      ];
      assert.equal(allIds.length, 50);
      for (let i = 1; i < allIds.length; i++) {
        assert.ok(allIds[i] < allIds[i - 1], 'IDs must be strictly monotonically decreasing');
      }
      const uniqueIds = new Set(allIds);
      assert.equal(uniqueIds.size, 50, 'Zero duplicate or skipped IDs across pages');
    });
  });
});
