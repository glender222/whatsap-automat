/**
 * Whatsap-Automat v0.4 — Automation Studio Mock Fixtures (UC-06 Realistic Enterprise Flow)
 * Phase F4: PR-F4-03
 *
 * Flow Topology:
 *   [1. Inbound Webhook (ERP Order Ingest)]
 *                     │
 *                     ▼
 *   [2. Condition: Amount > $5,000?]
 *         ├── (true: High-Value) ─────────► [3. Approval Gate: Manager Authorization]
 *         │                                            │ (approved)
 *         └── (false: Auto-Approve) ──────────┐        │
 *                                             ▼        ▼
 *                                  [4. Activity: ERP Business Mutation (order.approve)]
 *                                                     │
 *                                                     ▼
 *                                  [5. Delay: 5-Minute Dispatch Timer]
 *                                                     │
 *                                                     ▼
 *                                  [6. Activity: Outbound ERP Webhook (SSRF Guarded)]
 *                                                     │
 *                                                     ▼
 *                                  [7. End: Order Completed]
 */

import type {
  WorkflowDefinitionV1,
  WorkflowRevisionV1,
  WorkflowRunV1,
  WorkflowRunState,
  WorkflowTriggerV1,
  StudioSimulationResult,
  WorkflowDagGraphV1,
} from './types';

export const MOCK_UC06_WORKFLOW_DEFINITION: WorkflowDefinitionV1 = {
  id: 'wf-uc06-erp-order-pipeline',
  tenantId: '1',
  workspaceId: '10',
  name: 'UC-06: Order Processing & Manager Approval Pipeline',
  description:
    'Channel-less enterprise automation orchestrating ERP order ingestion, credit check branching, human approval gate, atomic database mutation, and outbound webhook notification.',
  status: 'published',
  publishedRevisionId: 'rev-uc06-v2',
  createdAt: '2026-11-02T08:00:00.000Z',
  updatedAt: '2026-11-02T08:30:00.000Z',
};

export const MOCK_UC06_DAG_GRAPH: WorkflowDagGraphV1 = {
  nodes: [
    {
      id: 'node-1-trigger',
      kind: 'trigger',
      label: 'Inbound Webhook (ERP Order Ingest)',
      position: { x: 280, y: 40 },
      config: {
        triggerType: 'webhook',
        endpointKey: 'sap-erp-orders-inbound',
        method: 'POST',
        authScheme: 'token',
        samplePayload: {
          orderId: 'ord_erp_98241',
          customerId: 'cust_corp_441',
          customerName: 'Distribuidora Industrial S.A.C.',
          amount: 12500,
          currency: 'USD',
          creditScore: 780,
          verificationUrl: 'https://erp.acmecorp.com/api/v1/orders/verify',
          outboundWebhookUrl: 'https://erp.acmecorp.com/api/v1/orders/dispatch-confirmation',
        },
      },
    },
    {
      id: 'node-2-condition',
      kind: 'condition',
      label: 'Condition: Amount > $5,000',
      position: { x: 280, y: 160 },
      config: {
        expression: 'amount > 5000',
        description: 'High-value orders requiring managerial authorization',
      },
    },
    {
      id: 'node-3-approval',
      kind: 'approval',
      label: 'Approval Gate: Manager Authorization',
      position: { x: 140, y: 280 },
      config: {
        timeoutMs: 86400000, // 24h
        requiredRoles: ['finance_manager', 'admin'],
        description: 'Commercial manager authorization for orders over $5,000',
        approvalType: 'high_value_order_authorization',
      },
    },
    {
      id: 'node-4-erp-mutation',
      kind: 'activity',
      label: 'Activity: ERP Business Mutation (order.approve)',
      position: { x: 280, y: 400 },
      config: {
        effectType: 'order.approve',
        parameters: {
          orderId: 'ord_erp_98241',
          newStatus: 'approved',
          ledgerKey: 'postgres.orders',
        },
      },
    },
    {
      id: 'node-5-delay',
      kind: 'delay',
      label: 'Delay: 5-Minute Dispatch Timer',
      position: { x: 280, y: 520 },
      config: {
        durationMs: 300000,
        seconds: 300,
        description: '5-minute durable staging timer before external notification',
      },
    },
    {
      id: 'node-6-outbound-webhook',
      kind: 'activity',
      label: 'Activity: Outbound ERP Webhook (SSRF Guarded)',
      position: { x: 280, y: 640 },
      config: {
        url: 'https://erp.acmecorp.com/api/v1/orders/dispatch-confirmation',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Workflow-Source': 'Whatsap-Automat-Studio',
        },
        body: {
          orderId: 'ord_erp_98241',
          status: 'approved',
        },
      },
    },
    {
      id: 'node-7-completed-end',
      kind: 'end',
      label: 'End: Order Completed',
      position: { x: 280, y: 760 },
      config: {
        status: 'completed',
        summary: 'Order successfully authorized, recorded in ERP and confirmed via webhook',
      },
    },
    {
      id: 'node-8-rejected-end',
      kind: 'end',
      label: 'End: Order Halted (Rejected)',
      position: { x: 500, y: 400 },
      config: {
        status: 'rejected',
        summary: 'Manager rejected order authorization',
      },
    },
  ],
  edges: [
    {
      id: 'e1',
      source: 'node-1-trigger',
      target: 'node-2-condition',
    },
    {
      id: 'e2_true',
      source: 'node-2-condition',
      target: 'node-3-approval',
      sourceHandle: 'true',
      condition: 'true',
      label: 'Amount > 5000 (Approval Required)',
    },
    {
      id: 'e2_false',
      source: 'node-2-condition',
      target: 'node-4-erp-mutation',
      sourceHandle: 'false',
      condition: 'false',
      label: 'Amount <= 5000 (Auto-Approve)',
    },
    {
      id: 'e3_approved',
      source: 'node-3-approval',
      target: 'node-4-erp-mutation',
      sourceHandle: 'approved',
      condition: 'approved',
      label: 'Manager Approved',
    },
    {
      id: 'e3_rejected',
      source: 'node-3-approval',
      target: 'node-8-rejected-end',
      sourceHandle: 'rejected',
      condition: 'rejected',
      label: 'Manager Rejected',
    },
    {
      id: 'e4',
      source: 'node-4-erp-mutation',
      target: 'node-5-delay',
    },
    {
      id: 'e5',
      source: 'node-5-delay',
      target: 'node-6-outbound-webhook',
    },
    {
      id: 'e6',
      source: 'node-6-outbound-webhook',
      target: 'node-7-completed-end',
    },
  ],
};

export const MOCK_UC06_WORKFLOW_REVISION_V1: WorkflowRevisionV1 = {
  id: 'rev-uc06-v1',
  tenantId: '1',
  workflowId: 'wf-uc06-erp-order-pipeline',
  revisionNumber: 1,
  status: 'archived',
  specHash: 'c001a1d01ff7b880952c1d3bc6f0b4f98cf5500ec9b9820c8c4cd028a71b4aaa',
  limits: {
    maxDurationSeconds: 86400,
    maxStepCount: 50,
    timeoutSeconds: 1800,
  },
  publishedAt: '2026-11-01T12:00:00.000Z',
  createdAt: '2026-11-01T10:00:00.000Z',
  dagGraph: {
    nodes: MOCK_UC06_DAG_GRAPH.nodes.slice(0, 5),
    edges: MOCK_UC06_DAG_GRAPH.edges.slice(0, 4),
  },
};

export const MOCK_UC06_WORKFLOW_REVISION: WorkflowRevisionV1 = {
  id: 'rev-uc06-v2',
  tenantId: '1',
  workflowId: 'wf-uc06-erp-order-pipeline',
  revisionNumber: 2,
  status: 'published',
  specHash: 'd110afd01ff7b880952c1d3bc6f0b4f98cf5500ec9b9820c8c4cd028a71b4f7d',
  limits: {
    maxDurationSeconds: 86400,
    maxStepCount: 100,
    timeoutSeconds: 3600,
  },
  publishedAt: '2026-11-02T08:30:00.000Z',
  createdAt: '2026-11-02T08:00:00.000Z',
  dagGraph: MOCK_UC06_DAG_GRAPH,
};

export const MOCK_UC06_REVISIONS: readonly WorkflowRevisionV1[] = [
  MOCK_UC06_WORKFLOW_REVISION_V1,
  MOCK_UC06_WORKFLOW_REVISION,
];

export const MOCK_UC06_TRIGGER: WorkflowTriggerV1 = {
  id: 'trig-uc06-webhook',
  tenantId: '1',
  workflowId: 'wf-uc06-erp-order-pipeline',
  type: 'webhook',
  endpointKey: 'sap-erp-orders-inbound',
  authTokenHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  isActive: true,
  metadata: {
    source: 'SAP ERP S/4HANA',
    environment: 'production',
  },
  createdAt: '2026-11-02T08:00:00.000Z',
  updatedAt: '2026-11-02T08:00:00.000Z',
};

export const MOCK_UC06_ACTIVE_RUN: WorkflowRunV1 = {
  id: 'run_uc06_77190',
  tenantId: '1',
  workspaceId: '10',
  workflowId: 'wf-uc06-erp-order-pipeline',
  revisionId: 'rev-uc06-v2',
  temporalWorkflowId: 'wf_1_run_uc06_77190',
  temporalRunId: 'temporal_run_9921',
  triggerType: 'webhook',
  status: 'waiting_approval',
  correlationId: 'corr_erp_98241_2026',
  inputPayload: {
    orderId: 'ord_erp_98241',
    customerId: 'cust_corp_441',
    customerName: 'Distribuidora Industrial S.A.C.',
    amount: 12500,
    currency: 'USD',
    creditScore: 780,
  },
  outputPayload: {},
  currentStep: 'node-3-approval',
  stepCount: 2,
  errorDetails: null,
  startedAt: '2026-11-02T09:15:00.000Z',
  completedAt: null,
};

export const MOCK_UC06_FAILED_RUN: WorkflowRunV1 = {
  id: 'run_uc06_failed_882',
  tenantId: '1',
  workspaceId: '10',
  workflowId: 'wf-uc06-erp-order-pipeline',
  revisionId: 'rev-uc06-v2',
  temporalWorkflowId: 'wf_1_run_uc06_failed_882',
  temporalRunId: 'temporal_run_9944',
  triggerType: 'webhook',
  status: 'failed',
  correlationId: 'corr_fail_110',
  inputPayload: {
    orderId: 'ord_fail_999',
    amount: 99999,
  },
  outputPayload: {},
  currentStep: 'node-6-outbound-webhook',
  stepCount: 5,
  errorDetails: {
    code: 'SSRF_BLOCKED',
    message: 'Egress target resolved to private IP 10.0.0.12 (SSRF Guard)',
    nodeId: 'node-6-outbound-webhook',
    retryable: false,
    timestamp: '2026-11-02T09:20:00.000Z',
    stack: 'Error: SSRF_BLOCKED\n  at assertUrlIsSafe (ssrfGuard.ts:44)\n  at executeHttpRequestActivity (activities.ts:89)',
  },
  startedAt: '2026-11-02T09:18:00.000Z',
  completedAt: '2026-11-02T09:20:00.000Z',
};

export const MOCK_UC06_LIVE_INSPECTOR_STATE: WorkflowRunState = {
  workflowId: 'wf-uc06-erp-order-pipeline',
  runId: 'run_uc06_77190',
  tenantId: 1,
  revisionId: 'rev-uc06-v2',
  status: 'waiting_approval',
  currentNodeId: 'node-3-approval',
  stepCount: 2,
  variables: {
    orderId: 'ord_erp_98241',
    customerId: 'cust_corp_441',
    customerName: 'Distribuidora Industrial S.A.C.',
    amount: 12500,
    currency: 'USD',
    creditScore: 780,
    verificationUrl: 'https://erp.acmecorp.com/api/v1/orders/verify',
    outboundWebhookUrl: 'https://erp.acmecorp.com/api/v1/orders/dispatch-confirmation',
    triggerType: 'webhook',
    correlationId: 'corr_erp_98241_2026',
    workflowId: 'wf-uc06-erp-order-pipeline',
    runId: 'run_uc06_77190',
    'node-2-condition_condition': true,
  },
  historyTrace: [
    {
      nodeId: 'node-1-trigger',
      status: 'node_started_trigger',
      timestamp: '2026-11-02T09:15:00.120Z',
      details: { triggerType: 'webhook', endpointKey: 'sap-erp-orders-inbound' },
    },
    {
      nodeId: 'node-2-condition',
      status: 'node_started_condition',
      timestamp: '2026-11-02T09:15:00.250Z',
      details: { expression: 'amount > 5000', evaluatedResult: true },
    },
    {
      nodeId: 'node-3-approval',
      status: 'waiting_approval',
      timestamp: '2026-11-02T09:15:00.310Z',
      details: {
        approvalId: 'app_run_uc06_77190_node-3-approval',
        requiredRoles: ['finance_manager', 'admin'],
      },
    },
  ],
  pendingApproval: {
    approvalId: 'app_run_uc06_77190_node-3-approval',
    nodeId: 'node-3-approval',
    requestedAt: '2026-11-02T09:15:00.310Z',
    expiresAt: '2026-11-03T09:15:00.310Z',
    timeoutMs: 86400000,
  },
  approvalDecision: null,
  lastUpdated: '2026-11-02T09:15:01.000Z',
};

export const MOCK_UC06_COMPLETED_RUN_STATE: WorkflowRunState = {
  workflowId: 'wf-uc06-erp-order-pipeline',
  runId: 'run_uc06_77190',
  tenantId: 1,
  revisionId: 'rev-uc06-v2',
  status: 'completed',
  currentNodeId: 'node-7-completed-end',
  stepCount: 6,
  variables: {
    orderId: 'ord_erp_98241',
    amount: 12500,
    'node-2-condition_condition': true,
    'node-3-approval_approval': {
      approvalId: 'app_run_uc06_77190_node-3-approval',
      decision: 'approved',
      actor: { userId: 'usr_mgr_42', roles: ['finance_manager'] },
      reason: 'Authorized based on positive credit rating and active contract',
      timestamp: '2026-11-02T09:18:22.000Z',
    },
    'node-4-erp-mutation': {
      status: 'success',
      effectKey: 'wf_1_wf-uc06-erp-order-pipeline_run_uc06_77190_order_approve',
      applied: true,
      updatedRows: 1,
    },
    'node-6-outbound-webhook': {
      statusCode: 200,
      delivered: true,
      timestamp: '2026-11-02T09:23:25.000Z',
    },
  },
  historyTrace: [
    {
      nodeId: 'node-1-trigger',
      status: 'node_started_trigger',
      timestamp: '2026-11-02T09:15:00.120Z',
    },
    {
      nodeId: 'node-2-condition',
      status: 'node_started_condition',
      timestamp: '2026-11-02T09:15:00.250Z',
    },
    {
      nodeId: 'node-3-approval',
      status: 'approval_granted',
      timestamp: '2026-11-02T09:18:22.000Z',
      details: { actor: { userId: 'usr_mgr_42' }, decision: 'approved' },
    },
    {
      nodeId: 'node-4-erp-mutation',
      status: 'node_started_activity',
      timestamp: '2026-11-02T09:18:22.400Z',
    },
    {
      nodeId: 'node-5-delay',
      status: 'timer_completed',
      timestamp: '2026-11-02T09:23:22.500Z',
    },
    {
      nodeId: 'node-6-outbound-webhook',
      status: 'node_started_activity',
      timestamp: '2026-11-02T09:23:25.100Z',
    },
    {
      nodeId: 'node-7-completed-end',
      status: 'workflow_completed',
      timestamp: '2026-11-02T09:23:25.300Z',
    },
  ],
  pendingApproval: null,
  approvalDecision: {
    approvalId: 'app_run_uc06_77190_node-3-approval',
    decision: 'approved',
    actor: { userId: 'usr_mgr_42', roles: ['finance_manager'] },
    reason: 'Authorized based on positive credit rating and active contract',
    timestamp: '2026-11-02T09:18:22.000Z',
  },
  lastUpdated: '2026-11-02T09:23:26.000Z',
};

export const MOCK_UC06_SIMULATION_RESULT: StudioSimulationResult = {
  success: true,
  durationMs: 480,
  steps: [
    {
      stepIndex: 1,
      nodeId: 'node-1-trigger',
      nodeKind: 'trigger',
      nodeLabel: 'Inbound Webhook (ERP Order Ingest)',
      status: 'simulated_success',
      latencyMs: 12,
      outputVariables: {
        orderId: 'ord_erp_98241',
        amount: 12500,
        currency: 'USD',
      },
    },
    {
      stepIndex: 2,
      nodeId: 'node-2-condition',
      nodeKind: 'condition',
      nodeLabel: 'Condition: Amount > $5,000',
      status: 'simulated_success',
      latencyMs: 4,
      outputVariables: {
        'node-2-condition_condition': true,
      },
    },
    {
      stepIndex: 3,
      nodeId: 'node-3-approval',
      nodeKind: 'approval',
      nodeLabel: 'Approval Gate: Manager Authorization',
      status: 'waiting_gate',
      latencyMs: 200,
      outputVariables: {
        pendingApprovalId: 'app_sim_node-3-approval',
      },
    },
    {
      stepIndex: 4,
      nodeId: 'node-4-erp-mutation',
      nodeKind: 'activity',
      nodeLabel: 'Activity: ERP Business Mutation (order.approve)',
      status: 'simulated_success',
      latencyMs: 85,
      outputVariables: {
        applied: true,
        orderStatus: 'approved',
      },
    },
    {
      stepIndex: 5,
      nodeId: 'node-5-delay',
      nodeKind: 'delay',
      nodeLabel: 'Delay: 5-Minute Dispatch Timer',
      status: 'simulated_success',
      latencyMs: 15,
      outputVariables: {
        delayPassedSeconds: 300,
      },
    },
    {
      stepIndex: 6,
      nodeId: 'node-6-outbound-webhook',
      nodeKind: 'activity',
      nodeLabel: 'Activity: Outbound ERP Webhook (SSRF Guarded)',
      status: 'simulated_success',
      latencyMs: 140,
      outputVariables: {
        httpStatus: 200,
        webhookDelivered: true,
      },
    },
    {
      stepIndex: 7,
      nodeId: 'node-7-completed-end',
      nodeKind: 'end',
      nodeLabel: 'End: Order Completed',
      status: 'simulated_success',
      latencyMs: 24,
      outputVariables: {
        workflowFinalStatus: 'completed',
      },
    },
  ],
  finalPayload: {
    orderId: 'ord_erp_98241',
    amount: 12500,
    status: 'completed',
    approvedBy: 'simulated_manager',
  },
};

/**
 * Fixture with a cyclic dependency for testing DAG cycle validation
 */
export const MOCK_CYCLIC_DAG_GRAPH: WorkflowDagGraphV1 = {
  nodes: [
    { id: 'cycle-1', kind: 'trigger', label: 'Trigger A', config: {}, position: { x: 100, y: 100 } },
    { id: 'cycle-2', kind: 'activity', label: 'Activity B', config: {}, position: { x: 300, y: 100 } },
    { id: 'cycle-3', kind: 'activity', label: 'Activity C', config: {}, position: { x: 500, y: 100 } },
  ],
  edges: [
    { id: 'e_c1', source: 'cycle-1', target: 'cycle-2' },
    { id: 'e_c2', source: 'cycle-2', target: 'cycle-3' },
    { id: 'e_c3', source: 'cycle-3', target: 'cycle-1' }, // loop back to 1!
  ],
};

/**
 * Fixture with disconnected orphan nodes for testing connectivity validation
 */
export const MOCK_ORPHAN_DAG_GRAPH: WorkflowDagGraphV1 = {
  nodes: [
    { id: 'orphan-trigger', kind: 'trigger', label: 'Main Trigger', config: {}, position: { x: 100, y: 100 } },
    { id: 'connected-node', kind: 'end', label: 'Connected End', config: {}, position: { x: 300, y: 100 } },
    { id: 'lonely-orphan-1', kind: 'activity', label: 'Orphan Action', config: {}, position: { x: 100, y: 400 } },
    { id: 'lonely-orphan-2', kind: 'delay', label: 'Orphan Delay', config: {}, position: { x: 300, y: 400 } },
  ],
  edges: [
    { id: 'e_valid', source: 'orphan-trigger', target: 'connected-node' },
  ],
};
