import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  workflowDefinitionV1Schema,
  workflowRevisionV1Schema,
  workflowDagGraphV1Schema,
  computeWorkflowSpecHash,
  rollbackWorkflowCommandV1Schema,
  workflowTriggerV1Schema,
  WorkflowDagGraphV1,
  WorkflowExecutionLimitsV1,
} from '@whatsap-automat/contracts';

describe('PR-F4-02: Workflows Monorepo Contract Integration', () => {
  const limits: WorkflowExecutionLimitsV1 = {
    maxDurationSeconds: 86400,
    maxStepCount: 100,
    timeoutSeconds: 3600,
  };

  const dagGraph: WorkflowDagGraphV1 = {
    nodes: [
      { id: 'node_start', kind: 'trigger', config: {} },
      { id: 'node_exec', kind: 'activity', config: { effectType: 'order.approve' } },
      { id: 'node_end', kind: 'end', config: {} },
    ],
    edges: [
      { id: 'e1', source: 'node_start', target: 'node_exec' },
      { id: 'e2', source: 'node_exec', target: 'node_end' },
    ],
  };

  test('validates WorkflowDagGraphV1 schema across package boundary', () => {
    const parsed = workflowDagGraphV1Schema.safeParse(dagGraph);
    assert.strictEqual(parsed.success, true);
  });

  test('generates valid 64-character SHA-256 spec_hash matching database regex', () => {
    const hash = computeWorkflowSpecHash(dagGraph, limits);
    assert.strictEqual(typeof hash, 'string');
    assert.strictEqual(hash.length, 64);
    assert.match(hash, /^[a-f0-9]{64}$/);
  });

  test('validates RollbackWorkflowCommandV1 schema for API controller payloads', () => {
    const command = {
      schemaVersion: 1,
      tenantId: '1',
      workflowId: 'wf_order_flow',
      targetRevisionNumber: 2,
      userId: 'user_42',
      reason: 'Rollback requested by manager',
    };
    const parsed = rollbackWorkflowCommandV1Schema.safeParse(command);
    assert.strictEqual(parsed.success, true);
  });

  test('validates WorkflowTriggerV1 schema for UC-06 webhook records', () => {
    const trigger = {
      id: 'trig_uc06_webhook',
      tenantId: '1',
      workflowId: 'wf_order_flow',
      type: 'webhook',
      endpointKey: 'erp-inbound-orders',
      isActive: true,
      metadata: { department: 'Finance' },
      createdAt: '2026-11-02T00:00:00.000Z',
      updatedAt: '2026-11-02T00:00:00.000Z',
    };
    const parsed = workflowTriggerV1Schema.safeParse(trigger);
    assert.strictEqual(parsed.success, true);
  });
});
