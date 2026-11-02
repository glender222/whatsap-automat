/**
 * Whatsap-Automat v0.4 — Omnichannel Inbox Mock Data Fixtures
 * Phase F3: PR-F3-04 (WCAG 2.2 AA & CAS Concurrency)
 */

import type {
  OmnichannelConversation,
  OmnichannelMessage,
  AiSuggestionPayload,
  AiToolTraceItem,
  CustomerOrderSummary,
  InternalNote,
  FunctionalPlaneItem,
} from './types';

export const MOCK_FUNCTIONAL_PLANES: FunctionalPlaneItem[] = [
  { id: 'plane-ops', label: 'Operaciones', plane: 'operations', badge: 4 },
  { id: 'plane-auto', label: 'Automatización', plane: 'automation', badge: 0 },
  { id: 'plane-plat', label: 'Plataforma', plane: 'platform', badge: 0 },
  { id: 'plane-admin', label: 'Administración', plane: 'admin', badge: 0 },
];

export const MOCK_CONVERSATIONS: OmnichannelConversation[] = [
  {
    id: 'conv-wsp-01',
    tenantId: 'tenant-acme',
    channel: 'whatsapp',
    participant: {
      id: 'part-01',
      name: 'Carlos Mendoza',
      phoneNumber: '+51 987 654 321',
      channel: 'whatsapp',
    },
    lastMessagePreview: 'Buenas tardes, ¿tienen disponibilidad del modelo X en stock?',
    lastMessageTimestamp: Date.now() - 3 * 60 * 1000,
    unreadCount: 1,
    status: 'ai_handling',
    slaDeadline: Date.now() + 18 * 60 * 1000, // Nominal (>5 min remaining)
    slaBreached: false,
    stateVersion: 1,
    ownershipEpoch: 1,
    tags: [
      { id: 'tag-1', name: 'Ventas', color: '#0D9488' },
      { id: 'tag-2', name: 'VIP', color: '#8B5CF6' },
    ],
    is24hWindowActive: true,
    activeOrderId: 'ord-8831',
  },
  {
    id: 'conv-wsp-02',
    tenantId: 'tenant-acme',
    channel: 'whatsapp',
    participant: {
      id: 'part-02',
      name: 'Elena Ramos',
      phoneNumber: '+51 912 345 678',
      channel: 'whatsapp',
    },
    lastMessagePreview: 'Gracias, quedo atenta a la confirmación de la entrega.',
    lastMessageTimestamp: Date.now() - 28 * 60 * 60 * 1000, // 28 hours ago
    unreadCount: 0,
    status: 'open',
    assignedOperatorId: 'op-01',
    assignedOperatorName: 'Ana Pérez (Tú)',
    slaDeadline: Date.now() - 15 * 60 * 1000, // Breached
    slaBreached: true,
    stateVersion: 3,
    ownershipEpoch: 2,
    tags: [{ id: 'tag-3', name: 'Soporte', color: '#F59E0B' }],
    is24hWindowActive: false, // 24h Meta window closed
    activeOrderId: 'ord-7720',
  },
  {
    id: 'conv-tg-01',
    tenantId: 'tenant-acme',
    channel: 'telegram',
    participant: {
      id: 'part-03',
      name: 'Alex Voronkov',
      username: '@alex_v',
      channel: 'telegram',
    },
    lastMessagePreview: 'Hola, tengo una consulta sobre la integración de webhooks.',
    lastMessageTimestamp: Date.now() - 4 * 60 * 1000,
    unreadCount: 2,
    status: 'pending_handoff',
    slaDeadline: Date.now() + 3 * 60 * 1000 + 45 * 1000, // Warning (<5 min remaining)
    slaBreached: false,
    stateVersion: 2,
    ownershipEpoch: 1,
    tags: [{ id: 'tag-4', name: 'Integración API', color: '#0284C7' }],
    is24hWindowActive: true, // Non-WhatsApp channel is always active
  },
  {
    id: 'conv-ig-01',
    tenantId: 'tenant-acme',
    channel: 'instagram',
    participant: {
      id: 'part-04',
      name: 'Lucía Morales',
      username: '@lucia_style',
      channel: 'instagram',
    },
    lastMessagePreview: '¡Me encanta el producto! ¿Hacen envíos a provincia?',
    lastMessageTimestamp: Date.now() - 12 * 60 * 1000,
    unreadCount: 0,
    status: 'open',
    assignedOperatorId: 'op-01',
    assignedOperatorName: 'Ana Pérez (Tú)',
    slaDeadline: Date.now() + 42 * 60 * 1000,
    slaBreached: false,
    stateVersion: 1,
    ownershipEpoch: 1,
    tags: [{ id: 'tag-1', name: 'Ventas', color: '#0D9488' }],
    is24hWindowActive: true,
  },
  {
    id: 'conv-web-01',
    tenantId: 'tenant-acme',
    channel: 'webchat',
    participant: {
      id: 'part-05',
      name: 'Visitante Web #4402',
      channel: 'webchat',
    },
    lastMessagePreview: '¿Tienen demo en vivo disponible hoy?',
    lastMessageTimestamp: Date.now() - 1 * 60 * 1000,
    unreadCount: 1,
    status: 'ai_handling',
    slaDeadline: Date.now() + 9 * 60 * 1000,
    slaBreached: false,
    stateVersion: 1,
    ownershipEpoch: 1,
    tags: [{ id: 'tag-5', name: 'Lead Calificado', color: '#10B981' }],
    is24hWindowActive: true,
  },
];

export const MOCK_MESSAGES: Record<string, OmnichannelMessage[]> = {
  'conv-wsp-01': [
    {
      id: 'msg-01-1',
      conversationId: 'conv-wsp-01',
      senderType: 'customer',
      senderName: 'Carlos Mendoza',
      body: 'Buenas tardes, ¿tienen disponibilidad del modelo X en stock?',
      timestamp: Date.now() - 3 * 60 * 1000,
      status: 'read',
      channel: 'whatsapp',
    },
  ],
  'conv-wsp-02': [
    {
      id: 'msg-02-1',
      conversationId: 'conv-wsp-02',
      senderType: 'customer',
      senderName: 'Elena Ramos',
      body: 'Hola, quería consultar sobre mi pedido #ORD-7720.',
      timestamp: Date.now() - 29 * 60 * 60 * 1000,
      status: 'read',
      channel: 'whatsapp',
    },
    {
      id: 'msg-02-2',
      conversationId: 'conv-wsp-02',
      senderType: 'operator',
      senderName: 'Ana Pérez',
      body: 'Hola Elena, tu pedido ya fue despachado con la guía #PE-9901.',
      timestamp: Date.now() - 28 * 60 * 60 * 1000 - 30 * 60 * 1000,
      status: 'read',
      channel: 'whatsapp',
    },
    {
      id: 'msg-02-3',
      conversationId: 'conv-wsp-02',
      senderType: 'customer',
      senderName: 'Elena Ramos',
      body: 'Gracias, quedo atenta a la confirmación de la entrega.',
      timestamp: Date.now() - 28 * 60 * 60 * 1000,
      status: 'read',
      channel: 'whatsapp',
    },
  ],
  'conv-tg-01': [
    {
      id: 'msg-03-1',
      conversationId: 'conv-tg-01',
      senderType: 'customer',
      senderName: 'Alex Voronkov',
      body: 'Hola, tengo una consulta sobre la integración de webhooks.',
      timestamp: Date.now() - 4 * 60 * 1000,
      status: 'read',
      channel: 'telegram',
    },
  ],
  'conv-ig-01': [
    {
      id: 'msg-04-1',
      conversationId: 'conv-ig-01',
      senderType: 'customer',
      senderName: 'Lucía Morales',
      body: '¡Me encanta el producto! ¿Hacen envíos a provincia?',
      timestamp: Date.now() - 12 * 60 * 1000,
      status: 'read',
      channel: 'instagram',
    },
    {
      id: 'msg-04-2',
      conversationId: 'conv-ig-01',
      senderType: 'operator',
      senderName: 'Ana Pérez',
      body: '¡Hola Lucía! Sí, realizamos envíos a todo el país a través de Olva Courier y Shalom.',
      timestamp: Date.now() - 10 * 60 * 1000,
      status: 'read',
      channel: 'instagram',
    },
  ],
  'conv-web-01': [
    {
      id: 'msg-05-1',
      conversationId: 'conv-web-01',
      senderType: 'customer',
      senderName: 'Visitante Web #4402',
      body: '¿Tienen demo en vivo disponible hoy?',
      timestamp: Date.now() - 1 * 60 * 1000,
      status: 'read',
      channel: 'webchat',
    },
  ],
};

export const MOCK_AI_SUGGESTIONS: Record<string, AiSuggestionPayload> = {
  'conv-wsp-01': {
    suggestionId: 'sug-101',
    conversationId: 'conv-wsp-01',
    replyText:
      '¡Hola Carlos! Sí, disponemos de 15 unidades del modelo X listas para despacho inmediato en Lima. ¿Deseas que reservemos tu pedido?',
    confidenceScore: 0.94,
    suggestedAction: 'Consultó inventario (15 unidades en stock)',
    reasoningNotes:
      'El cliente preguntó por disponibilidad del modelo X. Stock verificado mediante get_product_stock().',
    knowledgeSourcesUsed: [
      { id: 'k-1', title: 'Catálogo de Productos 2026', type: 'catalog' },
      { id: 'k-2', title: 'Políticas de Despacho Lima Metropolitana', type: 'policy' },
    ],
    expiresAt: Date.now() + 10 * 60 * 1000,
  },
  'conv-web-01': {
    suggestionId: 'sug-102',
    conversationId: 'conv-web-01',
    replyText:
      '¡Hola! Claro que sí, disponemos de sesiones guiadas en vivo hoy a las 3:00 PM y 5:00 PM. ¿Te gustaría agendar una?',
    confidenceScore: 0.88,
    suggestedAction: 'Ofrecer enlace de agendamiento Calendly',
    reasoningNotes: 'Consulta sobre demo en vivo. Se ofrecen horarios disponibles de asesores.',
    knowledgeSourcesUsed: [
      { id: 'k-3', title: 'Horarios de Asesores Comerciales', type: 'schedule' },
    ],
    expiresAt: Date.now() + 8 * 60 * 1000,
  },
};

export const MOCK_AGENT_TRACES: Record<string, AiToolTraceItem[]> = {
  'conv-wsp-01': [
    {
      id: 'trace-01',
      functionName: 'get_product_stock(sku: "MOD-X")',
      resultSummary: 'Stock: 15 unidades disponibles en almacén principal',
      timestamp: Date.now() - 2 * 60 * 1000,
      status: 'completed',
      latencyMs: 142,
      parametersJson: '{"sku": "MOD-X", "warehouse": "LIM-01"}',
      outputSummary: '{"available": 15, "reserved": 2}',
      executionMs: 142,
    },
    {
      id: 'trace-02',
      functionName: 'check_shipping_sla(dest: "Lima")',
      resultSummary: 'Entrega estándar en 24 horas hábiles',
      timestamp: Date.now() - 2 * 60 * 1000 + 200,
      status: 'completed',
      latencyMs: 89,
      executionMs: 89,
    },
  ],
};

export const MOCK_CUSTOMER_ORDERS: Record<string, CustomerOrderSummary> = {
  'conv-wsp-01': {
    id: 'ord-8831',
    orderNumber: '#ORD-8831',
    amount: '180.00',
    currency: 'USD',
    status: 'pending_payment',
    createdAt: '2026-11-02 10:15',
    itemsSummary: '1x Modelo X Pro (Color Titanio)',
    title: 'Pedido Comercial',
    total: '$180.00 USD',
  },
  'conv-wsp-02': {
    id: 'ord-7720',
    orderNumber: '#ORD-7720',
    amount: '340.50',
    currency: 'USD',
    status: 'dispatched',
    createdAt: '2026-10-31 16:40',
    itemsSummary: '2x Modelo Alpha, 1x Kit de Cables USB-C',
    title: 'Pedido Despachado',
    total: '$340.50 USD',
  },
};

export const MOCK_INTERNAL_NOTES: Record<string, InternalNote[]> = {
  'conv-wsp-01': [
    {
      id: 'note-01',
      authorName: 'Ana Pérez',
      text: 'Cliente interesado en compra por volumen si la entrega es antes del viernes.',
      timestamp: Date.now() - 20 * 60 * 1000,
    },
  ],
  'conv-wsp-02': [
    {
      id: 'note-02',
      authorName: 'Mario Ruiz',
      text: 'Se confirmó número de rastreo con Olva Courier.',
      timestamp: Date.now() - 24 * 60 * 60 * 1000,
    },
  ],
};
