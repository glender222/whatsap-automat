import { api } from '../../../shared/axios/http';

export type AutomatorMode = 'normal' | 'mixed' | 'automator';
export type PaymentGatewayProvider = 'mercadopago' | 'stripe' | 'paypal' | 'manual' | 'other';
export type HandoffOutcome = 'sale_confirmed' | 'no_sale' | 'follow_up_required' | 'support_resolved' | 'duplicate' | 'cancelled';

export type IaPauseStatus = {
  paused: boolean;
  pausedBy: number | null;
  pausedAt: string | null;
  resumeAt: string | null;
  reason: string | null;
  expired: boolean;
};

export type HandoffTicketSummary = {
  id: number;
  conversationId: number;
  chatId: string | null;
  customerName: string;
  reason: string;
  priority: 'low' | 'medium' | 'high';
  status: 'open' | 'taken' | 'closed' | 'cancelled';
  agentId: number | null;
  orderId: number | null;
  outcome: HandoffOutcome | null;
  notes: string | null;
  waitingSeconds: number;
  createdAt: string;
};

export type RuntimeLogEntry = {
  id: number;
  agentId: number | null;
  agentName: string | null;
  chatId: string | null;
  stage: string;
  level: string;
  status: string;
  summary: string;
  confidence: number | null;
  action: 'suggest' | 'auto_reply' | 'handoff' | 'block' | null;
  toolName: string | null;
  toolResultStatus: string | null;
  relatedOrderId: number | null;
  relatedHandoffId: number | null;
  createdAt: string;
};

export type RuntimeLogToolResultStatus =
  | 'ok'
  | 'skipped'
  | 'failed'
  | 'forbidden'
  | 'disabled_future_tool'
  | 'not_found'
  | 'invalid_input'
  | 'scope_empty'
  | 'permission_denied';

export const RUNTIME_LOG_TOOL_NAMES: readonly string[] = [
  'catalog.search',
  'catalog.getItem',
  'catalog.recommendAlternatives',
  'availability.check',
  'message.sendProductCard',
  'order.upsertPreorder',
  'handoff.create',
  'conversation.setCommercialState',
  'tag.applySystem',
  'timeline.record',
  'payment.createLink',
  'payment.validateVoucher',
  'payment.getStatus',
];

export const RUNTIME_LOG_TOOL_RESULT_STATUSES: readonly RuntimeLogToolResultStatus[] = [
  'ok',
  'skipped',
  'failed',
  'forbidden',
  'disabled_future_tool',
  'not_found',
  'invalid_input',
  'scope_empty',
  'permission_denied',
];

export type PaymentGateway = {
  id: number;
  companyId: number;
  provider: PaymentGatewayProvider;
  displayName: string;
  credentials: Record<string, unknown>;
  webhookSecret: string | null;
  status: 'active' | 'inactive' | 'archived';
  isDefault: boolean;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type PaymentGatewayInput = {
  provider: PaymentGatewayProvider;
  displayName: string;
  credentials?: Record<string, unknown>;
  webhookSecret?: string | null;
  status?: 'active' | 'inactive';
  isDefault?: boolean;
  metadata?: Record<string, unknown>;
};

function unwrap<T>(response: { data: { success: boolean; data: T } }): T {
  return response.data.data;
}

export const iaService = {
  async getCompanyMode(): Promise<AutomatorMode> {
    const response = await api.get('/agents/company-mode');
    return unwrap<{ mode: AutomatorMode }>(response).mode;
  },

  async setCompanyMode(mode: AutomatorMode): Promise<void> {
    await api.put('/agents/company-mode', { mode });
  },

  async getPauseStatus(chatId: string): Promise<IaPauseStatus> {
    const response = await api.get(`/chats/ia/${encodeURIComponent(chatId)}/status`);
    return unwrap<IaPauseStatus>(response);
  },

  async pauseIa(chatId: string, reason?: string, durationHours?: number): Promise<void> {
    await api.post(`/chats/ia/${encodeURIComponent(chatId)}/pause`, { reason, durationHours });
  },

  async resumeIa(chatId: string): Promise<void> {
    await api.post(`/chats/ia/${encodeURIComponent(chatId)}/resume`);
  },

  async listHandoffTickets(filters: { status?: string; limit?: number; offset?: number } = {}): Promise<{ rows: HandoffTicketSummary[]; total: number }> {
    const response = await api.get('/agents/handoff-tickets', {
      params: {
        status: filters.status,
        limit: filters.limit ?? 50,
        offset: filters.offset ?? 0,
      },
    });
    return unwrap<{ rows: HandoffTicketSummary[]; total: number }>(response);
  },

  async takeHandoffTicket(ticketId: number): Promise<void> {
    await api.post(`/agents/handoff-tickets/${ticketId}/take`);
  },

  async closeHandoffTicket(ticketId: number, input: { outcome: HandoffOutcome; notes?: string }): Promise<void> {
    await api.post(`/agents/handoff-tickets/${ticketId}/close`, input);
  },

  async listRuntimeLogs(filters: { chatId?: string; status?: string; action?: string; toolName?: string; toolResultStatus?: string; agentId?: number; limit?: number } = {}): Promise<RuntimeLogEntry[]> {
    const response = await api.get('/agents/runtime-logs', {
      params: {
        chatId: filters.chatId,
        status: filters.status,
        action: filters.action,
        toolName: filters.toolName,
        toolResultStatus: filters.toolResultStatus,
        agentId: filters.agentId,
        limit: filters.limit ?? 100,
      },
    });
    return unwrap<RuntimeLogEntry[]>(response);
  },

  async listGateways(): Promise<PaymentGateway[]> {
    const response = await api.get('/agents/payment-gateways');
    return unwrap<PaymentGateway[]>(response);
  },

  async createGateway(input: PaymentGatewayInput): Promise<PaymentGateway> {
    const response = await api.post('/agents/payment-gateways', input);
    return unwrap<PaymentGateway>(response);
  },

  async updateGateway(id: number, input: Partial<PaymentGatewayInput>): Promise<PaymentGateway> {
    const response = await api.patch(`/agents/payment-gateways/${id}`, input);
    return unwrap<PaymentGateway>(response);
  },

  async archiveGateway(id: number): Promise<void> {
    await api.delete(`/agents/payment-gateways/${id}`);
  },
};
