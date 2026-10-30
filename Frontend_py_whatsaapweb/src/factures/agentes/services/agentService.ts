import { api } from '../../../shared/axios/http';

export type AgentMode = 'disabled' | 'suggest' | 'auto';
export type AgentStatus = 'draft' | 'active' | 'paused' | 'archived';
export type AgentPurpose = 'router' | 'sales_assistant' | 'support' | 'order_tracking' | 'booking' | 'operations' | 'general';
export type KnowledgeType = 'faq' | 'product' | 'pricing' | 'policy' | 'document' | 'url' | 'catalog';
export type AiDomainKey = 'gestion_web' | 'inventory_stock' | 'commercial_catalog' | 'orders' | 'support' | 'payments';
export type AiDomainStatus = 'active' | 'prepared' | 'coming_soon' | 'inactive';

export interface BusinessHours {
  enabled: boolean;
  timezone: string;
  start: string;
  end: string;
  days: string[];
}

export interface AgentProfile {
  businessDescription: string;
  communicationStyle: string;
  sellingScope: string;
  forbiddenClaims: string;
  language: string;
  tone: string;
  style: string;
  welcomeMessage: string;
}

export interface AgentRules {
  autoReplyWhen: string;
  suggestWhen: string;
  handoffWhen: string;
  businessHours: BusinessHours;
  confidenceThreshold: number;
  blockedTopics: string[];
  sensitiveTopics: string[];
  maxContextMessages: number;
}

export interface AgentKnowledgeSource {
  id: number;
  agentId: number;
  sourceType: KnowledgeType;
  title: string;
  content: string;
  url?: string | null;
  metadata?: Record<string, unknown>;
  enabled: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface AiAgent {
  id: number;
  companyId: number;
  name: string;
  status: AgentStatus;
  mode: AgentMode;
  provider: string;
  model?: string | null;
  purpose: AgentPurpose;
  moduleAccess: {
    catalog?: boolean;
    orders?: boolean;
    customerHistory?: boolean;
    tags?: boolean;
    handoff?: boolean;
    paymentsRead?: boolean;
    reportsRead?: boolean;
    commercialState?: boolean;
  };
  toolAccess?: {
    catalogSearch?: boolean;
    catalogGetItem?: boolean;
    catalogRecommendAlternatives?: boolean;
    availabilityCheck?: boolean;
    messageSendProductCard?: boolean;
    orderUpsertPreorder?: boolean;
    handoffCreate?: boolean;
    conversationSetCommercialState?: boolean;
    tagApplySystem?: boolean;
    timelineRecord?: boolean;
  };
  triggerRules: Record<string, unknown>;
  catalogScope: {
    catalogIds?: number[];
    sectionIds?: number[];
  };
  autoConfirmOrders: boolean;
  autoCreateVouchers: boolean;
  autoGeneratePaymentLinks: boolean;
  isDefault: boolean;
  createdAt?: string;
  updatedAt?: string;
  profile?: AgentProfile;
  rules?: AgentRules;
  knowledge?: AgentKnowledgeSource[];
}

export interface AiDomainSummary {
  domainKey: AiDomainKey;
  label: string;
  description: string;
  status: AiDomainStatus;
  available: boolean;
  agentId: number | null;
  assignedAgent: AiAgent | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface AiDomainActivityItem {
  id: number;
  agentId?: number;
  eventType?: string;
  action?: string;
  status?: string;
  message?: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
  timestamp?: string;
}

export interface AiDomainMetrics {
  domainKey: AiDomainKey;
  activeSessions: number;
  turns: number;
  commands: number;
  suggestions: number;
  autoReplies: number;
  handoffs: number;
  errors: number;
  dryRuns: number;
}

export interface AgentRuntimeResult {
  reply: string;
  confidence: number;
  action: 'suggest' | 'auto_reply' | 'handoff' | 'block';
  reason: string;
  usedKnowledgeIds: number[];
  provider: string;
  agentId?: number;
  commandCount?: number;
  commands?: Array<{ toolName: string; status: string }>;
  isTest?: boolean;
  turn?: AgentActivityTurn | null;
  context?: {
    source: 'provided' | 'recent_24h' | 'none';
    messages: number;
    expanded: boolean;
    expandedMessages: number;
  };
}

export interface AgentActivityCommand {
  id: number;
  title: string;
  summary: string;
  toolName: string | null;
  status: string;
  durationMs: number | null;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  relatedOrderId: number | null;
  relatedHandoffId: number | null;
  createdAt: string;
}

export interface AgentActivityTurn {
  id: number;
  sessionId: number;
  agentId: number | null;
  agentName: string;
  inboundProviderMessageId: string | null;
  status: 'running' | 'ok' | 'skipped' | 'failed';
  finalAction: 'suggest' | 'auto_reply' | 'handoff' | 'block' | 'none';
  finalReplyPreview: string;
  commandCount: number;
  startedAt: string;
  completedAt: string | null;
  commands: AgentActivityCommand[];
}

export interface AiChatSession {
  id: number;
  companyId: number;
  domainKey: AiDomainKey;
  conversationId: number;
  chatId: string;
  agentId: number | null;
  status: 'active' | 'paused' | 'handoff' | 'closed';
  lastInboundProviderMessageId: string | null;
  lastActivityAt: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface AgentProviderStatus {
  provider: string;
  configured: boolean;
  apiUrlConfigured: boolean;
  hasApiKey: boolean;
  chatPath: string;
  modelsPath: string;
  defaultModel?: string | null;
}

export interface AgentProviderModel {
  id: string;
  name: string;
}

export interface AgentProviderTestResult {
  ok: boolean;
  model?: string | null;
  reply: string;
}

function data<T>(response: { data: { data: T } | T }): T {
  return (response.data as any).data || response.data;
}

export const agentService = {
  async list(): Promise<AiAgent[]> {
    const response = await api.get<{ data: AiAgent[] }>('/agents');
    return data<AiAgent[]>(response);
  },

  async create(payload: Partial<AiAgent> & { domainKey?: AiDomainKey }): Promise<AiAgent> {
    const response = await api.post<{ data: AiAgent }>('/agents', payload);
    return data<AiAgent>(response);
  },

  async listDomains(): Promise<AiDomainSummary[]> {
    const response = await api.get<{ data: AiDomainSummary[] }>('/agents/domains');
    return data<AiDomainSummary[]>(response);
  },

  async activateDomain(domainKey: AiDomainKey): Promise<AiDomainSummary> {
    const response = await api.post<{ data: AiDomainSummary }>(`/agents/domains/${domainKey}/activate`);
    return data<AiDomainSummary>(response);
  },

  async assignDomainAgent(domainKey: AiDomainKey, agentId: number | null): Promise<AiDomainSummary> {
    const response = await api.put<{ data: AiDomainSummary }>(`/agents/domains/${domainKey}/agent`, { agentId });
    return data<AiDomainSummary>(response);
  },

  async deployDomainAgent(domainKey: AiDomainKey, agentId: number, patch?: Partial<AiAgent>): Promise<AiDomainSummary> {
    const response = await api.post<{ data: AiDomainSummary }>(`/agents/domains/${domainKey}/deploy`, { agentId, patch });
    return data<AiDomainSummary>(response);
  },

  async listDomainActivity(domainKey: AiDomainKey): Promise<AiDomainActivityItem[]> {
    const response = await api.get<{ data: AiDomainActivityItem[] }>(`/agents/domains/${domainKey}/activity`);
    return data<AiDomainActivityItem[]>(response);
  },

  async listDomainOperations(domainKey: AiDomainKey, filters: {
    agentId?: number | null;
    status?: string;
    tool?: string;
    chatId?: string;
    dateFrom?: string;
    dateTo?: string;
    limit?: number;
  } = {}): Promise<AgentActivityTurn[]> {
    const response = await api.get<{ data: AgentActivityTurn[] }>(`/agents/domains/${domainKey}/operations`, { params: filters });
    return data<AgentActivityTurn[]>(response);
  },

  async listDomainSessions(domainKey: AiDomainKey): Promise<AiChatSession[]> {
    const response = await api.get<{ data: AiChatSession[] }>(`/agents/domains/${domainKey}/sessions`);
    return data<AiChatSession[]>(response);
  },

  async getDomainMetrics(domainKey: AiDomainKey): Promise<AiDomainMetrics> {
    const response = await api.get<{ data: AiDomainMetrics }>(`/agents/domains/${domainKey}/metrics`);
    return data<AiDomainMetrics>(response);
  },

  async getProviderStatus(): Promise<AgentProviderStatus> {
    const response = await api.get<{ data: AgentProviderStatus }>('/agents/provider/status');
    return data<AgentProviderStatus>(response);
  },

  async listProviderModels(): Promise<AgentProviderModel[]> {
    const response = await api.get<{ data: AgentProviderModel[] }>('/agents/provider/models');
    return data<AgentProviderModel[]>(response);
  },

  async testProvider(model?: string | null): Promise<AgentProviderTestResult> {
    const response = await api.post<{ data: AgentProviderTestResult }>('/agents/provider/test', { model });
    return data<AgentProviderTestResult>(response);
  },

  async get(id: number): Promise<AiAgent> {
    const response = await api.get<{ data: AiAgent }>(`/agents/${id}`);
    return data<AiAgent>(response);
  },

  async update(id: number, payload: Partial<AiAgent>): Promise<AiAgent> {
    const response = await api.put<{ data: AiAgent }>(`/agents/${id}`, payload);
    return data<AiAgent>(response);
  },

  async updateProfile(id: number, profile: AgentProfile): Promise<AiAgent> {
    const response = await api.put<{ data: AiAgent }>(`/agents/${id}/profile`, profile);
    return data<AiAgent>(response);
  },

  async updateRules(id: number, rules: AgentRules): Promise<AiAgent> {
    const response = await api.put<{ data: AiAgent }>(`/agents/${id}/rules`, rules);
    return data<AiAgent>(response);
  },

  async createKnowledge(id: number, payload: Partial<AgentKnowledgeSource>): Promise<AgentKnowledgeSource> {
    const response = await api.post<{ data: AgentKnowledgeSource }>(`/agents/${id}/knowledge`, payload);
    return data<AgentKnowledgeSource>(response);
  },

  async uploadKnowledgeFile(id: number, payload: { file: File; title?: string; content?: string; enabled?: boolean }): Promise<AgentKnowledgeSource> {
    const formData = new FormData();
    formData.append('file', payload.file);
    if (payload.title) formData.append('title', payload.title);
    if (payload.content) formData.append('content', payload.content);
    if (payload.enabled !== undefined) formData.append('enabled', String(payload.enabled));

    const response = await api.post<{ data: AgentKnowledgeSource }>(`/agents/${id}/knowledge/upload`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return data<AgentKnowledgeSource>(response);
  },

  async updateKnowledge(id: number, sourceId: number, payload: Partial<AgentKnowledgeSource>): Promise<AgentKnowledgeSource> {
    const response = await api.put<{ data: AgentKnowledgeSource }>(`/agents/${id}/knowledge/${sourceId}`, payload);
    return data<AgentKnowledgeSource>(response);
  },

  async deleteKnowledge(id: number, sourceId: number): Promise<void> {
    await api.delete(`/agents/${id}/knowledge/${sourceId}`);
  },

  async test(id: number, message: string, history?: any[], mode = 'sandbox'): Promise<AgentRuntimeResult> {
    const response = await api.post<{ data: AgentRuntimeResult }>(`/agents/${id}/test`, { message, history, mode });
    return data<AgentRuntimeResult>(response);
  },

  async testSession(id: number, payload: { message: string; history?: any[]; domainKey?: 'gestion_web' }): Promise<AgentRuntimeResult> {
    const response = await api.post<{ data: AgentRuntimeResult }>(`/agents/${id}/test-session`, {
      message: payload.message,
      history: payload.history || [],
      domainKey: payload.domainKey || 'gestion_web',
    });
    return data<AgentRuntimeResult>(response);
  },

  async suggestDefault(payload: { chatId?: string | null; message: string; history?: any[] }): Promise<AgentRuntimeResult> {
    const response = await api.post<{ data: AgentRuntimeResult }>('/agents/suggest/default', payload);
    return data<AgentRuntimeResult>(response);
  },

  async getChatAiSession(chatId: string): Promise<AiChatSession | null> {
    const response = await api.get<{ data: AiChatSession | null }>(`/chats/${encodeURIComponent(chatId)}/ai-session`);
    return data<AiChatSession | null>(response);
  },

  async listChatAgentActivity(chatId: string, limit = 50): Promise<AgentActivityTurn[]> {
    const response = await api.get<{ data: AgentActivityTurn[] }>(`/chats/${encodeURIComponent(chatId)}/agent-activity`, { params: { limit } });
    return data<AgentActivityTurn[]>(response);
  },
};
