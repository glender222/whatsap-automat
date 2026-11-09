import './fixtures/testEnv';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';
import type { NextFunction, Request, Response } from 'express';

const config = require('../config/index') as typeof import('../config/index').default;
const createMetaWebhookRoutes = require('../routes/metaWebhookRoutes').default as typeof import('../routes/metaWebhookRoutes').default;
const WhatsAppService = require('../services/whatsappService').default as typeof import('../services/whatsappService').default;
const MetaCloudClient = require('../services/whatsapp/meta/MetaCloudClient').MetaCloudClient as typeof import('../services/whatsapp/meta/MetaCloudClient').MetaCloudClient;
type WhatsAppService = import('../services/whatsappService').default;
type MetaCloudClient = import('../services/whatsapp/meta/MetaCloudClient').MetaCloudClient;

type TestHttpResponse = {
  status: number;
  text: string;
  json: Record<string, any> | null;
};

type TestRequest = {
  query?: Record<string, unknown>;
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
  rawBody?: Buffer;
};

const originalProvider = config.whatsapp.provider;
const originalAppSecret = config.meta.appSecret;
const originalVerifyToken = config.meta.webhookVerifyToken;

function createMetaClient(): MetaCloudClient {
  return new MetaCloudClient({
    graphVersion: 'v25.0',
    accessToken: 'test-only-access-token',
    phoneNumberId: 'test-phone-number-id',
    appSecret: config.meta.appSecret,
  });
}

describe('Meta media download trust boundary', () => {
  const clientConfig = {
    graphVersion: 'v25.0', accessToken: 'fixture-only-token', phoneNumberId: '1234567',
  };

  test('rejects untrusted media URLs without sending the bearer token to them', async () => {
    for (const url of [
      'http://lookaside.fbsbx.com/whatsapp/file',
      'https://lookaside.fbsbx.com.example.invalid/whatsapp/file',
      'https://user@lookaside.fbsbx.com/whatsapp/file',
      'https://lookaside.fbsbx.com:8443/whatsapp/file',
      'http://127.0.0.1/private',
    ]) {
      const requests: string[] = [];
      const client = new MetaCloudClient(clientConfig, async (input) => {
        requests.push(String(input));
        return Response.json({ url });
      });
      await assert.rejects(client.downloadMedia('12345'), { code: 'META_MEDIA_URL_UNTRUSTED' });
      assert.deepEqual(requests, ['https://graph.facebook.com/v25.0/12345']);
    }
  });

  test('downloads from the Meta origin without following redirects or returning its signed URL', async () => {
    const media = Buffer.from('fixture bytes');
    const location = 'https://lookaside.fbsbx.com/whatsapp/file?hash=temporary';
    let requests = 0;
    const client = new MetaCloudClient(clientConfig, async (input, request) => {
      assert.equal(request?.redirect, 'error');
      assert.equal(new Headers(request?.headers).get('authorization'), 'Bearer fixture-only-token');
      if (requests++ === 0) return Response.json({ url: location, file_size: media.length });
      assert.equal(String(input), location);
      return new Response(media, { headers: { 'Content-Type': 'image/png' } });
    });
    const downloaded = await client.downloadMedia('12345');
    assert.equal(requests, 2);
    assert.deepEqual(downloaded.bytes, media);
    assert.equal(downloaded.fileSize, media.length);
    assert.equal(downloaded.mimeType, 'image/png');
    assert.equal('url' in downloaded.raw, false);
  });

  test('cancels a media body exceeding the byte limit even without a content length', async () => {
    const chunk = new Uint8Array(1_000_000);
    let cancelled = false;
    let requests = 0;
    const client = new MetaCloudClient(clientConfig, async () => {
      if (requests++ === 0) return Response.json({ url: 'https://lookaside.fbsbx.com/whatsapp/file' });
      return new Response(new ReadableStream<Uint8Array>({
        pull: (controller) => controller.enqueue(chunk),
        cancel: () => { cancelled = true; },
      }));
    });
    await assert.rejects(client.downloadMedia('12345'), { code: 'META_MEDIA_TOO_LARGE' });
    assert.equal(cancelled, true);
  });
});

function createRouteService(
  handleMetaWebhook = mock.fn(async () => ({ processed: 1, results: [] }))
): WhatsAppService {
  const service = Object.create(WhatsAppService.prototype) as WhatsAppService;
  Object.assign(service, {
    provider: 'meta-cloud',
    metaClient: createMetaClient(),
    handleMetaWebhook,
  });
  return service;
}

function signatureFor(rawBody: string): string {
  return `sha256=${crypto
    .createHmac('sha256', config.meta.appSecret)
    .update(rawBody)
    .digest('hex')}`;
}

async function invokeWebhook(
  service: WhatsAppService,
  method: 'get' | 'post',
  request: TestRequest
): Promise<TestHttpResponse> {
  const router = createMetaWebhookRoutes(service) as any;
  const layer = router.stack.find((candidate: any) => candidate.route?.methods?.[method]);
  assert.ok(layer, `debe existir la ruta ${method.toUpperCase()} /`);
  const handler = layer.route.stack[0].handle as (
    req: Request,
    res: Response,
    next: NextFunction
  ) => unknown;

  let status = 200;
  let text = '';
  let json: Record<string, any> | null = null;
  let nextError: any = null;
  const response = {
    status(code: number) {
      status = code;
      return this;
    },
    send(value: unknown) {
      text = String(value);
      return this;
    },
    json(value: Record<string, any>) {
      json = value;
      text = JSON.stringify(value);
      return this;
    },
  } as unknown as Response;

  await handler(
    {
      query: request.query || {},
      headers: request.headers || {},
      body: request.body,
      rawBody: request.rawBody,
    } as unknown as Request,
    response,
    ((error?: any) => { nextError = error; }) as NextFunction
  );

  if (nextError) {
    status = nextError.statusCode || 500;
    json = {
      success: false,
      code: nextError.code || 'INTERNAL_ERROR',
      error: nextError.message || 'Internal error',
    };
    text = JSON.stringify(json);
  }

  return { status, text, json };
}

function metaPayload(phoneNumberId: string, messageId: string, body: string): Record<string, unknown> {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'test-waba-id',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: {
            display_phone_number: '15550000000',
            phone_number_id: phoneNumberId,
          },
          contacts: [{ wa_id: '51999999999', profile: { name: 'Cliente' } }],
          messages: [{
            from: '51999999999',
            id: messageId,
            timestamp: '1710000000',
            type: 'text',
            text: { body },
          }],
        },
      }],
    }],
  };
}

describe('P0 seguridad del webhook Meta', () => {
  beforeEach(() => {
    config.whatsapp.provider = 'meta-cloud';
    config.meta.appSecret = 'test-only-app-secret';
    config.meta.webhookVerifyToken = 'test-only-verify-token';
  });

  afterEach(() => {
    config.whatsapp.provider = originalProvider;
    config.meta.appSecret = originalAppSecret;
    config.meta.webhookVerifyToken = originalVerifyToken;
  });

  test('falla al registrar rutas Meta sin App Secret', () => {
    config.meta.appSecret = '';
    assert.throws(
      () => createMetaWebhookRoutes(createRouteService()),
      /META_APP_SECRET es obligatorio/
    );
  });

  test('GET devuelve el challenge solo con modo y verify token validos', async () => {
    const response = await invokeWebhook(
      createRouteService(),
      'get',
      {
        query: {
          'hub.mode': 'subscribe',
          'hub.verify_token': 'test-only-verify-token',
          'hub.challenge': 'challenge-123',
        },
      }
    );

    assert.equal(response.status, 200);
    assert.equal(response.text, 'challenge-123');
  });

  test('GET rechaza verify token invalido con 403', async () => {
    const response = await invokeWebhook(
      createRouteService(),
      'get',
      {
        query: {
          'hub.mode': 'subscribe',
          'hub.verify_token': 'incorrecto',
          'hub.challenge': 'challenge-123',
        },
      }
    );

    assert.equal(response.status, 403);
  });

  test('POST rechaza firma invalida sin ejecutar el webhook', async () => {
    const handleMetaWebhook = mock.fn(async () => ({ processed: 1, results: [] }));
    const rawBody = JSON.stringify(metaPayload('known-phone-id', 'wamid.invalid-signature', 'hola'));
    const response = await invokeWebhook(createRouteService(handleMetaWebhook), 'post', {
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': 'sha256=invalid',
      },
      body: JSON.parse(rawBody),
      rawBody: Buffer.from(rawBody),
    });

    assert.equal(response.status, 403);
    assert.equal(handleMetaWebhook.mock.calls.length, 0);
  });

  test('POST valida el HMAC contra el cuerpo crudo exacto', async () => {
    const handleMetaWebhook = mock.fn(async () => ({ processed: 1, results: [] }));
    const rawBody = JSON.stringify(
      metaPayload('known-phone-id', 'wamid.valid-signature', 'hola'),
      null,
      2
    );
    const response = await invokeWebhook(createRouteService(handleMetaWebhook), 'post', {
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signatureFor(rawBody),
      },
      body: JSON.parse(rawBody),
      rawBody: Buffer.from(rawBody),
    });

    assert.equal(response.status, 200);
    assert.equal(handleMetaWebhook.mock.calls.length, 1);
  });

  test('rechaza phone_number_id desconocido y nunca usa la empresa por defecto', async () => {
    const findByPhoneNumberId = mock.fn(async () => null);
    const withCompany = mock.fn(() => ({
      persistInboundMessage: mock.fn(),
      persistStatus: mock.fn(),
    }));
    const service = Object.create(WhatsAppService.prototype) as WhatsAppService;
    Object.assign(service, {
      provider: 'meta-cloud',
      metaClient: createMetaClient(),
      metaAccountStore: { findByPhoneNumberId },
      metaStore: { withCompany },
      agentService: { logRuntimeEvent: mock.fn(async () => undefined) },
    });

    const rawBody = JSON.stringify(metaPayload(
      'unknown-phone-number-id',
      'wamid.unknown-tenant',
      'mensaje que no debe persistirse'
    ));
    const response = await invokeWebhook(service, 'post', {
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signatureFor(rawBody),
      },
      body: JSON.parse(rawBody),
      rawBody: Buffer.from(rawBody),
    });

    assert.equal(response.status, 404);
    assert.equal(response.json?.code, 'META_WEBHOOK_TENANT_NOT_FOUND');
    assert.equal(findByPhoneNumberId.mock.calls.length, 1);
    assert.equal(withCompany.mock.calls.length, 0);
  });

  test('un wamid duplicado no reejecuta agente, handoff ni envio', async () => {
    const inboundText = 'mensaje privado del cliente que no debe aparecer en trazas';
    const outboundText = 'respuesta privada que tampoco debe aparecer en trazas';
    const seen = new Set<string>();
    const persistInboundMessage = mock.fn(async ({ message }: any) => {
      const duplicate = seen.has(String(message.id));
      seen.add(String(message.id));
      return { duplicate, conversationId: 321, messageId: 654 };
    });
    const runtimeLog = mock.fn(async () => undefined);
    const processInbound = mock.fn(async () => ({
      routerMissing: false,
      route: 'ventas',
      agentId: 7,
      action: 'handoff' as const,
      reply: outboundText,
      confidence: 0.94,
      reason: 'dato que no debe persistirse en la traza',
      handoffTicketId: 99,
      toolResults: [{ toolName: 'handoff.create', status: 'ok', output: { secret: 'no-log' } }],
      rounds: 2,
      delivery: null,
    }));
    const sendAgentReply = mock.fn(async () => undefined);
    const withCompany = mock.fn(() => ({
      persistInboundMessage,
      persistStatus: mock.fn(async () => ({})),
    }));
    const service = Object.create(WhatsAppService.prototype) as WhatsAppService;
    Object.assign(service, {
      provider: 'meta-cloud',
      metaClient: createMetaClient(),
      metaAccountStore: {
        findByPhoneNumberId: mock.fn(async () => ({ company_id: 42 })),
        recordLastError: mock.fn(async () => undefined),
      },
      metaStore: { withCompany },
      agentService: {
        logRuntimeEvent: runtimeLog,
        isConversationPaused: mock.fn(async () => false),
        getConversationContext: mock.fn(async () => []),
      },
      getRuntimeOrchestrator: () => ({ processInbound }),
      sendAgentReply,
    });
    const payload = metaPayload('known-phone-number-id', 'wamid.dedupe', inboundText);

    const first = await service.handleMetaWebhook(payload);
    const second = await service.handleMetaWebhook(payload);

    assert.equal(first.processed, 1);
    assert.equal(second.processed, 1);
    assert.equal(persistInboundMessage.mock.calls.length, 2);
    assert.equal(processInbound.mock.calls.length, 1);
    assert.equal(sendAgentReply.mock.calls.length, 1);
    assert.deepEqual(withCompany.mock.calls.map((call: any) => call.arguments[0]), [42, 42]);

    const completedCall = runtimeLog.mock.calls.find(
      (call: any) => call.arguments[0]?.stage === 'agent_runtime_completed'
    );
    assert.ok(completedCall, 'debe registrar la traza intent -> agent -> tools -> handoff');
    assert.equal(completedCall.arguments[0].inboundProviderMessageId, 'wamid.dedupe');
    assert.equal(completedCall.arguments[0].agentId, 7);
    assert.equal(completedCall.arguments[0].relatedHandoffId, 99);
    assert.deepEqual(completedCall.arguments[0].payload.tools, [
      { toolName: 'handoff.create', status: 'ok' },
    ]);

    const serializedLogs = JSON.stringify(runtimeLog.mock.calls);
    assert.equal(serializedLogs.includes(inboundText), false);
    assert.equal(serializedLogs.includes(outboundText), false);
    assert.equal(serializedLogs.includes('no-log'), false);
  });

  test('traza segura enlaza wamid inbound con wamid outbound', async () => {
    const reply = 'respuesta completa que solo debe enviarse, no loguearse';
    const runtimeLog = mock.fn(async () => undefined);
    const service = Object.create(WhatsAppService.prototype) as WhatsAppService;
    Object.assign(service, {
      provider: 'meta-cloud',
      metaAccountStore: { recordLastError: mock.fn(async () => undefined) },
      agentService: { logRuntimeEvent: runtimeLog },
      ensureFreeFormWindowOpen: mock.fn(async () => undefined),
      resolveProductCardMedia: mock.fn(async () => null),
      sendMessage: mock.fn(async () => ({ id: 'wamid.outbound' })),
    });

    await (service as any).sendAgentReply(42, 7, '51999999999', 'wamid.inbound', {
      reply,
      action: 'handoff',
      confidence: 0.91,
    });

    const successCall = runtimeLog.mock.calls.find(
      (call: any) => call.arguments[0]?.stage === 'meta_send_success'
    );
    assert.ok(successCall, 'debe registrar el envio aceptado por Meta');
    assert.equal(successCall.arguments[0].inboundProviderMessageId, 'wamid.inbound');
    assert.equal(successCall.arguments[0].outboundProviderMessageId, 'wamid.outbound');
    assert.equal(JSON.stringify(runtimeLog.mock.calls).includes(reply), false);
  });
});
