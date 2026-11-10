// Invariants before config load
process.env.JWT_SECRET = 'test-only-jwt-secret-with-at-least-32-characters-for-testing';
process.env.DB_PASSWORD = 'test-only-database-password';

import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
const { createBrokerFixtureRegistry, createBrokerFixtureEffectCache } = require('./fixtures/brokerTools') as typeof import('./fixtures/brokerTools');
const {
  ToolBroker,
  ToolRegistry,
  EffectCache,
  HitlApprovalService,
  ApprovalNotFoundError,
  ApprovalAlreadyDecidedError,
  ApprovalCasConflictError,
  ApprovalExpiredError,
  HttpRequestTool,
  SearchKnowledgeTool,
} = require('../services/ai/broker') as typeof import('../services/ai/broker');
const {
  ConversationCasService,
  CasConflictError,
  ConversationNotFoundError,
} = require('../services/conversations/ConversationCasService') as typeof import('../services/conversations/ConversationCasService');
import type {
  ToolExecutionRequestV1,
  ToolDefinitionV1,
  ApprovalRequestV1,
  ApprovalDecisionResultV1,
} from '@whatsap-automat/contracts';

// =============================================================================
// Robust In-Memory Mock Unit of Work Supporting CAS & Multi-Tenant Isolation
// =============================================================================
function createAdversarialMockUoW() {
  const store = {
    conversations: new Map<string, any>(),
    approvals: new Map<string, any>(),
    effects: new Map<string, any>(),
    grants: new Map<string, any>(),
    toolDefinitions: new Map<string, any>(),
    auditLogs: [] as any[],
  };

  const mockUow: any = {
    store,
    async run(tenantId: number, fn: (client: any) => Promise<any>) {
      const client = {
        async query(sql: string, params: any[] = []) {
          // 1. UPDATE conversations (Takeover CAS, Pause AI, Resume AI)
          if (sql.includes('UPDATE conversations')) {
            let convId: string;
            let companyId: number;
            let expectedVer: number;

            if (sql.includes("owner_type = 'human'")) {
              // takeoverConversation: WHERE id = $3 AND company_id = $4 AND version = $5
              convId = String(params[2]);
              companyId = Number(params[3]);
              expectedVer = Number(params[4]);
            } else if (sql.includes('ia_paused = true')) {
              // pauseAi: WHERE id = $3 AND company_id = $4 AND version = $5
              convId = String(params[2]);
              companyId = Number(params[3]);
              expectedVer = Number(params[4]);
            } else {
              // resumeAi: WHERE id = $1 AND company_id = $2 AND version = $3
              convId = String(params[0]);
              companyId = Number(params[1]);
              expectedVer = Number(params[2]);
            }

            const convKey = `${companyId}:${convId}`;
            const conv = store.conversations.get(convKey);

            if (!conv || conv.version !== expectedVer) {
              return { rowCount: 0, rows: [] };
            }

            if (sql.includes("owner_type = 'human'")) {
              conv.owner_type = 'human';
              conv.owner_id = String(params[0]);
              conv.assigned_user_id = Number(params[1]);
              conv.ownership_epoch += 1;
              conv.version += 1;
              conv.ia_paused = true;
            } else if (sql.includes('ia_paused = true')) {
              conv.ia_paused = true;
              conv.version += 1;
            } else if (sql.includes('ia_paused = false')) {
              conv.ia_paused = false;
              conv.owner_type = 'ai_agent';
              conv.owner_id = null;
              conv.ownership_epoch += 1;
              conv.version += 1;
            }

            return {
              rowCount: 1,
              rows: [{
                id: conv.id,
                company_id: conv.company_id,
                version: conv.version,
                ownership_epoch: conv.ownership_epoch,
                owner_type: conv.owner_type,
                owner_id: conv.owner_id,
                status: 'open',
                assigned_user_id: conv.assigned_user_id,
                ia_paused: conv.ia_paused,
              }],
            };
          }

          // 2. SELECT conversation state (getConversationState / disambiguate)
          if (sql.includes('FROM conversations')) {
            const convId = String(params[0]);
            const companyId = params[1] !== undefined ? Number(params[1]) : tenantId;
            const conv = store.conversations.get(`${companyId}:${convId}`);
            if (!conv) return { rowCount: 0, rows: [] };
            return {
              rowCount: 1,
              rows: [{
                id: conv.id,
                company_id: conv.company_id || companyId,
                version: conv.version,
                ownership_epoch: conv.ownership_epoch,
                owner_type: conv.owner_type,
                owner_id: conv.owner_id,
                ia_paused: conv.ia_paused,
              }],
            };
          }

          // 3. INSERT into approval_requests
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
            return { rowCount: 1, rows: [approval] };
          }

          // 4. SELECT from approval_requests by effect_key
          if (sql.includes('FROM approval_requests') && sql.includes('effect_key = $2')) {
            const app = store.approvals.get(`effect:${tenantId}:${params[1]}`);
            if (!app) return { rowCount: 0, rows: [] };
            return { rowCount: 1, rows: [app] };
          }

          // 5. SELECT from approval_requests by id (getApprovalById or disambiguation check)
          if (sql.includes('FROM approval_requests')) {
            if (sql.includes('tenant_id = $1 AND id = $2')) {
              // getApprovalById: params[0] = tenantId, params[1] = approvalId
              const app = store.approvals.get(`${params[0]}:${params[1]}`);
              if (!app) return { rowCount: 0, rows: [] };
              return { rowCount: 1, rows: [app] };
            }
            if (sql.includes('id = $1 AND tenant_id = $2')) {
              // decideApproval disambiguation checkRes: params[0] = approvalId, params[1] = tenantId
              const app = store.approvals.get(`${params[1]}:${params[0]}`);
              if (!app) return { rowCount: 0, rows: [] };
              return { rowCount: 1, rows: [app] };
            }
          }

          // 6. UPDATE approval_requests (CAS atomic supervisor decision)
          if (sql.includes('UPDATE approval_requests')) {
            const decision = params[0];
            const actorId = params[1];
            const reason = params[2];
            const approvalId = params[3];
            const tId = params[4];
            const expectedVer = params[5];

            const app = store.approvals.get(`${tId}:${approvalId}`);
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
            const eff = store.effects.get(`${tenantId}:${params[1]}`);
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
              output: JSON.parse(params[5]),
            };
            store.effects.set(`${tenantId}:${record.effect_key}`, record);
            return { rowCount: 1, rows: [record] };
          }

          // 8. SELECT agent_tool_grants
          if (sql.includes('FROM agent_tool_grants')) {
            const toolName = params[1];
            const graphId = params[2];
            // Check specific graph grant or generic tenant grant
            const grantKeySpecific = `${tenantId}:${toolName}:${graphId}`;
            const grantKeyGeneric = `${tenantId}:${toolName}`;
            const grant = store.grants.get(grantKeySpecific) || store.grants.get(grantKeyGeneric);
            if (!grant) return { rowCount: 0, rows: [] };
            return { rowCount: 1, rows: [grant] };
          }

          // 9. INSERT INTO operational_actions (audit trail)
          if (sql.includes('INSERT INTO operational_actions')) {
            store.auditLogs.push(params);
            return { rowCount: 1, rows: [] };
          }

          return { rowCount: 0, rows: [] };
        },
      };

      return fn(client);
    },
  };

  return mockUow;
}

describe('PR-F5-02 Empirical Adversarial Stress Challenge Suite', () => {
  let mockUow: any;
  let registry: ToolRegistry;
  let hitlService: HitlApprovalService;
  let casService: ConversationCasService;
  let effectCache: ReturnType<typeof createBrokerFixtureEffectCache>;
  let broker: ToolBroker;

  beforeEach(() => {
    mockUow = createAdversarialMockUoW();
    registry = createBrokerFixtureRegistry(mockUow);
    hitlService = new HitlApprovalService(mockUow);
    casService = new ConversationCasService(mockUow);
    effectCache = createBrokerFixtureEffectCache();
    broker = new ToolBroker({
      uow: mockUow,
      registry,
      hitlService,
      casService,
      effectCache,
    });
  });

  // ===========================================================================
  // SECTION 1: Step 6 CAS Anti-Takeover Fencing & Monotonic Epoch Protection
  // ===========================================================================
  describe('Adversarial Section 1: CAS Anti-Takeover Fencing & Monotonic Epoch Protection (Step 6)', () => {
    it('1.1 Concurrency race: 20 simultaneous AI sends competing with human takeover -> 100% rejection post-takeover', async () => {
      // 1. Initialize conversation in AI-owned active state
      const tenantId = 1;
      const convId = 101;
      mockUow.store.conversations.set(`${tenantId}:${convId}`, {
        id: convId,
        company_id: tenantId,
        version: 1,
        ownership_epoch: 1,
        owner_type: 'ai_agent',
        owner_id: null,
        ia_paused: false,
      });

      // 2. Perform human takeover to transition owner_type='human', ia_paused=true, version=2, epoch=2
      const takeoverResult = await casService.takeoverConversation({
        tenantId,
        conversationId: convId,
        expectedVersion: 1,
        userId: 42,
        reason: 'Emergency supervisor manual override',
      });
      assert.equal(takeoverResult.success, true);
      assert.equal(takeoverResult.newVersion, 2);
      assert.equal(takeoverResult.ownerType, 'human');
      assert.equal(takeoverResult.aiPaused, true);

      // 3. Fire 20 concurrent AI send requests (simulating delayed in-flight queue)
      const concurrentSendPromises = Array.from({ length: 20 }, (_, i) => {
        const req: ToolExecutionRequestV1 = {
          tenantId,
          agentGraphId: 'graph_chat_agent',
          runId: `run_race_${i}`,
          toolName: 'send_whatsapp_message',
          conversationId: convId,
          expectedConversationVersion: 1, // Stale version
          input: {
            conversationId: convId,
            messageText: `Race attempt message payload #${i}`,
          },
          actorRoles: ['agent'],
        };
        return broker.execute(req);
      });

      const results = await Promise.all(concurrentSendPromises);

      // 4. Verify 100% rejection rate with cas_conflict and HUMAN_TAKEOVER_ACTIVE
      assert.equal(results.length, 20);
      for (const res of results) {
        assert.equal(res.success, false, 'AI send must NOT succeed post human takeover');
        assert.equal(res.status, 'cas_conflict', 'Status must be cas_conflict');
        assert.equal(res.error?.code, 'HUMAN_TAKEOVER_ACTIVE', 'Error code must indicate human takeover active');
      }
    });

    it('1.2 Rejects outbound send when ia_paused=true even if owner_type remains ai_agent', async () => {
      const tenantId = 1;
      const convId = 102;
      mockUow.store.conversations.set(`${tenantId}:${convId}`, {
        id: convId,
        company_id: tenantId,
        version: 3,
        ownership_epoch: 1,
        owner_type: 'ai_agent',
        owner_id: null,
        ia_paused: true, // Paused by policy
      });

      const req: ToolExecutionRequestV1 = {
        tenantId,
        agentGraphId: 'graph_chat_agent',
        runId: 'run_paused_ai',
        toolName: 'send_whatsapp_message',
        conversationId: convId,
        expectedConversationVersion: 3,
        input: {
          conversationId: convId,
          messageText: 'Attempting send while AI is paused',
        },
        actorRoles: ['agent'],
      };

      const result = await broker.execute(req);
      assert.equal(result.success, false);
      assert.equal(result.status, 'cas_conflict');
      assert.equal(result.error?.code, 'HUMAN_TAKEOVER_ACTIVE');
    });

    it('1.3 Monotonic epoch/version mismatch: expectedConversationVersion prevents stale send actions', async () => {
      const tenantId = 1;
      const convId = 103;
      // Conversation is currently at version 7, epoch 3
      mockUow.store.conversations.set(`${tenantId}:${convId}`, {
        id: convId,
        company_id: tenantId,
        version: 7,
        ownership_epoch: 3,
        owner_type: 'ai_agent',
        owner_id: null,
        ia_paused: false,
      });

      // Attack vector A: Stale version (expected 6, current 7)
      const staleReq: ToolExecutionRequestV1 = {
        tenantId,
        agentGraphId: 'graph_chat_agent',
        runId: 'run_stale_ver',
        toolName: 'send_whatsapp_message',
        conversationId: convId,
        expectedConversationVersion: 6,
        input: { conversationId: convId, messageText: 'Stale version message' },
        actorRoles: ['agent'],
      };
      const staleRes = await broker.execute(staleReq);
      assert.equal(staleRes.success, false);
      assert.equal(staleRes.status, 'cas_conflict');
      assert.equal(staleRes.error?.code, 'CONCURRENCY_CONFLICT');
      assert.match(staleRes.error?.message || '', /CAS version mismatch.*expected version 6.*current version is 7/);

      // Attack vector B: Future version mismatch (expected 8, current 7)
      const futureReq: ToolExecutionRequestV1 = {
        tenantId,
        agentGraphId: 'graph_chat_agent',
        runId: 'run_future_ver',
        toolName: 'send_whatsapp_message',
        conversationId: convId,
        expectedConversationVersion: 8,
        input: { conversationId: convId, messageText: 'Future version message' },
        actorRoles: ['agent'],
      };
      const futureRes = await broker.execute(futureReq);
      assert.equal(futureRes.success, false);
      assert.equal(futureRes.status, 'cas_conflict');
      assert.equal(futureRes.error?.code, 'CONCURRENCY_CONFLICT');

      // Valid vector: Exactly matching version (7) succeeds
      const validReq: ToolExecutionRequestV1 = {
        tenantId,
        agentGraphId: 'graph_chat_agent',
        runId: 'run_matching_ver',
        toolName: 'send_whatsapp_message',
        conversationId: convId,
        expectedConversationVersion: 7,
        input: { conversationId: convId, messageText: 'Matching version message' },
        actorRoles: ['agent'],
      };
      const validRes = await broker.execute(validReq);
      assert.equal(validRes.success, true);
      assert.equal(validRes.status, 'executed');
    });

    it('1.4 Missing conversationId fails fast at schema validation (Step 1) and CAS fencing (Step 6)', async () => {
      // 1. send_whatsapp_message with missing input conversationId fails at Step 1 schema validation
      const missingInputReq: ToolExecutionRequestV1 = {
        tenantId: 1,
        agentGraphId: 'graph_chat_agent',
        runId: 'run_missing_id_input',
        toolName: 'send_whatsapp_message',
        input: { messageText: 'No conversation id provided' },
        actorRoles: ['agent'],
      };
      const schemaRes = await broker.execute(missingInputReq);
      assert.equal(schemaRes.success, false);
      assert.equal(schemaRes.error?.code, 'VALIDATION_ERROR');

      // 2. Custom tool with requiresCasFencing: true but no conversationId in request or input fails at Step 6 with MISSING_CONVERSATION_ID
      registry.registerTool({
        definition: {
          schemaVersion: 1,
          name: 'custom_send_action',
          description: 'Custom outbound action requiring CAS',
          riskLevel: 'send',
          requiredRoles: ['agent'],
          parameters: { type: 'object' },
          timeoutMs: 5000,
          requiresCasFencing: true,
        },
        validateInput: () => ({ valid: true }), // Passes Step 1
        execute: async () => ({ dispatched: true }),
      });

      const missingCasReq: ToolExecutionRequestV1 = {
        tenantId: 1,
        agentGraphId: 'graph_chat_agent',
        runId: 'run_missing_cas_id',
        toolName: 'custom_send_action',
        input: { action: 'fire' }, // Missing conversationId
        actorRoles: ['agent'],
      };
      const casRes = await broker.execute(missingCasReq);
      assert.equal(casRes.success, false);
      assert.equal(casRes.error?.code, 'MISSING_CONVERSATION_ID');

      // 3. Non-existent conversation fails with CONVERSATION_NOT_FOUND
      const nonExistentReq: ToolExecutionRequestV1 = {
        tenantId: 1,
        agentGraphId: 'graph_chat_agent',
        runId: 'run_not_found',
        toolName: 'send_whatsapp_message',
        conversationId: 99999,
        input: { conversationId: 99999, messageText: 'Unknown conversation' },
        actorRoles: ['agent'],
      };
      const nonExistentRes = await broker.execute(nonExistentReq);
      assert.equal(nonExistentRes.success, false);
      assert.equal(nonExistentRes.error?.code, 'CONVERSATION_NOT_FOUND');
    });
  });

  // ===========================================================================
  // SECTION 2: Step 3 Budget Failsafe Interception
  // ===========================================================================
  describe('Adversarial Section 2: Step & Token Budget Failsafe Interception (Step 3)', () => {
    it('2.1 Immediate rejection with budget_exhausted when currentStep = 16', async () => {
      const req: ToolExecutionRequestV1 = {
        tenantId: 1,
        agentGraphId: 'graph_search_agent',
        runId: 'run_step_overflow',
        toolName: 'search_knowledge',
        input: { query: 'Refund request policy' },
        actorRoles: ['agent'],
        currentStep: 16, // > 15
        currentTokensUsed: 100,
      };

      const result = await broker.execute(req);
      assert.equal(result.success, false);
      assert.equal(result.status, 'budget_exhausted');
      assert.equal(result.error?.code, 'BUDGET_EXHAUSTED');
      assert.match(result.error?.message || '', /Operational limit exceeded: steps=16\/15/);
    });

    it('2.2 Immediate rejection with budget_exhausted when currentTokensUsed = 4001', async () => {
      const req: ToolExecutionRequestV1 = {
        tenantId: 1,
        agentGraphId: 'graph_search_agent',
        runId: 'run_token_overflow',
        toolName: 'search_knowledge',
        input: { query: 'Shipping tracking' },
        actorRoles: ['agent'],
        currentStep: 2,
        currentTokensUsed: 4001, // > 4000
      };

      const result = await broker.execute(req);
      assert.equal(result.success, false);
      assert.equal(result.status, 'budget_exhausted');
      assert.equal(result.error?.code, 'BUDGET_EXHAUSTED');
      assert.match(result.error?.message || '', /tokens=4001\/4000/);
    });

    it('2.3 Boundary limit tests: step=15 & tokens=3999 passes; tokens=4000 rejects', async () => {
      // 15 steps and 3999 tokens: passes Step 3 limit
      const passReq: ToolExecutionRequestV1 = {
        tenantId: 1,
        agentGraphId: 'graph_search_agent',
        runId: 'run_boundary_pass',
        toolName: 'search_knowledge',
        input: { query: 'Valid query' },
        actorRoles: ['agent'],
        currentStep: 15,
        currentTokensUsed: 3999,
      };
      const passRes = await broker.execute(passReq);
      assert.equal(passRes.success, true);
      assert.equal(passRes.status, 'executed');

      // Exactly 4000 tokens: rejected
      const failTokenReq: ToolExecutionRequestV1 = {
        tenantId: 1,
        agentGraphId: 'graph_search_agent',
        runId: 'run_boundary_fail_token',
        toolName: 'search_knowledge',
        input: { query: 'Valid query' },
        actorRoles: ['agent'],
        currentStep: 15,
        currentTokensUsed: 4000,
      };
      const failTokenRes = await broker.execute(failTokenReq);
      assert.equal(failTokenRes.success, false);
      assert.equal(failTokenRes.status, 'budget_exhausted');
    });

    it('2.4 Pipeline order invariant: Step budget exhaustion occurs BEFORE creating HITL approvals', async () => {
      // Attempting financial tool create_invoice with exhausted step budget
      const req: ToolExecutionRequestV1 = {
        tenantId: 1,
        agentGraphId: 'graph_finance',
        runId: 'run_order_of_ops',
        toolName: 'create_invoice',
        input: {
          customerId: 'cust_999',
          items: [{ description: 'Test', quantity: 1, unitAmountCents: 1000 }],
        },
        actorRoles: ['agent', 'admin'],
        currentStep: 16, // Step limit violated
      };

      const result = await broker.execute(req);
      assert.equal(result.success, false);
      assert.equal(result.status, 'budget_exhausted');
      assert.equal(result.hitlRequired, false);
      assert.equal(result.approvalId, null);

      // Verify that NO approval request was inserted into the store
      assert.equal(mockUow.store.approvals.size, 0, 'No approval request must be created if budget is exhausted');
    });
  });

  // ===========================================================================
  // SECTION 3: Step 2 RBAC Authorization & Tenant Grants
  // ===========================================================================
  describe('Adversarial Section 3: RBAC Authorization & Tenant Grants (Step 2)', () => {
    it('3.1 Unprivileged caller trying to execute admin-only tool is rejected with 403 / FORBIDDEN', async () => {
      // Register custom tool requiring admin or supervisor roles
      registry.registerTool({
        definition: {
          schemaVersion: 1,
          name: 'admin.purge_tenant_data',
          description: 'Destructive purge of tenant database records',
          riskLevel: 'destructive',
          requiredRoles: ['admin', 'super_admin'],
          parameters: { type: 'object' },
          timeoutMs: 5000,
        },
        validateInput: () => ({ valid: true }),
        execute: async () => ({ purged: true }),
      });

      // Attack vector: unprivileged actor role 'guest'
      const guestReq: ToolExecutionRequestV1 = {
        tenantId: 1,
        agentGraphId: 'graph_malicious',
        runId: 'run_priv_esc_1',
        toolName: 'admin.purge_tenant_data',
        input: {},
        actorRoles: ['guest'],
      };
      const guestRes = await broker.execute(guestReq);
      assert.equal(guestRes.success, false);
      assert.equal(guestRes.status, 'unauthorized');
      assert.equal(guestRes.error?.code, 'FORBIDDEN');

      // Attack vector: standard agent trying to execute admin tool
      const agentReq: ToolExecutionRequestV1 = {
        tenantId: 1,
        agentGraphId: 'graph_malicious',
        runId: 'run_priv_esc_2',
        toolName: 'admin.purge_tenant_data',
        input: {},
        actorRoles: ['agent'],
      };
      const agentRes = await broker.execute(agentReq);
      assert.equal(agentRes.success, false);
      assert.equal(agentRes.status, 'unauthorized');
      assert.equal(agentRes.error?.code, 'FORBIDDEN');

      // Valid admin role succeeds past RBAC
      const adminReq: ToolExecutionRequestV1 = {
        tenantId: 1,
        agentGraphId: 'graph_legit',
        runId: 'run_admin_ok',
        toolName: 'admin.purge_tenant_data',
        input: {},
        actorRoles: ['admin'],
      };
      // Destructive tool requires HITL approval if role passes
      const adminRes = await broker.execute(adminReq);
      assert.equal(adminRes.status, 'awaiting_approval', 'Admin passes RBAC and pauses at HITL');
    });

    it('3.2 Tenant grant revoked in agent_tool_grants rejects execution with TOOL_DISABLED', async () => {
      // Revoke http_request tool for tenant 1
      mockUow.store.grants.set('1:http_request', {
        is_enabled: false,
        required_roles: ['agent', 'admin'],
      });

      const req: ToolExecutionRequestV1 = {
        tenantId: 1,
        agentGraphId: 'graph_01',
        runId: 'run_revoked_grant',
        toolName: 'http_request',
        input: { url: 'https://api.external.com/webhook' },
        actorRoles: ['admin'], // Even an admin is blocked if tool is disabled in tenant grant
      };

      const result = await broker.execute(req);
      assert.equal(result.success, false);
      assert.equal(result.status, 'unauthorized');
      assert.equal(result.error?.code, 'TOOL_DISABLED');
      assert.match(result.error?.message || '', /disabled by tenant administration/);
    });

    it('3.3 Custom required_roles in agent_tool_grants overrides tool default role requirements', async () => {
      // Set grant with restricted role 'security_officer'
      mockUow.store.grants.set('1:create_invoice', {
        is_enabled: true,
        required_roles: ['security_officer'],
      });

      const req: ToolExecutionRequestV1 = {
        tenantId: 1,
        agentGraphId: 'graph_sales',
        runId: 'run_grant_override',
        toolName: 'create_invoice',
        input: {
          customerId: 'cust_1',
          items: [{ description: 'Test', quantity: 1, unitAmountCents: 500 }],
        },
        actorRoles: ['agent', 'admin'], // Has standard roles, but lacks 'security_officer'
      };

      const result = await broker.execute(req);
      assert.equal(result.success, false);
      assert.equal(result.status, 'unauthorized');
      assert.equal(result.error?.code, 'FORBIDDEN');
      assert.match(result.error?.message || '', /Tool grant requires one of: \[security_officer\]/);
    });

    it('3.4 Actor roles matching is case-insensitive', async () => {
      const req: ToolExecutionRequestV1 = {
        tenantId: 1,
        agentGraphId: 'graph_01',
        runId: 'run_case_insensitive',
        toolName: 'search_knowledge',
        input: { query: 'test' },
        actorRoles: ['AGENT'], // Upper-case
      };

      const result = await broker.execute(req);
      assert.equal(result.success, true);
      assert.equal(result.status, 'executed');
    });
  });

  // ===========================================================================
  // SECTION 4: Step 5 & 8 HITL Approvals & CAS Concurrency
  // ===========================================================================
  describe('Adversarial Section 4: HITL Approvals & CAS Concurrency Protection (Step 5)', () => {
    it('4.1 Financial mutation paused -> approval request created -> supervisor decision submitted with CAS check -> replay attempt with stale version rejected', async () => {
      const tenantId = 1;
      const req: ToolExecutionRequestV1 = {
        tenantId,
        agentGraphId: 'graph_billing',
        runId: 'run_inv_001',
        toolName: 'create_invoice',
        input: {
          customerId: 'cust_corp_01',
          currency: 'USD',
          items: [{ description: 'Annual SaaS Subscription', quantity: 1, unitAmountCents: 120000 }],
        },
        actorRoles: ['agent'],
      };

      // 1. Initial attempt: paused awaiting human approval
      const pauseResult = await broker.execute(req);
      assert.equal(pauseResult.success, false);
      assert.equal(pauseResult.status, 'awaiting_approval');
      assert.equal(pauseResult.hitlRequired, true);
      const approvalId = pauseResult.approvalId!;
      assert.ok(approvalId, 'Must generate unique approvalId');

      // 2. Supervisor approves with CAS version 1
      const approvalDecision = await hitlService.decideApproval({
        tenantId,
        approvalId,
        decision: 'approved',
        expectedVersion: 1,
        actorId: 'sup_finance_lead',
        actorRole: 'finance_director',
        reason: 'Authorized by corporate billing policy',
      });
      assert.equal(approvalDecision.status, 'approved');
      assert.equal(approvalDecision.decidedBy, 'sup_finance_lead');

      // 3. Replay attack: second attempt to submit decision with expectedVersion=1 MUST fail with CAS conflict
      await assert.rejects(
        async () => {
          await hitlService.decideApproval({
            tenantId,
            approvalId,
            decision: 'rejected', // Attacker trying to flip to rejected
            expectedVersion: 1,   // Stale version (now 2)
            actorId: 'attacker_01',
            actorRole: 'guest',
          });
        },
        (err: any) => {
          assert.ok(
            err instanceof ApprovalAlreadyDecidedError ||
            err instanceof ApprovalCasConflictError ||
            err.code === 'APPROVAL_ALREADY_DECIDED' ||
            err.code === 'CONCURRENCY_CONFLICT',
            `Expected CAS conflict error, got ${err.name} (${err.code})`
          );
          return true;
        }
      );

      // 4. Stale version attempt (e.g. expectedVersion=99) throws ApprovalCasConflictError or ApprovalAlreadyDecidedError
      await assert.rejects(
        async () => {
          await hitlService.decideApproval({
            tenantId,
            approvalId,
            decision: 'approved',
            expectedVersion: 99,
            actorId: 'sup_user',
            actorRole: 'admin',
          });
        },
        (err: any) => {
          assert.ok(
            err instanceof ApprovalAlreadyDecidedError ||
            err instanceof ApprovalCasConflictError,
            'Must fail CAS verification'
          );
          return true;
        }
      );

      // 5. Tool execution re-attempt: since approval status is now 'approved', execution completes
      const postApprovalResult = await broker.execute(req);
      assert.equal(postApprovalResult.success, true);
      assert.equal(postApprovalResult.status, 'executed');
      assert.ok((postApprovalResult.output as any).invoiceId);
    });

    it('4.2 Rejection branch: Supervisor rejects approval request -> subsequent execution returns status "rejected"', async () => {
      const tenantId = 1;
      const req: ToolExecutionRequestV1 = {
        tenantId,
        agentGraphId: 'graph_billing',
        runId: 'run_inv_reject_test',
        toolName: 'create_invoice',
        input: {
          customerId: 'cust_fraud_risk',
          items: [{ description: 'High Risk Transfer', quantity: 1, unitAmountCents: 5000000 }],
        },
        actorRoles: ['agent'],
      };

      const pauseResult = await broker.execute(req);
      const approvalId = pauseResult.approvalId!;

      // Supervisor rejects
      await hitlService.decideApproval({
        tenantId,
        approvalId,
        decision: 'rejected',
        expectedVersion: 1,
        actorId: 'compliance_officer',
        actorRole: 'compliance_supervisor',
        reason: 'Fraud risk triggered by AML filter',
      });

      // Subsequent tool invocation is rejected by broker
      const reResult = await broker.execute(req);
      assert.equal(reResult.success, false);
      assert.equal(reResult.status, 'rejected');
      assert.equal(reResult.error?.code, 'APPROVAL_REJECTED');
    });

    it('4.3 Concurrent supervisor race on approval decision: exactly one wins, second fails with conflict', async () => {
      const tenantId = 1;
      const req: ToolExecutionRequestV1 = {
        tenantId,
        agentGraphId: 'graph_billing',
        runId: 'run_inv_race',
        toolName: 'create_invoice',
        input: {
          customerId: 'cust_race_01',
          items: [{ description: 'Widget', quantity: 2, unitAmountCents: 100 }],
        },
        actorRoles: ['agent'],
      };

      const pauseResult = await broker.execute(req);
      const approvalId = pauseResult.approvalId!;

      // Two supervisors submit decisions at the exact same time with expectedVersion = 1
      const p1 = hitlService.decideApproval({
        tenantId,
        approvalId,
        decision: 'approved',
        expectedVersion: 1,
        actorId: 'sup_alice',
        actorRole: 'supervisor',
      });

      const p2 = hitlService.decideApproval({
        tenantId,
        approvalId,
        decision: 'rejected',
        expectedVersion: 1,
        actorId: 'sup_bob',
        actorRole: 'supervisor',
      });

      const results = await Promise.allSettled([p1, p2]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      assert.equal(fulfilled.length, 1, 'Exactly one supervisor decision must succeed');
      assert.equal(rejected.length, 1, 'The competing decision must be rejected due to CAS version increment');
    });
  });

  // ===========================================================================
  // SECTION 5: Step 8 Idempotency & Effect Key Caching
  // ===========================================================================
  describe('Adversarial Section 5: Effect Key Idempotency & Side-Effect Prevention (Step 8)', () => {
    it('5.1 Effect key caching: Identical effectKey returns cached output with zero duplicate physical tool invocations', async () => {
      let physicalExecutionCount = 0;

      // Register custom mutative tool with spy counter
      registry.registerTool({
        definition: {
          schemaVersion: 1,
          name: 'payment.charge_card',
          description: 'Charges customer payment method',
          riskLevel: 'write', // Mutative, eligible for caching
          requiredRoles: ['agent'],
          parameters: { type: 'object' },
          timeoutMs: 5000,
        },
        validateInput: () => ({ valid: true }),
        execute: async (input) => {
          physicalExecutionCount += 1;
          return {
            chargeId: `ch_${Date.now()}_${physicalExecutionCount}`,
            amountCents: input.amountCents,
            executionCount: physicalExecutionCount,
          };
        },
      });

      const staticEffectKey = 'eff_charge_card_fixed_key_999';

      const baseReq: ToolExecutionRequestV1 = {
        tenantId: 1,
        agentGraphId: 'graph_payments',
        runId: 'run_charge_01',
        toolName: 'payment.charge_card',
        effectKey: staticEffectKey,
        input: { amountCents: 5000 },
        actorRoles: ['agent'],
      };

      // 1. First execution: physical tool runs
      const res1 = await broker.execute(baseReq);
      assert.equal(res1.success, true);
      assert.equal(res1.status, 'executed');
      assert.equal(physicalExecutionCount, 1, 'Tool body must execute once');
      const firstChargeId = (res1.output as any).chargeId;

      // 2. Ten duplicate calls with identical effectKey
      for (let i = 2; i <= 10; i++) {
        const repeatRes = await broker.execute(baseReq);
        assert.equal(repeatRes.success, true);
        assert.equal(repeatRes.status, 'cached', `Call #${i} must return cached status`);
        assert.equal(
          (repeatRes.output as any).chargeId,
          firstChargeId,
          `Call #${i} must return identical cached chargeId`
        );
      }

      // 3. Verify ZERO duplicate physical executions occurred
      assert.equal(
        physicalExecutionCount,
        1,
        'Physical tool execution MUST remain strictly at 1 across all 10 calls'
      );
    });

    it('5.2 Read-only tools (riskLevel = read) bypass effect cache and execute freshly each time', async () => {
      let readCount = 0;
      registry.registerTool({
        definition: {
          schemaVersion: 1,
          name: 'analytics.read_metrics',
          description: 'Reads current system metrics',
          riskLevel: 'read',
          requiredRoles: ['agent'],
          parameters: { type: 'object' },
          timeoutMs: 5000,
        },
        validateInput: () => ({ valid: true }),
        execute: async () => {
          readCount += 1;
          return { timestamp: Date.now(), counter: readCount };
        },
      });

      const req: ToolExecutionRequestV1 = {
        tenantId: 1,
        agentGraphId: 'graph_01',
        runId: 'run_read_test',
        toolName: 'analytics.read_metrics',
        effectKey: 'eff_read_always_fresh',
        input: {},
        actorRoles: ['agent'],
      };

      const res1 = await broker.execute(req);
      assert.equal(res1.status, 'executed');
      assert.equal((res1.output as any).counter, 1);

      const res2 = await broker.execute(req);
      assert.equal(res2.status, 'executed', 'Read tool must NOT be returned from cache');
      assert.equal((res2.output as any).counter, 2);
      assert.equal(readCount, 2);
    });
  });

  // ===========================================================================
  // SECTION 6: Multi-Tenant Boundary Isolation
  // ===========================================================================
  describe('Adversarial Section 6: Multi-Tenant Boundary Isolation', () => {
    it('6.1 Cross-tenant HITL decision isolation: Tenant 2 cannot decide or view Tenant 1 approval', async () => {
      const tenant1Req: ToolExecutionRequestV1 = {
        tenantId: 1,
        agentGraphId: 'graph_billing',
        runId: 'run_t1_inv',
        toolName: 'create_invoice',
        input: {
          customerId: 'cust_t1',
          items: [{ description: 'Item 1', quantity: 1, unitAmountCents: 100 }],
        },
        actorRoles: ['agent'],
      };

      const t1Pause = await broker.execute(tenant1Req);
      const approvalId = t1Pause.approvalId!;

      // Attacker from Tenant 2 attempts to decide Tenant 1's approval request
      await assert.rejects(
        async () => {
          await hitlService.decideApproval({
            tenantId: 2, // Cross-tenant leak attempt
            approvalId,
            decision: 'approved',
            expectedVersion: 1,
            actorId: 'sup_t2',
            actorRole: 'admin',
          });
        },
        (err: any) => {
          assert.ok(
            err instanceof ApprovalNotFoundError || err.code === 'APPROVAL_NOT_FOUND',
            `Must throw ApprovalNotFoundError on cross-tenant access, got ${err.name}`
          );
          return true;
        }
      );
    });

    it('6.2 Cross-tenant EffectCache isolation: Tenant 2 cannot read Tenant 1 cached execution output', async () => {
      let tenant1Executions = 0;
      let tenant2Executions = 0;

      registry.registerTool({
        definition: {
          schemaVersion: 1,
          name: 'data.export_sensitive',
          description: 'Generates secure export',
          riskLevel: 'write',
          requiredRoles: ['agent'],
          parameters: { type: 'object' },
          timeoutMs: 5000,
        },
        validateInput: () => ({ valid: true }),
        execute: async (_input, ctx) => {
          if (ctx.tenantId === 1) tenant1Executions += 1;
          if (ctx.tenantId === 2) tenant2Executions += 1;
          return { tenantId: ctx.tenantId, secretPayload: `secret_data_for_tenant_${ctx.tenantId}` };
        },
      });

      const sharedEffectKey = 'eff_colliding_shared_hash_key';

      // Tenant 1 executes
      const resT1 = await broker.execute({
        tenantId: 1,
        agentGraphId: 'graph_t1',
        runId: 'run_t1',
        toolName: 'data.export_sensitive',
        effectKey: sharedEffectKey,
        input: {},
        actorRoles: ['agent'],
      });
      assert.equal(resT1.status, 'executed');
      assert.equal((resT1.output as any).secretPayload, 'secret_data_for_tenant_1');
      assert.equal(tenant1Executions, 1);

      // Tenant 2 executes with identical effectKey
      const resT2 = await broker.execute({
        tenantId: 2,
        agentGraphId: 'graph_t2',
        runId: 'run_t2',
        toolName: 'data.export_sensitive',
        effectKey: sharedEffectKey,
        input: {},
        actorRoles: ['agent'],
      });

      // Tenant 2 MUST NOT get Tenant 1's cached secret data
      assert.equal(resT2.status, 'executed', 'Tenant 2 must execute freshly, not read Tenant 1 cache');
      assert.equal((resT2.output as any).secretPayload, 'secret_data_for_tenant_2');
      assert.equal(tenant2Executions, 1);
    });

    it('6.3 Cross-tenant CAS Conversation isolation: Tenant 2 cannot access Tenant 1 conversation', async () => {
      // Conversation belongs to Tenant 1
      mockUow.store.conversations.set('1:777', {
        id: 777,
        company_id: 1,
        version: 1,
        ownership_epoch: 1,
        owner_type: 'ai_agent',
        owner_id: null,
        ia_paused: false,
      });

      // Tenant 2 tries to send message on Tenant 1 conversation 777
      const resT2 = await broker.execute({
        tenantId: 2,
        agentGraphId: 'graph_t2',
        runId: 'run_t2_leak',
        toolName: 'send_whatsapp_message',
        conversationId: 777,
        input: { conversationId: 777, messageText: 'Cross-tenant injection' },
        actorRoles: ['agent'],
      });

      assert.equal(resT2.success, false);
      assert.equal(resT2.status, 'failed');
      assert.equal(resT2.error?.code, 'CONVERSATION_NOT_FOUND');
    });
  });
});
