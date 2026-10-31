/**
 * Whatsap-Automat v0.4 — Mock Contracts & UI Interfaces
 * 
 * Contratos e interfaces aisladas para desarrollo de frontend y prototipos UX/UI
 * Compatibles con Blueprint v0.4, sin acoplamiento a implementaciones de backend no mergeadas.
 */

export type ChannelProvider = 'whatsapp' | 'telegram' | 'instagram';

export type OperatorPresence = 'available' | 'busy' | 'offline';

export interface TenantSummary {
  id: string;
  name: string;
  slug: string;
  logoUrl?: string;
  plan: 'starter' | 'pro' | 'enterprise';
  status: 'active' | 'configuring' | 'suspended';
  activeChannels: ChannelProvider[];
}

export interface ConversationParticipant {
  id: string;
  name: string;
  phoneNumber?: string;
  username?: string;
  avatarUrl?: string;
  channel: ChannelProvider;
}

export type ConversationStatus = 'open' | 'pending_handoff' | 'ai_handling' | 'resolved';

export interface OmnichannelConversation {
  id: string;
  tenantId: string;
  channel: ChannelProvider;
  participant: ConversationParticipant;
  lastMessagePreview: string;
  lastMessageTimestamp: number;
  unreadCount: number;
  status: ConversationStatus;
  assignedOperatorId?: string;
  assignedOperatorName?: string;
  slaDeadline: number; // Unix timestamp
  slaBreached: boolean;
  stateVersion: number; // CAS versioning guard
  tags: Array<{ id: string; name: string; color: string }>;
  is24hWindowActive: boolean; // Meta 24h service window
}

export type MessageSenderType = 'customer' | 'operator' | 'agent' | 'system';

export interface OmnichannelMessage {
  id: string;
  conversationId: string;
  senderType: MessageSenderType;
  senderName: string;
  senderAvatar?: string;
  body: string;
  timestamp: number;
  status: 'sending' | 'sent' | 'delivered' | 'read' | 'failed';
  channel: ChannelProvider;
  mediaUrl?: string;
  mediaType?: 'image' | 'video' | 'audio' | 'document';
  fileName?: string;
  fileSizeBytes?: number;
  isOptimistic?: boolean;
  agentTraceId?: string;
  agentModelUsed?: string;
  agentConfidenceScore?: number;
}

export interface AiSuggestionPayload {
  suggestionId: string;
  conversationId: string;
  replyText: string;
  confidenceScore: number;
  suggestedAction: string;
  reasoningNotes: string;
  knowledgeSourcesUsed: Array<{ id: string; title: string; type: string }>;
  expiresAt: number;
}

// ----------------------------------------------------
// Agent Studio — Node Graph Schema (Blueprint v0.4)
// ----------------------------------------------------

export type AgentNodeType = 
  | 'trigger' 
  | 'policy_guard' 
  | 'memory_retrieval' 
  | 'llm_reasoner' 
  | 'tool_call' 
  | 'human_approval_gate' 
  | 'response_dispatch'
  | 'handoff';

export interface AgentGraphNode {
  id: string;
  type: AgentNodeType;
  label: string;
  position: { x: number; y: number };
  config: Record<string, unknown>;
  inputs: string[];
  outputs: string[];
}

export interface AgentGraphEdge {
  id: string;
  sourceNodeId: string;
  sourceHandle: string;
  targetNodeId: string;
  targetHandle: string;
  conditionLabel?: string;
}

export interface AgentDefinition {
  id: string;
  tenantId: string;
  name: string;
  description: string;
  version: string;
  status: 'draft' | 'published' | 'archived';
  nodes: AgentGraphNode[];
  edges: AgentGraphEdge[];
  systemPrompt: string;
  temperature: number;
  providerModel: 'gemini-1.5-pro' | 'gpt-4o' | 'local-vllm';
  toolGrants: string[];
  createdAt: string;
  updatedAt: string;
}

// ----------------------------------------------------
// Automations Wizard Schema
// ----------------------------------------------------

export interface AutomationRuleDefinition {
  id: string;
  tenantId: string;
  name: string;
  description: string;
  enabled: boolean;
  trigger: {
    event: 'inbound_message' | 'chat_inactivity' | 'keyword_match' | 'payment_uploaded';
    params: Record<string, unknown>;
  };
  conditions: Array<{
    field: string;
    operator: 'equals' | 'contains' | 'in' | 'greater_than';
    value: unknown;
  }>;
  actions: Array<{
    type: 'send_template' | 'assign_tag' | 'transfer_human' | 'pause_ia' | 'webhook';
    params: Record<string, unknown>;
  }>;
  delayMinutes: number;
}

export interface DryRunSimulationResult {
  success: boolean;
  simulatedActions: Array<{
    actionType: string;
    target: string;
    payloadPreview: Record<string, unknown>;
    status: 'simulated_ok' | 'simulated_warning';
    validationNotes?: string;
  }>;
  executionDurationMs: number;
}

// ----------------------------------------------------
// Human Approvals Queue Schema
// ----------------------------------------------------

export type RiskSeverity = 'low' | 'medium' | 'high';

export interface ApprovalTask {
  id: string;
  tenantId: string;
  riskSeverity: RiskSeverity;
  originAgentId: string;
  originAgentName: string;
  conversationId: string;
  customerName: string;
  channel: ChannelProvider;
  proposedAction: {
    type: 'send_outbound_message' | 'confirm_payment' | 'apply_discount' | 'cancel_order';
    summary: string;
    diff: {
      before: Record<string, unknown>;
      after: Record<string, unknown>;
    };
  };
  approvalToken: string; // One-time CAS token
  expiresAt: number; // Unix timestamp
  status: 'pending' | 'approved' | 'modified' | 'rejected' | 'expired';
}

// ----------------------------------------------------
// Mock Data Fixtures
// ----------------------------------------------------

export const MOCK_TENANTS: TenantSummary[] = [
  {
    id: 'ten-acme-01',
    name: 'Acme Commercial S.A.C.',
    slug: 'acme-com',
    plan: 'enterprise',
    status: 'active',
    activeChannels: ['whatsapp', 'telegram', 'instagram'],
  },
  {
    id: 'ten-peru-log-02',
    name: 'Logística Express Perú',
    slug: 'log-express',
    plan: 'pro',
    status: 'active',
    activeChannels: ['whatsapp'],
  },
];

export const MOCK_CONVERSATIONS: OmnichannelConversation[] = [
  {
    id: 'chat-wsp-01',
    tenantId: 'ten-acme-01',
    channel: 'whatsapp',
    participant: {
      id: 'part-01',
      name: 'Carlos Mendoza',
      phoneNumber: '+51 987 654 321',
      channel: 'whatsapp',
    },
    lastMessagePreview: '¿Tienen disponibilidad del modelo X en stock?',
    lastMessageTimestamp: Date.now() - 1000 * 60 * 3, // hace 3 min
    unreadCount: 2,
    status: 'ai_handling',
    slaDeadline: Date.now() + 1000 * 60 * 7, // restan 7 min
    slaBreached: false,
    stateVersion: 14,
    tags: [
      { id: 'tag-1', name: 'Cotización', color: '#10B981' },
      { id: 'tag-2', name: 'Lima', color: '#3B82F6' },
    ],
    is24hWindowActive: true,
  },
  {
    id: 'chat-tg-02',
    tenantId: 'ten-acme-01',
    channel: 'telegram',
    participant: {
      id: 'part-02',
      name: 'Elena Morales',
      username: '@elena_dev',
      channel: 'telegram',
    },
    lastMessagePreview: 'Necesito hablar con un asesor humano por favor.',
    lastMessageTimestamp: Date.now() - 1000 * 60 * 12,
    unreadCount: 1,
    status: 'pending_handoff',
    slaDeadline: Date.now() - 1000 * 60 * 2, // breached
    slaBreached: true,
    stateVersion: 6,
    tags: [{ id: 'tag-3', name: 'Handoff Urgente', color: '#EF4444' }],
    is24hWindowActive: true,
  },
];
