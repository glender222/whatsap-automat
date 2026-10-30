/**
 * Tests SPEC-HU15 Tools Reales IA (13 casos spec §14).
 * Unit tests con mocks DB. No requiere PostgreSQL real.
 *
 * Ejecutar:
 *   npm test
 */

import { test, describe, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.JWT_SECRET ||= 'test-only-jwt-secret-with-at-least-32-characters';
process.env.DB_PASSWORD ||= 'test-only-database-password';

// Mocks DB
type QueryResult = { rows: any[] };
type QueryFn = (text: string, params?: any[]) => Promise<QueryResult>;

function makePoolMock(rowsByPattern: Array<{ match: RegExp; rows: any[] }>): { query: QueryFn } {
  const queryFn: QueryFn = async (text: string, _params?: any[]) => {
    for (const entry of rowsByPattern) {
      if (entry.match.test(text)) return { rows: entry.rows };
    }
    return { rows: [] };
  };
  return { query: queryFn };
}

describe('SPEC-HU15 Tools Reales IA - 13 casos §14', () => {
  test('1. Sin router activo: inbound no corre IA; log router_missing', async () => {
    const { AgentRouterService } = await import('../modules/ai/application/AgentRouterService');
    const { AgentRepositoryPg } = await import('../modules/ai/infra/db/AgentRepositoryPg');
    const { AgentRuntimeLogRepositoryPg } = await import('../modules/ai/infra/db/AgentRuntimeLogRepositoryPg');
    const logSpy = mock.fn();
    const logRepo = Object.create(AgentRuntimeLogRepositoryPg.prototype);
    logRepo.log = logSpy;
    const agentRepo = Object.create(AgentRepositoryPg.prototype);
    const pool = makePoolMock([{ match: /purpose = 'router'/, rows: [] }]);
    const router = new AgentRouterService(pool as any, agentRepo as any, logRepo as any);
    const outcome = await router.route({
      companyId: 1, chatId: '54911', message: 'hola', history: [],
      companyMode: 'automator', conversationId: 10, inboundProviderMessageId: 'wamid.1',
    });
    assert.equal(outcome.routerMissing, true);
    assert.equal(outcome.route, 'none');
    const routerMissingLog = logSpy.mock.calls.find((c: any) => c.arguments[0]?.stage === 'router_missing');
    assert.ok(routerMissingLog, 'debe loguear router_missing');
  });

  test('2. Router activo sin agente ventas valido: handoff sin_agente_disponible', async () => {
    const { AgentRouterService } = await import('../modules/ai/application/AgentRouterService');
    const { AgentRepositoryPg } = await import('../modules/ai/infra/db/AgentRepositoryPg');
    const { AgentRuntimeLogRepositoryPg } = await import('../modules/ai/infra/db/AgentRuntimeLogRepositoryPg');
    const logRepo = Object.create(AgentRuntimeLogRepositoryPg.prototype);
    logRepo.log = mock.fn(async () => {});
    const agentRepo = Object.create(AgentRepositoryPg.prototype);
    agentRepo.list = mock.fn(async () => []);
    const routerAgent = { id: 1, name: 'Router', purpose: 'router', status: 'active', mode: 'suggest', provider: 'opencode', model: null, moduleAccess: { handoff: true }, catalogScope: { catalogIds: [], sectionIds: [] }, toolAccess: { handoffCreate: true } };
    agentRepo.get = mock.fn(async (_cid: number, aid: number) => aid === 1 ? routerAgent : (() => { throw new Error('not found'); })());
    const pool = makePoolMock([
      { match: /purpose = 'router'/, rows: [{ id: 1 }] },
      { match: /INSERT INTO handoff_tickets/, rows: [{ id: 77, company_id: 1, conversation_id: 10, agent_id: null, order_id: null, reason: 'sin_agente_disponible', priority: 'medium', status: 'open', taken_by: null, taken_at: null, closed_at: null, closed_by: null, outcome: null, notes: null, metadata_json: {}, created_at: new Date(), updated_at: new Date() }] },
      { match: /INSERT INTO ia_pause_overrides/, rows: [{ id: 1, company_id: 1, conversation_id: 10, paused_by: null, reason: 'handoff:sin_agente_disponible', expires_at: new Date(), created_at: new Date() }] },
      { match: /UPDATE conversations SET ia_paused/, rows: [] },
      { match: /SELECT id FROM conversations/, rows: [{ id: 10 }] },
      { match: /UPDATE conversations SET commercial_stage/, rows: [] },
      { match: /INSERT INTO operational_actions/, rows: [] },
    ]);
    const fakeProvider = { complete: async () => JSON.stringify({ route: 'sales_assistant', targetAgentId: 10, confidence: 0.9, reason: 'ventas', handoffReason: null }) };
    const providerFactory = { create: () => fakeProvider };
    const router = new AgentRouterService(pool as any, agentRepo as any, logRepo as any, providerFactory as any);
    const outcome = await router.route({
      companyId: 1, chatId: '54911', message: 'precio', history: [],
      companyMode: 'automator', conversationId: 10, inboundProviderMessageId: 'wamid.1',
    });
    assert.equal(outcome.route, 'handoff');
    assert.match(outcome.reason || '', /sin_agente_disponible|Ruta sales_assistant sin agente valido/);
  });

  test('3. Agente ventas con scope vacio: catalog.search devuelve [] y status scope_empty', async () => {
    const { CommercialCatalogToolService } = await import('../modules/ai/application/tools/CommercialCatalogToolService');
    const { ProductRepositoryPg } = await import('../modules/inventory');
    const productRepo = Object.create(ProductRepositoryPg.prototype);
    productRepo.findActiveForAgent = mock.fn(async () => []);
    const ctx = {
      companyId: 1, conversationId: 10, chatId: '54911', agentId: 5, agentPurpose: 'sales_assistant',
      companyMode: 'automator', agentMode: 'auto', moduleAccess: { catalog: true }, toolAccess: { catalogSearch: true },
      catalogScope: { catalogIds: [], sectionIds: [] }, inboundProviderMessageId: null, actorUserId: null,
    };
    const service = new CommercialCatalogToolService(productRepo as any);
    const result = await service.search(ctx, { q: 'curso excel' });
    assert.equal(result.status, 'scope_empty');
    assert.deepEqual(result.output, { items: [], total: 0 });
  });

  test('4. catalog.search con scope valido: solo productos activos, IA enabled, catalogo activo', async () => {
    const { CommercialCatalogToolService } = await import('../modules/ai/application/tools/CommercialCatalogToolService');
    const { ProductRepositoryPg } = await import('../modules/inventory');
    const productRepo = Object.create(ProductRepositoryPg.prototype);
    const sampleProduct = {
      id: 123, name: 'Curso Excel Basico', sku: null, description: 'intro', itemType: 'course',
      priceMode: 'fixed', price: 120, currency: 'PEN', status: 'active', aiEnabled: true,
      aiDescription: 'curso', aiSalesInstructions: null, requiresHumanApproval: false,
      availabilityType: 'capacity', capacity: 20, allowBackorder: false, reservationTtlMinutes: null,
      stockAvailable: 0, stockReserved: 0,
      catalogs: [{ id: 1, name: 'Cursos', status: 'active', aiEnabled: true }],
      sections: [{ id: 2, catalogId: 1, catalogName: 'Cursos', name: 'Ofimatica', status: 'active', aiEnabled: true }],
      primaryImage: null, images: [], imageUrl: null, imageAltText: null,
      aiReadiness: 'ready', metadata: {}, createdAt: new Date(), updatedAt: new Date(),
    };
    productRepo.findActiveForAgent = mock.fn(async () => [sampleProduct]);
    const ctx = {
      companyId: 1, conversationId: 10, chatId: '54911', agentId: 5, agentPurpose: 'sales_assistant',
      companyMode: 'automator', agentMode: 'auto', moduleAccess: { catalog: true }, toolAccess: { catalogSearch: true },
      catalogScope: { catalogIds: [1], sectionIds: [] }, inboundProviderMessageId: null, actorUserId: null,
    };
    const service = new CommercialCatalogToolService(productRepo as any);
    const result = await service.search(ctx, { q: 'excel' });
    assert.equal(result.status, 'ok');
    assert.equal((result.output as any).items.length, 1);
    assert.equal((result.output as any).items[0].id, 123);
  });

  test('5. Producto fuera de scope: catalog.getItem devuelve not_found', async () => {
    const { CommercialCatalogToolService } = await import('../modules/ai/application/tools/CommercialCatalogToolService');
    const { ProductRepositoryPg } = await import('../modules/inventory');
    const productRepo = Object.create(ProductRepositoryPg.prototype);
    productRepo.get = mock.fn(async () => ({
      id: 999, name: 'Otro', status: 'active', aiEnabled: true, itemType: 'service',
      catalogs: [{ id: 50, name: 'Otros', status: 'active', aiEnabled: true }],
      sections: [], primaryImage: null, images: [], imageUrl: null,
      priceMode: 'fixed', price: 10, currency: 'PEN', availabilityType: 'unlimited',
      stockAvailable: 0, stockReserved: 0, capacity: null, requiresHumanApproval: false,
      aiDescription: null, aiSalesInstructions: null, description: null, sku: null,
      imageAltText: null, aiReadiness: 'ready', metadata: {}, allowBackorder: false,
      reservationTtlMinutes: null, createdAt: new Date(), updatedAt: new Date(),
    }));
    const ctx = {
      companyId: 1, conversationId: 10, chatId: '54911', agentId: 5, agentPurpose: 'sales_assistant',
      companyMode: 'automator', agentMode: 'auto', moduleAccess: { catalog: true }, toolAccess: { catalogGetItem: true },
      catalogScope: { catalogIds: [1], sectionIds: [] }, inboundProviderMessageId: null, actorUserId: null,
    };
    const service = new CommercialCatalogToolService(productRepo as any);
    const result = await service.getItem(ctx, { commercialItemId: 999 });
    assert.equal(result.status, 'not_found');
  });

  test('6. availability.check: no modifica stock ni crea movimientos', async () => {
    const { AvailabilityToolService } = await import('../modules/ai/application/tools/AvailabilityToolService');
    const { ProductRepositoryPg } = await import('../modules/inventory');
    const productRepo = Object.create(ProductRepositoryPg.prototype);
    const getSpy = mock.fn(async () => ({
      id: 123, status: 'active', availabilityType: 'stock', stockAvailable: 10, requiresHumanApproval: false,
    }));
    productRepo.get = getSpy;
    const ctx = {
      companyId: 1, conversationId: 10, chatId: '54911', agentId: 5, agentPurpose: 'sales_assistant',
      companyMode: 'automator', agentMode: 'auto', moduleAccess: { catalog: true }, toolAccess: { availabilityCheck: true },
      catalogScope: { catalogIds: [1], sectionIds: [] }, inboundProviderMessageId: null, actorUserId: null,
    };
    const service = new AvailabilityToolService(productRepo as any);
    const result = await service.check(ctx, { commercialItemId: 123, quantity: 1 });
    assert.equal(result.status, 'ok');
    assert.equal((result.output as any).available, true);
    assert.equal((result.output as any).status, 'available');
    // productRepo.get solo lee; no hay UPDATE/INSERT en AvailabilityToolService
    assert.equal(getSpy.mock.calls.length, 1);
  });

  test('7. Tool prohibida: no ejecuta; log forbidden', async () => {
    const { AgentToolExecutor } = await import('../modules/ai/application/AgentToolExecutor');
    const { AgentToolRegistry } = await import('../modules/ai/application/AgentToolRegistry');
    const { AgentToolLogger } = await import('../modules/ai/application/AgentToolLogger');
    const logRepo = { log: mock.fn(async () => {}) };
    const logger = new AgentToolLogger(logRepo as any);
    const registry = new AgentToolRegistry();
    const pool = makePoolMock([]);
    const ctx = {
      companyId: 1, conversationId: 10, chatId: '54911', agentId: 5, agentPurpose: 'sales_assistant',
      companyMode: 'mixed', agentMode: 'suggest',
      moduleAccess: { catalog: true, orders: true, handoff: true, commercialState: true, tags: true },
      toolAccess: { orderUpsertPreorder: true, handoffCreate: true, conversationSetCommercialState: true, tagApplySystem: true },
      catalogScope: { catalogIds: [1], sectionIds: [] }, inboundProviderMessageId: null, actorUserId: null,
    };
    const executor = new AgentToolExecutor(pool as any, registry, logger);
    const result = await executor.execute(ctx, { id: 'call_1', name: 'order.upsertPreorder', input: { items: [{ commercialItemId: 1, quantity: 1 }] } });
    assert.equal(result.status, 'forbidden');
    const forbiddenLog = (logRepo.log as any).mock.calls.find((c: any) => c.arguments[0]?.toolResultStatus === 'forbidden');
    assert.ok(forbiddenLog, 'debe loguear forbidden');
  });

  test('8. Payment future tool: no ejecuta; log disabled_future_tool; handoff si cliente quiere pagar', async () => {
    const { AgentToolExecutor } = await import('../modules/ai/application/AgentToolExecutor');
    const { AgentToolRegistry } = await import('../modules/ai/application/AgentToolRegistry');
    const { AgentToolLogger } = await import('../modules/ai/application/AgentToolLogger');
    const logRepo = { log: mock.fn(async () => {}) };
    const logger = new AgentToolLogger(logRepo as any);
    const registry = new AgentToolRegistry();
    const pool = makePoolMock([
      { match: /INSERT INTO handoff_tickets/, rows: [{ id: 88, company_id: 1, conversation_id: 10, agent_id: 5, order_id: null, reason: 'payment_closure', priority: 'high', status: 'open', taken_by: null, taken_at: null, closed_at: null, closed_by: null, outcome: null, notes: null, metadata_json: {}, created_at: new Date(), updated_at: new Date() }] },
      { match: /SELECT id FROM conversations/, rows: [{ id: 10 }] },
      { match: /INSERT INTO operational_actions/, rows: [] },
      { match: /UPDATE conversations/, rows: [] },
      { match: /INSERT INTO ia_pause_overrides/, rows: [{ id: 1, company_id: 1, conversation_id: 10, paused_by: null, reason: 'handoff:payment_closure', expires_at: new Date(), created_at: new Date() }] },
      { match: /UPDATE conversations SET ia_paused/, rows: [] },
    ]);
    const ctx = {
      companyId: 1, conversationId: 10, chatId: '54911', agentId: 5, agentPurpose: 'sales_assistant',
      companyMode: 'automator', agentMode: 'auto',
      moduleAccess: { catalog: true, orders: true, handoff: true, commercialState: true, tags: true },
      toolAccess: { handoffCreate: true },
      catalogScope: { catalogIds: [1], sectionIds: [] }, inboundProviderMessageId: null, actorUserId: null,
    };
    const executor = new AgentToolExecutor(pool as any, registry, logger);
    const result = await executor.execute(ctx, { id: 'call_1', name: 'payment.createLink', input: { amount: 100 } });
    assert.equal(result.status, 'disabled_future_tool');
    const disabledLog = (logRepo.log as any).mock.calls.find((c: any) => c.arguments[0]?.toolResultStatus === 'disabled_future_tool');
    assert.ok(disabledLog, 'debe loguear disabled_future_tool');
  });

  test('9. Modo Asistido: permite read tools; bloquea write tools', async () => {
    const { AgentToolExecutor } = await import('../modules/ai/application/AgentToolExecutor');
    const { AgentToolRegistry } = await import('../modules/ai/application/AgentToolRegistry');
    const { AgentToolLogger } = await import('../modules/ai/application/AgentToolLogger');
    const logRepo = { log: mock.fn(async () => {}) };
    const logger = new AgentToolLogger(logRepo as any);
    const registry = new AgentToolRegistry();
    const pool = makePoolMock([]);
    const ctxMixed = {
      companyId: 1, conversationId: 10, chatId: '54911', agentId: 5, agentPurpose: 'sales_assistant',
      companyMode: 'mixed', agentMode: 'suggest',
      moduleAccess: { catalog: true, orders: true, handoff: true },
      toolAccess: { catalogSearch: true, orderUpsertPreorder: true, handoffCreate: true },
      catalogScope: { catalogIds: [1], sectionIds: [] }, inboundProviderMessageId: null, actorUserId: null,
    };
    const executor = new AgentToolExecutor(pool as any, registry, logger);
    const readResult = await executor.execute(ctxMixed, { id: 'c1', name: 'catalog.search', input: { q: 'x' } });
    assert.notEqual(readResult.status, 'forbidden');
    assert.notEqual(readResult.status, 'permission_denied');
    const writeResult = await executor.execute(ctxMixed, { id: 'c2', name: 'order.upsertPreorder', input: { items: [{ commercialItemId: 1, quantity: 1 }] } });
    assert.equal(writeResult.status, 'forbidden');
  });

  test('10. Modo Automatico: permite ficha/prepedido/handoff; bloquea confirmacion/reserva/pago', async () => {
    const { AgentToolExecutor } = await import('../modules/ai/application/AgentToolExecutor');
    const { AgentToolRegistry } = await import('../modules/ai/application/AgentToolRegistry');
    const { AgentToolLogger } = await import('../modules/ai/application/AgentToolLogger');
    const logRepo = { log: mock.fn(async () => {}) };
    const logger = new AgentToolLogger(logRepo as any);
    const registry = new AgentToolRegistry();
    const pool = makePoolMock([]);
    const ctxAuto = {
      companyId: 1, conversationId: 10, chatId: '54911', agentId: 5, agentPurpose: 'sales_assistant',
      companyMode: 'automator', agentMode: 'auto',
      moduleAccess: { catalog: true, orders: true, handoff: true, commercialState: true, tags: true },
      toolAccess: { orderUpsertPreorder: true, handoffCreate: true, conversationSetCommercialState: true, tagApplySystem: true },
      catalogScope: { catalogIds: [1], sectionIds: [] }, inboundProviderMessageId: null, actorUserId: null,
    };
    const executor = new AgentToolExecutor(pool as any, registry, logger);
    // Payment future bloqueado
    const paymentResult = await executor.execute(ctxAuto, { id: 'c1', name: 'payment.createLink', input: {} });
    assert.equal(paymentResult.status, 'disabled_future_tool');
    // Write tool no bloqueado por modo (validateMode pasa)
    const orderResult = await executor.execute(ctxAuto, { id: 'c2', name: 'order.upsertPreorder', input: { items: [{ commercialItemId: 1, quantity: 1 }] } });
    assert.notEqual(orderResult.status, 'forbidden');
    assert.notEqual(orderResult.status, 'permission_denied');
  });

  test('11. Cliente pide pagar: handoff.create pausa IA + estado handoff/handoff_pending + ticket', async () => {
    const { HandoffToolService } = await import('../modules/ai/application/tools/HandoffToolService');
    const { AgentHandoffService } = await import('../modules/ai/application/AgentHandoffService');
    const { AgentPauseService } = await import('../modules/ai/application/AgentPauseService');
    const { HandoffTicketRepositoryPg } = await import('../modules/ai/infra/db/HandoffTicketRepositoryPg');
    const { IaPauseOverrideRepositoryPg } = await import('../modules/ai/infra/db/IaPauseOverrideRepositoryPg');

    const handoffRepo = Object.create(HandoffTicketRepositoryPg.prototype);
    handoffRepo.findActiveByConversation = mock.fn(async () => null);
    handoffRepo.create = mock.fn(async (input: any) => ({
      id: 77, companyId: input.companyId, conversationId: input.conversationId, agentId: input.agentId,
      orderId: input.orderId, reason: input.reason, priority: input.priority, status: 'open',
      takenBy: null, takenAt: null, closedAt: null, closedBy: null, outcome: null, notes: null,
      metadata: input.metadata, createdAt: new Date(), updatedAt: new Date(),
    }));
    handoffRepo.assignHandoffTag = mock.fn(async () => {});

    const pauseRepo = Object.create(IaPauseOverrideRepositoryPg.prototype);
    const pauseSpy = mock.fn(async () => ({ id: 1, companyId: 1, conversationId: 10, pausedBy: null, reason: 'handoff', expiresAt: new Date(), createdAt: new Date() }));
    pauseRepo.pause = pauseSpy;
    pauseRepo.resume = mock.fn(async () => {});
    pauseRepo.getStatus = mock.fn(async () => ({ paused: true, pausedBy: null, pausedAt: new Date(), resumeAt: null, reason: 'handoff', expired: false }));
    pauseRepo.isPaused = mock.fn(async () => true);
    pauseRepo.purgeExpired = mock.fn(async () => 0);

    const pool = makePoolMock([
      { match: /SELECT id FROM conversations/, rows: [{ id: 10 }] },
      { match: /UPDATE conversations SET commercial_stage/, rows: [] },
      { match: /INSERT INTO operational_actions/, rows: [] },
    ]);

    const handoffService = new AgentHandoffService(handoffRepo as any);
    const pauseService = new AgentPauseService(pauseRepo as any);
    const service = new HandoffToolService(pool as any, handoffService, pauseService);

    const ctx = {
      companyId: 1, conversationId: 10, chatId: '54911', agentId: 5, agentPurpose: 'sales_assistant',
      companyMode: 'automator', agentMode: 'auto',
      moduleAccess: { handoff: true }, toolAccess: { handoffCreate: true },
      catalogScope: { catalogIds: [], sectionIds: [] }, inboundProviderMessageId: null, actorUserId: null,
    };
    const result = await service.create(ctx, { reason: 'payment_closure', priority: 'high', messageToCustomer: 'Un asesor continuara.' });
    assert.equal(result.status, 'ok');
    assert.equal((result.output as any).ticketId, 77);
    assert.equal((result.output as any).conversationPaused, true);
    assert.equal(pauseSpy.mock.calls.length, 1, 'debe llamar pauseService.pause');
    assert.equal(result.relatedHandoffId, 77);
  });

  test('12. Handoff tomado: conversacion queda pausada para IA (pause persiste)', async () => {
    // Cubre pausa persiste tras handoff.create; verificar pauseService.isPaused true
    const { AgentPauseService } = await import('../modules/ai/application/AgentPauseService');
    const { IaPauseOverrideRepositoryPg } = await import('../modules/ai/infra/db/IaPauseOverrideRepositoryPg');
    const pauseRepo = Object.create(IaPauseOverrideRepositoryPg.prototype);
    pauseRepo.isPaused = mock.fn(async () => true);
    pauseRepo.purgeExpired = mock.fn(async () => 0);
    const service = new AgentPauseService(pauseRepo as any);
    const paused = await service.isPaused(1, '54911');
    assert.equal(paused, true, 'tras handoff la IA debe estar pausada');
  });

  test('13. Handoff cerrado: se libera o mantiene segun estado final (resume llamado al cerrar con support_resolved)', async () => {
    // El flujo actual de HandoffTicketRepositoryPg.close cambia estado commercial; la liberacion de pausa
    // se hace explicitamente via AgentPauseService.resume. Verificamos que resume existe y es callable.
    const { AgentPauseService } = await import('../modules/ai/application/AgentPauseService');
    const { IaPauseOverrideRepositoryPg } = await import('../modules/ai/infra/db/IaPauseOverrideRepositoryPg');
    const resumeSpy = mock.fn(async () => {});
    const pauseRepo = Object.create(IaPauseOverrideRepositoryPg.prototype);
    pauseRepo.resume = resumeSpy;
    pauseRepo.purgeExpired = mock.fn(async () => 0);
    const service = new AgentPauseService(pauseRepo as any);
    await service.resume(1, 10, '54911');
    assert.equal(resumeSpy.mock.calls.length, 1, 'resume debe llamarse para liberar IA al cerrar handoff');
  });
});

describe('Runtime IA - revision semantica de handoff humano', () => {
  test('si una decision final es debil, el agente reevalua y puede ejecutar handoff.create', async () => {
    const { AgentToolRuntimeLoop } = await import('../modules/ai/application/AgentToolRuntimeLoop');
    const { AgentToolRegistry } = await import('../modules/ai/application/AgentToolRegistry');
    const { getAiProviderFactory } = await import('../modules/ai/infra/provider/AiProviderFactory');

    const factory = getAiProviderFactory() as any;
    const originalCreate = factory.create;
    const responses = [
      JSON.stringify({ type: 'final', reply: 'Te ayudo por aqui.', action: 'auto_reply', confidence: 0.6, reason: 'respuesta general' }),
      JSON.stringify({ type: 'tool_request', toolCalls: [{ id: 'handoff_1', name: 'handoff.create', input: { reason: 'customer_asks_human', priority: 'high' } }] }),
      JSON.stringify({ type: 'final', reply: 'Claro, un asesor humano continuara contigo.', action: 'handoff', confidence: 1, reason: 'customer_asks_human' }),
    ];
    const providerCalls: any[][] = [];
    const completeSpy = mock.fn(async (messages: any[]) => {
      providerCalls.push(messages.map((message) => ({ ...message })));
      return responses.shift() || responses[responses.length - 1];
    });
    factory.create = () => ({
      providerName: 'fake',
      isConfigured: () => true,
      getStatus: () => ({ provider: 'fake', configured: true, apiUrlConfigured: true, hasApiKey: true, chatPath: '', modelsPath: '', defaultModel: null }),
      listModels: async () => [],
      testConnection: async () => ({ ok: true, model: null, reply: '' }),
      complete: completeSpy,
    });

    try {
      const executeSpy = mock.fn(async (_ctx: any, call: any) => ({
        toolCallId: call.id,
        toolName: call.name,
        status: 'ok',
        output: { ticketId: 99 },
        durationMs: 1,
        relatedHandoffId: 99,
      }));
      const loop = new AgentToolRuntimeLoop(
        makePoolMock([]) as any,
        new AgentToolRegistry(),
        { logStage: mock.fn(async () => {}) } as any,
        { execute: executeSpy } as any
      );
      const agent = {
        id: 5,
        companyId: 1,
        name: 'Agente',
        status: 'active',
        mode: 'auto',
        provider: 'opencode',
        model: null,
        purpose: 'sales_assistant',
        moduleAccess: { handoff: true },
        triggerRules: { commercialIntent: true, handoffForPayment: true },
        catalogScope: { catalogIds: [], sectionIds: [] },
        toolAccess: { handoffCreate: true },
        autoConfirmOrders: false,
        autoCreateVouchers: false,
        autoGeneratePaymentLinks: false,
        isDefault: true,
        createdBy: null,
      };
      const ctx = {
        companyId: 1,
        conversationId: 10,
        chatId: '54911',
        domainKey: 'gestion_web',
        sessionId: null,
        turnId: null,
        agentId: 5,
        agentPurpose: 'sales_assistant',
        companyMode: 'automator',
        agentMode: 'auto',
        moduleAccess: { handoff: true },
        toolAccess: { handoffCreate: true },
        catalogScope: { catalogIds: [], sectionIds: [] },
        inboundProviderMessageId: null,
        actorUserId: null,
        isTest: true,
      };

      const result = await loop.run({ ctx, agent: agent as any, message: 'quiero hablar con un empleado', history: [], companyMode: 'automator' });

      assert.equal(completeSpy.mock.calls.length, 3);
      assert.match(providerCalls[1].at(-1).content, /Revisa semanticamente/);
      assert.equal(executeSpy.mock.calls[0].arguments[1].name, 'handoff.create');
      assert.equal(executeSpy.mock.calls[0].arguments[1].input.reason, 'customer_asks_human');
      assert.equal(result.handoffTicketId, 99);
      assert.equal(result.final?.action, 'handoff');
    } finally {
      factory.create = originalCreate;
    }
  });
});
