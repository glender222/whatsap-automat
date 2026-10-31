import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { NextFunction, Request, Response } from 'express';

process.env.JWT_SECRET ||= 'test-only-jwt-secret-with-at-least-32-characters-for-testing';
process.env.DB_PASSWORD ||= 'test-only-database-password';

const configModule = require('../config/index');
const config = (configModule.default || configModule) as typeof import('../config/index').default;
const {
  extractBearerToken,
  hasCompanyClaim,
  optionalWhatsappJwt,
  requireJwt,
  resolveWhatsappCompanyId,
  toPositiveInt,
} = require('../middleware/jwtAuth') as typeof import('../middleware/jwtAuth');
type JwtRequest = import('../middleware/jwtAuth').JwtRequest;

const {
  createResourceAuth,
  normalizeChatIdCandidates,
} = require('../middleware/resourceAuth') as typeof import('../middleware/resourceAuth');

const {
  createExpiredToken,
  createInvalidCompanyClaimToken,
  createInvalidSignatureToken,
  createNoCompanyClaimToken,
  createSnakeCaseCompanyClaimToken,
  createTenantAToken,
  createTenantBToken,
  createTenantIdClaimToken,
  createTestJwt,
  MALFORMED_TOKEN,
  TEST_JWT_SECRET,
} = require('./fixtures/authFixtures') as typeof import('./fixtures/authFixtures');

type MockResponse = {
  statusCode: number;
  headers: Record<string, string>;
  body: any;
  status(code: number): MockResponse;
  json(data: any): MockResponse;
  setHeader(name: string, value: string): MockResponse;
};

function createMockResponse(): MockResponse {
  const res: MockResponse = {
    statusCode: 200,
    headers: {},
    body: null,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(data: any) {
      this.body = data;
      return this;
    },
    setHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
      return this;
    },
  };
  return res;
}

function createMockRequest(options: {
  headers?: Record<string, string>;
  params?: Record<string, string>;
  body?: any;
  path?: string;
  method?: string;
  user?: Record<string, unknown>;
  whatsappCompanyId?: number;
} = {}): JwtRequest {
  return {
    headers: options.headers || {},
    params: options.params || {},
    body: options.body || {},
    path: options.path || '/',
    method: options.method || 'GET',
    user: options.user,
    whatsappCompanyId: options.whatsappCompanyId,
  } as unknown as JwtRequest;
}

describe('PR-01: P0 Fail-closed JWT y Resolución de Tenant (SEC-03)', () => {
  test('requireJwt rechaza petición sin header Authorization con 401', () => {
    const req = createMockRequest();
    const res = createMockResponse();
    let nextCalled = false;

    requireJwt(req, res as unknown as Response, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.success, false);
    assert.equal(res.body.error, 'Token no proporcionado');
  });

  test('requireJwt rechaza Authorization con esquema no-Bearer', () => {
    const req = createMockRequest({
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
    });
    const res = createMockResponse();
    let nextCalled = false;

    requireJwt(req, res as unknown as Response, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.error, 'Token no proporcionado');
  });

  test('requireJwt rechaza token malformado con 401', () => {
    const req = createMockRequest({
      headers: { authorization: `Bearer ${MALFORMED_TOKEN}` },
    });
    const res = createMockResponse();
    let nextCalled = false;

    requireJwt(req, res as unknown as Response, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.error, 'Token invalido o expirado');
  });

  test('requireJwt rechaza token expirado con 401', () => {
    const expiredToken = createExpiredToken(1);
    const req = createMockRequest({
      headers: { authorization: `Bearer ${expiredToken}` },
    });
    const res = createMockResponse();
    let nextCalled = false;

    requireJwt(req, res as unknown as Response, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.error, 'Token invalido o expirado');
  });

  test('requireJwt rechaza token firmado con secreto incorrecto con 401', () => {
    const invalidSigToken = createInvalidSignatureToken(1);
    const req = createMockRequest({
      headers: { authorization: `Bearer ${invalidSigToken}` },
    });
    const res = createMockResponse();
    let nextCalled = false;

    requireJwt(req, res as unknown as Response, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.error, 'Token invalido o expirado');
  });

  test('SEC-03: JWT sin company claim es rechazado con 403 sin fallback a defaultCompanyId', () => {
    const tokenNoClaim = createNoCompanyClaimToken();
    const req = createMockRequest({
      headers: { authorization: `Bearer ${tokenNoClaim}` },
    });
    const res = createMockResponse();
    let nextCalled = false;

    requireJwt(req, res as unknown as Response, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.success, false);
    assert.equal(res.body.error, 'Empresa no asociada al token');
    assert.equal(req.whatsappCompanyId, undefined);
  });

  test('SEC-03: JWT con companyId nulo, cero o negativo es rechazado con 403', () => {
    for (const invalidValue of [null, 0, -1, 'invalido']) {
      const token = createInvalidCompanyClaimToken(invalidValue);
      const req = createMockRequest({
        headers: { authorization: `Bearer ${token}` },
      });
      const res = createMockResponse();
      let nextCalled = false;

      requireJwt(req, res as unknown as Response, () => {
        nextCalled = true;
      });

      assert.equal(nextCalled, false, `Debió rechazar companyId: ${invalidValue}`);
      assert.equal(res.statusCode, 403);
      assert.equal(res.body.error, 'Empresa no asociada al token');
    }
  });

  test('requireJwt acepta token válido con claim companyId y propaga req.whatsappCompanyId', () => {
    const validToken = createTenantAToken(10);
    const req = createMockRequest({
      headers: { authorization: `Bearer ${validToken}` },
    });
    const res = createMockResponse();
    let nextCalled = false;

    requireJwt(req, res as unknown as Response, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, true);
    assert.equal(req.whatsappCompanyId, 10);
    assert.equal(req.user?.companyId, 10);
    assert.equal(req.user?.email, 'admin-tenant-a@example.com');
  });

  test('requireJwt acepta variantes válidas de claim: company_id y tenantId', () => {
    // Probar company_id
    const tokenSnake = createSnakeCaseCompanyClaimToken(5);
    const req1 = createMockRequest({ headers: { authorization: `Bearer ${tokenSnake}` } });
    const res1 = createMockResponse();
    let next1 = false;
    requireJwt(req1, res1 as unknown as Response, () => { next1 = true; });
    assert.equal(next1, true);
    assert.equal(req1.whatsappCompanyId, 5);

    // Probar tenantId (convención v0.4)
    const tokenTenantId = createTenantIdClaimToken(8);
    const req2 = createMockRequest({ headers: { authorization: `Bearer ${tokenTenantId}` } });
    const res2 = createMockResponse();
    let next2 = false;
    requireJwt(req2, res2 as unknown as Response, () => { next2 = true; });
    assert.equal(next2, true);
    assert.equal(req2.whatsappCompanyId, 8);
  });

  test('resolveWhatsappCompanyId lanza error si no hay claim válido y NUNCA recurre a defaultCompanyId', () => {
    const reqSinClaim = createMockRequest({ user: { email: 'no-claim@example.com' } });
    assert.throws(
      () => resolveWhatsappCompanyId(reqSinClaim),
      /TENANT_CLAIM_REQUIRED/,
      'Debe lanzar error y no devolver defaultCompanyId (1)'
    );

    const reqVacio = createMockRequest();
    assert.throws(
      () => resolveWhatsappCompanyId(reqVacio),
      /TENANT_CLAIM_REQUIRED/,
      'Debe lanzar error con request vacio'
    );
  });

  test('optionalWhatsappJwt opera como requireJwt (fail-closed) por defecto', () => {
    const reqSinToken = createMockRequest();
    const res = createMockResponse();
    let nextCalled = false;

    optionalWhatsappJwt(reqSinToken, res as unknown as Response, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
  });
});

describe('PR-01: Aislamiento Cross-Tenant en Recursos - Chats (SEC-01)', () => {
  test('SEC-01: Tenant A consultando chat perteneciente a Tenant B recibe 403 Forbidden', async () => {
    const mockDb = {
      query: async (sql: string, params?: unknown[]) => {
        // Simular que el chat 5491112345678@c.us pertenece al Tenant B (company_id: 2)
        return {
          rows: [
            { id: 99, company_id: 2, external_conversation_id: '5491112345678@c.us' },
          ],
        };
      },
    };

    const resourceAuth = createResourceAuth(mockDb);

    // Tenant A (companyId: 1) intenta consultar el chat
    const req = createMockRequest({
      whatsappCompanyId: 1,
      params: { chatId: '5491112345678@c.us' },
      method: 'GET',
    });
    const res = createMockResponse();
    let nextCalled = false;

    await resourceAuth.requireChatTenantAccess(req, res as unknown as Response, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.success, false);
    assert.equal(res.body.error, 'FORBIDDEN');
    assert.match(res.body.message, /otra empresa/);
  });

  test('SEC-01: Tenant A consultando chat que no existe en el sistema recibe 404 Not Found', async () => {
    const mockDb = {
      query: async () => ({ rows: [] }),
    };

    const resourceAuth = createResourceAuth(mockDb);
    const req = createMockRequest({
      whatsappCompanyId: 1,
      params: { chatId: '5499999999999@c.us' },
      method: 'GET',
    });
    const res = createMockResponse();
    let nextCalled = false;

    await resourceAuth.requireChatTenantAccess(req, res as unknown as Response, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 404);
    assert.equal(res.body.error, 'CHAT_NOT_FOUND');
  });

  test('SEC-01: Tenant A consultando chat propio (company_id: 1) pasa con éxito next()', async () => {
    const mockDb = {
      query: async () => ({
        rows: [
          { id: 10, company_id: 1, external_conversation_id: '5491111111111@c.us' },
        ],
      }),
    };

    const resourceAuth = createResourceAuth(mockDb);
    const req = createMockRequest({
      whatsappCompanyId: 1,
      params: { chatId: '5491111111111@c.us' },
      method: 'GET',
    });
    const res = createMockResponse();
    let nextCalled = false;

    await resourceAuth.requireChatTenantAccess(req, res as unknown as Response, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(req.conversation?.id, 10);
  });

  test('SEC-01: Acceso a conversación por ID numérico rechaza acceso cross-tenant con 403', async () => {
    const mockDb = {
      query: async () => ({
        rows: [
          { id: 50, company_id: 2, external_conversation_id: '5492222222222@c.us' },
        ],
      }),
    };

    const resourceAuth = createResourceAuth(mockDb);
    const req = createMockRequest({
      whatsappCompanyId: 1,
      params: { id: '50' },
      method: 'GET',
    });
    const res = createMockResponse();
    let nextCalled = false;

    await resourceAuth.requireChatTenantAccess(req, res as unknown as Response, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.error, 'FORBIDDEN');
  });

  test('Normalización de candidatos de chatId maneja sufijos @c.us y formatos numéricos', () => {
    const candidates = normalizeChatIdCandidates('5491112345678@c.us');
    assert.ok(candidates.includes('5491112345678@c.us'));
    assert.ok(candidates.includes('5491112345678'));
    assert.ok(candidates.includes('5491112345678@s.whatsapp.net'));
  });
});

describe('PR-01: Aislamiento Cross-Tenant en Media y Comprobantes (SEC-06)', () => {
  test('SEC-06: Tenant A intentando acceder a media de Tenant B recibe 403 Forbidden', async () => {
    const mockDb = {
      query: async () => ({
        rows: [
          {
            message_id: 100,
            company_id: 2, // Pertenece a Tenant B
            attachment_id: 200,
            internal_path: 'uploads/tenants/2/meta-cloud/sensitive_doc.pdf',
          },
        ],
      }),
    };

    const resourceAuth = createResourceAuth(mockDb);
    const req = createMockRequest({
      whatsappCompanyId: 1, // Solicitante es Tenant A
      params: { messageId: 'msg-wamid-tenant-b' },
      method: 'GET',
    });
    const res = createMockResponse();
    let nextCalled = false;

    await resourceAuth.requireMediaTenantAccess(req, res as unknown as Response, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.error, 'FORBIDDEN');
    assert.match(res.body.message, /otra empresa/);
  });

  test('SEC-06: Media no existente devuelve 404 Not Found', async () => {
    const mockDb = { query: async () => ({ rows: [] }) };
    const resourceAuth = createResourceAuth(mockDb);
    const req = createMockRequest({
      whatsappCompanyId: 1,
      params: { messageId: 'non-existent-msg' },
      method: 'GET',
    });
    const res = createMockResponse();
    let nextCalled = false;

    await resourceAuth.requireMediaTenantAccess(req, res as unknown as Response, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 404);
    assert.equal(res.body.error, 'MEDIA_NOT_FOUND');
  });

  test('SEC-06: Media propio de Tenant A pasa validación next()', async () => {
    const mockDb = {
      query: async () => ({
        rows: [
          {
            message_id: 101,
            company_id: 1,
            attachment_id: 201,
            internal_path: 'uploads/tenants/1/meta-cloud/invoice.pdf',
          },
        ],
      }),
    };

    const resourceAuth = createResourceAuth(mockDb);
    const req = createMockRequest({
      whatsappCompanyId: 1,
      params: { messageId: 'msg-wamid-tenant-a' },
      method: 'GET',
    });
    const res = createMockResponse();
    let nextCalled = false;

    await resourceAuth.requireMediaTenantAccess(req, res as unknown as Response, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, true);
    assert.equal(req.mediaAttachment?.attachment_id, 201);
  });

  test('SEC-06: Comprobante de pago (voucher) de Tenant B es bloqueado con 403', async () => {
    const mockDb = {
      query: async () => ({
        rows: [
          {
            id: 15,
            company_id: 2,
            file_url: '/uploads/payment-vouchers/receipt_tenant_b.jpg',
          },
        ],
      }),
    };

    const resourceAuth = createResourceAuth(mockDb);
    const req = createMockRequest({
      whatsappCompanyId: 1,
      params: { filename: 'receipt_tenant_b.jpg' },
      method: 'GET',
    });
    const res = createMockResponse();
    let nextCalled = false;

    await resourceAuth.requireVoucherTenantAccess(req, res as unknown as Response, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.error, 'FORBIDDEN');
  });
});

describe('PR-01: Rutas Legacy y Demo Fuera del Endpoint Productivo', () => {
  test('extractBearerToken extrae token ignorando mayúsculas y espacios múltiples', () => {
    assert.equal(extractBearerToken('Bearer my-token-123'), 'my-token-123');
    assert.equal(extractBearerToken('bearer   my-token-123'), 'my-token-123');
    assert.equal(extractBearerToken('BEARER my-token-123'), 'my-token-123');
    assert.equal(extractBearerToken('Token my-token-123'), null);
    assert.equal(extractBearerToken(undefined), null);
    assert.equal(extractBearerToken(''), null);
  });

  test('hasCompanyClaim valida adecuadamente presencia de cualquier claim de tenant', () => {
    assert.equal(hasCompanyClaim({ companyId: 1 }), true);
    assert.equal(hasCompanyClaim({ company_id: 2 }), true);
    assert.equal(hasCompanyClaim({ tenantId: 3 }), true);
    assert.equal(hasCompanyClaim({ companyId: '4' }), true);
    assert.equal(hasCompanyClaim({ companyId: 0 }), false);
    assert.equal(hasCompanyClaim({ companyId: -1 }), false);
    assert.equal(hasCompanyClaim({ companyId: null }), false);
    assert.equal(hasCompanyClaim({ otherField: 'val' }), false);
    assert.equal(hasCompanyClaim(undefined), false);
  });

  test('Plan de migración: tokens antiguos sin claim son rechazados de forma segura exigiendo refresh', () => {
    // Cuando un usuario legado presenta token sin claim:
    const legacyToken = createNoCompanyClaimToken({ email: 'legacy@empresa.com' });
    const req = createMockRequest({ headers: { authorization: `Bearer ${legacyToken}` } });
    const res = createMockResponse();
    let nextCalled = false;

    requireJwt(req, res as unknown as Response, () => { nextCalled = true; });

    // Falla cerrado (403/401)
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);

    // Tras llamar refresh, el nuevo token SI incluye claim y es aceptado:
    const refreshedToken = createTenantAToken(1, 'EMPLEADO', { email: 'legacy@empresa.com' });
    const req2 = createMockRequest({ headers: { authorization: `Bearer ${refreshedToken}` } });
    const res2 = createMockResponse();
    let nextCalled2 = false;

    requireJwt(req2, res2 as unknown as Response, () => { nextCalled2 = true; });
    assert.equal(nextCalled2, true);
    assert.equal(req2.whatsappCompanyId, 1);
  });

  test('Configuración fail-closed: sandbox bypass está deshabilitado en production', () => {
    const originalEnv = process.env.NODE_ENV;
    const originalSandboxFlag = config.security.allowInsecureSandbox;
    try {
      (config.security as any).allowInsecureSandbox = false;
      const req = createMockRequest();
      const res = createMockResponse();
      let nextCalled = false;

      optionalWhatsappJwt(req, res as unknown as Response, () => { nextCalled = true; });
      assert.equal(nextCalled, false);
      assert.equal(res.statusCode, 401);
    } finally {
      process.env.NODE_ENV = originalEnv;
      (config.security as any).allowInsecureSandbox = originalSandboxFlag;
    }
  });

  test('Rutas legacy en App están protegidas con fail-closed auth', () => {
    // Lista de rutas legacy que antes estaban desprotegidas o bajo optionalWhatsappJwt
    const legacyRoutes = [
      { method: 'GET', path: '/qr' },
      { method: 'GET', path: '/status' },
      { method: 'GET', path: '/me' },
      { method: 'POST', path: '/logout' },
      { method: 'GET', path: '/chats' },
      { method: 'GET', path: '/messages/5491112345678@c.us' },
      { method: 'POST', path: '/send-message' },
      { method: 'GET', path: '/download-media/msg-123' },
      { method: 'GET', path: '/profile-photo/5491112345678@c.us' },
      { method: 'GET', path: '/uploads/payment-vouchers/voucher_1.jpg' },
    ];

    for (const route of legacyRoutes) {
      const req = createMockRequest({ method: route.method, path: route.path });
      const res = createMockResponse();
      let nextCalled = false;

      requireJwt(req, res as unknown as Response, () => { nextCalled = true; });
      assert.equal(nextCalled, false, `Ruta legacy ${route.method} ${route.path} debe requerir auth`);
      assert.equal(res.statusCode, 401);
    }
  });

  test('Rutas productivas /api/chats, /api/whatsapp, /api/media rechazan peticiones sin token', () => {
    const productiveEndpoints = [
      '/api/chats',
      '/api/chats/5491112345678@c.us/messages',
      '/api/whatsapp/status',
      '/api/whatsapp/chats',
      '/api/media/chats',
      '/api/media/media/msg-100',
    ];

    for (const endpoint of productiveEndpoints) {
      const req = createMockRequest({ path: endpoint });
      const res = createMockResponse();
      let nextCalled = false;

      requireJwt(req, res as unknown as Response, () => { nextCalled = true; });
      assert.equal(nextCalled, false, `Endpoint productivo ${endpoint} debe fallar cerrado`);
      assert.equal(res.statusCode, 401);
    }
  });
});
