export type AgentMode = 'disabled' | 'suggest' | 'auto';
export type AgentStatus = 'draft' | 'active' | 'paused' | 'archived';
export type AgentPurpose = 'router' | 'sales_assistant' | 'support' | 'order_tracking' | 'booking' | 'operations' | 'general';
export type AutomatorMode = 'normal' | 'mixed' | 'automator';
export type KnowledgeType = 'faq' | 'product' | 'pricing' | 'policy' | 'document' | 'url' | 'catalog';
export type AiDomainKey = 'gestion_web' | 'inventory_stock' | 'commercial_catalog' | 'orders' | 'support' | 'payments';
export type AiDomainStatus = 'active' | 'prepared' | 'coming_soon' | 'inactive';

export type BusinessHours = {
  enabled: boolean;
  timezone: string;
  start: string;
  end: string;
  days: string[];
};

export type AgentProfile = {
  businessDescription: string;
  communicationStyle: string;
  sellingScope: string;
  forbiddenClaims: string;
  language: string;
  tone: string;
  style: string;
  welcomeMessage: string;
};

export type AgentRules = {
  autoReplyWhen: string;
  suggestWhen: string;
  handoffWhen: string;
  businessHours: BusinessHours;
  confidenceThreshold: number;
  blockedTopics: string[];
  sensitiveTopics: string[];
  maxContextMessages: number;
};

export type AgentModuleAccess = {
  catalog?: boolean;
  orders?: boolean;
  customerHistory?: boolean;
  tags?: boolean;
  handoff?: boolean;
  paymentsRead?: boolean;
  reportsRead?: boolean;
  commercialState?: boolean;
};

export type AgentToolAccess = {
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

export type AgentTriggerRules = {
  commercialIntent: boolean | 'always' | 'never' | 'regex';
  handoffForPayment: boolean;
};

export type AgentCatalogScope = {
  catalogIds: number[];
  sectionIds: number[];
};

export type AgentKnowledgeSource = {
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
};

export type AiAgent = {
  id: number;
  companyId: number;
  name: string;
  status: AgentStatus;
  mode: AgentMode;
  provider: string;
  model?: string | null;
  purpose: AgentPurpose;
  moduleAccess: AgentModuleAccess;
  triggerRules: AgentTriggerRules;
  catalogScope: AgentCatalogScope;
  toolAccess?: AgentToolAccess;
  autoConfirmOrders: boolean;
  autoCreateVouchers: boolean;
  autoGeneratePaymentLinks: boolean;
  isDefault: boolean;
  createdBy: number | null;
  createdAt?: string;
  updatedAt?: string;
  profile?: AgentProfile;
  rules?: AgentRules;
  knowledge?: AgentKnowledgeSource[];
};

export type AiDomainSummary = {
  domainKey: AiDomainKey;
  label: string;
  description: string;
  status: AiDomainStatus;
  available: boolean;
  agentId: number | null;
  assignedAgent: AiAgent | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};
