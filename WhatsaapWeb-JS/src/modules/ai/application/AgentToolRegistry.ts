import type { ToolDefinition, ToolName } from '../domain/tool.types';

const V1_TOOLS: ToolDefinition[] = [
  {
    name: 'catalog.search',
    kind: 'read',
    description: 'Busca productos activos habilitados para IA dentro del scope del agente.',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string' },
        type: {
          type: 'string',
          enum: ['physical_product', 'digital_product', 'service', 'course', 'subscription', 'custom'],
        },
        catalogId: { type: 'integer' },
        sectionId: { type: 'integer' },
        limit: { type: 'integer', minimum: 1, maximum: 20 },
      },
    },
    requiresModule: 'catalog',
    requiresToolFlag: 'catalogSearch',
  },
  {
    name: 'catalog.getItem',
    kind: 'read',
    description: 'Obtiene un item comercial por ID dentro del scope del agente.',
    inputSchema: {
      type: 'object',
      properties: { commercialItemId: { type: 'integer' } },
      required: ['commercialItemId'],
    },
    requiresModule: 'catalog',
    requiresToolFlag: 'catalogGetItem',
  },
  {
    name: 'catalog.recommendAlternatives',
    kind: 'read',
    description: 'Recomienda alternativas dentro del scope para un item dado.',
    inputSchema: {
      type: 'object',
      properties: {
        commercialItemId: { type: 'integer' },
        reason: {
          type: 'string',
          enum: ['out_of_stock', 'ambiguous', 'cheaper', 'similar'],
        },
        limit: { type: 'integer', minimum: 1, maximum: 3 },
      },
      required: ['commercialItemId'],
    },
    requiresModule: 'catalog',
    requiresToolFlag: 'catalogRecommendAlternatives',
  },
  {
    name: 'availability.check',
    kind: 'read',
    description: 'Verifica disponibilidad sin reservar ni descontar stock.',
    inputSchema: {
      type: 'object',
      properties: {
        commercialItemId: { type: 'integer' },
        quantity: { type: 'integer', minimum: 1 },
      },
      required: ['commercialItemId'],
    },
    requiresModule: 'catalog',
    requiresToolFlag: 'availabilityCheck',
  },
  {
    name: 'message.sendProductCard',
    kind: 'send',
    description: 'System-only. El orquestador puede enviar ficha de producto como parte de la entrega final.',
    inputSchema: {
      type: 'object',
      properties: {
        commercialItemId: { type: 'integer' },
        caption: { type: 'string' },
      },
      required: ['commercialItemId'],
    },
    requiresModule: 'catalog',
    requiresToolFlag: 'messageSendProductCard',
    systemOnly: true,
  },
  {
    name: 'order.upsertPreorder',
    kind: 'write',
    description: 'Crea o actualiza prepedido. Solo estados draft/quoted/pending_handoff.',
    inputSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              commercialItemId: { type: 'integer' },
              quantity: { type: 'integer', minimum: 1 },
            },
            required: ['commercialItemId', 'quantity'],
          },
        },
        status: { type: 'string', enum: ['draft', 'quoted', 'pending_handoff'] },
        notes: { type: 'string' },
      },
      required: ['items'],
    },
    requiresModule: 'orders',
    requiresToolFlag: 'orderUpsertPreorder',
  },
  {
    name: 'handoff.create',
    kind: 'write',
    description: 'Crea ticket handoff, aplica tag, cambia estado commercial, pausa IA, emite socket.',
    inputSchema: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          enum: [
            'payment_closure',
            'customer_asks_human',
            'product_not_found',
            'low_confidence',
            'stock_capacity',
            'policy_restriction',
            'support',
            'other',
          ],
        },
        priority: { type: 'string', enum: ['low', 'medium', 'high'] },
        orderId: { type: 'integer' },
        messageToCustomer: { type: 'string' },
      },
      required: ['reason'],
    },
    requiresModule: 'handoff',
    requiresToolFlag: 'handoffCreate',
  },
  {
    name: 'conversation.setCommercialState',
    kind: 'write',
    description: 'Cambia estado comercial de la conversacion. No permite estados de cierre humano.',
    inputSchema: {
      type: 'object',
      properties: {
        stage: {
          type: 'string',
          enum: ['new', 'ai_assisting', 'catalog', 'preorder', 'handoff', 'payment', 'closed'],
        },
        substatus: { type: 'string' },
        metadata: { type: 'object' },
      },
      required: ['stage'],
    },
    requiresModule: 'commercialState',
    requiresToolFlag: 'conversationSetCommercialState',
  },
  {
    name: 'tag.applySystem',
    kind: 'write',
    description: 'Aplica etiqueta de sistema predefinida. No permite etiquetas libres ni borrar.',
    inputSchema: {
      type: 'object',
      properties: {
        tag: {
          type: 'string',
          enum: ['handoff-pendiente', 'ia-asistiendo', 'prepedido-abierto', 'pago-pendiente'],
        },
      },
      required: ['tag'],
    },
    requiresModule: 'tags',
    requiresToolFlag: 'tagApplySystem',
  },
  {
    name: 'timeline.record',
    kind: 'system',
    description: 'System-only. El modelo no llama esta tool. Backend registra eventos automaticamente.',
    inputSchema: { type: 'object', properties: {} },
    systemOnly: true,
    requiresToolFlag: 'timelineRecord',
  },
];

const PAYMENT_FUTURE_TOOLS: ToolDefinition[] = [
  {
    name: 'payment.createLink',
    kind: 'payment_future',
    description: 'Futura. Crea link de pago. Desactivada en v1.',
    inputSchema: { type: 'object', properties: {} },
    disabled: true,
  },
  {
    name: 'payment.validateVoucher',
    kind: 'payment_future',
    description: 'Futura. Valida comprobante de pago. Desactivada en v1.',
    inputSchema: { type: 'object', properties: {} },
    disabled: true,
  },
  {
    name: 'payment.getStatus',
    kind: 'payment_future',
    description: 'Futura. Obtiene estado de pago. Desactivada en v1.',
    inputSchema: { type: 'object', properties: {} },
    disabled: true,
  },
];

const ALL_TOOLS: ToolDefinition[] = [...V1_TOOLS, ...PAYMENT_FUTURE_TOOLS];

export class AgentToolRegistry {
  private readonly byName: Map<ToolName, ToolDefinition>;

  constructor(tools: ToolDefinition[] = ALL_TOOLS) {
    this.byName = new Map(tools.map((t) => [t.name, t]));
  }

  get(name: string): ToolDefinition | undefined {
    return this.byName.get(name as ToolName);
  }

  has(name: string): boolean {
    return this.byName.has(name as ToolName);
  }

  list(): ToolDefinition[] {
    return Array.from(this.byName.values());
  }

  listCallable(): ToolDefinition[] {
    return this.list().filter((t) => !t.disabled && !t.systemOnly);
  }

  listDisabled(): ToolDefinition[] {
    return this.list().filter((t) => t.disabled);
  }

  isDisabled(name: string): boolean {
    return Boolean(this.byName.get(name as ToolName)?.disabled);
  }

  isSystemOnly(name: string): boolean {
    return Boolean(this.byName.get(name as ToolName)?.systemOnly);
  }

  isPaymentFuture(name: string): boolean {
    return this.byName.get(name as ToolName)?.kind === 'payment_future';
  }

  schemasForPrompt(): Array<{ name: ToolName; description: string; input: Record<string, unknown> }> {
    return this.listCallable().map((t) => ({
      name: t.name,
      description: t.description,
      input: t.inputSchema,
    }));
  }
}

let defaultRegistry: AgentToolRegistry | null = null;

export function getDefaultToolRegistry(): AgentToolRegistry {
  if (!defaultRegistry) defaultRegistry = new AgentToolRegistry();
  return defaultRegistry;
}
