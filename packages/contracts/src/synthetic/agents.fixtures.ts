import { AgentGraphVersionV1 } from '../agents/graph';
import { AgentRunTraceV1, ToolInvocationV1 } from '../agents/runs';
import {
  ModelCompletionRequestV1,
  ModelCompletionResultV1,
  ByokCredentialV1,
  ByokCredentialSummaryV1,
  RegisterByokCredentialCommandV1,
} from '../agents/models';
import {
  TokenLedgerEntryV1,
  TenantTokenQuotaV1,
  TenantUsageSummaryV1,
} from '../agents/ledger';
import {
  ToolDefinitionV1,
  ToolExecutionRequestV1,
  ToolExecutionResultV1,
} from '../agents/tools';

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

export const mockByokOpenAiFixture: ByokCredentialV1 = {
  id: 'byok_openai_001',
  tenantId: 'tenant_synthetic_alpha',
  provider: 'openai',
  encryptedApiKey: 'v1:c29tZWl2MTIzNDU2:dGFnMTIzNDU2Nzg5MDEy:Y2lwaGVydGV4dGRhdGExMjM=',
  keyFingerprint: 'sk-...4a2b',
  defaultModel: 'gpt-4o',
  isActive: true,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
};

export const mockByokAnthropicFixture: ByokCredentialV1 = {
  id: 'byok_anthropic_001',
  tenantId: 'tenant_synthetic_alpha',
  provider: 'anthropic',
  encryptedApiKey: 'v1:aW5pdHZlY3RvcmI2NA==:YXV0aHRhZ2I2NDEyMzQ1Ng==:ZW5jcnlwdGVkYXBpa2V5YTY0',
  keyFingerprint: 'sk-ant-...9f1c',
  defaultModel: 'claude-3-5-sonnet-20241022',
  isActive: true,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
};

export const mockByokLocalFixture: ByokCredentialV1 = {
  id: 'byok_local_001',
  tenantId: 'tenant_synthetic_alpha',
  provider: 'local_openai',
  baseUrl: 'http://ollama-service.internal:11434/v1',
  defaultModel: 'llama3:8b',
  isActive: true,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
};

export const mockByokSummaryListFixture: readonly ByokCredentialSummaryV1[] = [
  {
    tenantId: 'tenant_synthetic_alpha',
    provider: 'openai',
    isConfigured: true,
    keyFingerprint: 'sk-...4a2b',
    baseUrl: null,
    defaultModel: 'gpt-4o',
    isActive: true,
  },
  {
    tenantId: 'tenant_synthetic_alpha',
    provider: 'anthropic',
    isConfigured: false,
    keyFingerprint: null,
    baseUrl: null,
    defaultModel: 'claude-3-5-sonnet-20241022',
    isActive: false,
  },
  {
    tenantId: 'tenant_synthetic_alpha',
    provider: 'local_openai',
    isConfigured: true,
    keyFingerprint: null,
    baseUrl: 'http://ollama-service.internal:11434/v1',
    defaultModel: 'llama3:8b',
    isActive: true,
  },
];

export const mockModelCompletionRequestFixture: ModelCompletionRequestV1 = {
  schemaVersion: 1,
  tenantId: 'tenant_synthetic_alpha',
  workspaceId: 1,
  agentRunId: 'run_commercial_001',
  conversationId: 42,
  provider: 'openai',
  model: 'gpt-4o',
  messages: [
    { role: 'system', content: 'Eres un asistente comercial cordial.' },
    { role: 'user', content: '¿Tienen stock del producto PROD-4091?' },
  ],
  tools: [
    {
      name: 'catalog.search',
      description: 'Busca productos en el catalogo',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    },
  ],
  temperature: 0.2,
  maxTokens: 1000,
  timeoutMs: 30000,
};

export const mockModelCompletionResultFixture: ModelCompletionResultV1 = {
  text: 'Voy a verificar la disponibilidad del producto PROD-4091 en nuestro catalogo.',
  toolCalls: [
    {
      id: 'call_search_001',
      name: 'catalog.search',
      arguments: { query: 'PROD-4091' },
    },
  ],
  usage: {
    promptTokens: 420,
    completionTokens: 85,
    totalTokens: 505,
  },
  costMicroUsd: 1900,
  provider: 'openai',
  model: 'gpt-4o',
  finishReason: 'tool_calls',
  latencyMs: 840,
};

export const mockTokenLedgerEntryFixture: TokenLedgerEntryV1 = {
  id: 'ledger_evt_001',
  tenantId: 'tenant_synthetic_alpha',
  workspaceId: 1,
  agentRunId: 'run_commercial_001',
  conversationId: 42,
  provider: 'openai',
  model: 'gpt-4o',
  operation: 'completion',
  promptTokens: 420,
  completionTokens: 85,
  totalTokens: 505,
  costMicroUsd: 1900,
  isByok: true,
  latencyMs: 840,
  status: 'success',
  metadataJson: { runStep: 2 },
  createdAt: '2026-11-02T10:00:00.000Z',
};

export const mockTenantTokenQuotaFixture: TenantTokenQuotaV1 = {
  tenantId: 'tenant_synthetic_alpha',
  monthlyCostLimitMicroUsd: 100000000, // $100.00 USD
  monthlyTokenLimit: 10000000,         // 10M tokens
  currentMonthCostMicroUsd: 12450000,  // $12.45 USD
  currentMonthTokensUsed: 1420500,     // 1.42M tokens
  hardLimitEnabled: true,
  hardLimitAction: 'block',
  periodStart: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-02T10:00:00.000Z',
};

export const mockTenantUsageSummaryFixture: TenantUsageSummaryV1 = {
  tenantId: 'tenant_synthetic_alpha',
  monthlyCostLimitMicroUsd: 100000000,
  currentMonthCostMicroUsd: 12450000,
  currentMonthCostUsd: '12.45',
  monthlyTokenLimit: 10000000,
  currentMonthTokensUsed: 1420500,
  percentageCostUsed: 12.45,
  percentageTokensUsed: 14.21,
  hardLimitEnabled: true,
  periodStart: '2026-11-01T00:00:00.000Z',
};

export const mockRegisterByokCredentialFixture: RegisterByokCredentialCommandV1 = {
  provider: 'openai',
  apiKey: 'sk-proj-1234567890abcdefghijklmnopqrstuvwxyz',
  defaultModel: 'gpt-4o',
  isActive: true,
};

export const mockReadToolFixture: ToolDefinitionV1 = {
  schemaVersion: 1,
  name: 'catalog.search',
  description: 'Searches product catalog by query keywords and filters',
  riskLevel: 'read',
  requiredRoles: ['AGENT', 'SALES_SUPERVISOR'],
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      limit: { type: 'number', default: 5 },
    },
    required: ['query'],
  },
  timeoutMs: 5000,
  isEgressNetworkTool: false,
};

export const mockWriteToolFixture: ToolDefinitionV1 = {
  schemaVersion: 1,
  name: 'order.create_draft',
  description: 'Creates a pending draft preorder within the tenant database',
  riskLevel: 'write',
  requiredRoles: ['AGENT', 'SALES_SUPERVISOR'],
  parameters: {
    type: 'object',
    properties: {
      customerId: { type: 'string' },
      items: { type: 'array' },
    },
    required: ['customerId', 'items'],
  },
  timeoutMs: 10000,
  isEgressNetworkTool: false,
};

export const mockSendToolFixture: ToolDefinitionV1 = {
  schemaVersion: 1,
  name: 'whatsapp.send_message',
  description: 'Transmits an outbound conversational message to customer via WhatsApp',
  riskLevel: 'send',
  requiredRoles: ['AGENT'],
  parameters: {
    type: 'object',
    properties: {
      to: { type: 'string' },
      text: { type: 'string' },
    },
    required: ['to', 'text'],
  },
  timeoutMs: 10000,
  requiresCasFencing: true,
  isEgressNetworkTool: true,
};

export const mockFinancialToolFixture: ToolDefinitionV1 = {
  schemaVersion: 1,
  name: 'payment.create_link',
  description: 'Generates an external payment checkout link and charges customer',
  riskLevel: 'financial',
  requiredRoles: ['SALES_SUPERVISOR', 'FINANCE_ADMIN'],
  parameters: {
    type: 'object',
    properties: {
      orderId: { type: 'string' },
      amountCents: { type: 'number' },
      currency: { type: 'string' },
    },
    required: ['orderId', 'amountCents', 'currency'],
  },
  timeoutMs: 15000,
  requiresApproval: true,
  isEgressNetworkTool: true,
};

export const mockDestructiveToolFixture: ToolDefinitionV1 = {
  schemaVersion: 1,
  name: 'customer.purge_gdpr',
  description: 'Permanently erases customer profile and interaction history under GDPR RTBF',
  riskLevel: 'destructive',
  requiredRoles: ['DPO_ADMIN', 'SECURITY_OFFICER'],
  parameters: {
    type: 'object',
    properties: {
      customerId: { type: 'string' },
      reason: { type: 'string' },
    },
    required: ['customerId', 'reason'],
  },
  timeoutMs: 30000,
  requiresApproval: true,
  isEgressNetworkTool: false,
};

export const mockToolExecutionRequestFixture: ToolExecutionRequestV1 = {
  tenantId: 'tenant_synthetic_alpha',
  agentGraphId: 'graph_commercial_flow_001',
  runId: 'run_commercial_001',
  toolName: 'catalog.search',
  input: { query: 'PROD-4091', limit: 3 },
  actorRoles: ['AGENT'],
  actorId: 'agent_runner_42',
  currentStep: 1,
  currentTokensUsed: 420,
};

export const mockMutativeToolExecutionRequestFixture: ToolExecutionRequestV1 = {
  tenantId: 'tenant_synthetic_alpha',
  agentGraphId: 'graph_commercial_flow_001',
  runId: 'run_commercial_001',
  toolName: 'order.create_draft',
  input: { customerId: 'cust_9981', items: [{ sku: 'PROD-4091', quantity: 2 }] },
  effectKey: 'eff_order_create_draft_step2_a8b9c0d1e2f3',
  actorRoles: ['AGENT'],
  actorId: 'agent_runner_42',
  currentStep: 2,
  currentTokensUsed: 950,
};

export const mockSendToolExecutionRequestFixture: ToolExecutionRequestV1 = {
  tenantId: 'tenant_synthetic_alpha',
  agentGraphId: 'graph_commercial_flow_001',
  runId: 'run_commercial_001',
  toolName: 'whatsapp.send_message',
  input: { to: '+5491122334455', text: 'Su pedido ha sido reservado.' },
  effectKey: 'eff_whatsapp_send_step3_112233445566',
  expectedConversationVersion: 4,
  actorRoles: ['AGENT'],
  actorId: 'agent_runner_42',
  currentStep: 3,
  currentTokensUsed: 1300,
};

export const mockToolExecutionResultSuccessFixture: ToolExecutionResultV1 = {
  success: true,
  status: 'executed',
  output: { items: [{ sku: 'PROD-4091', name: 'Widget Alpha', stock: 15 }] },
  durationMs: 145,
  riskLevel: 'read',
  hitlRequired: false,
  approvalId: null,
  effectKey: null,
};

export const mockToolExecutionResultHitlFixture: ToolExecutionResultV1 = {
  success: false,
  status: 'awaiting_approval',
  output: null,
  durationMs: 25,
  riskLevel: 'financial',
  hitlRequired: true,
  approvalId: 'appr_req_fin_001',
  effectKey: 'eff_payment_create_link_step4_99887766',
};

