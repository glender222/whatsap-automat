import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  TOOL_RISK_LEVELS,
  toolRiskLevelSchema,
  toolDefinitionV1Schema,
  toolExecutionRequestV1Schema,
  toolExecutionResultV1Schema,
  agentBudgetLimitsV1Schema,
  TOOL_BROKER_BUDGET_LIMITS,
  isHitlRequired,
  isMutativeTool,
  requiresCasFencing,
  checkBudgetExhausted,
  validateToolExecutionRequest,
  computeEffectKey,
  toModelToolDefinition,
  approvalRequestV1Schema,
  approvalDecisionCommandV1Schema,
  mockReadToolFixture,
  mockWriteToolFixture,
  mockSendToolFixture,
  mockFinancialToolFixture,
  mockDestructiveToolFixture,
  mockToolExecutionRequestFixture,
  mockMutativeToolExecutionRequestFixture,
  mockSendToolExecutionRequestFixture,
  mockToolExecutionResultSuccessFixture,
  mockToolExecutionResultHitlFixture,
} from '../src';

describe('PR-F5-02 ToolBroker Security Barrier & Risk Taxonomy Contracts', () => {
  describe('5-Tier Risk Classification & Predicates', () => {
    it('defines exactly 5 canonical risk levels', () => {
      assert.deepEqual(TOOL_RISK_LEVELS, ['read', 'write', 'send', 'financial', 'destructive']);
    });

    it('validates each risk level against Zod schema', () => {
      for (const level of TOOL_RISK_LEVELS) {
        assert.ok(toolRiskLevelSchema.safeParse(level).success);
      }
      assert.equal(toolRiskLevelSchema.safeParse('unauthorized_level').success, false);
      assert.equal(toolRiskLevelSchema.safeParse('low').success, false); // low belongs to legacy risk
    });

    it('correctly classifies HITL requirement (financial & destructive)', () => {
      assert.equal(isHitlRequired('read'), false);
      assert.equal(isHitlRequired('write'), false);
      assert.equal(isHitlRequired('send'), false);
      assert.equal(isHitlRequired('financial'), true);
      assert.equal(isHitlRequired('destructive'), true);
    });

    it('correctly classifies mutative side-effects (write, send, financial, destructive)', () => {
      assert.equal(isMutativeTool('read'), false);
      assert.equal(isMutativeTool('write'), true);
      assert.equal(isMutativeTool('send'), true);
      assert.equal(isMutativeTool('financial'), true);
      assert.equal(isMutativeTool('destructive'), true);
    });

    it('correctly classifies CAS anti-takeover requirement (send only)', () => {
      assert.equal(requiresCasFencing('read'), false);
      assert.equal(requiresCasFencing('write'), false);
      assert.equal(requiresCasFencing('send'), true);
      assert.equal(requiresCasFencing('financial'), false);
      assert.equal(requiresCasFencing('destructive'), false);
    });
  });

  describe('ToolDefinitionV1 Contracts', () => {
    it('validates all 5 mock tool fixtures representing each risk tier', () => {
      assert.ok(toolDefinitionV1Schema.safeParse(mockReadToolFixture).success);
      assert.ok(toolDefinitionV1Schema.safeParse(mockWriteToolFixture).success);
      assert.ok(toolDefinitionV1Schema.safeParse(mockSendToolFixture).success);
      assert.ok(toolDefinitionV1Schema.safeParse(mockFinancialToolFixture).success);
      assert.ok(toolDefinitionV1Schema.safeParse(mockDestructiveToolFixture).success);
    });

    it('rejects an invalid tool name with disallowed characters', () => {
      const invalid = {
        ...mockReadToolFixture,
        name: 'catalog search; rm -rf /',
      };
      const parsed = toolDefinitionV1Schema.safeParse(invalid);
      assert.equal(parsed.success, false);
    });

    it('rejects a tool definition with empty requiredRoles', () => {
      const invalid = {
        ...mockReadToolFixture,
        requiredRoles: [],
      };
      const parsed = toolDefinitionV1Schema.safeParse(invalid);
      assert.equal(parsed.success, false);
    });

    it('converts ToolDefinitionV1 to ModelToolDefinitionV1 stripping security metadata', () => {
      const modelTool = toModelToolDefinition(mockFinancialToolFixture);
      assert.equal(modelTool.name, 'payment.create_link');
      assert.equal(modelTool.description, mockFinancialToolFixture.description);
      assert.deepEqual(modelTool.parameters, mockFinancialToolFixture.parameters);
      assert.equal((modelTool as any).riskLevel, undefined);
      assert.equal((modelTool as any).requiredRoles, undefined);
    });
  });

  describe('ToolExecutionRequestV1 & Idempotency Key Validation', () => {
    it('validates a read tool execution request without effectKey', () => {
      const parsed = toolExecutionRequestV1Schema.safeParse(mockToolExecutionRequestFixture);
      assert.ok(parsed.success);
      const validation = validateToolExecutionRequest(parsed.data, 'read');
      assert.equal(validation.valid, true);
    });

    it('validates a mutative tool execution request with valid effectKey', () => {
      const parsed = toolExecutionRequestV1Schema.safeParse(mockMutativeToolExecutionRequestFixture);
      assert.ok(parsed.success);
      const validation = validateToolExecutionRequest(parsed.data, 'write');
      assert.equal(validation.valid, true);
    });

    it('rejects a mutative tool execution request when effectKey is missing', () => {
      const req = {
        ...mockMutativeToolExecutionRequestFixture,
        effectKey: undefined,
      };
      const validation = validateToolExecutionRequest(req, 'write');
      assert.equal(validation.valid, false);
      assert.match(validation.error!, /requires a valid effectKey for idempotency/);
    });

    it('rejects an outbound send tool when expectedConversationVersion is missing', () => {
      const req = {
        ...mockSendToolExecutionRequestFixture,
        expectedConversationVersion: undefined,
      };
      const validation = validateToolExecutionRequest(req, 'send');
      assert.equal(validation.valid, false);
      assert.match(validation.error!, /requires expectedConversationVersion for CAS anti-takeover fencing/);
    });

    it('computes deterministic effectKey across identical inputs', () => {
      const key1 = computeEffectKey(42, 'run_001', 'order.create_draft', 2, { sku: 'PROD-1', qty: 2 });
      const key2 = computeEffectKey(42, 'run_001', 'order.create_draft', 2, { qty: 2, sku: 'PROD-1' }); // keys reversed
      assert.equal(key1, key2);
      assert.match(key1, /^eff_order_create_draft_step2_[a-f0-9]{16}$/);
    });
  });

  describe('ToolExecutionResultV1 Contracts', () => {
    it('validates successful execution result fixture', () => {
      const parsed = toolExecutionResultV1Schema.safeParse(mockToolExecutionResultSuccessFixture);
      assert.ok(parsed.success);
      assert.equal(parsed.data.status, 'executed');
      assert.equal(parsed.data.hitlRequired, false);
      assert.equal(parsed.data.approvalId, null);
    });

    it('validates HITL required execution result fixture with pending approval', () => {
      const parsed = toolExecutionResultV1Schema.safeParse(mockToolExecutionResultHitlFixture);
      assert.ok(parsed.success);
      assert.equal(parsed.data.status, 'awaiting_approval');
      assert.equal(parsed.data.hitlRequired, true);
      assert.equal(parsed.data.approvalId, 'appr_req_fin_001');
    });

    it('validates error execution result with standard error payload', () => {
      const errorResult = {
        success: false,
        status: 'ssrf_blocked' as const,
        output: null,
        error: {
          code: 'POLICY_DENIED',
          message: 'Target destination IP belongs to prohibited private subnet',
          details: { destinationIp: '169.254.169.254', range: 'Cloud IMDS' },
        },
        durationMs: 8,
        riskLevel: 'read' as const,
        hitlRequired: false,
        approvalId: null,
        effectKey: null,
      };
      const parsed = toolExecutionResultV1Schema.safeParse(errorResult);
      assert.ok(parsed.success);
      assert.equal(parsed.data.status, 'ssrf_blocked');
      assert.equal(parsed.data.error?.code, 'POLICY_DENIED');
    });
  });

  describe('Step and Token Budget Failsafe Contracts', () => {
    it('validates default budget limits of 15 steps and 4,000 tokens', () => {
      const defaultLimits = agentBudgetLimitsV1Schema.parse({});
      assert.equal(defaultLimits.maxSteps, 15);
      assert.equal(defaultLimits.maxModelTokens, 4000);
      assert.equal(TOOL_BROKER_BUDGET_LIMITS.MAX_STEPS_PER_RUN, 15);
      assert.equal(TOOL_BROKER_BUDGET_LIMITS.MAX_MODEL_TOKENS_PER_RUN, 4000);
    });

    it('triggers budget exhaustion when steps reach or exceed limit', () => {
      const check1 = checkBudgetExhausted(14, 2000);
      assert.equal(check1.isExhausted, false);

      const check2 = checkBudgetExhausted(15, 2000);
      assert.equal(check2.isExhausted, true);
      assert.equal(check2.reason, 'steps_exhausted');

      const check3 = checkBudgetExhausted(16, 2000);
      assert.equal(check3.isExhausted, true);
    });

    it('triggers budget exhaustion when tokens reach or exceed limit', () => {
      const check1 = checkBudgetExhausted(5, 3999);
      assert.equal(check1.isExhausted, false);

      const check2 = checkBudgetExhausted(5, 4000);
      assert.equal(check2.isExhausted, true);
      assert.equal(check2.reason, 'tokens_exhausted');
    });
  });

  describe('HITL Approval Integration & Backward Compatibility', () => {
    it('accepts 5-tier risk levels in ApprovalRequestV1 without breaking', () => {
      const finApproval = {
        id: 'appr_req_fin_001',
        tenantId: 'tenant_synthetic_alpha',
        runId: 'run_001',
        nodeId: 'node_pay',
        effectKey: 'eff_pay_001',
        proposedActionHash: 'sha256_hash_123',
        policyVersion: 1,
        risk: 'financial' as const,
        status: 'pending' as const,
        expiresAt: '2026-11-03T10:00:00.000Z',
        createdAt: '2026-11-02T10:00:00.000Z',
      };
      const parsedFin = approvalRequestV1Schema.safeParse(finApproval);
      assert.ok(parsedFin.success);
      assert.equal(parsedFin.data.risk, 'financial');

      const destApproval = {
        ...finApproval,
        id: 'appr_req_dest_002',
        risk: 'destructive' as const,
      };
      const parsedDest = approvalRequestV1Schema.safeParse(destApproval);
      assert.ok(parsedDest.success);
      assert.equal(parsedDest.data.risk, 'destructive');
    });

    it('accepts ApprovalDecisionCommandV1 with direct actorId/actorRole or actor object', () => {
      const directCmd = {
        schemaVersion: 1,
        decision: 'approved' as const,
        reason: 'Authorized by finance manager',
        expectedVersion: 1,
        approvalId: 'appr_req_fin_001',
        actorId: 'usr_mgr_01',
        actorRole: 'FINANCE_ADMIN',
      };
      const parsedDirect = approvalDecisionCommandV1Schema.safeParse(directCmd);
      assert.ok(parsedDirect.success);
      assert.equal(parsedDirect.data.decision, 'approved');
      assert.equal(parsedDirect.data.actorRole, 'FINANCE_ADMIN');
    });
  });
});
