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
  HttpRequestTool,
  SearchKnowledgeTool,
} = require('../services/ai/broker') as typeof import('../services/ai/broker');
const { ConversationCasService } = require('../services/conversations/ConversationCasService') as typeof import('../services/conversations/ConversationCasService');
import type {
  ToolExecutionRequestV1,
  ApprovalRequestV1,
  ApprovalDecisionResultV1,
} from '@whatsap-automat/contracts';

// In-memory mock UoW for isolated unit testing
function createMockUoW() {
  const store = {
    conversations: new Map<string, any>(),
    approvals: new Map<string, any>(),
    effects: new Map<string, any>(),
    grants: new Map<string, any>(),
  };

  const mockUow: any = {
    store,
    async run(tenantId: number, fn: (client: any) => Promise<any>) {
      const client = {
        async query(sql: string, params: any[] = []) {
          // 1. SELECT conversation state
          if (sql.includes('FROM conversations')) {
            const convId = String(params[0]);
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

          // 3. SELECT from approval_requests by effect_key
          if (sql.includes('FROM approval_requests') && sql.includes('effect_key = $2')) {
            const app = store.approvals.get(`effect:${tenantId}:${params[1]}`);
            if (!app) return { rowCount: 0, rows: [] };
            return { rowCount: 1, rows: [app] };
          }

          // 4. SELECT from approval_requests by id
          if (sql.includes('FROM approval_requests') && sql.includes('id = $2')) {
            const app = store.approvals.get(`${tenantId}:${params[1]}`);
            if (!app) return { rowCount: 0, rows: [] };
            return { rowCount: 1, rows: [app] };
          }

          // 5. UPDATE approval_requests (CAS decision)
          if (sql.includes('UPDATE approval_requests')) {
            const decision = params[0];
            const actorId = params[1];
            const reason = params[2];
            const approvalId = params[3];
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

          // 6. SELECT / INSERT tool_execution_effects
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

          // 7. SELECT agent_tool_grants
          if (sql.includes('FROM agent_tool_grants')) {
            const grant = store.grants.get(`${tenantId}:${params[1]}`);
            if (!grant) return { rowCount: 0, rows: [] };
            return { rowCount: 1, rows: [grant] };
          }

          return { rowCount: 0, rows: [] };
        },
      };

      return fn(client);
    },
  };

  return mockUow;
}

describe('PR-F5-02 ToolBroker Security Barrier & Interception Engine Tests', () => {
  let mockUow: any;
  let registry: ToolRegistry;
  let hitlService: HitlApprovalService;
  let casService: ConversationCasService;
  let effectCache: ReturnType<typeof createBrokerFixtureEffectCache>;
  let broker: ToolBroker;

  beforeEach(() => {
    mockUow = createMockUoW();
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

  describe('Suite 1: Tool Registry & Discovery', () => {
    it('exposes only tools with a working implementation by default', async () => {
      const productionRegistry = new ToolRegistry(mockUow);
      assert.deepEqual((await productionRegistry.listTools(1)).map((tool) => tool.definition.name), [
        'http_request', 'search_knowledge',
      ]);
      assert.equal(await productionRegistry.getTool(1, 'send_whatsapp_message'), null);
      assert.equal(await productionRegistry.getTool(1, 'create_invoice'), null);
    });

    it('lists implemented tools and explicitly injected test fixtures', async () => {
      const tools = await registry.listTools(1);
      const toolNames = tools.map((t) => t.definition.name);

      assert.ok(toolNames.includes('http_request'));
      assert.ok(toolNames.includes('search_knowledge'));
      assert.ok(toolNames.includes('send_whatsapp_message'));
      assert.ok(toolNames.includes('create_invoice'));
    });

    it('returns null when querying a non-existent tool', async () => {
      const tool = await registry.getTool(1, 'non_existent_tool_xyz');
      assert.equal(tool, null);
    });

    it('allows registering custom tools per tenant', async () => {
      registry.registerTool({
        definition: {
          schemaVersion: 1,
          name: 'crm.sync_contact',
          description: 'Syncs contact details with CRM',
          riskLevel: 'write',
          requiredRoles: ['agent'],
          parameters: { type: 'object' },
          timeoutMs: 5000,
          isEgressNetworkTool: false,
        },
        validateInput: () => ({ valid: true }),
        execute: async () => ({ synced: true }),
      }, 42);

      const toolT42 = await registry.getTool(42, 'crm.sync_contact');
      assert.ok(toolT42);
      assert.equal(toolT42.definition.name, 'crm.sync_contact');

      // Tenant 1 does not see tenant 42 custom tool
      const toolT1 = await registry.getTool(1, 'crm.sync_contact');
      assert.equal(toolT1, null);
    });
  });

  describe('Suite 2: Schema Validation (Step 1)', () => {
    it('rejects an unregistered tool with TOOL_NOT_FOUND and destructive risk fail-secure', async () => {
      const req: ToolExecutionRequestV1 = {
        tenantId: 1,
        agentGraphId: 'graph_01',
        runId: 'run_01',
        toolName: 'malicious_shell_exec',
        input: { cmd: 'cat /etc/passwd' },
        actorRoles: ['agent'],
      };

      const result = await broker.execute(req);
      assert.equal(result.success, false);
      assert.equal(result.status, 'failed');
      assert.equal(result.error?.code, 'TOOL_NOT_FOUND');
      assert.equal(result.riskLevel, 'destructive');
    });

    it('rejects http_request tool when required "url" parameter is missing', async () => {
      const req: ToolExecutionRequestV1 = {
        tenantId: 1,
        agentGraphId: 'graph_01',
        runId: 'run_01',
        toolName: 'http_request',
        input: { method: 'GET' }, // Missing 'url'
        actorRoles: ['agent'],
      };

      const result = await broker.execute(req);
      assert.equal(result.success, false);
      assert.equal(result.status, 'failed');
      assert.equal(result.error?.code, 'VALIDATION_ERROR');
    });

    it('rejects send_whatsapp_message tool when messageText is missing', async () => {
      const req: ToolExecutionRequestV1 = {
        tenantId: 1,
        agentGraphId: 'graph_01',
        runId: 'run_01',
        toolName: 'send_whatsapp_message',
        input: { conversationId: 100 }, // Missing messageText
        actorRoles: ['agent'],
      };

      const result = await broker.execute(req);
      assert.equal(result.success, false);
      assert.equal(result.status, 'failed');
      assert.equal(result.error?.code, 'VALIDATION_ERROR');
    });
  });

  describe('Suite 3: RBAC Authorization (Step 2)', () => {
    it('rejects tool execution when actor lacks required roles', async () => {
      const req: ToolExecutionRequestV1 = {
        tenantId: 1,
        agentGraphId: 'graph_01',
        runId: 'run_01',
        toolName: 'http_request',
        input: { url: 'https://example.com/api' },
        actorRoles: ['guest'], // 'http_request' requires ['agent', 'admin']
      };

      const result = await broker.execute(req);
      assert.equal(result.success, false);
      assert.equal(result.status, 'unauthorized');
      assert.equal(result.error?.code, 'FORBIDDEN');
    });

    it('rejects tool execution when tool is disabled by tenant administration in agent_tool_grants', async () => {
      // Disable http_request for tenant 1
      mockUow.store.grants.set('1:http_request', {
        is_enabled: false,
        required_roles: ['agent'],
      });

      const req: ToolExecutionRequestV1 = {
        tenantId: 1,
        agentGraphId: 'graph_01',
        runId: 'run_01',
        toolName: 'http_request',
        input: { url: 'https://example.com/api' },
        actorRoles: ['agent'],
      };

      const result = await broker.execute(req);
      assert.equal(result.success, false);
      assert.equal(result.status, 'unauthorized');
      assert.equal(result.error?.code, 'TOOL_DISABLED');
    });
  });

  describe('Suite 4: Operational Limits & Budget Failsafe (Step 3)', () => {
    it('halts execution with budget_exhausted when currentStep > 15', async () => {
      const req: ToolExecutionRequestV1 = {
        tenantId: 1,
        agentGraphId: 'graph_01',
        runId: 'run_01',
        toolName: 'search_knowledge',
        input: { query: 'returns policy' },
        actorRoles: ['agent'],
        currentStep: 16, // Exceeds MAX_STEPS_PER_RUN (15)
        currentTokensUsed: 500,
      };

      const result = await broker.execute(req);
      assert.equal(result.success, false);
      assert.equal(result.status, 'budget_exhausted');
      assert.equal(result.error?.code, 'BUDGET_EXHAUSTED');
    });

    it('halts execution with budget_exhausted when currentTokensUsed >= 4000', async () => {
      const req: ToolExecutionRequestV1 = {
        tenantId: 1,
        agentGraphId: 'graph_01',
        runId: 'run_01',
        toolName: 'search_knowledge',
        input: { query: 'returns policy' },
        actorRoles: ['agent'],
        currentStep: 3,
        currentTokensUsed: 4000, // Reaches MAX_MODEL_TOKENS_PER_RUN (4000)
      };

      const result = await broker.execute(req);
      assert.equal(result.success, false);
      assert.equal(result.status, 'budget_exhausted');
      assert.equal(result.error?.code, 'BUDGET_EXHAUSTED');
    });
  });

  describe('Suite 5: HITL Approvals Lifecycle (Step 5)', () => {
    it('pauses financial tool create_invoice and creates durable approval request', async () => {
      const req: ToolExecutionRequestV1 = {
        tenantId: 1,
        agentGraphId: 'graph_sales_01',
        runId: 'run_order_99',
        toolName: 'create_invoice',
        input: {
          customerId: 'cust_4001',
          items: [{ description: 'Enterprise License', quantity: 1, unitAmountCents: 50000 }],
        },
        actorRoles: ['agent'],
        currentStep: 2,
      };

      const result = await broker.execute(req);
      assert.equal(result.success, false);
      assert.equal(result.status, 'awaiting_approval');
      assert.equal(result.hitlRequired, true);
      assert.ok(result.approvalId);
      assert.equal(result.riskLevel, 'financial');

      // Subsequent identical call before approval returns the same pending approval
      const repeatResult = await broker.execute(req);
      assert.equal(repeatResult.status, 'awaiting_approval');
      assert.equal(repeatResult.approvalId, result.approvalId);
    });

    it('rejects execution when human supervisor rejects the approval request', async () => {
      const req: ToolExecutionRequestV1 = {
        tenantId: 1,
        agentGraphId: 'graph_sales_01',
        runId: 'run_order_99',
        toolName: 'create_invoice',
        input: {
          customerId: 'cust_4001',
          items: [{ description: 'Enterprise License', quantity: 1, unitAmountCents: 50000 }],
        },
        actorRoles: ['agent'],
        currentStep: 2,
      };

      const initialResult = await broker.execute(req);
      const approvalId = initialResult.approvalId!;

      // Supervisor rejects
      await hitlService.decideApproval({
        tenantId: 1,
        approvalId,
        decision: 'rejected',
        expectedVersion: 1,
        actorId: 'sup_user_1',
        actorRole: 'finance_admin',
        reason: 'Customer credit limit reached',
      });

      // ToolBroker re-evaluates: returns rejected
      const reResult = await broker.execute(req);
      assert.equal(reResult.success, false);
      assert.equal(reResult.status, 'rejected');
      assert.equal(reResult.error?.code, 'APPROVAL_REJECTED');
    });

    it('allows execution when human supervisor approves the approval request', async () => {
      const req: ToolExecutionRequestV1 = {
        tenantId: 1,
        agentGraphId: 'graph_sales_01',
        runId: 'run_order_99',
        toolName: 'create_invoice',
        input: {
          customerId: 'cust_4001',
          items: [{ description: 'Enterprise License', quantity: 1, unitAmountCents: 50000 }],
        },
        actorRoles: ['agent'],
        currentStep: 2,
      };

      const initialResult = await broker.execute(req);
      const approvalId = initialResult.approvalId!;

      // Supervisor approves
      await hitlService.decideApproval({
        tenantId: 1,
        approvalId,
        decision: 'approved',
        expectedVersion: 1,
        actorId: 'sup_user_1',
        actorRole: 'finance_admin',
      });

      const modified = await broker.execute({
        ...req,
        effectKey: initialResult.effectKey!,
        input: { ...req.input, items: [{ description: 'Enterprise License', quantity: 1, unitAmountCents: 90000 }] },
      });
      assert.equal(modified.status, 'unauthorized');
      assert.equal(modified.error?.code, 'APPROVAL_ACTION_MISMATCH');

      // The approved action itself can still execute.
      const reResult = await broker.execute(req);
      assert.equal(reResult.success, true);
      assert.equal(reResult.status, 'executed');
      assert.ok(reResult.output);
      assert.equal((reResult.output as any).status, 'created');
    });
  });

  describe('Suite 6: CAS Anti-Takeover Fencing on "send" Risk (Step 6)', () => {
    it('blocks outbound send when human operator has taken over the conversation', async () => {
      // Setup conversation in human control
      mockUow.store.conversations.set('1:101', {
        id: 101,
        version: 5,
        ownership_epoch: 2,
        owner_type: 'human',
        owner_id: 'agent_operator_alice',
        ia_paused: true,
      });

      const req: ToolExecutionRequestV1 = {
        tenantId: 1,
        agentGraphId: 'graph_chat_01',
        runId: 'run_chat_01',
        toolName: 'send_whatsapp_message',
        conversationId: 101,
        input: {
          conversationId: 101,
          messageText: 'Hello from AI assistant',
        },
        actorRoles: ['agent'],
      };

      const result = await broker.execute(req);
      assert.equal(result.success, false);
      assert.equal(result.status, 'cas_conflict');
      assert.equal(result.error?.code, 'HUMAN_TAKEOVER_ACTIVE');
    });

    it('blocks outbound send when conversation version does not match expected version', async () => {
      // Setup conversation at version 5
      mockUow.store.conversations.set('1:102', {
        id: 102,
        version: 5,
        ownership_epoch: 1,
        owner_type: 'ai_agent',
        owner_id: null,
        ia_paused: false,
      });

      const req: ToolExecutionRequestV1 = {
        tenantId: 1,
        agentGraphId: 'graph_chat_01',
        runId: 'run_chat_01',
        toolName: 'send_whatsapp_message',
        conversationId: 102,
        expectedConversationVersion: 4, // Stale version (db has 5)
        input: {
          conversationId: 102,
          messageText: 'Hello from AI assistant',
        },
        actorRoles: ['agent'],
      };

      const result = await broker.execute(req);
      assert.equal(result.success, false);
      assert.equal(result.status, 'cas_conflict');
      assert.equal(result.error?.code, 'CONCURRENCY_CONFLICT');
    });

    it('allows outbound send when version matches and AI has control', async () => {
      mockUow.store.conversations.set('1:103', {
        id: 103,
        version: 3,
        ownership_epoch: 1,
        owner_type: 'ai_agent',
        owner_id: null,
        ia_paused: false,
      });

      const req: ToolExecutionRequestV1 = {
        tenantId: 1,
        agentGraphId: 'graph_chat_01',
        runId: 'run_chat_01',
        toolName: 'send_whatsapp_message',
        conversationId: 103,
        expectedConversationVersion: 3, // Matches exactly
        input: {
          conversationId: 103,
          messageText: 'Su reserva está confirmada.',
        },
        actorRoles: ['agent'],
      };

      const result = await broker.execute(req);
      assert.equal(result.success, true);
      assert.equal(result.status, 'executed');
      assert.equal((result.output as any).status, 'dispatched');
    });
  });

  describe('Suite 7: SSRF Egress Firewall Interception (Step 7)', () => {
    it('rejects an external HTTP write before making a request', async () => {
      const result = await broker.execute({
        tenantId: 1, agentGraphId: 'graph_01', runId: 'run_01', toolName: 'http_request', actorRoles: ['admin'],
        input: { url: 'http://169.254.169.254/update', method: 'POST', body: { action: 'change' } },
      });
      assert.equal(result.status, 'failed');
      assert.equal(result.riskLevel, 'read');
      assert.equal(result.error?.code, 'VALIDATION_ERROR');
    });

    it('blocks http_request targeting RFC 1918 private address (192.168.1.1)', async () => {
      const req: ToolExecutionRequestV1 = {
        tenantId: 1,
        agentGraphId: 'graph_01',
        runId: 'run_01',
        toolName: 'http_request',
        input: { url: 'http://192.168.1.1/admin' },
        actorRoles: ['agent'],
      };

      const result = await broker.execute(req);
      assert.equal(result.success, false);
      assert.equal(result.status, 'ssrf_blocked');
      assert.equal(result.error?.code, 'SSRF_BLOCKED');
    });

    it('blocks http_request targeting Cloud IMDS (169.254.169.254)', async () => {
      const req: ToolExecutionRequestV1 = {
        tenantId: 1,
        agentGraphId: 'graph_01',
        runId: 'run_01',
        toolName: 'http_request',
        input: { url: 'http://169.254.169.254/latest/meta-data/' },
        actorRoles: ['agent'],
      };

      const result = await broker.execute(req);
      assert.equal(result.success, false);
      assert.equal(result.status, 'ssrf_blocked');
      assert.equal(result.error?.code, 'SSRF_BLOCKED');
    });
  });

  describe('Suite 8: Idempotency & Effect Caching (Step 8)', () => {
    it('returns cached output on duplicate mutative tool execution with same effectKey', async () => {
      mockUow.store.conversations.set('1:105', {
        id: 105,
        version: 1,
        ownership_epoch: 1,
        owner_type: 'ai_agent',
        owner_id: null,
        ia_paused: false,
      });

      const req: ToolExecutionRequestV1 = {
        tenantId: 1,
        agentGraphId: 'graph_01',
        runId: 'run_01',
        toolName: 'send_whatsapp_message',
        conversationId: 105,
        expectedConversationVersion: 1,
        effectKey: 'eff_send_msg_custom_key_105',
        input: {
          conversationId: 105,
          messageText: 'Mensaje idempotente.',
        },
        actorRoles: ['agent'],
      };

      // First run: physical execution
      const result1 = await broker.execute(req);
      assert.equal(result1.success, true);
      assert.equal(result1.status, 'executed');
      const messageId1 = (result1.output as any).messageId;

      // Second run: cached result
      const result2 = await broker.execute(req);
      assert.equal(result2.success, true);
      assert.equal(result2.status, 'cached');
      const messageId2 = (result2.output as any).messageId;

      // Outputs match exactly (no second message sent)
      assert.equal(messageId1, messageId2);
    });
  });
});
