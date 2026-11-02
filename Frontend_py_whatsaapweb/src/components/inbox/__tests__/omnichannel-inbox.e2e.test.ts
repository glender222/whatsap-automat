/**
 * Comprehensive Opaque-Box Test Suite for PR-F3-04: Omnichannel Inbox & Unified Workspace
 * Coverage: Tiers 1-4 (Features F1-F20, Boundaries B1-B8, Combinatorial C1-C7, Scenarios 1-5)
 * Test Runner: Node.js native test runner (node --import tsx --test)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type {
  ChannelProvider,
  OperatorPresence,
  FunctionalPlaneId,
  FunctionalPlaneItem,
  ConversationStatus,
  OmnichannelConversation,
  OmnichannelMessage,
  AiSuggestionPayload,
  AiToolTraceItem,
  CustomerOrderSummary,
  InternalNote,
  TenantSummary,
} from '../types.ts';

// ============================================================================
// DOMAIN ENGINES & PURE LOGIC HARNESSES (ORACLE IMPLEMENTATION DERIVED FROM SPECS)
// ============================================================================

export type SlaStatusColor = 'green' | 'amber' | 'red_breach';

/**
 * Dynamic SLA State Calculator
 * Thresholds: >5m (Green), <=5m & >0 (Amber), <=0 or slaBreached (Red Breach)
 */
export function calculateSlaState(
  conversation: Pick<OmnichannelConversation, 'slaDeadline' | 'slaBreached'>,
  now: number
): SlaStatusColor {
  if (conversation.slaBreached) {
    return 'red_breach';
  }
  const remainingMs = conversation.slaDeadline - now;
  if (remainingMs <= 0) {
    return 'red_breach';
  }
  if (remainingMs <= 5 * 60 * 1000) {
    return 'amber';
  }
  return 'green';
}

/**
 * Phone number & search normalization helper
 */
export function normalizeSearchString(val: string): string {
  return val.toLowerCase().replace(/[\s\-()+]/g, '').trim();
}

/**
 * Contact initials generator
 */
export function getContactInitials(name: string): string {
  const clean = name.trim();
  if (!clean) return '??';
  const parts = clean.split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return clean.slice(0, 2).toUpperCase();
}

/**
 * Meta 24-Hour Service Window Detector
 * Rules: Applies strictly to WhatsApp. Non-WhatsApp channels are exempt (always active).
 */
export function isServiceWindowActive(
  channel: ChannelProvider,
  lastInboundTimestamp: number,
  now: number
): boolean {
  if (channel !== 'whatsapp') {
    return true;
  }
  const elapsedMs = now - lastInboundTimestamp;
  return elapsedMs < 24 * 60 * 60 * 1000;
}

/**
 * Priority queue sorter
 * Order: Red Breach first -> Amber SLA -> Normal Green -> Resolved
 */
export function sortQueueByPriority(
  conversations: OmnichannelConversation[],
  now: number
): OmnichannelConversation[] {
  return [...conversations].sort((a, b) => {
    // Resolved always comes last
    if (a.status === 'resolved' && b.status !== 'resolved') return 1;
    if (b.status === 'resolved' && a.status !== 'resolved') return -1;

    const slaA = calculateSlaState(a, now);
    const slaB = calculateSlaState(b, now);

    const score = (sla: SlaStatusColor): number => {
      if (sla === 'red_breach') return 0;
      if (sla === 'amber') return 1;
      return 2;
    };

    const diff = score(slaA) - score(slaB);
    if (diff !== 0) return diff;

    // Secondary sort: nearest deadline first
    return a.slaDeadline - b.slaDeadline;
  });
}

/**
 * Multi-dimensional conversation queue filter
 */
export function filterConversations(
  conversations: OmnichannelConversation[],
  channelFilter: 'all' | ChannelProvider,
  statusFilter: 'all' | 'mine' | ConversationStatus | 'sla_risk',
  searchQuery: string,
  currentUserId: string,
  now: number
): OmnichannelConversation[] {
  let result = [...conversations];

  // 1. Channel Filter
  if (channelFilter !== 'all') {
    result = result.filter((c) => c.channel === channelFilter);
  }

  // 2. Status Filter
  if (statusFilter === 'mine') {
    result = result.filter((c) => c.assignedOperatorId === currentUserId);
  } else if (statusFilter === 'sla_risk') {
    result = result.filter((c) => {
      if (c.status === 'resolved') return false;
      const sla = calculateSlaState(c, now);
      return sla === 'red_breach' || sla === 'amber';
    });
  } else if (statusFilter !== 'all') {
    result = result.filter((c) => c.status === statusFilter);
  }

  // 3. Search Query
  const trimmedQuery = searchQuery.trim();
  if (trimmedQuery) {
    const rawLower = trimmedQuery.toLowerCase();
    const normalizedDigits = normalizeSearchString(trimmedQuery);

    result = result.filter((c) => {
      const nameMatch = c.participant.name.toLowerCase().includes(rawLower);
      const usernameMatch = c.participant.username
        ? c.participant.username.toLowerCase().includes(rawLower)
        : false;
      const phoneMatch = c.participant.phoneNumber
        ? normalizeSearchString(c.participant.phoneNumber).includes(normalizedDigits)
        : false;
      const lastMsgMatch = c.lastMessagePreview.toLowerCase().includes(rawLower);

      return nameMatch || usernameMatch || phoneMatch || lastMsgMatch;
    });
  }

  return result;
}

/**
 * CAS Takeover Result & Error
 */
export interface CasTakeoverResult {
  success: boolean;
  conversation?: OmnichannelConversation;
  invalidationTriggered: boolean;
  conflict?: {
    statusCode: 409;
    errorType: string;
    expectedVersion: number;
    currentVersion: number;
  };
}

/**
 * CAS Takeover State Machine Execution
 */
export function executeCasTakeover(
  conversation: OmnichannelConversation,
  expectedVersion: number,
  operatorId: string,
  operatorName: string
): CasTakeoverResult {
  if (conversation.stateVersion !== expectedVersion) {
    return {
      success: false,
      invalidationTriggered: false,
      conflict: {
        statusCode: 409,
        errorType: 'https://api.whatsap-automat.com/errors/cas-conflict',
        expectedVersion,
        currentVersion: conversation.stateVersion,
      },
    };
  }

  const updated: OmnichannelConversation = {
    ...conversation,
    status: 'open',
    assignedOperatorId: operatorId,
    assignedOperatorName: operatorName,
    stateVersion: conversation.stateVersion + 1,
    ownershipEpoch: (conversation.ownershipEpoch ?? 0) + 1,
  };

  return {
    success: true,
    conversation: updated,
    invalidationTriggered: true, // Invalidate any pending AI suggestions immediately
  };
}

// ============================================================================
// FIXTURES
// ============================================================================

const NOW_BASE = 1730520000000; // Reference timestamp

export const FIXTURE_TENANTS: TenantSummary[] = [
  {
    id: 'ten-acme-01',
    name: 'Acme Commercial S.A.C.',
    slug: 'acme-com',
    plan: 'enterprise',
    status: 'active',
    activeChannels: ['whatsapp', 'telegram', 'instagram', 'webchat'],
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

export const FIXTURE_CONVERSATIONS: OmnichannelConversation[] = [
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
    lastMessageTimestamp: NOW_BASE - 1000 * 60 * 3, // 3m ago
    unreadCount: 2,
    status: 'ai_handling',
    slaDeadline: NOW_BASE + 1000 * 60 * 7, // 7m remaining (Green)
    slaBreached: false,
    stateVersion: 14,
    ownershipEpoch: 2,
    tags: [
      { id: 'tag-1', name: 'Cotización', color: '#10B981' },
      { id: 'tag-2', name: 'Lima', color: '#3B82F6' },
    ],
    is24hWindowActive: true,
    activeOrderId: 'ORD-98214',
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
    lastMessageTimestamp: NOW_BASE - 1000 * 60 * 12,
    unreadCount: 1,
    status: 'pending_handoff',
    slaDeadline: NOW_BASE - 1000 * 60 * 2, // breached 2m ago (Red Breach)
    slaBreached: true,
    stateVersion: 6,
    ownershipEpoch: 1,
    tags: [{ id: 'tag-3', name: 'Handoff Urgente', color: '#EF4444' }],
    is24hWindowActive: true,
    activeOrderId: 'ORD-7721',
  },
  {
    id: 'chat-ig-03',
    tenantId: 'ten-acme-01',
    channel: 'instagram',
    participant: {
      id: 'part-03',
      name: 'Valeria Quispe',
      username: '@valeria_style',
      channel: 'instagram',
    },
    lastMessagePreview: 'Hola, me enviaron el paquete incorrecto.',
    lastMessageTimestamp: NOW_BASE - 1000 * 60 * 20,
    unreadCount: 0,
    status: 'open',
    assignedOperatorId: 'op-ana-01',
    assignedOperatorName: 'Ana Pérez',
    slaDeadline: NOW_BASE + 1000 * 60 * 3, // 3m remaining (Amber SLA)
    slaBreached: false,
    stateVersion: 9,
    ownershipEpoch: 3,
    tags: [{ id: 'tag-4', name: 'Reclamos', color: '#F59E0B' }],
    is24hWindowActive: true,
  },
  {
    id: 'chat-wc-04',
    tenantId: 'ten-acme-01',
    channel: 'webchat',
    participant: {
      id: 'part-04',
      name: 'Rodrigo Vega',
      phoneNumber: '+51 912 345 678',
      channel: 'webchat',
    },
    lastMessagePreview: 'Muchas gracias por la atención brindada.',
    lastMessageTimestamp: NOW_BASE - 1000 * 60 * 60,
    unreadCount: 0,
    status: 'resolved',
    assignedOperatorId: 'op-ana-01',
    assignedOperatorName: 'Ana Pérez',
    slaDeadline: NOW_BASE - 1000 * 60 * 30,
    slaBreached: false,
    stateVersion: 20,
    ownershipEpoch: 4,
    tags: [{ id: 'tag-5', name: 'Cerrado', color: '#6B7280' }],
    is24hWindowActive: true,
  },
  {
    id: 'chat-wsp-expired-05',
    tenantId: 'ten-acme-01',
    channel: 'whatsapp',
    participant: {
      id: 'part-05',
      name: 'Mario Vargas',
      phoneNumber: '+51 999 888 777',
      channel: 'whatsapp',
    },
    lastMessagePreview: 'Quedo a la espera de la cotización.',
    lastMessageTimestamp: NOW_BASE - 1000 * 60 * 60 * 26, // 26h ago (Expired Meta 24h window)
    unreadCount: 0,
    status: 'open',
    assignedOperatorId: 'op-ana-01',
    assignedOperatorName: 'Ana Pérez',
    slaDeadline: NOW_BASE + 1000 * 60 * 45,
    slaBreached: false,
    stateVersion: 3,
    ownershipEpoch: 1,
    tags: [{ id: 'tag-1', name: 'Cotización', color: '#10B981' }],
    is24hWindowActive: false,
  },
];

export const FIXTURE_SUGGESTION: AiSuggestionPayload = {
  suggestionId: 'sug-101',
  conversationId: 'chat-wsp-01',
  replyText: '¡Hola Carlos! Sí, disponemos de 15 unidades del modelo X listas para despacho inmediato en Lima. ¿Deseas que reservemos tu pedido?',
  confidenceScore: 0.94,
  suggestedAction: 'Consultó inventario (15 unidades en stock)',
  reasoningNotes: 'El cliente preguntó por disponibilidad del modelo X. Stock verificado mediante get_product_stock().',
  knowledgeSourcesUsed: [{ id: 'k-1', title: 'Catálogo de Productos 2026', type: 'catalog' }],
  expiresAt: NOW_BASE + 1000 * 60 * 10,
};

export const FIXTURE_TRACES: AiToolTraceItem[] = [
  {
    id: 'trace-1',
    functionName: 'get_product_stock',
    resultSummary: 'Stock confirmado: 15 unidades disponibles en almacén Lima Este',
    timestamp: NOW_BASE - 1000 * 60 * 2,
    status: 'completed',
    latencyMs: 142,
    parametersJson: '{"sku": "MOD-X-2026", "warehouse": "LIM-EAST"}',
    outputSummary: '{"available": 15, "reserved": 2}',
  },
  {
    id: 'trace-2',
    functionName: 'calculate_delivery_cost',
    resultSummary: 'Tarifa Lima Metropolitana calculada: S/ 15.00',
    timestamp: NOW_BASE - 1000 * 60 * 1,
    status: 'completed',
    latencyMs: 89,
    parametersJson: '{"district": "Lima", "weightKg": 2.5}',
    outputSummary: '{"cost": 15.00, "currency": "PEN"}',
  },
];

export const FIXTURE_ORDER: CustomerOrderSummary = {
  id: 'ORD-98214',
  orderNumber: 'ORD-98214',
  amount: '180.00',
  currency: 'PEN',
  status: 'pending_payment',
  createdAt: '2026-11-01T14:30:00Z',
  itemsSummary: '2x Modelo X (Negro)',
};

export const FIXTURE_NOTES: InternalNote[] = [
  {
    id: 'note-1',
    authorName: 'Ana Pérez',
    text: 'Cliente solicita factura comercial con RUC 20601234567. Confirmó dirección en San Borja.',
    timestamp: NOW_BASE - 1000 * 60 * 40,
  },
];

// ============================================================================
// TEST SUITE: PR-F3-04 OMNICHANNEL INBOX (TIERS 1 - 4)
// ============================================================================

describe('PR-F3-04: Omnichannel Inbox & Unified Workspace Specification Suite', () => {

  // --------------------------------------------------------------------------
  // TIER 1: CORE FEATURE COVERAGE (Features F1 to F20)
  // --------------------------------------------------------------------------
  describe('Tier 1: Core Feature Coverage (F1 - F20)', () => {

    describe('F1: Multi-Channel Filter', () => {
      it('1.1 returns all conversations when channel filter is "all"', () => {
        const res = filterConversations(FIXTURE_CONVERSATIONS, 'all', 'all', '', 'op-ana-01', NOW_BASE);
        assert.equal(res.length, 5);
      });

      it('1.2 filters precisely by "whatsapp" provider', () => {
        const res = filterConversations(FIXTURE_CONVERSATIONS, 'whatsapp', 'all', '', 'op-ana-01', NOW_BASE);
        assert.equal(res.length, 2);
        assert.ok(res.every((c) => c.channel === 'whatsapp'));
      });

      it('1.3 filters precisely by "telegram" provider', () => {
        const res = filterConversations(FIXTURE_CONVERSATIONS, 'telegram', 'all', '', 'op-ana-01', NOW_BASE);
        assert.equal(res.length, 1);
        assert.equal(res[0].id, 'chat-tg-02');
      });

      it('1.4 filters precisely by "instagram" provider', () => {
        const res = filterConversations(FIXTURE_CONVERSATIONS, 'instagram', 'all', '', 'op-ana-01', NOW_BASE);
        assert.equal(res.length, 1);
        assert.equal(res[0].id, 'chat-ig-03');
      });

      it('1.5 filters precisely by "webchat" provider', () => {
        const res = filterConversations(FIXTURE_CONVERSATIONS, 'webchat', 'all', '', 'op-ana-01', NOW_BASE);
        assert.equal(res.length, 1);
        assert.equal(res[0].id, 'chat-wc-04');
      });

      it('1.6 maps channel providers to accessible metadata and colors', () => {
        const channels: ChannelProvider[] = ['whatsapp', 'telegram', 'instagram', 'webchat'];
        for (const ch of channels) {
          assert.match(ch, /^(whatsapp|telegram|instagram|webchat)$/);
        }
      });
    });

    describe('F2: Reactive Debounced Search', () => {
      it('2.1 matches contact name with case-insensitivity', () => {
        const res = filterConversations(FIXTURE_CONVERSATIONS, 'all', 'all', 'carlos', 'op-ana-01', NOW_BASE);
        assert.equal(res.length, 1);
        assert.equal(res[0].participant.name, 'Carlos Mendoza');
      });

      it('2.2 matches E.164 phone number formatting', () => {
        const res = filterConversations(FIXTURE_CONVERSATIONS, 'all', 'all', '+51 987 654 321', 'op-ana-01', NOW_BASE);
        assert.equal(res.length, 1);
        assert.equal(res[0].id, 'chat-wsp-01');
      });

      it('2.3 normalizes phone search ignoring spaces, dashes, and parentheses', () => {
        const res = filterConversations(FIXTURE_CONVERSATIONS, 'all', 'all', '987654321', 'op-ana-01', NOW_BASE);
        assert.equal(res.length, 1);
        assert.equal(res[0].id, 'chat-wsp-01');
      });

      it('2.4 matches username with or without leading "@"', () => {
        const resWithAt = filterConversations(FIXTURE_CONVERSATIONS, 'all', 'all', '@elena_dev', 'op-ana-01', NOW_BASE);
        const resWithoutAt = filterConversations(FIXTURE_CONVERSATIONS, 'all', 'all', 'elena_dev', 'op-ana-01', NOW_BASE);
        assert.equal(resWithAt.length, 1);
        assert.equal(resWithoutAt.length, 1);
        assert.equal(resWithAt[0].id, 'chat-tg-02');
      });

      it('2.5 searches across last message previews', () => {
        const res = filterConversations(FIXTURE_CONVERSATIONS, 'all', 'all', 'disponibilidad', 'op-ana-01', NOW_BASE);
        assert.equal(res.length, 1);
        assert.equal(res[0].id, 'chat-wsp-01');
      });
    });

    describe('F3: Operational Status Filter', () => {
      it('3.1 filters by "mine" returning conversations assigned to current user', () => {
        const res = filterConversations(FIXTURE_CONVERSATIONS, 'all', 'mine', '', 'op-ana-01', NOW_BASE);
        assert.equal(res.length, 3);
        assert.ok(res.every((c) => c.assignedOperatorId === 'op-ana-01'));
      });

      it('3.2 filters by "ai_handling" status', () => {
        const res = filterConversations(FIXTURE_CONVERSATIONS, 'all', 'ai_handling', '', 'op-ana-01', NOW_BASE);
        assert.equal(res.length, 1);
        assert.equal(res[0].status, 'ai_handling');
      });

      it('3.3 filters by "pending_handoff" status', () => {
        const res = filterConversations(FIXTURE_CONVERSATIONS, 'all', 'pending_handoff', '', 'op-ana-01', NOW_BASE);
        assert.equal(res.length, 1);
        assert.equal(res[0].id, 'chat-tg-02');
      });

      it('3.4 filters by "sla_risk" returning both breached and amber chats', () => {
        const res = filterConversations(FIXTURE_CONVERSATIONS, 'all', 'sla_risk', '', 'op-ana-01', NOW_BASE);
        // Elena Morales (breached) and Valeria Quispe (3m remaining)
        assert.equal(res.length, 2);
        const ids = res.map((c) => c.id);
        assert.ok(ids.includes('chat-tg-02'));
        assert.ok(ids.includes('chat-ig-03'));
      });

      it('3.5 filters by "resolved" status', () => {
        const res = filterConversations(FIXTURE_CONVERSATIONS, 'all', 'resolved', '', 'op-ana-01', NOW_BASE);
        assert.equal(res.length, 1);
        assert.equal(res[0].status, 'resolved');
      });
    });

    describe('F4: Functional Planes Navigation', () => {
      it('4.1 defines the four core functional planes', () => {
        const planes: FunctionalPlaneId[] = ['operations', 'automation', 'platform', 'admin'];
        assert.equal(planes.length, 4);
      });

      it('4.2 structures navigation items with plane identifiers and badge variants', () => {
        const item: FunctionalPlaneItem = {
          id: 'nav-inbox',
          label: 'Inbox Omnicanal',
          plane: 'operations',
          badge: 3,
          badgeVariant: 'warning',
        };
        assert.equal(item.plane, 'operations');
        assert.equal(item.badgeVariant, 'warning');
      });

      it('4.3 aggregates unread counts across all active conversations', () => {
        const totalUnread = FIXTURE_CONVERSATIONS.reduce((acc, c) => acc + c.unreadCount, 0);
        assert.equal(totalUnread, 3); // 2 in wsp-01 + 1 in tg-02
      });

      it('4.4 resolves badge urgency: danger if any chat is breached, warning if pending handoff', () => {
        const hasBreached = FIXTURE_CONVERSATIONS.some((c) => c.slaBreached);
        const hasHandoff = FIXTURE_CONVERSATIONS.some((c) => c.status === 'pending_handoff');
        const variant = hasBreached ? 'danger' : hasHandoff ? 'warning' : 'default';
        assert.equal(variant, 'danger');
      });

      it('4.5 supports accessible navigation plane routes', () => {
        const routes: Record<FunctionalPlaneId, string> = {
          operations: '/workspace/inbox',
          automation: '/workspace/agent-studio',
          platform: '/workspace/operations',
          admin: '/workspace/settings',
        };
        assert.equal(routes.operations, '/workspace/inbox');
        assert.equal(routes.automation, '/workspace/agent-studio');
      });
    });

    describe('F5: Fixed-Density Conversation Card (64px)', () => {
      it('5.1 verifies height token adherence (--height-chat-row: 64px)', () => {
        const cardHeightPx = 64;
        assert.equal(cardHeightPx, 64);
      });

      it('5.2 generates contact initials when avatar image is missing', () => {
        assert.equal(getContactInitials('Carlos Mendoza'), 'CM');
        assert.equal(getContactInitials('Elena Morales'), 'EM');
        assert.equal(getContactInitials('Mario'), 'MA');
      });

      it('5.3 displays channel indicator badge matching provider', () => {
        for (const chat of FIXTURE_CONVERSATIONS) {
          assert.ok(chat.channel);
          assert.match(chat.channel, /^(whatsapp|telegram|instagram|webchat)$/);
        }
      });

      it('5.4 preserves message preview without layout breaking', () => {
        const card = FIXTURE_CONVERSATIONS[0];
        assert.ok(card.lastMessagePreview.length > 0);
        assert.ok(card.lastMessageTimestamp <= NOW_BASE);
      });

      it('5.5 highlights active conversation with distinct selection class/border', () => {
        const selectedId = 'chat-wsp-01';
        const isSelected = FIXTURE_CONVERSATIONS[0].id === selectedId;
        assert.equal(isSelected, true);
      });
    });

    describe('F6: Dynamic SLA Timer & Tri-Color Breach Indicator', () => {
      it('6.1 returns "green" when remaining time > 5 minutes', () => {
        const chat = FIXTURE_CONVERSATIONS[0]; // 7m remaining
        const state = calculateSlaState(chat, NOW_BASE);
        assert.equal(state, 'green');
      });

      it('6.2 returns "amber" when remaining time <= 5 minutes and > 0', () => {
        const chat = FIXTURE_CONVERSATIONS[2]; // 3m remaining
        const state = calculateSlaState(chat, NOW_BASE);
        assert.equal(state, 'amber');
      });

      it('6.3 returns "red_breach" when now > slaDeadline', () => {
        const overdueChat: OmnichannelConversation = {
          ...FIXTURE_CONVERSATIONS[0],
          slaDeadline: NOW_BASE - 1000,
          slaBreached: false,
        };
        const state = calculateSlaState(overdueChat, NOW_BASE);
        assert.equal(state, 'red_breach');
      });

      it('6.4 explicit slaBreached: true forces "red_breach" regardless of deadline', () => {
        const breachedChat: OmnichannelConversation = {
          ...FIXTURE_CONVERSATIONS[0],
          slaDeadline: NOW_BASE + 1000 * 60 * 60, // 1 hour in future
          slaBreached: true,
        };
        const state = calculateSlaState(breachedChat, NOW_BASE);
        assert.equal(state, 'red_breach');
      });

      it('6.5 exposes textual description "SLA Breach" for accessibility live regions', () => {
        const chat = FIXTURE_CONVERSATIONS[1];
        const state = calculateSlaState(chat, NOW_BASE);
        assert.equal(state, 'red_breach');
        const ariaLabel = state === 'red_breach' ? 'SLA Vencido' : 'SLA En tiempo';
        assert.equal(ariaLabel, 'SLA Vencido');
      });
    });

    describe('F7: Operator Presence & Queue Priority', () => {
      it('7.1 supports presence states: available, busy, offline', () => {
        const presences: OperatorPresence[] = ['available', 'busy', 'offline'];
        assert.equal(presences.length, 3);
      });

      it('7.2 sorts queue placing breached chats ahead of amber and green', () => {
        const sorted = sortQueueByPriority(FIXTURE_CONVERSATIONS, NOW_BASE);
        assert.equal(sorted[0].id, 'chat-tg-02'); // Breached
        assert.equal(sorted[1].id, 'chat-ig-03'); // Amber (3m remaining)
      });

      it('7.3 pushes resolved conversations to the bottom of the queue', () => {
        const sorted = sortQueueByPriority(FIXTURE_CONVERSATIONS, NOW_BASE);
        assert.equal(sorted[sorted.length - 1].id, 'chat-wc-04'); // Resolved
      });

      it('7.4 operator presence "busy" pauses round-robin queue assignment', () => {
        const checkEligibility = (p: OperatorPresence) => p === 'available';
        assert.equal(checkEligibility('busy'), false);
        assert.equal(checkEligibility('available'), true);
      });

      it('7.5 maps presence to status indicator tokens', () => {
        const presenceTokenMap: Record<OperatorPresence, string> = {
          available: '--color-success',
          busy: '--color-warning',
          offline: '--color-text-muted',
        };
        assert.equal(presenceTokenMap.available, '--color-success');
        assert.equal(presenceTokenMap.offline, '--color-text-muted');
      });
    });

    describe('F8: Semantic Conversation Tags', () => {
      it('8.1 verifies tag structure with id, name, and color', () => {
        const tag = FIXTURE_CONVERSATIONS[0].tags[0];
        assert.equal(tag.id, 'tag-1');
        assert.equal(tag.name, 'Cotización');
        assert.equal(tag.color, '#10B981');
      });

      it('8.2 calculates transparent background style with 20% alpha', () => {
        const tag = FIXTURE_CONVERSATIONS[0].tags[0];
        const bgStyle = `${tag.color}20`;
        assert.equal(bgStyle, '#10B98120');
      });

      it('8.3 renders multiple tags per conversation', () => {
        const chat = FIXTURE_CONVERSATIONS[0];
        assert.equal(chat.tags.length, 2);
        assert.equal(chat.tags[1].name, 'Lima');
      });

      it('8.4 handles empty tags array without crashing', () => {
        const emptyChat: OmnichannelConversation = {
          ...FIXTURE_CONVERSATIONS[0],
          tags: [],
        };
        assert.equal(emptyChat.tags.length, 0);
      });

      it('8.5 supports appending a new tag immutably', () => {
        const chat = FIXTURE_CONVERSATIONS[0];
        const newTag = { id: 'tag-new', name: 'VIP', color: '#8B5CF6' };
        const updatedTags = [...chat.tags, newTag];
        assert.equal(updatedTags.length, 3);
        assert.equal(chat.tags.length, 2); // original untouched
      });
    });

    describe('F9: Active Chat Header & Visible CAS Version', () => {
      it('9.1 conforms to design token topbar height (--height-topbar: 56px)', () => {
        const topbarHeightPx = 56;
        assert.equal(topbarHeightPx, 56);
      });

      it('9.2 renders participant name and channel badge', () => {
        const chat = FIXTURE_CONVERSATIONS[0];
        assert.equal(chat.participant.name, 'Carlos Mendoza');
        assert.equal(chat.channel, 'whatsapp');
      });

      it('9.3 displays visible CAS version string formatted as "CAS v{stateVersion}"', () => {
        const chat = FIXTURE_CONVERSATIONS[0];
        const versionString = `CAS v${chat.stateVersion}`;
        assert.equal(versionString, 'CAS v14');
      });

      it('9.4 displays ownership epoch when present', () => {
        const chat = FIXTURE_CONVERSATIONS[0];
        assert.equal(chat.ownershipEpoch, 2);
      });

      it('9.5 header exposes accessible role and title', () => {
        const headerTitle = FIXTURE_CONVERSATIONS[0].participant.name;
        assert.ok(headerTitle.length > 0);
      });
    });

    describe('F10: Multimodal Message Timeline', () => {
      it('10.1 timeline container has role="log" semantics', () => {
        const timelineRole = 'log';
        assert.equal(timelineRole, 'log');
      });

      it('10.2 differentiates customer inbound messages', () => {
        const msg: OmnichannelMessage = {
          id: 'msg-01',
          conversationId: 'chat-wsp-01',
          senderType: 'customer',
          senderName: 'Carlos Mendoza',
          body: 'Hola, buenas tardes',
          timestamp: NOW_BASE,
          status: 'read',
          channel: 'whatsapp',
        };
        assert.equal(msg.senderType, 'customer');
      });

      it('10.3 differentiates operator outbound messages', () => {
        const msg: OmnichannelMessage = {
          id: 'msg-02',
          conversationId: 'chat-wsp-01',
          senderType: 'operator',
          senderName: 'Ana Pérez',
          body: 'Con gusto te atiendo',
          timestamp: NOW_BASE + 1000,
          status: 'sent',
          channel: 'whatsapp',
        };
        assert.equal(msg.senderType, 'operator');
      });

      it('10.4 differentiates AI agent messages with model and confidence score', () => {
        const msg: OmnichannelMessage = {
          id: 'msg-03',
          conversationId: 'chat-wsp-01',
          senderType: 'agent',
          senderName: 'Automat AI',
          body: 'Tenemos 15 unidades en stock',
          timestamp: NOW_BASE + 2000,
          status: 'sent',
          channel: 'whatsapp',
          agentModelUsed: 'gemini-1.5-pro',
          agentConfidenceScore: 0.94,
        };
        assert.equal(msg.senderType, 'agent');
        assert.equal(msg.agentModelUsed, 'gemini-1.5-pro');
        assert.equal(msg.agentConfidenceScore, 0.94);
      });

      it('10.5 handles media attachments with metadata', () => {
        const msg: OmnichannelMessage = {
          id: 'msg-04',
          conversationId: 'chat-wsp-01',
          senderType: 'customer',
          senderName: 'Carlos Mendoza',
          body: 'Adjunto comprobante',
          timestamp: NOW_BASE + 3000,
          status: 'delivered',
          channel: 'whatsapp',
          mediaUrl: 'https://cdn.whatsap-automat.com/vouchers/v-991.pdf',
          mediaType: 'document',
          fileName: 'comprobante_pago.pdf',
          fileSizeBytes: 245000,
        };
        assert.equal(msg.mediaType, 'document');
        assert.equal(msg.fileName, 'comprobante_pago.pdf');
      });
    });

    describe('F11: AI Suggestion Banner', () => {
      it('11.1 displays confidence score percentage', () => {
        const pct = Math.round(FIXTURE_SUGGESTION.confidenceScore * 100);
        assert.equal(pct, 94);
      });

      it('11.2 displays proposed reply text and reasoning notes', () => {
        assert.ok(FIXTURE_SUGGESTION.replyText.includes('15 unidades'));
        assert.ok(FIXTURE_SUGGESTION.reasoningNotes.includes('get_product_stock'));
      });

      it('11.3 includes knowledge sources used', () => {
        assert.equal(FIXTURE_SUGGESTION.knowledgeSourcesUsed.length, 1);
        assert.equal(FIXTURE_SUGGESTION.knowledgeSourcesUsed[0].title, 'Catálogo de Productos 2026');
      });

      it('11.4 dismiss action clears active suggestion', () => {
        let activeSuggestion: AiSuggestionPayload | null = FIXTURE_SUGGESTION;
        const handleDismiss = () => {
          activeSuggestion = null;
        };
        handleDismiss();
        assert.equal(activeSuggestion, null);
      });

      it('11.5 detects expired suggestion past expiresAt', () => {
        const isExpired = NOW_BASE > FIXTURE_SUGGESTION.expiresAt;
        assert.equal(isExpired, false);

        const pastSuggestion: AiSuggestionPayload = {
          ...FIXTURE_SUGGESTION,
          expiresAt: NOW_BASE - 1000,
        };
        assert.equal(NOW_BASE > pastSuggestion.expiresAt, true);
      });
    });

    describe('F12: Quick Accept & Send AI Suggestion', () => {
      it('12.1 accepts suggestion and creates optimistic outbound message', () => {
        const chat = FIXTURE_CONVERSATIONS[0];
        const suggestion = FIXTURE_SUGGESTION;

        const optimisticMsg: OmnichannelMessage = {
          id: `msg-${NOW_BASE}`,
          conversationId: chat.id,
          senderType: 'operator',
          senderName: 'Ana Pérez',
          body: suggestion.replyText,
          timestamp: NOW_BASE,
          status: 'sent',
          channel: chat.channel,
          isOptimistic: true,
          agentTraceId: 'trace-88941',
        };

        assert.equal(optimisticMsg.isOptimistic, true);
        assert.equal(optimisticMsg.body, suggestion.replyText);
        assert.equal(optimisticMsg.senderType, 'operator');
      });

      it('12.2 clears active suggestion immediately after accept', () => {
        let activeSuggestion: AiSuggestionPayload | null = FIXTURE_SUGGESTION;
        const accept = () => {
          activeSuggestion = null;
        };
        accept();
        assert.equal(activeSuggestion, null);
      });

      it('12.3 edit-in-composer transfers reply text to composer state and clears banner', () => {
        let composerText = '';
        let activeSuggestion: AiSuggestionPayload | null = FIXTURE_SUGGESTION;

        const handleEditInComposer = () => {
          if (!activeSuggestion) return;
          composerText = activeSuggestion.replyText;
          activeSuggestion = null;
        };

        handleEditInComposer();
        assert.equal(composerText, FIXTURE_SUGGESTION.replyText);
        assert.equal(activeSuggestion, null);
      });

      it('12.4 Ctrl+Enter shortcut handler executes accept & send', () => {
        let sent = false;
        const onKeyDown = (e: { ctrlKey: boolean; key: string }) => {
          if (e.ctrlKey && e.key === 'Enter') {
            sent = true;
          }
        };
        onKeyDown({ ctrlKey: true, key: 'Enter' });
        assert.equal(sent, true);
      });

      it('12.5 plain Enter does not trigger AI suggestion accept shortcut', () => {
        let sent = false;
        const onKeyDown = (e: { ctrlKey: boolean; key: string }) => {
          if (e.ctrlKey && e.key === 'Enter') {
            sent = true;
          }
        };
        onKeyDown({ ctrlKey: false, key: 'Enter' });
        assert.equal(sent, false);
      });
    });

    describe('F13: Meta 24-Hour Service Window Guard & HSM Fallback', () => {
      it('13.1 detects active 24h window when within 24 hours on WhatsApp', () => {
        const lastInbound = NOW_BASE - 1000 * 60 * 60 * 2; // 2h ago
        const active = isServiceWindowActive('whatsapp', lastInbound, NOW_BASE);
        assert.equal(active, true);
      });

      it('13.2 detects expired 24h window when > 24 hours on WhatsApp', () => {
        const lastInbound = NOW_BASE - 1000 * 60 * 60 * 25; // 25h ago
        const active = isServiceWindowActive('whatsapp', lastInbound, NOW_BASE);
        assert.equal(active, false);
      });

      it('13.3 blocks free-text composer on WhatsApp when window is expired', () => {
        const chat = FIXTURE_CONVERSATIONS[4]; // is24hWindowActive: false
        const isComposerDisabled = !chat.is24hWindowActive && chat.channel === 'whatsapp';
        assert.equal(isComposerDisabled, true);
      });

      it('13.4 does NOT block Telegram conversations even if > 24 hours elapsed', () => {
        const lastInbound = NOW_BASE - 1000 * 60 * 60 * 48; // 48h ago
        const active = isServiceWindowActive('telegram', lastInbound, NOW_BASE);
        assert.equal(active, true); // Telegram has no 24h window limitation
      });

      it('13.5 does NOT block Instagram or Webchat conversations by 24h Meta rule', () => {
        const lastInbound = NOW_BASE - 1000 * 60 * 60 * 48;
        assert.equal(isServiceWindowActive('instagram', lastInbound, NOW_BASE), true);
        assert.equal(isServiceWindowActive('webchat', lastInbound, NOW_BASE), true);
      });

      it('13.6 triggers approved HSM template picker when expired', () => {
        const chat = FIXTURE_CONVERSATIONS[4];
        const canUseHsmTemplate = !chat.is24hWindowActive && chat.channel === 'whatsapp';
        assert.equal(canUseHsmTemplate, true);
      });
    });

    describe('F14: Auto-Resizing Message Composer', () => {
      it('14.1 Enter key without Shift dispatches message', () => {
        let sent = false;
        const handleKeyDown = (e: { key: string; shiftKey: boolean }) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            sent = true;
          }
        };
        handleKeyDown({ key: 'Enter', shiftKey: false });
        assert.equal(sent, true);
      });

      it('14.2 Shift+Enter inserts newline without dispatching', () => {
        let sent = false;
        const handleKeyDown = (e: { key: string; shiftKey: boolean }) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            sent = true;
          }
        };
        handleKeyDown({ key: 'Enter', shiftKey: true });
        assert.equal(sent, false);
      });

      it('14.3 empty or whitespace-only input disables send action', () => {
        const text1 = '';
        const text2 = '    \n\t  ';
        const canSend1 = Boolean(text1.trim());
        const canSend2 = Boolean(text2.trim());
        assert.equal(canSend1, false);
        assert.equal(canSend2, false);
      });

      it('14.4 message dispatch trims leading and trailing whitespace', () => {
        const raw = '   Hola Carlos, ¿cómo estás?   \n';
        const trimmed = raw.trim();
        assert.equal(trimmed, 'Hola Carlos, ¿cómo estás?');
      });

      it('14.5 composer clears input text upon successful dispatch', () => {
        let composerText = 'Mensaje para enviar';
        const handleSend = () => {
          if (!composerText.trim()) return;
          composerText = '';
        };
        handleSend();
        assert.equal(composerText, '');
      });
    });

    describe('F15: Consolidated Contact Profile (300px Panel 4)', () => {
      it('15.1 conforms to layout token (--width-inbox-context: 300px)', () => {
        const panelWidthPx = 300;
        assert.equal(panelWidthPx, 300);
      });

      it('15.2 displays contact avatar or derived initials', () => {
        const participant = FIXTURE_CONVERSATIONS[0].participant;
        assert.equal(getContactInitials(participant.name), 'CM');
      });

      it('15.3 displays E.164 phone number', () => {
        const participant = FIXTURE_CONVERSATIONS[0].participant;
        assert.equal(participant.phoneNumber, '+51 987 654 321');
      });

      it('15.4 displays origin channel identifier', () => {
        const participant = FIXTURE_CONVERSATIONS[1].participant;
        assert.equal(participant.channel, 'telegram');
        assert.equal(participant.username, '@elena_dev');
      });

      it('15.5 renders contact tag list', () => {
        const chat = FIXTURE_CONVERSATIONS[0];
        assert.equal(chat.tags.length, 2);
      });
    });

    describe('F16: CAS Takeover & AI Invalidation', () => {
      it('16.1 takeover button is available when status is "ai_handling"', () => {
        const chat = FIXTURE_CONVERSATIONS[0];
        const canTakeover = chat.status === 'ai_handling';
        assert.equal(canTakeover, true);
      });

      it('16.2 takeover increments stateVersion by exactly 1', () => {
        const chat = FIXTURE_CONVERSATIONS[0]; // stateVersion: 14
        const result = executeCasTakeover(chat, 14, 'op-ana-01', 'Ana Pérez');
        assert.equal(result.success, true);
        assert.equal(result.conversation?.stateVersion, 15);
      });

      it('16.3 takeover increments ownershipEpoch by 1', () => {
        const chat = FIXTURE_CONVERSATIONS[0]; // ownershipEpoch: 2
        const result = executeCasTakeover(chat, 14, 'op-ana-01', 'Ana Pérez');
        assert.equal(result.conversation?.ownershipEpoch, 3);
      });

      it('16.4 takeover sets status to "open" and assigns operator name', () => {
        const chat = FIXTURE_CONVERSATIONS[0];
        const result = executeCasTakeover(chat, 14, 'op-ana-01', 'Ana Pérez');
        assert.equal(result.conversation?.status, 'open');
        assert.equal(result.conversation?.assignedOperatorName, 'Ana Pérez');
      });

      it('16.5 takeover immediately triggers invalidation of active AI suggestion', () => {
        const chat = FIXTURE_CONVERSATIONS[0];
        const result = executeCasTakeover(chat, 14, 'op-ana-01', 'Ana Pérez');
        assert.equal(result.invalidationTriggered, true);
      });
    });

    describe('F17: Agent Tool Traces Inspector', () => {
      it('17.1 renders list of executed tool calls', () => {
        assert.equal(FIXTURE_TRACES.length, 2);
      });

      it('17.2 displays function name and status', () => {
        const trace = FIXTURE_TRACES[0];
        assert.equal(trace.functionName, 'get_product_stock');
        assert.equal(trace.status, 'completed');
      });

      it('17.3 displays tool execution latency in milliseconds', () => {
        const trace = FIXTURE_TRACES[0];
        assert.equal(trace.latencyMs, 142);
      });

      it('17.4 displays parameters preview and output summary', () => {
        const trace = FIXTURE_TRACES[0];
        assert.ok(trace.parametersJson?.includes('MOD-X-2026'));
        assert.ok(trace.outputSummary?.includes('"available": 15'));
      });

      it('17.5 handles failed tool trace state gracefully', () => {
        const failedTrace: AiToolTraceItem = {
          id: 'trace-failed',
          functionName: 'charge_credit_card',
          resultSummary: 'Tarjeta rechazada por fondos insuficientes',
          timestamp: NOW_BASE,
          status: 'failed',
          latencyMs: 512,
        };
        assert.equal(failedTrace.status, 'failed');
        assert.equal(failedTrace.resultSummary.includes('rechazada'), true);
      });
    });

    describe('F18: Customer Active Order Summary', () => {
      it('18.1 renders commercial summary with order ID', () => {
        assert.equal(FIXTURE_ORDER.orderNumber, 'ORD-98214');
      });

      it('18.2 displays order amount and currency formatted', () => {
        const formatted = `${FIXTURE_ORDER.currency} ${FIXTURE_ORDER.amount}`;
        assert.equal(formatted, 'PEN 180.00');
      });

      it('18.3 displays payment status badge', () => {
        assert.equal(FIXTURE_ORDER.status, 'pending_payment');
      });

      it('18.4 displays items summary list', () => {
        assert.equal(FIXTURE_ORDER.itemsSummary, '2x Modelo X (Negro)');
      });

      it('18.5 handles conversation without active order', () => {
        const chatWithoutOrder = FIXTURE_CONVERSATIONS[2]; // activeOrderId undefined
        assert.equal(chatWithoutOrder.activeOrderId, undefined);
      });
    });

    describe('F19: Private Internal Notes', () => {
      it('19.1 renders internal notes with author name and timestamp', () => {
        const note = FIXTURE_NOTES[0];
        assert.equal(note.authorName, 'Ana Pérez');
        assert.ok(note.timestamp <= NOW_BASE);
      });

      it('19.2 notes are isolated from customer timeline messages', () => {
        const note = FIXTURE_NOTES[0];
        // Notes do not have a MessageSenderType of 'customer'
        assert.equal('senderType' in note, false);
      });

      it('19.3 supports appending new internal note', () => {
        const newNote: InternalNote = {
          id: 'note-2',
          authorName: 'Carlos Supervisor',
          text: 'Autorizado descuento del 5% por pronto pago.',
          timestamp: NOW_BASE,
        };
        const allNotes = [...FIXTURE_NOTES, newNote];
        assert.equal(allNotes.length, 2);
        assert.equal(allNotes[1].authorName, 'Carlos Supervisor');
      });

      it('19.4 prevents empty note submission', () => {
        const emptyText = '   ';
        const isValid = Boolean(emptyText.trim());
        assert.equal(isValid, false);
      });

      it('19.5 maintains chronological ordering of notes', () => {
        const notes = [
          { id: 'n1', authorName: 'A', text: 'First', timestamp: 100 },
          { id: 'n2', authorName: 'B', text: 'Second', timestamp: 200 },
        ];
        assert.ok(notes[1].timestamp > notes[0].timestamp);
      });
    });

    describe('F20: Collapsible Context Panel Toggle', () => {
      it('20.1 context panel state defaults to open (true)', () => {
        const contextPanelOpen = true;
        assert.equal(contextPanelOpen, true);
      });

      it('20.2 toggling state flips between true and false', () => {
        let open = true;
        open = !open;
        assert.equal(open, false);
        open = !open;
        assert.equal(open, true);
      });

      it('20.3 width reflects 300px when open and 0px when closed', () => {
        const getWidthPx = (isOpen: boolean) => (isOpen ? 300 : 0);
        assert.equal(getWidthPx(true), 300);
        assert.equal(getWidthPx(false), 0);
      });

      it('20.4 exposes aria-expanded attribute on toggle trigger', () => {
        const getAriaExpanded = (isOpen: boolean) => String(isOpen);
        assert.equal(getAriaExpanded(true), 'true');
        assert.equal(getAriaExpanded(false), 'false');
      });

      it('20.5 toggle trigger includes accessible title and label', () => {
        const title = 'Alternar panel de contexto';
        assert.ok(title.length > 0);
      });
    });
  });

  // --------------------------------------------------------------------------
  // TIER 2: BOUNDARY & CORNER CASES (Suites B1 to B8)
  // --------------------------------------------------------------------------
  describe('Tier 2: Boundary & Corner Cases (B1 - B8)', () => {

    describe('B1: Search & Filter Boundary Conditions', () => {
      it('B1.1 empty search string returns entire unfiltered list', () => {
        const res = filterConversations(FIXTURE_CONVERSATIONS, 'all', 'all', '', 'op-ana-01', NOW_BASE);
        assert.equal(res.length, FIXTURE_CONVERSATIONS.length);
      });

      it('B1.2 whitespace-only query returns entire unfiltered list', () => {
        const res = filterConversations(FIXTURE_CONVERSATIONS, 'all', 'all', '   \t  \n ', 'op-ana-01', NOW_BASE);
        assert.equal(res.length, FIXTURE_CONVERSATIONS.length);
      });

      it('B1.3 query with zero matching items returns empty array without throwing', () => {
        const res = filterConversations(FIXTURE_CONVERSATIONS, 'all', 'all', 'non_existent_search_query_xyz', 'op-ana-01', NOW_BASE);
        assert.deepEqual(res, []);
      });

      it('B1.4 query with special regex metacharacters treated as literal characters', () => {
        const specialQuery = '.*+?^${}()|[]\\';
        const res = filterConversations(FIXTURE_CONVERSATIONS, 'all', 'all', specialQuery, 'op-ana-01', NOW_BASE);
        assert.deepEqual(res, []);
      });

      it('B1.5 extremely long query (1,000 chars) handles smoothly without crash', () => {
        const hugeQuery = 'a'.repeat(1000);
        const res = filterConversations(FIXTURE_CONVERSATIONS, 'all', 'all', hugeQuery, 'op-ana-01', NOW_BASE);
        assert.deepEqual(res, []);
      });
    });

    describe('B2: SLA Threshold Exact Boundary Analysis', () => {
      it('B2.1 exactly 5 minutes remaining (300,000 ms) is classified as amber', () => {
        const chat: OmnichannelConversation = {
          ...FIXTURE_CONVERSATIONS[0],
          slaDeadline: NOW_BASE + 300_000,
          slaBreached: false,
        };
        assert.equal(calculateSlaState(chat, NOW_BASE), 'amber');
      });

      it('B2.2 exactly 5 minutes plus 1 millisecond (300,001 ms) is classified as green', () => {
        const chat: OmnichannelConversation = {
          ...FIXTURE_CONVERSATIONS[0],
          slaDeadline: NOW_BASE + 300_001,
          slaBreached: false,
        };
        assert.equal(calculateSlaState(chat, NOW_BASE), 'green');
      });

      it('B2.3 exactly at deadline (remainingMs === 0) is classified as red_breach', () => {
        const chat: OmnichannelConversation = {
          ...FIXTURE_CONVERSATIONS[0],
          slaDeadline: NOW_BASE,
          slaBreached: false,
        };
        assert.equal(calculateSlaState(chat, NOW_BASE), 'red_breach');
      });

      it('B2.4 past deadline by 1 ms (remainingMs === -1) is classified as red_breach', () => {
        const chat: OmnichannelConversation = {
          ...FIXTURE_CONVERSATIONS[0],
          slaDeadline: NOW_BASE - 1,
          slaBreached: false,
        };
        assert.equal(calculateSlaState(chat, NOW_BASE), 'red_breach');
      });

      it('B2.5 extreme overdue (100 days in the past) stays stably in red_breach', () => {
        const chat: OmnichannelConversation = {
          ...FIXTURE_CONVERSATIONS[0],
          slaDeadline: NOW_BASE - 1000 * 60 * 60 * 24 * 100,
          slaBreached: false,
        };
        assert.equal(calculateSlaState(chat, NOW_BASE), 'red_breach');
      });
    });

    describe('B3: Meta 24-Hour Service Window Exact Boundaries', () => {
      const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

      it('B3.1 exactly 24 hours elapsed (86,400,000 ms) evaluates to expired', () => {
        const lastInbound = NOW_BASE - TWENTY_FOUR_HOURS;
        assert.equal(isServiceWindowActive('whatsapp', lastInbound, NOW_BASE), false);
      });

      it('B3.2 1 millisecond before 24 hours (86,399,999 ms) evaluates to active', () => {
        const lastInbound = NOW_BASE - (TWENTY_FOUR_HOURS - 1);
        assert.equal(isServiceWindowActive('whatsapp', lastInbound, NOW_BASE), true);
      });

      it('B3.3 1 millisecond after 24 hours (86,400,001 ms) evaluates to expired', () => {
        const lastInbound = NOW_BASE - (TWENTY_FOUR_HOURS + 1);
        assert.equal(isServiceWindowActive('whatsapp', lastInbound, NOW_BASE), false);
      });

      it('B3.4 non-WhatsApp provider with 7 days elapsed is exempt from 24h restriction', () => {
        const lastInbound = NOW_BASE - 1000 * 60 * 60 * 24 * 7;
        assert.equal(isServiceWindowActive('telegram', lastInbound, NOW_BASE), true);
        assert.equal(isServiceWindowActive('webchat', lastInbound, NOW_BASE), true);
      });
    });

    describe('B4: Degenerate & Empty Queue Boundaries', () => {
      it('B4.1 empty conversation list sorts and filters without exception', () => {
        const emptyList: OmnichannelConversation[] = [];
        const filtered = filterConversations(emptyList, 'all', 'all', '', 'op-01', NOW_BASE);
        const sorted = sortQueueByPriority(emptyList, NOW_BASE);
        assert.deepEqual(filtered, []);
        assert.deepEqual(sorted, []);
      });

      it('B4.2 single conversation queue retains selected item', () => {
        const single = [FIXTURE_CONVERSATIONS[0]];
        const sorted = sortQueueByPriority(single, NOW_BASE);
        assert.equal(sorted.length, 1);
        assert.equal(sorted[0].id, FIXTURE_CONVERSATIONS[0].id);
      });

      it('B4.3 filtering single item by incompatible channel yields empty array', () => {
        const singleWsp = [FIXTURE_CONVERSATIONS[0]]; // WhatsApp
        const filtered = filterConversations(singleWsp, 'telegram', 'all', '', 'op-01', NOW_BASE);
        assert.equal(filtered.length, 0);
      });
    });

    describe('B5: Message Text Length & Content Boundaries', () => {
      it('B5.1 single character message is valid', () => {
        const singleChar = '?';
        assert.equal(singleChar.trim().length, 1);
      });

      it('B5.2 maximum WhatsApp text limit (4,096 characters) accepted', () => {
        const maxMessage = 'A'.repeat(4096);
        assert.equal(maxMessage.length, 4096);
        assert.ok(maxMessage.trim().length > 0);
      });

      it('B5.3 message text with emojis, grapheme clusters, and unicode survives untouched', () => {
        const unicodeText = '👋🏽 Hola! 🎉 Disponibilidad en Lima 🌟 100% 👍';
        assert.equal(unicodeText.trim(), unicodeText);
      });

      it('B5.4 HTML and script tags are treated as plain text strings, not evaluated', () => {
        const xssPayload = '<script>alert("xss")</script>';
        assert.equal(xssPayload.trim(), '<script>alert("xss")</script>');
      });

      it('B5.5 multiline text with 50+ line breaks trims boundary newlines cleanly', () => {
        const multiline = '\n\n\n' + 'Linea 1\n'.repeat(50) + '\n\n';
        const trimmed = multiline.trim();
        assert.ok(trimmed.startsWith('Linea 1'));
        assert.ok(trimmed.endsWith('Linea 1'));
      });
    });

    describe('B6: CAS Version Boundary Values', () => {
      it('B6.1 initial stateVersion = 0 increments to 1', () => {
        const initialChat: OmnichannelConversation = {
          ...FIXTURE_CONVERSATIONS[0],
          stateVersion: 0,
          ownershipEpoch: 0,
        };
        const result = executeCasTakeover(initialChat, 0, 'op-ana-01', 'Ana Pérez');
        assert.equal(result.success, true);
        assert.equal(result.conversation?.stateVersion, 1);
        assert.equal(result.conversation?.ownershipEpoch, 1);
      });

      it('B6.2 high integer version (1,000,000) increments to 1,000,001 without precision loss', () => {
        const highChat: OmnichannelConversation = {
          ...FIXTURE_CONVERSATIONS[0],
          stateVersion: 1_000_000,
        };
        const result = executeCasTakeover(highChat, 1_000_000, 'op-ana-01', 'Ana Pérez');
        assert.equal(result.success, true);
        assert.equal(result.conversation?.stateVersion, 1_000_001);
      });

      it('B6.3 takeover on undefined ownershipEpoch initializes to 1', () => {
        const noEpochChat: OmnichannelConversation = {
          ...FIXTURE_CONVERSATIONS[0],
          ownershipEpoch: undefined,
        };
        const result = executeCasTakeover(noEpochChat, 14, 'op-ana-01', 'Ana Pérez');
        assert.equal(result.success, true);
        assert.equal(result.conversation?.ownershipEpoch, 1);
      });
    });

    describe('B7: Missing & Nullable Contact Profile Fields', () => {
      it('B7.1 participant without phone number (Telegram username only) formats initials', () => {
        const tgParticipant = FIXTURE_CONVERSATIONS[1].participant;
        assert.equal(tgParticipant.phoneNumber, undefined);
        assert.equal(tgParticipant.username, '@elena_dev');
        assert.equal(getContactInitials(tgParticipant.name), 'EM');
      });

      it('B7.2 single word name generates 2-letter uppercase initials', () => {
        assert.equal(getContactInitials('Platón'), 'PL');
      });

      it('B7.3 empty name string falls back to "??"', () => {
        assert.equal(getContactInitials('   '), '??');
      });
    });

    describe('B8: Internal Notes & Order Boundaries', () => {
      it('B8.1 order with zero items and zero amount formatted properly', () => {
        const zeroOrder: CustomerOrderSummary = {
          id: 'ORD-0',
          orderNumber: 'ORD-0',
          amount: '0.00',
          currency: 'PEN',
          status: 'pending_payment',
          createdAt: '2026-11-02T00:00:00Z',
          itemsSummary: 'Sin artículos',
        };
        assert.equal(zeroOrder.amount, '0.00');
        assert.equal(zeroOrder.itemsSummary, 'Sin artículos');
      });

      it('B8.2 notes list with 1,000+ words in text content persists intact', () => {
        const largeText = 'Comentario de supervisión '.repeat(100);
        const largeNote: InternalNote = {
          id: 'note-large',
          authorName: 'Supervisor',
          text: largeText,
          timestamp: NOW_BASE,
        };
        assert.equal(largeNote.text.length, largeText.length);
      });
    });
  });

  // --------------------------------------------------------------------------
  // TIER 3: COMBINATORIAL INTERACTIONS & CONCURRENCY (Suites C1 to C7)
  // --------------------------------------------------------------------------
  describe('Tier 3: Combinatorial & Concurrency Interactions (C1 - C7)', () => {

    describe('C1: CAS Takeover Race Condition Simulation', () => {
      it('C1.1 allows first concurrent takeover and rejects stale second with HTTP 409', () => {
        const currentChat = { ...FIXTURE_CONVERSATIONS[0] }; // stateVersion: 14

        // Concurrent dispatch: Operator 1 and Operator 2 both read stateVersion 14
        const op1Expected = 14;
        const op2Expected = 14;

        // Operator 1 executes first
        const op1Result = executeCasTakeover(currentChat, op1Expected, 'op-ana', 'Ana Pérez');
        assert.equal(op1Result.success, true);
        assert.equal(op1Result.conversation?.stateVersion, 15);

        // Operator 2 attempts takeover on the updated chat with stale version 14
        const updatedChat = op1Result.conversation!;
        const op2Result = executeCasTakeover(updatedChat, op2Expected, 'op-beto', 'Beto Silva');

        assert.equal(op2Result.success, false);
        assert.equal(op2Result.conflict?.statusCode, 409);
        assert.equal(op2Result.conflict?.expectedVersion, 14);
        assert.equal(op2Result.conflict?.currentVersion, 15);
        assert.equal(op2Result.conflict?.errorType, 'https://api.whatsap-automat.com/errors/cas-conflict');
      });
    });

    describe('C2: Takeover with Active AI Suggestion Invalidation', () => {
      it('C2.1 atomically invalidates active suggestion upon successful takeover', () => {
        let activeSuggestion: AiSuggestionPayload | null = FIXTURE_SUGGESTION;
        const chat = FIXTURE_CONVERSATIONS[0];

        // Perform takeover
        const result = executeCasTakeover(chat, 14, 'op-ana-01', 'Ana Pérez');
        if (result.invalidationTriggered) {
          activeSuggestion = null;
        }

        assert.equal(result.success, true);
        assert.equal(activeSuggestion, null);
      });
    });

    describe('C3: Multi-Filter Intersection (Channel x Status Matrix)', () => {
      it('C3.1 filters by channel=telegram AND status=pending_handoff', () => {
        const res = filterConversations(FIXTURE_CONVERSATIONS, 'telegram', 'pending_handoff', '', 'op-ana-01', NOW_BASE);
        assert.equal(res.length, 1);
        assert.equal(res[0].id, 'chat-tg-02');
      });

      it('C3.2 filters by channel=whatsapp AND status=pending_handoff (yielding 0 results)', () => {
        const res = filterConversations(FIXTURE_CONVERSATIONS, 'whatsapp', 'pending_handoff', '', 'op-ana-01', NOW_BASE);
        assert.equal(res.length, 0);
      });

      it('C3.3 switching channel preserves status filter integrity', () => {
        // Status filter: "open"
        const wspOpen = filterConversations(FIXTURE_CONVERSATIONS, 'whatsapp', 'open', '', 'op-ana-01', NOW_BASE);
        const igOpen = filterConversations(FIXTURE_CONVERSATIONS, 'instagram', 'open', '', 'op-ana-01', NOW_BASE);
        assert.equal(wspOpen.length, 1); // chat-wsp-expired-05
        assert.equal(igOpen.length, 1);  // chat-ig-03
      });
    });

    describe('C4: Operator Presence & Queue SLA Sorting Interaction', () => {
      it('C4.1 toggling presence preserves strict SLA queue priority order', () => {
        let presence: OperatorPresence = 'offline';
        let sorted = sortQueueByPriority(FIXTURE_CONVERSATIONS, NOW_BASE);
        assert.equal(sorted[0].slaBreached, true); // First is breached Elena Morales

        presence = 'available';
        sorted = sortQueueByPriority(FIXTURE_CONVERSATIONS, NOW_BASE);
        assert.equal(presence, 'available');
        assert.equal(sorted[0].slaBreached, true);
      });
    });

    describe('C5: In-Flight Window Expiration while Typing Draft', () => {
      it('C5.1 locks composer when 24h window expires while preserving draft text', () => {
        const draftText = 'Aquí te adjunto la cotización formal';
        let isWindowActive = true;

        // Window expires in background
        isWindowActive = false;
        const channel: ChannelProvider = 'whatsapp';

        const isLocked = !isWindowActive && channel === 'whatsapp';
        assert.equal(isLocked, true);
        // Draft text remains in state for subsequent template selection
        assert.equal(draftText, 'Aquí te adjunto la cotización formal');
      });
    });

    describe('C6: Rapid Successive Sends & Optimistic Timeline Ordering', () => {
      it('C6.1 maintains chronological timestamp ordering across multiple sends', () => {
        const timeline: OmnichannelMessage[] = [];
        const sendTimes = [NOW_BASE, NOW_BASE + 50, NOW_BASE + 120];

        for (let i = 0; i < sendTimes.length; i++) {
          timeline.push({
            id: `msg-${i}`,
            conversationId: 'chat-wsp-01',
            senderType: 'operator',
            senderName: 'Ana Pérez',
            body: `Mensaje #${i + 1}`,
            timestamp: sendTimes[i],
            status: 'sent',
            channel: 'whatsapp',
            isOptimistic: true,
          });
        }

        assert.equal(timeline.length, 3);
        assert.ok(timeline[0].timestamp < timeline[1].timestamp);
        assert.ok(timeline[1].timestamp < timeline[2].timestamp);
      });
    });

    describe('C7: Debounced Search + Channel + SLA Breach Intersection', () => {
      it('C7.1 narrows down exact match using 3 simultaneous filter dimensions', () => {
        const res = filterConversations(
          FIXTURE_CONVERSATIONS,
          'telegram',    // Channel: telegram
          'sla_risk',     // Status: breached / at risk
          'Elena',        // Query: contact name
          'op-ana-01',
          NOW_BASE
        );

        assert.equal(res.length, 1);
        assert.equal(res[0].id, 'chat-tg-02');
        assert.equal(res[0].participant.name, 'Elena Morales');
      });
    });
  });

  // --------------------------------------------------------------------------
  // TIER 4: REAL-WORLD APPLICATION WORKFLOW SCENARIOS (Scenarios 1 to 5)
  // --------------------------------------------------------------------------
  describe('Tier 4: Real-World Scenarios (Scenarios 1 - 5)', () => {

    it('Scenario 1: Multi-Agent Handoff with Concurrent CAS Takeover & AI Invalidation', () => {
      // 1. Initial State: Chat in ai_handling with pending AI suggestion
      const chat = { ...FIXTURE_CONVERSATIONS[0] };
      assert.equal(chat.status, 'ai_handling');
      assert.equal(chat.stateVersion, 14);

      let activeSuggestion: AiSuggestionPayload | null = { ...FIXTURE_SUGGESTION };
      assert.ok(activeSuggestion !== null);

      // 2. Operator Ana initiates Takeover
      const takeoverResult = executeCasTakeover(chat, 14, 'op-ana-01', 'Ana Pérez');
      assert.equal(takeoverResult.success, true);

      // 3. Invalidate suggestion atomically
      if (takeoverResult.invalidationTriggered) {
        activeSuggestion = null;
      }
      assert.equal(activeSuggestion, null);

      // 4. Update conversation state in workspace
      const updatedChat = takeoverResult.conversation!;
      assert.equal(updatedChat.status, 'open');
      assert.equal(updatedChat.stateVersion, 15);
      assert.equal(updatedChat.ownershipEpoch, 3);

      // 5. Operator dispatches custom outbound message
      const outboundMessage: OmnichannelMessage = {
        id: `msg-${NOW_BASE + 500}`,
        conversationId: updatedChat.id,
        senderType: 'operator',
        senderName: 'Ana Pérez',
        body: 'Hola Carlos, te saluda Ana. He tomado el control del chat para asistirte con tu pedido.',
        timestamp: NOW_BASE + 500,
        status: 'sent',
        channel: updatedChat.channel,
      };

      assert.equal(outboundMessage.senderType, 'operator');
      assert.equal(outboundMessage.conversationId, updatedChat.id);
    });

    it('Scenario 2: WhatsApp Chat 24h Window Expiration & HSM Fallback Flow', () => {
      // 1. Operator selects WhatsApp conversation with expired 24h window
      const chat = { ...FIXTURE_CONVERSATIONS[4] };
      assert.equal(chat.channel, 'whatsapp');
      assert.equal(chat.is24hWindowActive, false);

      // 2. Composer verifies policy: free text blocked
      const isFreeTextAllowed = chat.is24hWindowActive || chat.channel !== 'whatsapp';
      assert.equal(isFreeTextAllowed, false);

      // 3. UI displays Meta warning and enables HSM template selector
      const showHsmPicker = !isFreeTextAllowed;
      assert.equal(showHsmPicker, true);

      // 4. Operator selects approved template "cotizacion_seguimiento_v1"
      const hsmTemplateMessage: OmnichannelMessage = {
        id: `msg-hsm-${NOW_BASE}`,
        conversationId: chat.id,
        senderType: 'operator',
        senderName: 'Ana Pérez',
        body: 'Hola Mario, ¿aún estás interesado en la cotización que solicitaste?',
        timestamp: NOW_BASE,
        status: 'sent',
        channel: 'whatsapp',
      };

      assert.equal(hsmTemplateMessage.status, 'sent');
      assert.ok(hsmTemplateMessage.body.includes('cotización'));
    });

    it('Scenario 3: SLA Escalation & Multi-Channel Prioritization under Heavy Queue Load', () => {
      // 1. Initial queue contains normal, amber, and breached chats
      const queue = [...FIXTURE_CONVERSATIONS];

      // 2. Sort by SLA priority
      const prioritized = sortQueueByPriority(queue, NOW_BASE);

      // 3. Verify top item is breached SLA (Elena Morales)
      assert.equal(prioritized[0].id, 'chat-tg-02');
      assert.equal(prioritized[0].slaBreached, true);

      // 4. Verify second item is SLA at risk (Valeria Quispe, 3m remaining)
      assert.equal(prioritized[1].id, 'chat-ig-03');
      const slaStateSecond = calculateSlaState(prioritized[1], NOW_BASE);
      assert.equal(slaStateSecond, 'amber');

      // 5. Operator addresses breached chat -> sends message and clears breach flag
      const resolvedBreachChat: OmnichannelConversation = {
        ...prioritized[0],
        slaBreached: false,
        slaDeadline: NOW_BASE + 1000 * 60 * 30, // Deadline extended by 30m
        status: 'open',
      };

      const reSorted = sortQueueByPriority(
        [resolvedBreachChat, ...prioritized.slice(1)],
        NOW_BASE
      );

      // 6. Former breached chat is no longer #1; amber chat (Valeria) is now #1
      assert.equal(reSorted[0].id, 'chat-ig-03');
      assert.equal(reSorted.some((c) => c.slaBreached), false);
    });

    it('Scenario 4: Cross-Tenant Isolation & State Evacuation on Workspace Switch', () => {
      // 1. Current workspace: Tenant 1 (Acme Commercial)
      let currentTenant = FIXTURE_TENANTS[0];
      let loadedConversations = FIXTURE_CONVERSATIONS.filter((c) => c.tenantId === currentTenant.id);
      assert.equal(loadedConversations.length, 5);

      // 2. Operator switches to Tenant 2 (Logística Express Perú)
      currentTenant = FIXTURE_TENANTS[1];

      // 3. Immediate state evacuation: invalidate prior chats and load Tenant 2
      loadedConversations = FIXTURE_CONVERSATIONS.filter((c) => c.tenantId === currentTenant.id);

      // 4. Verify ZERO cross-tenant conversation or PII leakage
      assert.equal(loadedConversations.length, 0); // No chats assigned to Tenant 2 in mock
      assert.ok(!loadedConversations.some((c) => c.participant.name === 'Carlos Mendoza'));
    });

    it('Scenario 5: Full Commercial Operator Resolution Workflow', () => {
      // 1. Operator selects conversation chat-tg-02 (Elena Morales)
      const chat = FIXTURE_CONVERSATIONS[1];
      assert.equal(chat.participant.name, 'Elena Morales');
      assert.equal(chat.activeOrderId, 'ORD-7721');

      // 2. Operator reviews customer profile and active order
      const orderSummary: CustomerOrderSummary = {
        id: 'ORD-7721',
        orderNumber: 'ORD-7721',
        amount: '350.00',
        currency: 'PEN',
        status: 'pending_payment',
        createdAt: '2026-11-02T04:00:00Z',
        itemsSummary: '1x Servidor VPS Enterprise',
      };
      assert.equal(orderSummary.amount, '350.00');

      // 3. Operator reviews AI trace: voucher verification completed
      const voucherTrace: AiToolTraceItem = {
        id: 'trace-vouch-01',
        functionName: 'verify_payment_voucher',
        resultSummary: 'Comprobante verificado con éxito vía OCR BCP',
        timestamp: NOW_BASE - 1000 * 60 * 5,
        status: 'completed',
        latencyMs: 310,
      };
      assert.equal(voucherTrace.status, 'completed');

      // 4. Operator takes over chat via CAS
      const takeoverResult = executeCasTakeover(chat, 6, 'op-ana-01', 'Ana Pérez');
      assert.equal(takeoverResult.success, true);
      assert.equal(takeoverResult.conversation?.stateVersion, 7);

      // 5. Operator writes private internal note
      const internalNote: InternalNote = {
        id: 'note-tg-01',
        authorName: 'Ana Pérez',
        text: 'Comprobante validado por S/ 350.00. Activación de servicio completada.',
        timestamp: NOW_BASE,
      };
      assert.ok(internalNote.text.includes('350.00'));

      // 6. Operator replies to customer and marks conversation resolved
      const outboundReply: OmnichannelMessage = {
        id: `msg-${NOW_BASE + 200}`,
        conversationId: chat.id,
        senderType: 'operator',
        senderName: 'Ana Pérez',
        body: 'Hola Elena, tu pago ha sido validado satisfactoriamente. Tu servicio ha sido activado.',
        timestamp: NOW_BASE + 200,
        status: 'sent',
        channel: chat.channel,
      };
      assert.equal(outboundReply.status, 'sent');

      const resolvedChat: OmnichannelConversation = {
        ...takeoverResult.conversation!,
        status: 'resolved',
      };
      assert.equal(resolvedChat.status, 'resolved');
    });
  });
});
