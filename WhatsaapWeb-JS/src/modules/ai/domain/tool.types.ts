import type {
  AgentMode,
  AgentModuleAccess,
  AgentPurpose,
  AgentToolAccess,
  AgentCatalogScope,
  AutomatorMode,
} from './agent.types';
import type { AgentAction } from './runtime.types';

export type ToolName =
  | 'catalog.search'
  | 'catalog.getItem'
  | 'catalog.recommendAlternatives'
  | 'availability.check'
  | 'message.sendProductCard'
  | 'order.upsertPreorder'
  | 'handoff.create'
  | 'conversation.setCommercialState'
  | 'tag.applySystem'
  | 'timeline.record'
  | 'payment.createLink'
  | 'payment.validateVoucher'
  | 'payment.getStatus';

export type ToolKind = 'read' | 'write' | 'send' | 'system' | 'payment_future';

export type ToolResultStatus =
  | 'ok'
  | 'skipped'
  | 'failed'
  | 'forbidden'
  | 'disabled_future_tool'
  | 'not_found'
  | 'invalid_input'
  | 'scope_empty'
  | 'permission_denied';

export const TOOL_EXECUTION_ERROR_CODE = 'TOOL_EXECUTION_FAILED' as const;

export type AgentToolContext = {
  companyId: number;
  conversationId: number | null;
  chatId: string | null;
  domainKey?: string;
  sessionId?: number | null;
  turnId?: number | null;
  agentId: number | null;
  provider?: string;
  agentPurpose: AgentPurpose;
  companyMode: AutomatorMode;
  agentMode: AgentMode;
  moduleAccess: AgentModuleAccess;
  toolAccess: AgentToolAccess;
  catalogScope: AgentCatalogScope;
  inboundProviderMessageId: string | null;
  actorUserId: number | null;
  isTest?: boolean;
};

export type ToolCallRequest = {
  id: string;
  name: ToolName;
  input: Record<string, unknown>;
};

export type ToolRequest = {
  type: 'tool_request';
  toolCalls: ToolCallRequest[];
};

export type DetectedOrderFinal = {
  intent: 'quote' | 'purchase' | 'confirm' | 'question' | 'cancel' | 'unknown' | 'none';
  customerConfirmed: boolean;
  items: Array<{
    commercialItemId: number;
    quantity: number;
  }>;
  recommendedAction: 'quote' | 'create_draft' | 'handoff' | 'ask_clarification';
};

export type ToolFinalResponse = {
  type: 'final';
  reply: string;
  action: 'auto_reply' | 'suggest' | 'handoff' | 'block';
  confidence: number;
  reason: string;
  detectedOrder?: DetectedOrderFinal | null;
  delivery?: {
    productCards?: Array<{
      commercialItemId: number;
      caption?: string;
    }>;
  } | null;
};

export type ToolCallResult = {
  toolCallId: string;
  toolName: ToolName;
  status: ToolResultStatus;
  output: unknown;
  durationMs: number;
  relatedOrderId?: number | null;
  relatedHandoffId?: number | null;
};

export type ToolDefinition = {
  name: ToolName;
  kind: ToolKind;
  description: string;
  inputSchema: Record<string, unknown>;
  disabled?: boolean;
  systemOnly?: boolean;
  requiresModule?: keyof AgentModuleAccess;
  requiresToolFlag?: keyof AgentToolAccess;
};

export type ToolExecutorOutcome = {
  status: ToolResultStatus;
  output: unknown;
  relatedOrderId?: number | null;
  relatedHandoffId?: number | null;
};

export type AgentToolLogPayload = {
  toolCallId: string;
  toolName: ToolName;
  input: Record<string, unknown>;
  outputSummary: Record<string, unknown>;
  durationMs: number;
  companyMode: AutomatorMode;
  agentMode: AgentMode;
  agentPurpose: AgentPurpose;
  scope: {
    catalogIds: number[];
    sectionIds: number[];
  };
};

export type AgentRuntimeLogToolInput = {
  companyId: number;
  agentId: number | null;
  chatId?: string | null;
  inboundProviderMessageId?: string | null;
  outboundProviderMessageId?: string | null;
  stage: string;
  level?: 'debug' | 'info' | 'warn' | 'error';
  status?: 'ok' | 'skipped' | 'failed';
  summary?: string;
  errorCode?: string | null;
  errorMessage?: string | null;
  payload?: AgentToolLogPayload | Record<string, unknown>;
  confidence?: number | null;
  action?: AgentAction | null;
  toolName?: ToolName | null;
  toolResultStatus?: ToolResultStatus | null;
  relatedOrderId?: number | null;
  relatedHandoffId?: number | null;
  provider?: string;
};

export const TOOL_RESULT_STATUSES: readonly ToolResultStatus[] = [
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

export const SYSTEM_TAGS: ReadonlyArray<{ name: string; color: string }> = [
  { name: 'handoff-pendiente', color: '#128C7E' },
  { name: 'ia-asistiendo', color: '#0E766A' },
  { name: 'prepedido-abierto', color: '#5B6F66' },
  { name: 'pago-pendiente', color: '#25D366' },
];

export const COMMERCIAL_STAGES: readonly string[] = [
  'new',
  'ai_assisting',
  'catalog',
  'preorder',
  'handoff',
  'payment',
  'closed',
];

export const COMMERCIAL_SUBSTATUSES: readonly string[] = [
  'new',
  'intent_detected',
  'needs_clarification',
  'catalog_matched',
  'product_recommended',
  'quoted',
  'no_match',
  'out_of_stock',
  'preorder_open',
  'handoff_pending',
  'human_attending',
  'payment_pending',
  'voucher_received',
  'sale_confirmed',
  'completed',
  'lost_cancelled',
];

export const AI_FORBIDDEN_SUBSTATUSES: readonly string[] = [
  'sale_confirmed',
  'completed',
  'lost_cancelled',
];

export const MAX_TOOL_ROUNDS = 4;
export const MAX_TOOL_CALLS_PER_MESSAGE = 8;
export const MAX_CATALOG_ITEMS_PER_TOOL = 3;
export const ROUTER_CONFIDENCE_THRESHOLD = 0.7;
export const MATCH_CONFIDENCE_THRESHOLD = 0.75;
export const MAX_METADATA_BYTES = 8192;
