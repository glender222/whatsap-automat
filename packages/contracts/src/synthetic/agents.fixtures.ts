import { AgentGraphVersionV1 } from '../agents/graph';
import { AgentRunTraceV1, ToolInvocationV1 } from '../agents/runs';

const mockDate = '2026-10-31T02:00:00.000Z';
const mockTenantId = 'tenant_synthetic_alpha';

/**
 * Valid DAG: router -> sales_assistant -> inventory_check (tool) -> approval -> end
 */
export const validAgentGraphFixture: AgentGraphVersionV1 = {
  schemaVersion: 1,
  graphId: 'graph_commercial_flow_001',
  version: 1,
  tenantId: mockTenantId,
  entryNodeId: 'node_router',
  nodes: [
    {
      id: 'node_router',
      kind: 'router',
      config: {
        intents: ['sales', 'support', 'preorder'],
        defaultTarget: 'node_sales',
      },
    },
    {
      id: 'node_sales',
      kind: 'agent',
      config: {
        model: 'gpt-4o',
        temperature: 0.2,
        systemPrompt: 'Asistente de ventas cordial y eficiente.',
      },
    },
    {
      id: 'node_check_stock',
      kind: 'tool',
      config: {
        toolName: 'inventory.check_stock',
        timeoutMs: 3000,
      },
    },
    {
      id: 'node_approval_discount',
      kind: 'approval',
      config: {
        risk: 'medium',
        requiredRole: 'SALES_SUPERVISOR',
        timeoutHours: 2,
      },
    },
    {
      id: 'node_end',
      kind: 'end',
      config: {},
    },
  ],
  edges: [
    {
      id: 'edge_1',
      from: 'node_router',
      to: 'node_sales',
      condition: 'intent == "sales"',
      priority: 1,
    },
    {
      id: 'edge_2',
      from: 'node_sales',
      to: 'node_check_stock',
      condition: 'requires_stock_check == true',
    },
    {
      id: 'edge_3',
      from: 'node_check_stock',
      to: 'node_approval_discount',
      condition: 'discount_percentage > 15',
    },
    {
      id: 'edge_4',
      from: 'node_approval_discount',
      to: 'node_end',
    },
    {
      id: 'edge_5',
      from: 'node_check_stock',
      to: 'node_end',
      condition: 'discount_percentage <= 15',
    },
  ],
  policyRef: 'policy_commercial_standard_v1',
  limits: {
    maxSteps: 25,
    maxDelegations: 3,
    maxParallelNodes: 2,
    maxDurationSeconds: 120,
    maxModelTokens: 16000,
    maxCostMicroUsd: 500000, // $0.50 USD
  },
  status: 'published',
  specHash: 'sha256_e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
};

/**
 * Valid Graph with a controlled feedback cycle and strict operational limits
 */
export const cyclicAgentGraphFixture: AgentGraphVersionV1 = {
  schemaVersion: 1,
  graphId: 'graph_clarification_loop_001',
  version: 2,
  tenantId: mockTenantId,
  entryNodeId: 'node_clarify',
  nodes: [
    {
      id: 'node_clarify',
      kind: 'agent',
      config: {
        prompt: 'Preguntar al cliente por datos faltantes de la orden.',
      },
    },
    {
      id: 'node_validate_input',
      kind: 'condition',
      config: {
        expression: 'input.hasAllFields == true',
      },
    },
    {
      id: 'node_finish',
      kind: 'end',
      config: {},
    },
  ],
  edges: [
    {
      id: 'edge_loop_eval',
      from: 'node_clarify',
      to: 'node_validate_input',
    },
    {
      id: 'edge_loop_retry',
      from: 'node_validate_input',
      to: 'node_clarify',
      condition: 'input.hasAllFields == false',
    },
    {
      id: 'edge_loop_done',
      from: 'node_validate_input',
      to: 'node_finish',
      condition: 'input.hasAllFields == true',
    },
  ],
  policyRef: 'policy_clarification_v2',
  limits: {
    maxSteps: 5, // Strict step limit prevents infinite cycles
    maxDelegations: 1,
    maxParallelNodes: 1,
    maxDurationSeconds: 60,
    maxModelTokens: 4000,
    maxCostMicroUsd: 100000,
  },
  status: 'published',
  specHash: 'sha256_cyclic_approved_spec_hash_001',
};

export const toolInvocationFixture: ToolInvocationV1 = {
  id: 'tool_call_stock_001',
  tenantId: mockTenantId,
  agentRunId: 'run_commercial_001',
  graphVersion: 1,
  toolName: 'inventory.check_stock',
  schemaVersion: 1,
  input: {
    sku: 'PROD-4091',
    quantity: 2,
  },
  effectKey: 'eff_tool_stock_4091_qty2',
  expectedConversationVersion: 4,
  requestedByNodeId: 'node_check_stock',
};

export const agentRunTraceFixture: AgentRunTraceV1 = {
  runId: 'run_commercial_001',
  tenantId: mockTenantId,
  graphId: 'graph_commercial_flow_001',
  graphVersion: 1,
  state: 'awaiting_approval',
  timeline: [
    {
      timestamp: mockDate,
      step: 1,
      nodeId: 'node_router',
      event: 'node_executed',
      detailsRedacted: { matchedIntent: 'sales' },
    },
    {
      timestamp: mockDate,
      step: 2,
      nodeId: 'node_sales',
      event: 'agent_turn_completed',
      detailsRedacted: { tokens: 420 },
    },
    {
      timestamp: mockDate,
      step: 3,
      nodeId: 'node_check_stock',
      event: 'tool_invoked',
      detailsRedacted: { tool: 'inventory.check_stock', status: 'available' },
    },
    {
      timestamp: mockDate,
      step: 4,
      nodeId: 'node_approval_discount',
      event: 'approval_requested',
      detailsRedacted: { risk: 'medium' },
    },
  ],
  totalSteps: 4,
  totalTokensUsed: 980,
  totalCostMicroUsd: 14500,
};
