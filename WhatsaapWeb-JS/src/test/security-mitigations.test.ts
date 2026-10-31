import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Response } from 'express';

process.env.JWT_SECRET ||= 'test-only-jwt-secret-with-at-least-32-characters-for-testing';
process.env.DB_PASSWORD ||= 'test-only-database-password';

const configModule = require('../config/index');
const config = (configModule.default || configModule) as typeof import('../config/index').default;

const {
  requireJwt,
  resolveWhatsappCompanyId,
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
  createTenantAToken,
  createTenantBToken,
  MALFORMED_TOKEN,
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

describe('Security Mitigations Regression Suite (P0 Hardening & Verification)', () => {

  describe('SEC-03: JWT Fail-Closed & Tenant Claim Enforcement', () => {
    test('rechaza petición sin cabecera Authorization con 401 fail-closed', () => {
      const req = createMockRequest();
      const res = createMockResponse();
      let nextCalled = false;

      requireJwt(req, res as unknown as Response, () => {
        nextCalled = true;
      });

      assert.equal(nextCalled, false);
      assert.equal(res.statusCode, 401);
      assert.equal(res.body.success, false);
    });

    test('rechaza token expirado o manipulado con 401', () => {
      const expiredToken = createExpiredToken();
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

    test('SEC-03: rechaza token sin claim de empresa con 403 sin fallback a defaultCompanyId', () => {
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
      assert.equal(res.body.error, 'Empresa no asociada al token');
      assert.equal(req.whatsappCompanyId, undefined);
    });

    test('SEC-03: rechaza claim de empresa no positivo o nulo con 403', () => {
      const tokenInvalidClaim = createInvalidCompanyClaimToken(0);
      const req = createMockRequest({
        headers: { authorization: `Bearer ${tokenInvalidClaim}` },
      });
      const res = createMockResponse();
      let nextCalled = false;

      requireJwt(req, res as unknown as Response, () => {
        nextCalled = true;
      });

      assert.equal(nextCalled, false);
      assert.equal(res.statusCode, 403);
      assert.equal(res.body.error, 'Empresa no asociada al token');
    });

    test('SEC-03: token con claim booleano { companyId: true } es rechazado con 403 y no coerciona a tenant 1', () => {
      const boolToken = createInvalidCompanyClaimToken(true);
      const req = createMockRequest({
        headers: { authorization: `Bearer ${boolToken}` },
      });
      const res = createMockResponse();
      let nextCalled = false;

      requireJwt(req, res as unknown as Response, () => {
        nextCalled = true;
      });

      assert.equal(nextCalled, false);
      assert.equal(res.statusCode, 403);
      assert.equal(res.body.error, 'Empresa no asociada al token');
      assert.equal(req.whatsappCompanyId, undefined);
    });

    test('resolveWhatsappCompanyId rechaza invocación si req carece de empresa', () => {
      const req = createMockRequest();
      assert.throws(
        () => resolveWhatsappCompanyId(req),
        /TENANT_CLAIM_REQUIRED/
      );
    });
  });

  describe('SEC-01: Hardened Direct-SQL Tenant Isolation in ResourceAuth (Chats)', () => {
    test('rechaza identificador de chat ausente con 400 BAD_REQUEST', async () => {
      const mockDb = { query: async () => ({ rows: [] }) };
      const resourceAuth = createResourceAuth(mockDb);
      const req = createMockRequest({
        whatsappCompanyId: 1,
        params: {},
        method: 'GET',
      });
      const res = createMockResponse();
      let nextCalled = false;

      await resourceAuth.requireChatTenantAccess(req, res as unknown as Response, () => {
        nextCalled = true;
      });

      assert.equal(nextCalled, false);
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.error, 'BAD_REQUEST');
      assert.match(res.body.message, /requerido/);
    });

    test('rechaza formato de chatId inválido o caracteres ilegales con 400 INVALID_CHAT_ID', async () => {
      const mockDb = { query: async () => ({ rows: [] }) };
      const resourceAuth = createResourceAuth(mockDb);
      const req = createMockRequest({
        whatsappCompanyId: 1,
        params: { chatId: '5491112345678; DROP TABLE conversations;--' },
        method: 'GET',
      });
      const res = createMockResponse();
      let nextCalled = false;

      await resourceAuth.requireChatTenantAccess(req, res as unknown as Response, () => {
        nextCalled = true;
      });

      assert.equal(nextCalled, false);
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.error, 'INVALID_CHAT_ID');
    });

    test('aplica aislamiento SQL directo con company_id en consulta de chat numérico', async () => {
      const executedQueries: { sql: string; params: unknown[] }[] = [];
      const mockDb = {
        query: async (sql: string, params: unknown[] = []) => {
          executedQueries.push({ sql, params });
          // Simula DB donde id=42 pertenece a Tenant 1
          if (sql.includes('company_id = $2') && params[0] === 42 && params[1] === 1) {
            return { rows: [{ id: 42, company_id: 1, external_conversation_id: '5491111111111@c.us' }] };
          }
          return { rows: [] };
        },
      };

      const resourceAuth = createResourceAuth(mockDb);
      const req = createMockRequest({
        whatsappCompanyId: 1,
        params: { id: '42' },
        method: 'GET',
      });
      const res = createMockResponse();
      let nextCalled = false;

      await resourceAuth.requireChatTenantAccess(req, res as unknown as Response, () => {
        nextCalled = true;
      });

      assert.equal(nextCalled, true);
      assert.equal(req.conversation?.id, 42);
      // Validar que la consulta SQL incluyó directamente company_id = $2
      assert.ok(executedQueries.some(q => q.sql.includes('company_id = $2') && q.params[1] === 1));
    });

    test('SEC-01: acceso cross-tenant a chat numérico ajeno retorna 403 Forbidden', async () => {
      const mockDb = {
        query: async (sql: string, params: unknown[] = []) => {
          // Para Tenant 1, id=99 no retorna nada (aislamiento directo en SQL)
          if (sql.includes('company_id = $2')) {
            return { rows: [] };
          }
          // Chequeo de existencia para cualquier tenant: existe bajo empresa 2
          if (sql.includes('SELECT id, company_id FROM conversations WHERE id = $1')) {
            return { rows: [{ id: 99, company_id: 2 }] };
          }
          return { rows: [] };
        },
      };

      const resourceAuth = createResourceAuth(mockDb);
      const req = createMockRequest({
        whatsappCompanyId: 1, // Solicitante es Tenant 1
        params: { id: '99' }, // Conversación pertenece a Tenant 2
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
      assert.match(res.body.message, /otra empresa/);
    });

    test('chat no existente en ningún tenant retorna 404 CHAT_NOT_FOUND', async () => {
      const mockDb = { query: async () => ({ rows: [] }) };
      const resourceAuth = createResourceAuth(mockDb);
      const req = createMockRequest({
        whatsappCompanyId: 1,
        params: { id: '9999' },
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

    test('SEC-01: acceso cross-tenant a WhatsApp JID ajeno retorna 403 Forbidden', async () => {
      const mockDb = {
        query: async (sql: string, params: unknown[] = []) => {
          if (sql.includes('company_id = $2')) {
            return { rows: [] }; // No pertenece a Tenant 1
          }
          if (sql.includes('SELECT id, company_id FROM conversations') && sql.includes('external_conversation_id = ANY')) {
            return { rows: [{ id: 77, company_id: 2 }] }; // Pertenece a Tenant 2
          }
          return { rows: [] };
        },
      };

      const resourceAuth = createResourceAuth(mockDb);
      const req = createMockRequest({
        whatsappCompanyId: 1,
        params: { chatId: '5492222222222@c.us' },
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

    test('permite nuevo mensaje POST outbound a número no registrado previamente', async () => {
      const mockDb = { query: async () => ({ rows: [] }) };
      const resourceAuth = createResourceAuth(mockDb);
      const req = createMockRequest({
        whatsappCompanyId: 1,
        params: { chatId: '5493333333333@c.us' },
        method: 'POST',
      });
      const res = createMockResponse();
      let nextCalled = false;

      await resourceAuth.requireChatTenantAccess(req, res as unknown as Response, () => {
        nextCalled = true;
      });

      assert.equal(nextCalled, true);
    });

    test('POST outbound a JID externo no dispara 403 cuando otra empresa ya tiene conversacion con el mismo contacto', async () => {
      const mockDb = {
        query: async (sql: string, params: unknown[] = []) => {
          if (sql.includes('company_id = $2') && params[1] === 1) {
            return { rows: [] }; // No existe para Tenant 1
          }
          if (sql.includes('SELECT id, company_id FROM conversations') && sql.includes('external_conversation_id = ANY')) {
            return { rows: [{ id: 99, company_id: 2, external_conversation_id: '5491155554444@c.us' }] }; // Existe para Tenant 2
          }
          return { rows: [] };
        },
      };

      const resourceAuth = createResourceAuth(mockDb);
      const req = createMockRequest({
        whatsappCompanyId: 1,
        params: { chatId: '5491155554444@c.us' },
        method: 'POST',
        body: { message: 'Iniciando conversacion desde Tenant 1' },
      });
      const res = createMockResponse();
      let nextCalled = false;

      await resourceAuth.requireChatTenantAccess(req, res as unknown as Response, () => {
        nextCalled = true;
      });

      assert.equal(nextCalled, true);
      assert.equal(res.statusCode, 200);
    });
  });

  describe('SEC-06: Hardened Direct-SQL Cross-Tenant Isolation (Media & Vouchers)', () => {
    test('rechaza identificador de media ausente con 400 BAD_REQUEST', async () => {
      const mockDb = { query: async () => ({ rows: [] }) };
      const resourceAuth = createResourceAuth(mockDb);
      const req = createMockRequest({
        whatsappCompanyId: 1,
        params: {},
        method: 'GET',
      });
      const res = createMockResponse();
      let nextCalled = false;

      await resourceAuth.requireMediaTenantAccess(req, res as unknown as Response, () => {
        nextCalled = true;
      });

      assert.equal(nextCalled, false);
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.error, 'BAD_REQUEST');
    });

    test('aplica aislamiento SQL directo con m.company_id = $2 para media', async () => {
      const executedQueries: { sql: string; params: unknown[] }[] = [];
      const mockDb = {
        query: async (sql: string, params: unknown[] = []) => {
          executedQueries.push({ sql, params });
          if (sql.includes('m.company_id = $2') && params[0] === 'media-own-123' && params[1] === 1) {
            return {
              rows: [{
                message_id: 10,
                company_id: 1,
                attachment_id: 20,
                internal_path: 'uploads/tenants/1/media-own-123.jpg',
                provider_media_id: 'media-own-123',
              }],
            };
          }
          return { rows: [] };
        },
      };

      const resourceAuth = createResourceAuth(mockDb);
      const req = createMockRequest({
        whatsappCompanyId: 1,
        params: { messageId: 'media-own-123' },
        method: 'GET',
      });
      const res = createMockResponse();
      let nextCalled = false;

      await resourceAuth.requireMediaTenantAccess(req, res as unknown as Response, () => {
        nextCalled = true;
      });

      assert.equal(nextCalled, true);
      assert.equal(req.mediaAttachment?.attachment_id, 20);
      assert.ok(executedQueries.some(q => q.sql.includes('m.company_id = $2') && q.params[1] === 1));
    });

    test('SEC-06: media de Tenant 2 solicitado por Tenant 1 devuelve 403 Forbidden', async () => {
      const mockDb = {
        query: async (sql: string) => {
          if (sql.includes('m.company_id = $2')) {
            return { rows: [] };
          }
          return {
            rows: [{ message_id: 50, company_id: 2 }],
          };
        },
      };

      const resourceAuth = createResourceAuth(mockDb);
      const req = createMockRequest({
        whatsappCompanyId: 1,
        params: { messageId: 'media-tenant-2' },
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
    });

    test('SEC-06: comprobante de pago con intento de path traversal devuelve 400 BAD_REQUEST', async () => {
      const mockDb = { query: async () => ({ rows: [] }) };
      const resourceAuth = createResourceAuth(mockDb);
      const req = createMockRequest({
        whatsappCompanyId: 1,
        params: { filename: '../../../etc/passwd' },
        method: 'GET',
      });
      const res = createMockResponse();
      let nextCalled = false;

      await resourceAuth.requireVoucherTenantAccess(req, res as unknown as Response, () => {
        nextCalled = true;
      });

      assert.equal(nextCalled, false);
      // path.basename ('passwd') previene traversal o si es inválido se rechaza
      assert.ok(res.statusCode === 400 || res.statusCode === 404);
    });

    test('SEC-06: comprobante de Tenant 2 solicitado por Tenant 1 devuelve 403 Forbidden', async () => {
      const mockDb = {
        query: async (sql: string) => {
          if (sql.includes('company_id = $3')) {
            return { rows: [] };
          }
          return {
            rows: [{ id: 80, company_id: 2, file_url: '/vouchers/receipt-tenant2.pdf' }],
          };
        },
      };

      const resourceAuth = createResourceAuth(mockDb);
      const req = createMockRequest({
        whatsappCompanyId: 1,
        params: { filename: 'receipt-tenant2.pdf' },
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

    test('SEC-06: consulta de comprobante con comodines SQL LIKE ("%" o "_") retorna 400 y no filtra existencia cross-tenant', async () => {
      let queryExecuted = false;
      const mockDb = {
        query: async () => {
          queryExecuted = true;
          return { rows: [{ id: 90, company_id: 2, file_url: '/vouchers/secret-tenant2.pdf' }] };
        },
      };

      const resourceAuth = createResourceAuth(mockDb);

      for (const wildcard of ['%', '_', '___', '%test', 'test%', 'receipt%.pdf']) {
        const req = createMockRequest({
          whatsappCompanyId: 1,
          params: { filename: wildcard },
          method: 'GET',
        });
        const res = createMockResponse();
        let nextCalled = false;

        await resourceAuth.requireVoucherTenantAccess(req, res as unknown as Response, () => {
          nextCalled = true;
        });

        assert.equal(nextCalled, false, `Wildcard "${wildcard}" no debe llamar next()`);
        assert.equal(res.statusCode, 400, `Wildcard "${wildcard}" debe retornar 400`);
        assert.equal(res.body.error, 'BAD_REQUEST');
        assert.equal(res.body.message, 'Identificador de comprobante invalido');
      }

      assert.equal(queryExecuted, false, 'No debe ejecutar consultas SQL ante comodines ilegales');
    });
  });

  describe('Multipart Routes Protection & Fail-Closed Body Parsing', () => {
    test('requireChatTenantAccess procesa req.body.chatId provisto tras multer', async () => {
      const executedQueries: { sql: string; params: unknown[] }[] = [];
      const mockDb = {
        query: async (sql: string, params: unknown[] = []) => {
          executedQueries.push({ sql, params });
          return { rows: [{ id: 101, company_id: 1, external_conversation_id: '5491199887766@c.us' }] };
        },
      };

      const resourceAuth = createResourceAuth(mockDb);
      // Simula petición multipart parseada por multer con req.body.chatId
      const req = createMockRequest({
        whatsappCompanyId: 1,
        params: {},
        body: { chatId: '5491199887766@c.us', message: 'Hello' },
        method: 'POST',
      });
      const res = createMockResponse();
      let nextCalled = false;

      await resourceAuth.requireChatTenantAccess(req, res as unknown as Response, () => {
        nextCalled = true;
      });

      assert.equal(nextCalled, true);
      assert.equal(req.conversation?.id, 101);
    });

    test('multipart sin chatId en body es rechazado con 400 BAD_REQUEST inmediatamente', async () => {
      const mockDb = { query: async () => ({ rows: [] }) };
      const resourceAuth = createResourceAuth(mockDb);
      const req = createMockRequest({
        whatsappCompanyId: 1,
        params: {},
        body: { message: 'No destination' },
        method: 'POST',
      });
      const res = createMockResponse();
      let nextCalled = false;

      await resourceAuth.requireChatTenantAccess(req, res as unknown as Response, () => {
        nextCalled = true;
      });

      assert.equal(nextCalled, false);
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.error, 'BAD_REQUEST');
    });

    test('ruta /api/whatsapp/send-message con upload.single("file") antes de requireChatTenantAccess procesa correctamente multipart/form-data con chatId', async () => {
      const express = require('express');
      const http = require('http');
      const pool = require('../config/database');
      const { createWhatsAppRoutes } = require('../routes/whatsappRoutes');

      const originalQuery = pool.query;
      pool.query = async () => ({ rows: [] });

      const mockService = {
        getCompanyStatus: async () => ({}),
        getQR: () => null,
        getMyInfo: () => ({}),
        sendMessage: async (chatId: string, message: string) => ({
          id: { _serialized: 'msg-123' },
          timestamp: 1234567890,
        }),
      };

      const app = express();
      app.use((req: any, res: any, next: any) => {
        req.whatsappCompanyId = 1;
        next();
      });
      app.use('/api/whatsapp', createWhatsAppRoutes(mockService));

      const server = app.listen(0);
      try {
        const port = (server.address() as any).port;
        const boundary = '----WebKitFormBoundary7MA4YWxkTrZu0gW';
        const body =
          `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="chatId"\r\n\r\n` +
          `123456789@c.us\r\n` +
          `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="message"\r\n\r\n` +
          `Hello world\r\n` +
          `--${boundary}--\r\n`;

        const response: { statusCode: number; body: any } = await new Promise((resolve, reject) => {
          const clientReq = http.request(
            {
              hostname: '127.0.0.1',
              port,
              path: '/api/whatsapp/send-message',
              method: 'POST',
              headers: {
                'Content-Type': `multipart/form-data; boundary=${boundary}`,
                'Content-Length': Buffer.byteLength(body),
              },
            },
            (clientRes: any) => {
              let data = '';
              clientRes.on('data', (chunk: any) => (data += chunk));
              clientRes.on('end', () => {
                resolve({ statusCode: clientRes.statusCode, body: JSON.parse(data) });
              });
            }
          );
          clientReq.on('error', reject);
          clientReq.write(body);
          clientReq.end();
        });

        assert.equal(response.statusCode, 200);
        assert.equal(response.body.success, true);
        assert.equal(response.body.data.messageId, 'msg-123');
      } finally {
        pool.query = originalQuery;
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });
});
