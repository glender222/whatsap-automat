import { PauseAiCommandV1, ResumeAiCommandV1, TakeoverCommandV1 } from '../conversations/commands';
import { ServerEventV1 } from '../conversations/realtime';
import { ConversationMessageV1, ConversationV1 } from '../conversations/types';

const mockDate = '2026-10-31T02:00:00.000Z';
const mockTenantId = 'tenant_synthetic_alpha';

export const canonicalConversationFixture: ConversationV1 = {
  id: 'conv_canonical_wa_001',
  tenantId: mockTenantId,
  connectionId: 'conn_wa_prod_001',
  channel: 'whatsapp-cloud',
  externalConversationId: '573001234567',
  contactIdentityId: 'ident_user_001',
  title: 'Juan Pérez - Consulta de compra',
  status: 'open',
  stage: 'catalog',
  stateVersion: 3,
  aiPaused: false,
  aiPausedUntil: null,
  assignedUserId: null,
  assignedAgentId: 'agent_sales_v1',
  lastMessageAt: mockDate,
  serviceWindowExpiresAt: '2026-11-01T02:00:00.000Z',
  createdAt: '2026-10-30T18:00:00.000Z',
  updatedAt: mockDate,
};

export const canonicalMessageFixture: ConversationMessageV1 = {
  id: 'msg_canonical_001',
  conversationId: 'conv_canonical_wa_001',
  tenantId: mockTenantId,
  connectionId: 'conn_wa_prod_001',
  channel: 'whatsapp-cloud',
  direction: 'inbound',
  deliveryState: 'delivered',
  originEventId: 'evt_wa_inbound_text_001',
  clientRequestId: null,
  correlationId: 'corr_wa_001',
  body: 'Hola, deseo consultar el estado de mi pedido #1042.',
  attachments: [],
  causedBy: {
    type: 'customer',
    id: '573001234567',
  },
  createdAt: mockDate,
};

export const takeoverCommandFixture: TakeoverCommandV1 = {
  schemaVersion: 1,
  tenantId: mockTenantId,
  conversationId: 'conv_canonical_wa_001',
  expectedVersion: 3,
  userId: 'user_agent_12',
  reason: 'Cliente solicita hablar con operador humano para negociar entrega personalizada.',
};

export const pauseAiCommandFixture: PauseAiCommandV1 = {
  schemaVersion: 1,
  tenantId: mockTenantId,
  conversationId: 'conv_canonical_wa_001',
  expectedVersion: 3,
  durationSeconds: 7200, // 2 hours
  reason: 'Intervención manual en proceso de checkout.',
};

export const resumeAiCommandFixture: ResumeAiCommandV1 = {
  schemaVersion: 1,
  tenantId: mockTenantId,
  conversationId: 'conv_canonical_wa_001',
  expectedVersion: 4,
  reason: 'Operador humano cerró consulta, reactivando agente IA.',
};

export const serverRealtimeEventsFixtures: ServerEventV1[] = [
  {
    type: 'conversation.updated',
    tenantId: mockTenantId,
    conversationId: 'conv_canonical_wa_001',
    version: 4,
    eventId: 'evt_rt_conv_upd_001',
  },
  {
    type: 'message.created',
    tenantId: mockTenantId,
    conversationId: 'conv_canonical_wa_001',
    messageId: 'msg_canonical_002',
    eventId: 'evt_rt_msg_new_001',
  },
  {
    type: 'agent.run.updated',
    tenantId: mockTenantId,
    runId: 'run_commercial_001',
    state: 'awaiting_approval',
    eventId: 'evt_rt_run_upd_001',
  },
  {
    type: 'approval.created',
    tenantId: mockTenantId,
    approvalId: 'appr_req_discount_001',
    eventId: 'evt_rt_appr_new_001',
  },
];
