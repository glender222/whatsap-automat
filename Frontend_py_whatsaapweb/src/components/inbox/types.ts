/**
 * Whatsap-Automat v0.4 — Omnichannel Inbox Types & Contracts
 * Phase F3: PR-F3-04 (WCAG 2.2 AA & CAS Concurrency)
 */

export type ChannelProvider = 'whatsapp' | 'telegram' | 'instagram' | 'webchat';

export type OperatorPresence = 'available' | 'busy' | 'offline';

export type FunctionalPlaneId = 'operations' | 'automation' | 'platform' | 'admin';

export type FunctionalPlane = FunctionalPlaneId;

export interface FunctionalPlaneItem {
  id: string;
  label: string;
  plane: FunctionalPlaneId;
  iconName?: string;
  to?: string;
  badge?: number;
  badgeVariant?: 'default' | 'warning' | 'danger';
}

export type ConversationStatus = 'open' | 'pending_handoff' | 'ai_handling' | 'resolved';

export type MessageSenderType = 'customer' | 'operator' | 'agent' | 'system';

export type MessageStatus = 'sending' | 'sent' | 'delivered' | 'read' | 'failed';

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

export interface ConversationTag {
  id: string;
  name: string;
  color: string;
}

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
  slaDeadline: number; // Unix timestamp (ms)
  slaBreached: boolean;
  stateVersion: number; // CAS versioning guard v{version}
  ownershipEpoch?: number;
  tags: ConversationTag[];
  is24hWindowActive: boolean; // Meta 24h service window
  activeOrderId?: string;
}

export interface OmnichannelMessage {
  id: string;
  conversationId: string;
  senderType: MessageSenderType;
  senderName: string;
  senderAvatar?: string;
  body: string;
  timestamp: number;
  status: MessageStatus;
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

export interface AiToolTraceItem {
  id: string;
  functionName: string;
  resultSummary: string;
  timestamp: number;
  status: 'completed' | 'failed' | 'in_progress';
  latencyMs?: number;
  toolName?: string;
  parametersJson?: string;
  outputSummary?: string;
  executionMs?: number;
}

export type AgentToolTrace = AiToolTraceItem;

export interface CustomerOrderSummary {
  id: string;
  orderNumber: string;
  amount: string;
  currency: string;
  status: 'pending_payment' | 'paid' | 'dispatched' | 'cancelled';
  createdAt: string;
  itemsSummary: string;
  title?: string;
  total?: string;
}

export interface InternalNote {
  id: string;
  authorName: string;
  text: string;
  timestamp: number;
  content?: string;
  createdAt?: number;
}

export type InternalCustomerNote = InternalNote;
