import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

process.env.JWT_SECRET ||= 'test-only-jwt-secret-with-at-least-32-characters';
process.env.DB_PASSWORD ||= 'test-only-database-password';

test('dev:tunnel limita stdout y runtime a estado y URLs sin verify token', async () => {
  process.env.WHATSAPP_PROVIDER = 'meta-cloud';
  process.env.META_GRAPH_VERSION = 'v25.0';
  process.env.META_WA_PHONE_NUMBER_ID = 'test-phone-number-id';
  process.env.META_WABA_ID = 'test-waba-id';
  process.env.META_WEBHOOK_VERIFY_TOKEN = 'sentinel-verify-token-never-print';
  process.env.META_WA_ACCESS_TOKEN = 'test-only-meta-access-token';
  process.env.META_APP_SECRET = 'test-only-meta-app-secret';
  process.env.META_TOKEN_ENCRYPTION_KEY = 'test-only-encryption-key-32-characters-minimum';

  const { buildRuntimeOutput, buildSuccessOutput, isExpectedBackendHealth } = await import('../../scripts/dev-tunnel');
  const publicUrl = 'https://p0-demo.trycloudflare.com';
  const callbackUrl = `${publicUrl}/api/webhooks/meta/whatsapp`;
  const stdout = buildSuccessOutput(false, publicUrl, callbackUrl).join('\n');
  const runtime = buildRuntimeOutput(publicUrl, callbackUrl);
  const combined = `${stdout}\n${runtime}`;

  assert.equal(buildSuccessOutput(false, publicUrl, callbackUrl).length, 3);
  assert.match(stdout, /^Backend: listo \(iniciado\)\nPublic URL: https:\/\/p0-demo\.trycloudflare\.com\nCallback URL: https:\/\/p0-demo\.trycloudflare\.com\/api\/webhooks\/meta\/whatsapp$/);
  assert.equal(runtime, `PUBLIC_URL=${publicUrl}\nMETA_CALLBACK_URL=${callbackUrl}\n`);
  assert.equal(combined.includes(process.env.META_WEBHOOK_VERIFY_TOKEN), false);
  assert.equal(combined.includes('hub.verify_token'), false);
  assert.equal(combined.includes('META_WEBHOOK_VERIFY_TOKEN='), false);
  assert.equal(isExpectedBackendHealth({ status: 'ok' }), false);
  assert.equal(isExpectedBackendHealth({ status: 'ok', provider: 'webjs', metaConfigured: false }), false);
  assert.equal(isExpectedBackendHealth({ status: 'ok', provider: 'meta-cloud', metaConfigured: true }), true);
});

test('Meta en development puede usar el token de .env sin persistirlo si no hay clave de cifrado', async () => {
  const config = (await import('../config/index')).default;
  const { MetaAccountStore } = await import('../services/whatsapp/meta/MetaAccountStore');
  const originalEncryptionKey = config.security.tokenEncryptionKey;
  const originalAccessToken = config.meta.accessToken;
  const originalPhone = config.meta.phoneNumberId;
  const envOnlyToken = 'test-only-env-access-token-not-for-production';
  const query = mock.fn(async (_sql: string, params: unknown[]) => ({
    rows: [{
      company_id: params[0],
      provider: 'meta-cloud',
      waba_id: params[1],
      phone_number_id: params[2],
      graph_version: params[5],
      token_secret_ref: params[6],
      access_token_encrypted: params[7],
      token_last_four: params[8],
      webhook_verify_token: params[11],
      status: params[12],
      metadata_json: JSON.parse(String(params[13])),
    }],
  }));

  try {
    config.security.tokenEncryptionKey = '';
    config.meta.accessToken = envOnlyToken;
    config.meta.phoneNumberId = 'test-phone-number-id';
    const statements: string[] = [];
    const store = new MetaAccountStore({
      connect: async () => ({
        query: async (sql: string, params: unknown[]) => {
          statements.push(sql);
          return sql.startsWith('INSERT INTO whatsapp_business_accounts') ? query(sql, params) : { rows: [] };
        },
        release() {},
      }),
    } as any);
    const companyId = config.defaultCompanyId || 1;
    const account = await store.ensureEnvAccount(companyId, {
      graphVersion: 'v25.0',
      phoneNumberId: 'test-phone-number-id',
      wabaId: 'test-waba-id',
      webhookVerifyToken: 'test-only-verify-token',
      accessToken: envOnlyToken,
    });

    const parameters = query.mock.calls[0].arguments[1] as unknown[];
    assert.deepEqual(statements.slice(0, 2), ['BEGIN', `SET LOCAL app.current_tenant_id = '${companyId}'`]);
    assert.equal(statements.at(-1), 'COMMIT');
    assert.equal(parameters[6], 'META_WA_ACCESS_TOKEN');
    assert.equal(parameters[7], null);
    assert.equal(parameters[8], null);
    assert.equal(JSON.stringify(parameters).includes(envOnlyToken), false);
    assert.equal(store.toClientConfig(account as any, true)?.accessToken, envOnlyToken);
    assert.equal(store.toClientConfig({ ...account, company_id: companyId + 1 }, true)?.accessToken, '');
    assert.equal(store.toClientConfig({ ...account, phone_number_id: 'wrong-phone' }, true)?.accessToken, '');
    assert.equal(store.toClientConfig({ ...account, status: 'disconnected' }, true), null);
    assert.equal(store.toClientConfig(null, true), null);
    const configFromEditedAccount = store.toClientConfig({ ...account, graph_version: 'wrong/account', waba_id: 'wrong' }, true);
    assert.equal(configFromEditedAccount?.graphVersion, config.meta.graphVersion);
    assert.equal(configFromEditedAccount?.wabaId, config.meta.wabaId);
  } finally {
    config.security.tokenEncryptionKey = originalEncryptionKey;
    config.meta.accessToken = originalAccessToken;
    config.meta.phoneNumberId = originalPhone;
  }
});

test('OpenCode envia un payload chat-completions compatible sin campos no soportados', async () => {
  const config = (await import('../config/index')).default;
  const { OpenCodeProvider } = await import('../modules/ai/infra/provider/OpenCodeProvider');
  const originalOpenCode = { ...config.ai.opencode };
  const originalFetch = globalThis.fetch;
  const fetchCall = mock.fn(async () => new Response(JSON.stringify({
    choices: [{ message: { content: '{"ok":true}' } }],
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));

  try {
    Object.assign(config.ai.opencode, {
      apiUrl: 'https://opencode.test/zen',
      apiKey: 'test-only-opencode-key',
      model: 'test-chat-model',
      chatPath: '/v1/chat/completions',
      requestTimeoutMs: 1000,
    });
    globalThis.fetch = fetchCall as typeof fetch;

    const reply = await new OpenCodeProvider().complete([
      { role: 'system', content: 'Return JSON.' },
      { role: 'user', content: 'ping' },
    ]);
    const request = fetchCall.mock.calls[0].arguments[1] as RequestInit;
    const body = JSON.parse(String(request.body));

    assert.equal(reply, '{"ok":true}');
    assert.equal(body.model, 'test-chat-model');
    assert.equal(body.messages.length, 2);
    assert.equal('prompt' in body, false);
    assert.equal('response_format' in body, false);
  } finally {
    Object.assign(config.ai.opencode, originalOpenCode);
    globalThis.fetch = originalFetch;
  }
});

test('traza de tools no persiste mensajes, consultas ni resultados completos', async () => {
  const { AgentToolLogger } = await import('../modules/ai/application/AgentToolLogger');
  const log = mock.fn(async () => undefined);
  const record = mock.fn(async () => undefined);
  const logger = new AgentToolLogger({ log } as any, { record } as any);
  const secretText = 'contenido-completo-que-no-debe-registrarse';
  const ctx = {
    companyId: 1,
    conversationId: 10,
    chatId: '51999999999',
    domainKey: 'gestion_web',
    sessionId: 20,
    turnId: 30,
    agentId: 5,
    agentPurpose: 'sales_assistant',
    companyMode: 'automator',
    agentMode: 'auto',
    moduleAccess: { handoff: true },
    toolAccess: { handoffCreate: true },
    catalogScope: { catalogIds: [], sectionIds: [] },
    inboundProviderMessageId: 'wamid.inbound',
    actorUserId: null,
  } as any;
  const call = {
    id: 'handoff-1',
    name: 'handoff.create' as const,
    input: {
      reason: 'customer_asks_human',
      priority: 'high',
      query: secretText,
      messageToCustomer: secretText,
    },
  };

  await logger.logToolStarted(ctx, call);
  await logger.logToolCall(ctx, call, {
    toolCallId: call.id,
    toolName: call.name,
    status: 'ok',
    output: { ticketId: 99, rawReply: secretText },
    durationMs: 4,
    relatedHandoffId: 99,
  });

  const serialized = JSON.stringify({ logs: log.mock.calls, events: record.mock.calls });
  assert.equal(serialized.includes(secretText), false);
  assert.equal(serialized.includes('rawReply'), false);
  assert.match(serialized, /handoff\.create/);
  assert.match(serialized, /customer_asks_human/);
});

test('errores internos de tools se reemplazan por un codigo seguro', async () => {
  const { AgentToolExecutor } = await import('../modules/ai/application/AgentToolExecutor');
  const { AgentToolRegistry } = await import('../modules/ai/application/AgentToolRegistry');
  const { AgentToolLogger } = await import('../modules/ai/application/AgentToolLogger');
  const { PreorderToolService } = await import('../modules/ai/application/tools/PreorderToolService');
  const { MessageSendProductCardToolService } = await import(
    '../modules/ai/application/tools/MessageSendProductCardToolService'
  );

  const internalError = 'postgres://private-user:private-password@db/internal-stack';
  const ctx = {
    companyId: 1,
    conversationId: 10,
    chatId: '51999999999',
    agentId: 5,
    agentPurpose: 'sales_assistant',
    companyMode: 'automator',
    agentMode: 'auto',
    moduleAccess: { catalog: true, orders: true },
    toolAccess: { catalogSearch: true, orderUpsertPreorder: true },
    catalogScope: { catalogIds: [1], sectionIds: [] },
    inboundProviderMessageId: null,
    actorUserId: null,
  } as any;
  const safeError = { errorCode: 'TOOL_EXECUTION_FAILED' };

  const executorPool = {
    query: mock.fn(async () => {
      throw new Error(internalError);
    }),
  };
  const executor = new AgentToolExecutor(
    executorPool as any,
    new AgentToolRegistry(),
    new AgentToolLogger({ log: mock.fn(async () => undefined) } as any)
  );
  const executorResult = await executor.execute(ctx, {
    id: 'catalog-1',
    name: 'catalog.search',
    input: { q: 'producto' },
  });

  const preorder = new PreorderToolService({
    createDetected: mock.fn(async () => {
      throw new Error(internalError);
    }),
  } as any);
  const preorderResult = await preorder.upsertPreorder(ctx, {
    items: [{ commercialItemId: 1, quantity: 1 }],
  });

  const productCard = new MessageSendProductCardToolService(
    { query: mock.fn(async () => ({ rows: [] })) } as any,
    {
      get: mock.fn(async () => ({
        id: 1,
        name: 'Producto',
        status: 'active',
        aiEnabled: true,
        catalogs: [{ id: 1 }],
        sections: [],
        primaryImage: { url: 'https://example.test/producto.jpg' },
        imageUrl: null,
      })),
    } as any,
    {
      sendProductCard: mock.fn(async () => {
        throw new Error(internalError);
      }),
    }
  );
  const productCardResult = await productCard.send(ctx, { commercialItemId: 1 });

  assert.equal(executorResult.status, 'failed');
  assert.deepEqual(executorResult.output, { reason: 'execution_error', ...safeError });
  assert.deepEqual(preorderResult.output, { orderId: null, items: [], ...safeError });
  assert.deepEqual(productCardResult.output, { sent: false, reason: 'send_error', ...safeError });
  assert.equal(JSON.stringify([executorResult, preorderResult, productCardResult]).includes(internalError), false);
});

test('AgentToolLogger usa el provider del contexto y conserva fallback legacy', async () => {
  const { AgentToolLogger } = await import('../modules/ai/application/AgentToolLogger');
  const log = mock.fn(async () => undefined);
  const logger = new AgentToolLogger({ log } as any);
  const baseContext = {
    companyId: 1,
    conversationId: 10,
    chatId: '51999999999',
    agentId: 5,
    agentPurpose: 'sales_assistant',
    companyMode: 'automator',
    agentMode: 'auto',
    moduleAccess: {},
    toolAccess: {},
    catalogScope: { catalogIds: [], sectionIds: [] },
    inboundProviderMessageId: null,
    actorUserId: null,
  } as any;

  await logger.logStage({ ...baseContext, provider: 'openai' }, 'provider_selected');
  await logger.logStage(baseContext, 'legacy_provider');
  await logger.logToolCall(
    { ...baseContext, provider: 'openai' },
    { id: 'catalog-1', name: 'catalog.search', input: {} },
    {
      toolCallId: 'catalog-1',
      toolName: 'catalog.search',
      status: 'ok',
      output: { items: [] },
      durationMs: 1,
    }
  );

  assert.equal(log.mock.calls[0].arguments[0].provider, 'openai');
  assert.equal(log.mock.calls[1].arguments[0].provider, 'opencode');
  assert.equal(log.mock.calls[2].arguments[0].provider, 'openai');
});
