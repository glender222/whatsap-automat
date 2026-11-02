import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  workflowDefinitionV1Schema,
  workflowRevisionV1Schema,
  workflowDagGraphV1Schema,
  workflowExecutionLimitsV1Schema,
  workflowRunV1Schema,
  rollbackWorkflowCommandV1Schema,
  publishWorkflowRevisionCommandV1Schema,
  workflowTriggerV1Schema,
  computeWorkflowSpecHash,
  automationDefinitionV1Schema,
  executionRecordV1Schema,
  WorkflowDagGraphV1,
  WorkflowExecutionLimitsV1,
} from '../src/workflows';

describe('Workflow Contracts, DAG Schemas & Deterministic Hashing', () => {
  const validLimits: WorkflowExecutionLimitsV1 = {
    maxDurationSeconds: 86400,
    maxStepCount: 100,
    timeoutSeconds: 3600,
  };

  const validDagGraph: WorkflowDagGraphV1 = {
    nodes: [
      {
        id: 'node_trigger',
        kind: 'trigger',
        label: 'Inbound Webhook',
        config: { event: 'order.created' },
        position: { x: 100, y: 100 },
      },
      {
        id: 'node_check',
        kind: 'condition',
        label: 'Amount > 1000',
        config: { expression: 'order.amount > 1000' },
        position: { x: 100, y: 200 },
      },
      {
        id: 'node_approval',
        kind: 'approval',
        label: 'Manager Approval Gate',
        config: { timeoutMs: 86400000 },
        position: { x: 50, y: 300 },
      },
      {
        id: 'node_erp_post',
        kind: 'activity',
        label: 'Execute ERP Webhook',
        config: { url: 'https://erp.example.com/api/orders' },
        position: { x: 150, y: 300 },
      },
      {
        id: 'node_end',
        kind: 'end',
        label: 'End Flow',
        config: {},
        position: { x: 100, y: 400 },
      },
    ],
    edges: [
      { id: 'e1', source: 'node_trigger', target: 'node_check' },
      { id: 'e2', source: 'node_check', target: 'node_approval', sourceHandle: 'true', condition: 'true' },
      { id: 'e3', source: 'node_check', target: 'node_erp_post', sourceHandle: 'false', condition: 'false' },
      { id: 'e4', source: 'node_approval', target: 'node_erp_post', sourceHandle: 'approved', condition: 'approved' },
      { id: 'e5', source: 'node_erp_post', target: 'node_end' },
    ],
  };

  test('validates workflowDefinitionV1Schema with valid inputs', () => {
    const validDef = {
      id: 'wf_order_processing',
      tenantId: '1',
      workspaceId: '10',
      name: 'Order Processing Pipeline',
      description: 'Automated order ingestion and approval',
      status: 'published',
      publishedRevisionId: 'rev_wf_order_1',
      createdAt: '2026-11-02T00:00:00.000Z',
      updatedAt: '2026-11-02T01:00:00.000Z',
    };
    const parsed = workflowDefinitionV1Schema.safeParse(validDef);
    assert.strictEqual(parsed.success, true);
  });

  test('rejects workflowDefinitionV1Schema with invalid status', () => {
    const invalidDef = {
      id: 'wf_1',
      tenantId: '1',
      name: 'Test',
      status: 'pending_review', // invalid
      createdAt: '2026-11-02T00:00:00.000Z',
      updatedAt: '2026-11-02T01:00:00.000Z',
    };
    const parsed = workflowDefinitionV1Schema.safeParse(invalidDef);
    assert.strictEqual(parsed.success, false);
  });

  test('validates workflowDagGraphV1Schema and enforces node connectivity', () => {
    const parsed = workflowDagGraphV1Schema.safeParse(validDagGraph);
    assert.strictEqual(parsed.success, true);
  });

  test('rejects workflowDagGraphV1Schema when edge points to phantom node', () => {
    const invalidDag = {
      nodes: [{ id: 'node_1', kind: 'trigger', config: {} }],
      edges: [{ id: 'e1', source: 'node_1', target: 'node_phantom' }],
    };
    const parsed = workflowDagGraphV1Schema.safeParse(invalidDag);
    assert.strictEqual(parsed.success, false);
    if (!parsed.success) {
      assert.match(parsed.error.issues[0].message, /valid existing node IDs/);
    }
  });

  test('rejects workflowDagGraphV1Schema when nodes list is empty', () => {
    const invalidDag = {
      nodes: [],
      edges: [],
    };
    const parsed = workflowDagGraphV1Schema.safeParse(invalidDag);
    assert.strictEqual(parsed.success, false);
  });

  test('validates computeWorkflowSpecHash determinism and UI position invariance', () => {
    const hash1 = computeWorkflowSpecHash(validDagGraph, validLimits);
    assert.strictEqual(typeof hash1, 'string');
    assert.strictEqual(hash1.length, 64);
    assert.match(hash1, /^[a-f0-9]{64}$/);

    // Modify only UI position of nodes (simulating visual drag & drop on canvas)
    const modifiedCanvasDag: WorkflowDagGraphV1 = {
      ...validDagGraph,
      nodes: validDagGraph.nodes.map((n) => ({
        ...n,
        position: { x: (n.position?.x ?? 0) + 250, y: (n.position?.y ?? 0) + 300 },
      })),
    };
    const hash2 = computeWorkflowSpecHash(modifiedCanvasDag, validLimits);
    assert.strictEqual(hash1, hash2, 'Spec hash must be invariant under UI coordinate shifts');

    // Modify executable node config -> hash must change
    const modifiedLogicDag: WorkflowDagGraphV1 = {
      ...validDagGraph,
      nodes: validDagGraph.nodes.map((n) =>
        n.id === 'node_check' ? { ...n, config: { expression: 'order.amount > 5000' } } : n
      ),
    };
    const hash3 = computeWorkflowSpecHash(modifiedLogicDag, validLimits);
    assert.notStrictEqual(hash1, hash3, 'Spec hash must change when node config changes');
  });

  test('validates workflowRevisionV1Schema with calculated specHash', () => {
    const specHash = computeWorkflowSpecHash(validDagGraph, validLimits);
    const validRev = {
      id: 'rev_wf_order_1',
      tenantId: '1',
      workflowId: 'wf_order_processing',
      revisionNumber: 1,
      status: 'published',
      dagGraph: validDagGraph,
      specHash,
      limits: validLimits,
      publishedAt: '2026-11-02T01:00:00.000Z',
      createdAt: '2026-11-02T00:00:00.000Z',
    };
    const parsed = workflowRevisionV1Schema.safeParse(validRev);
    assert.strictEqual(parsed.success, true);
  });

  test('rejects workflowRevisionV1Schema with malformed specHash', () => {
    const invalidRev = {
      id: 'rev_wf_order_1',
      tenantId: '1',
      workflowId: 'wf_order_processing',
      revisionNumber: 1,
      status: 'published',
      dagGraph: validDagGraph,
      specHash: 'not-a-valid-sha256-hash',
      limits: validLimits,
      createdAt: '2026-11-02T00:00:00.000Z',
    };
    const parsed = workflowRevisionV1Schema.safeParse(invalidRev);
    assert.strictEqual(parsed.success, false);
  });

  test('validates workflowRunV1Schema and preserves error details structure', () => {
    const validRun = {
      id: 'run_123',
      tenantId: '1',
      workspaceId: '10',
      workflowId: 'wf_order_processing',
      revisionId: 'rev_wf_order_1',
      temporalWorkflowId: 'wf_1_run_123',
      temporalRunId: 'temp_run_456',
      triggerType: 'webhook',
      status: 'running',
      correlationId: 'corr_789',
      inputPayload: { orderId: 'ord_1' },
      outputPayload: {},
      currentStep: 'node_check',
      stepCount: 2,
      errorDetails: null,
      startedAt: '2026-11-02T02:00:00.000Z',
      completedAt: null,
    };
    const parsed = workflowRunV1Schema.safeParse(validRun);
    assert.strictEqual(parsed.success, true);
  });

  test('validates rollbackWorkflowCommandV1Schema with targetRevisionNumber or targetRevisionId', () => {
    const withNumber = {
      schemaVersion: 1,
      tenantId: '1',
      workflowId: 'wf_order_processing',
      targetRevisionNumber: 2,
      userId: 'user_admin',
      reason: 'Rollback due to bug in rev 3',
    };
    assert.strictEqual(rollbackWorkflowCommandV1Schema.safeParse(withNumber).success, true);

    const withId = {
      schemaVersion: 1,
      tenantId: '1',
      workflowId: 'wf_order_processing',
      targetRevisionId: 'rev_wf_order_2',
      userId: 'user_admin',
      reason: 'Rollback by revision ID',
    };
    assert.strictEqual(rollbackWorkflowCommandV1Schema.safeParse(withId).success, true);

    const withoutTarget = {
      schemaVersion: 1,
      tenantId: '1',
      workflowId: 'wf_order_processing',
      userId: 'user_admin',
      reason: 'Missing target',
    };
    const parsedMissing = rollbackWorkflowCommandV1Schema.safeParse(withoutTarget);
    assert.strictEqual(parsedMissing.success, false);
    if (!parsedMissing.success) {
      assert.match(parsedMissing.error.issues[0].message, /Must provide either targetRevisionNumber or targetRevisionId/);
    }
  });

  test('validates publishWorkflowRevisionCommandV1Schema and workflowTriggerV1Schema', () => {
    const publishCmd = {
      schemaVersion: 1,
      tenantId: '1',
      workflowId: 'wf_order_processing',
      revisionId: 'rev_wf_order_2',
      userId: 'user_admin',
      comment: 'Releasing v2 with credit check',
    };
    assert.strictEqual(publishWorkflowRevisionCommandV1Schema.safeParse(publishCmd).success, true);

    const trigger = {
      id: 'trig_1',
      tenantId: '1',
      workflowId: 'wf_order_processing',
      type: 'webhook',
      endpointKey: 'erp-inbound-orders-2026',
      authTokenHash: 'd2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2',
      isActive: true,
      metadata: { source: 'SAP ERP' },
      createdAt: '2026-11-02T00:00:00.000Z',
      updatedAt: '2026-11-02T00:00:00.000Z',
    };
    assert.strictEqual(workflowTriggerV1Schema.safeParse(trigger).success, true);
  });

  test('preserves backward compatibility with legacy automation and execution schemas', () => {
    const legacyAuto = {
      id: 'auto_1',
      tenantId: '1',
      name: 'Legacy Auto',
      trigger: {
        type: 'webhook',
        config: { url: 'https://example.com' },
      },
      graphId: 'graph_1',
      graphVersion: 1,
      status: 'active',
      createdAt: '2026-11-02T00:00:00.000Z',
      updatedAt: '2026-11-02T00:00:00.000Z',
    };
    assert.strictEqual(automationDefinitionV1Schema.safeParse(legacyAuto).success, true);

    const legacyExec = {
      id: 'exec_1',
      tenantId: '1',
      workflowId: 'wf_1',
      workflowRunId: 'run_1',
      correlationId: 'corr_1',
      status: 'completed',
      startedAt: '2026-11-02T00:00:00.000Z',
      retryCount: 0,
    };
    assert.strictEqual(executionRecordV1Schema.safeParse(legacyExec).success, true);
  });
});
