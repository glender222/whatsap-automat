import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  agentGraphVersionV1Schema,
  toolInvocationV1Schema,
  agentRunTraceV1Schema,
  approvalRequestV1Schema,
  approvalDecisionCommandV1Schema,
  validAgentGraphFixture,
  cyclicAgentGraphFixture,
  toolInvocationFixture,
  agentRunTraceFixture,
  pendingApprovalFixture,
  approvedDecisionCommandFixture,
  rejectedDecisionCommandFixture,
  expiredApprovalFixture,
} from '../src';

describe('Agent Graphs, Tool Invocations & Approvals Contracts', () => {
  it('validates a comprehensive multi-node DAG AgentGraphVersionV1', () => {
    const parsed = agentGraphVersionV1Schema.safeParse(validAgentGraphFixture);
    assert.ok(parsed.success, `Graph validation failed: ${JSON.stringify(parsed.error?.issues)}`);
    assert.equal(parsed.data.schemaVersion, 1);
    assert.equal(parsed.data.nodes.length, 5);
    assert.equal(parsed.data.limits.maxSteps, 25);
    assert.equal(parsed.data.status, 'published');
  });

  it('validates a cyclic graph with strict operational limits', () => {
    const parsed = agentGraphVersionV1Schema.safeParse(cyclicAgentGraphFixture);
    assert.ok(parsed.success, `Cyclic graph validation failed: ${JSON.stringify(parsed.error?.issues)}`);
    assert.equal(parsed.data.limits.maxSteps, 5);
  });

  it('rejects an invalid graph without nodes', () => {
    const invalid = {
      ...validAgentGraphFixture,
      nodes: [],
    };
    const parsed = agentGraphVersionV1Schema.safeParse(invalid);
    assert.equal(parsed.success, false);
  });

  it('validates ToolInvocationV1 fixture', () => {
    const parsed = toolInvocationV1Schema.safeParse(toolInvocationFixture);
    assert.ok(parsed.success, `Tool invocation validation failed: ${JSON.stringify(parsed.error?.issues)}`);
    assert.equal(parsed.data.toolName, 'inventory.check_stock');
    assert.equal(parsed.data.expectedConversationVersion, 4);
  });

  it('validates AgentRunTraceV1 fixture with redacted timeline', () => {
    const parsed = agentRunTraceV1Schema.safeParse(agentRunTraceFixture);
    assert.ok(parsed.success, `Agent run trace validation failed: ${JSON.stringify(parsed.error?.issues)}`);
    assert.equal(parsed.data.state, 'awaiting_approval');
    assert.equal(parsed.data.timeline.length, 4);
  });

  it('validates pending ApprovalRequestV1 fixture', () => {
    const parsed = approvalRequestV1Schema.safeParse(pendingApprovalFixture);
    assert.ok(parsed.success, `Approval request validation failed: ${JSON.stringify(parsed.error?.issues)}`);
    assert.equal(parsed.data.risk, 'medium');
    assert.equal(parsed.data.status, 'pending');
    assert.equal(parsed.data.details?.requiredRole, 'SALES_SUPERVISOR');
  });

  it('validates expired ApprovalRequestV1 fixture', () => {
    const parsed = approvalRequestV1Schema.safeParse(expiredApprovalFixture);
    assert.ok(parsed.success);
    assert.equal(parsed.data.status, 'expired');
  });

  it('validates ApprovalDecisionCommandV1 for approval and rejection', () => {
    const approved = approvalDecisionCommandV1Schema.safeParse(approvedDecisionCommandFixture);
    assert.ok(approved.success);
    assert.equal(approved.data.decision, 'approved');
    assert.equal(approved.data.actor.roles.includes('SALES_SUPERVISOR'), true);

    const rejected = approvalDecisionCommandV1Schema.safeParse(rejectedDecisionCommandFixture);
    assert.ok(rejected.success);
    assert.equal(rejected.data.decision, 'rejected');
  });
});
