import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AiAgent, AgentPurpose } from '../modules/ai/domain/agent.types';

process.env.JWT_SECRET ||= 'test-jwt-secret-with-at-least-32-characters';
process.env.DB_PASSWORD ||= 'test-password';

function makeAgent(id: number, purpose: AgentPurpose, overrides: Partial<AiAgent> = {}): AiAgent {
  return {
    id,
    companyId: 1,
    name: `${purpose}-${id}`,
    status: 'active',
    mode: 'auto',
    provider: 'openai',
    model: 'gpt-test',
    purpose,
    moduleAccess: {},
    triggerRules: { commercialIntent: false, handoffForPayment: false },
    catalogScope: { catalogIds: [], sectionIds: [] },
    toolAccess: {},
    autoConfirmOrders: false,
    autoCreateVouchers: false,
    autoGeneratePaymentLinks: false,
    isDefault: false,
    createdBy: null,
    ...overrides,
  };
}

test('router distingue intents demo usando los propositos existentes', async (t) => {
  const { AgentRouterService } = await import('../modules/ai/application/AgentRouterService');
  const routerAgent = makeAgent(1, 'router', { mode: 'suggest' });
  const support = makeAgent(2, 'support');
  const sales = makeAgent(3, 'sales_assistant', {
    moduleAccess: { catalog: true, orders: true },
    catalogScope: { catalogIds: [10], sectionIds: [] },
  });
  const operations = makeAgent(4, 'operations', {
    moduleAccess: { catalog: true, orders: true },
    catalogScope: { catalogIds: [10], sectionIds: [] },
  });
  const orderTracking = makeAgent(5, 'order_tracking', { moduleAccess: { orders: true } });
  const agents = [support, sales, operations, orderTracking];

  const cases = [
    { route: 'customer_service', targetAgentId: support.id, expectedAgentId: support.id },
    { route: 'sales_assistant', targetAgentId: sales.id, expectedAgentId: sales.id },
    { route: 'inventory_stock', targetAgentId: operations.id, expectedAgentId: operations.id },
    { route: 'order_tracking', targetAgentId: orderTracking.id, expectedAgentId: orderTracking.id },
    { route: 'preorder', targetAgentId: sales.id, expectedAgentId: sales.id },
    { route: 'handoff', targetAgentId: null, expectedAgentId: null },
  ] as const;

  for (const scenario of cases) {
    await t.test(scenario.route, async () => {
      const logs: Array<Record<string, unknown>> = [];
      const pool = {
        query: async (sql: string) => ({ rows: sql.includes("purpose = 'router'") ? [{ id: routerAgent.id }] : [] }),
      };
      const agentRepo = {
        list: async () => agents,
        get: async (_companyId: number, agentId: number) => {
          const agent = agentId === routerAgent.id ? routerAgent : agents.find((candidate) => candidate.id === agentId);
          if (!agent) throw new Error('not_found');
          return agent;
        },
      };
      const providerFactory = {
        create: () => ({
          complete: async () => JSON.stringify({
            route: scenario.route,
            targetAgentId: scenario.targetAgentId,
            confidence: 0.96,
            reason: 'classified',
            handoffReason: scenario.route === 'handoff' ? 'customer_asks_human' : null,
          }),
        }),
      };
      const router = new AgentRouterService(
        pool as never,
        agentRepo as never,
        { log: async (entry: Record<string, unknown>) => { logs.push(entry); } } as never,
        providerFactory as never
      );
      const outcome = await router.route({
        companyId: 1,
        chatId: '51999999999',
        message: 'mensaje de prueba',
        history: [],
        companyMode: 'automator',
        conversationId: null,
        inboundProviderMessageId: 'wamid.test',
      });

      assert.equal(outcome.route, scenario.route);
      assert.equal(outcome.targetAgent?.id ?? null, scenario.expectedAgentId);
      const decision = logs.find((entry) => entry.stage === 'router_decision');
      assert.ok(decision);
      assert.equal(decision.provider, 'openai');
      const serializedPayload = JSON.stringify(decision.payload);
      assert.equal(serializedPayload.includes('classified'), false);
      assert.equal(serializedPayload.includes('mensaje de prueba'), false);
    });
  }
});

test('router intenta otro agente compatible si el sugerido no tiene scope de catalogo', async () => {
  const { AgentRouterService } = await import('../modules/ai/application/AgentRouterService');
  const routerAgent = makeAgent(1, 'router', { mode: 'suggest' });
  const withoutScope = makeAgent(2, 'sales_assistant', {
    moduleAccess: { catalog: true },
    catalogScope: { catalogIds: [], sectionIds: [] },
  });
  const withScope = makeAgent(3, 'sales_assistant', {
    moduleAccess: { catalog: true },
    catalogScope: { catalogIds: [10], sectionIds: [] },
  });
  const agents = [withoutScope, withScope];
  const router = new AgentRouterService(
    { query: async () => ({ rows: [{ id: routerAgent.id }] }) } as never,
    {
      list: async () => agents,
      get: async (_companyId: number, agentId: number) => {
        const agent = agentId === routerAgent.id
          ? routerAgent
          : agents.find((candidate) => candidate.id === agentId);
        if (!agent) throw new Error('not_found');
        return agent;
      },
    } as never,
    { log: async () => undefined } as never,
    {
      create: () => ({
        complete: async () => JSON.stringify({
          route: 'sales_assistant',
          targetAgentId: withoutScope.id,
          confidence: 0.95,
          reason: 'sales_intent',
        }),
      }),
    } as never
  );

  const outcome = await router.route({
    companyId: 1,
    chatId: '51999999999',
    message: 'Quiero comprar una unidad',
    history: [],
    companyMode: 'automator',
    conversationId: 10,
    inboundProviderMessageId: 'wamid.catalog-fallback',
  });

  assert.equal(outcome.route, 'sales_assistant');
  assert.equal(outcome.targetAgent?.id, withScope.id);
  assert.equal(outcome.handoffTicketId, null);
});

test('orchestrator ejecuta el loop con el agente seleccionado por el router', async () => {
  const { AiRuntimeOrchestrator } = await import('../modules/ai/application/AiRuntimeOrchestrator');
  const { AgentToolRegistry } = await import('../modules/ai/application/AgentToolRegistry');
  const { getAiProviderFactory } = await import('../modules/ai/infra/provider/AiProviderFactory');
  const selectedAgent = makeAgent(20, 'operations', {
    provider: 'openai',
    moduleAccess: { catalog: true },
    catalogScope: { catalogIds: [10], sectionIds: [] },
  });
  const stages: Array<{ stage: string; options: Record<string, unknown> }> = [];
  const factory = getAiProviderFactory() as unknown as { create: (provider: string) => unknown };
  const originalCreate = factory.create;
  factory.create = () => ({
    complete: async () => JSON.stringify({
      type: 'final',
      reply: 'Hay stock disponible.',
      action: 'auto_reply',
      confidence: 1,
      reason: 'inventory_checked',
    }),
  });

  try {
    const orchestrator = new AiRuntimeOrchestrator(
      { query: async () => ({ rows: [] }) } as never,
      { getAutomatorMode: async () => 'automator' } as never,
      {
        route: async () => ({
          route: 'inventory_stock',
          targetAgent: selectedAgent,
          confidence: 0.97,
          reason: 'stock_intent',
          handoffReason: null,
          handoffTicketId: null,
          routerMissing: false,
        }),
      } as never,
      new AgentToolRegistry(),
      {
        logStage: async (_ctx: unknown, stage: string, options: Record<string, unknown>) => {
          stages.push({ stage, options });
        },
      } as never,
      {} as never
    );
    const result = await orchestrator.processInbound({
      companyId: 1,
      chatId: '51999999999',
      message: 'Tienen stock?',
      history: [],
      inboundProviderMessageId: 'wamid.stock',
      sender: { sendProductCard: async () => ({ providerMessageId: null }) },
    });

    assert.equal(result.route, 'inventory_stock');
    assert.equal(result.agentId, selectedAgent.id);
    assert.equal(result.action, 'auto_reply');
    assert.equal(result.reply, 'Hay stock disponible.');
    const routeTrace = stages.find((entry) => entry.stage === 'multiagent_route_selected');
    assert.ok(routeTrace);
    assert.deepEqual(routeTrace.options.payload, {
      route: 'inventory_stock',
      targetAgentId: selectedAgent.id,
      routerConfidence: 0.97,
      provider: 'openai',
    });
  } finally {
    factory.create = originalCreate;
  }
});

test('orchestrator propaga handoff seguro sin ejecutar un agente', async () => {
  const { AiRuntimeOrchestrator } = await import('../modules/ai/application/AiRuntimeOrchestrator');
  const { AgentToolRegistry } = await import('../modules/ai/application/AgentToolRegistry');
  const orchestrator = new AiRuntimeOrchestrator(
    { query: async () => ({ rows: [] }) } as never,
    { getAutomatorMode: async () => 'automator' } as never,
    {
      route: async () => ({
        route: 'handoff',
        targetAgent: null,
        confidence: 0.99,
        reason: 'customer_asks_human',
        handoffReason: 'customer_asks_human',
        handoffTicketId: 44,
        routerMissing: false,
      }),
    } as never,
    new AgentToolRegistry(),
    { logStage: async () => undefined } as never,
    {} as never
  );

  const result = await orchestrator.processInbound({
    companyId: 1,
    chatId: '51999999999',
    message: 'Quiero hablar con una persona',
    history: [],
    inboundProviderMessageId: 'wamid.handoff',
    sender: { sendProductCard: async () => ({ providerMessageId: null }) },
  });

  assert.equal(result.action, 'handoff');
  assert.equal(result.handoffTicketId, 44);
  assert.match(result.reply, /asesor humano/i);
});

test('orchestrator no promete handoff cuando el router no persistio ticket', async () => {
  const { AiRuntimeOrchestrator } = await import('../modules/ai/application/AiRuntimeOrchestrator');
  const { AgentToolRegistry } = await import('../modules/ai/application/AgentToolRegistry');
  const orchestrator = new AiRuntimeOrchestrator(
    { query: async () => ({ rows: [] }) } as never,
    { getAutomatorMode: async () => 'automator' } as never,
    {
      route: async () => ({
        route: 'handoff',
        targetAgent: null,
        confidence: 0,
        reason: 'router_provider_failed',
        handoffReason: 'low_confidence',
        handoffTicketId: null,
        routerMissing: false,
      }),
    } as never,
    new AgentToolRegistry(),
    { logStage: async () => undefined } as never,
    {} as never
  );

  const result = await orchestrator.processInbound({
    companyId: 1,
    chatId: '51999999999',
    message: 'Necesito ayuda',
    history: [],
    inboundProviderMessageId: 'wamid.router-handoff-failed',
    sender: { sendProductCard: async () => ({ providerMessageId: null }) },
  });

  assert.equal(result.action, 'none');
  assert.equal(result.reply, '');
  assert.equal(result.handoffTicketId, null);
  assert.equal(result.reason, 'handoff_ticket_missing');
});

test('orchestrator no promete handoff cuando el agente dirigido no esta disponible', async () => {
  const { AiRuntimeOrchestrator } = await import('../modules/ai/application/AiRuntimeOrchestrator');
  const { AgentToolRegistry } = await import('../modules/ai/application/AgentToolRegistry');
  const unavailableAgent = makeAgent(30, 'support', { status: 'draft' });
  const stages: string[] = [];
  const orchestrator = new AiRuntimeOrchestrator(
    { query: async () => ({ rows: [] }) } as never,
    { getAutomatorMode: async () => 'automator' } as never,
    {
      route: async () => ({
        route: 'customer_service',
        targetAgent: unavailableAgent,
        confidence: 0.95,
        reason: 'support_intent',
        handoffReason: null,
        handoffTicketId: null,
        routerMissing: false,
      }),
    } as never,
    new AgentToolRegistry(),
    { logStage: async (_ctx: unknown, stage: string) => { stages.push(stage); } } as never,
    {} as never
  );

  const result = await orchestrator.processInbound({
    companyId: 1,
    chatId: '51999999999',
    message: 'Necesito soporte',
    history: [],
    inboundProviderMessageId: 'wamid.agent-unavailable',
    sender: { sendProductCard: async () => ({ providerMessageId: null }) },
  });

  assert.equal(result.action, 'none');
  assert.equal(result.reply, '');
  assert.equal(result.handoffTicketId, null);
  assert.equal(result.reason, 'routed_agent_unavailable');
  assert.deepEqual(stages, ['routed_agent_unavailable']);
});

test('orchestrator descarta un final handoff del loop sin ticket persistido', async () => {
  const { AiRuntimeOrchestrator } = await import('../modules/ai/application/AiRuntimeOrchestrator');
  const { AgentToolRegistry } = await import('../modules/ai/application/AgentToolRegistry');
  const { getAiProviderFactory } = await import('../modules/ai/infra/provider/AiProviderFactory');
  const selectedAgent = makeAgent(40, 'support', { provider: 'openai' });
  const stages: string[] = [];
  const factory = getAiProviderFactory() as unknown as { create: (provider: string) => unknown };
  const originalCreate = factory.create;
  factory.create = () => ({
    complete: async () => JSON.stringify({
      type: 'final',
      reply: 'Un asesor humano continuara contigo.',
      action: 'handoff',
      confidence: 0.98,
      reason: 'customer_asks_human',
    }),
  });

  try {
    const orchestrator = new AiRuntimeOrchestrator(
      { query: async () => ({ rows: [] }) } as never,
      { getAutomatorMode: async () => 'automator' } as never,
      {
        route: async () => ({
          route: 'customer_service',
          targetAgent: selectedAgent,
          confidence: 0.97,
          reason: 'support_intent',
          handoffReason: null,
          handoffTicketId: null,
          routerMissing: false,
        }),
      } as never,
      new AgentToolRegistry(),
      { logStage: async (_ctx: unknown, stage: string) => { stages.push(stage); } } as never,
      {} as never
    );

    const result = await orchestrator.processInbound({
      companyId: 1,
      chatId: '51999999999',
      message: 'Quiero hablar con una persona',
      history: [],
      inboundProviderMessageId: 'wamid.loop-handoff-no-ticket',
      sender: { sendProductCard: async () => ({ providerMessageId: null }) },
    });

    assert.equal(result.action, 'none');
    assert.equal(result.reply, '');
    assert.equal(result.handoffTicketId, null);
    assert.equal(result.reason, 'handoff_ticket_missing');
    assert.deepEqual(stages, ['multiagent_route_selected', 'handoff_ticket_missing']);
  } finally {
    factory.create = originalCreate;
  }
});
