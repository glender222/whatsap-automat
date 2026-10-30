export type AgentAction = 'suggest' | 'auto_reply' | 'handoff' | 'block';

export type DetectedOrder = {
  intent: 'none' | 'quote' | 'purchase' | 'confirm' | 'question' | 'cancel' | 'unknown';
  confidence: number;
  items: Array<{
    commercialItemId?: number | null;
    detectedName: string;
    productName?: string;
    quantity?: number;
    confidence?: number;
    ambiguous?: boolean;
  }>;
  customerConfirmed: boolean;
  recommendedAction?: 'ask_clarification' | 'quote' | 'create_draft' | 'handoff';
  notes?: string;
  reason?: string;
};

export type AgentRuntimeResult = {
  reply: string;
  confidence: number;
  action: AgentAction;
  reason: string;
  usedKnowledgeIds: number[];
  detectedOrder?: DetectedOrder | null;
  provider: string;
  context?: {
    source: 'provided' | 'recent_24h' | 'none';
    messages: number;
    expanded: boolean;
    expandedMessages: number;
  };
  canAutoConfirmOrder?: boolean;
  canCreateVoucher?: boolean;
  canGeneratePaymentLink?: boolean;
  commandCount?: number;
  commands?: Array<{ toolName: string; status: string }>;
  isTest?: boolean;
};

export type AgentConversationMessage = {
  fromMe: boolean;
  body: string;
  timestamp: Date | string;
  type: string;
};

export type RunAgentInput = {
  message: string;
  history?: any[];
  chatId?: string;
  mode?: string;
  inboundProviderMessageId?: string | null;
};

export type AgentRuntimeLogInput = {
  companyId: number;
  agentId?: number | null;
  provider?: string;
  chatId?: string | null;
  inboundProviderMessageId?: string | null;
  outboundProviderMessageId?: string | null;
  stage: string;
  level?: 'debug' | 'info' | 'warn' | 'error';
  status?: 'ok' | 'skipped' | 'failed';
  summary?: string;
  errorCode?: string | null;
  errorMessage?: string | null;
  payload?: unknown;
  confidence?: number | null;
  action?: AgentAction | null;
  toolName?: string | null;
  toolResultStatus?: string | null;
  relatedOrderId?: number | null;
  relatedHandoffId?: number | null;
};

export type AgentRuntimeLogEntry = {
  id: number;
  companyId: number;
  agentId: number | null;
  agentName: string | null;
  provider: string;
  chatId: string | null;
  inboundProviderMessageId: string | null;
  outboundProviderMessageId: string | null;
  stage: string;
  level: string;
  status: string;
  summary: string;
  errorCode: string | null;
  errorMessage: string | null;
  payload: Record<string, unknown>;
  confidence: number | null;
  action: AgentAction | null;
  toolName?: string | null;
  toolResultStatus?: string | null;
  relatedOrderId?: number | null;
  relatedHandoffId?: number | null;
  createdAt: string;
};

export type HandoffTicket = {
  id: number;
  companyId: number;
  conversationId: number;
  agentId: number | null;
  orderId: number | null;
  reason: string;
  priority: 'low' | 'medium' | 'high';
  status: 'open' | 'taken' | 'closed' | 'cancelled';
  takenBy: number | null;
  takenAt: string | null;
  closedAt: string | null;
  closedBy: number | null;
  outcome: 'sale_confirmed' | 'no_sale' | 'follow_up_required' | 'support_resolved' | 'duplicate' | 'cancelled' | null;
  notes: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type HandoffTicketSummary = HandoffTicket & {
  chatId: string | null;
  customerName: string;
  waitingSeconds: number;
};

export type IaPauseOverride = {
  id: number;
  companyId: number;
  conversationId: number;
  pausedBy: number | null;
  reason: string | null;
  expiresAt: string | null;
  createdAt: string;
};

export type IaPauseStatus = {
  paused: boolean;
  pausedBy: number | null;
  pausedAt: string | null;
  resumeAt: string | null;
  reason: string | null;
  expired: boolean;
};
