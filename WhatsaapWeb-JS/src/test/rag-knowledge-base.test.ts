// Test environment variables before config load
process.env.JWT_SECRET = 'test-only-jwt-secret-with-at-least-32-characters-for-testing';
process.env.DB_PASSWORD = 'test-only-database-password';
process.env.META_TOKEN_ENCRYPTION_KEY = 'test-encryption-key-with-at-least-32-chars-for-aes256';

import assert from 'node:assert/strict';
const { createFixtureAccessToken, createMemoryKnowledgeBaseService } = require('./fixtures/embeddingGateway') as typeof import('./fixtures/embeddingGateway');
import { describe, it } from 'node:test';
import { DocumentParser } from '../services/ai/rag/DocumentParser';
import { TextChunker } from '../services/ai/rag/TextChunker';
import { KnowledgeBaseService } from '../services/ai/rag/KnowledgeBaseService';
import { ModelGateway } from '../services/ai/gateway/ModelGateway';
import { ByokService } from '../services/ai/gateway/byok/ByokService';
import { QuotaManager } from '../services/ai/gateway/QuotaManager';
import { TokenCostLedger } from '../services/ai/gateway/TokenCostLedger';
import createAiRoutes from '../routes/ai.routes';
import jwt from 'jsonwebtoken';

async function invokeRoute(
  router: any,
  method: 'get' | 'post' | 'delete',
  path: string,
  options: {
    body?: any;
    query?: any;
    params?: any;
    token?: string;
  } = {}
) {
  const layer = router.stack.find(
    (candidate: any) =>
      candidate.route?.path === path && candidate.route?.methods?.[method.toLowerCase()]
  );
  if (!layer) {
    throw new Error(`Route ${method.toUpperCase()} ${path} not found in router stack`);
  }

  let statusCode = 200;
  let jsonBody: any = null;

  const req: any = {
    method: method.toUpperCase(),
    params: options.params || {},
    query: options.query || {},
    body: options.body || {},
    headers: options.token ? { authorization: `Bearer ${options.token}` } : {},
    originalUrl: `/api/v1/ai${path}`,
  };

  const res: any = {
    setHeader() { return res; },
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(data: any) {
      jsonBody = data;
      return res;
    },
  };

  for (const mw of layer.route.stack) {
    let calledNext = false;
    let nextErr: any = null;
    try {
      await mw.handle(req, res, (err: any) => {
        calledNext = true;
        nextErr = err;
      });
    } catch (caughtErr) {
      nextErr = caughtErr;
    }

    if (nextErr) {
      return {
        status: nextErr.statusCode || (nextErr.name === 'JsonWebTokenError' ? 401 : 500),
        body: { error: nextErr.code || 'ERROR', message: nextErr.message },
      };
    }

    if (!calledNext) {
      break;
    }
  }

  return { status: statusCode, body: jsonBody };
}

describe('PR-F5-03: Backend pgvector RAG Knowledge Base & GDPR Purge Tests', () => {
  const tokenTenant1 = createFixtureAccessToken({ id: 1, sub: 'user_1', tenantId: 1, companyId: 1, role: 'admin', rol: 'ADMIN' });
  const tokenTenant2 = createFixtureAccessToken({ id: 2, sub: 'user_2', tenantId: 2, companyId: 2, role: 'admin', rol: 'ADMIN' });

  describe('1. DocumentParser Multi-Format Extraction', () => {
    it('normalizes plain text whitespace and line breaks', () => {
      const raw = '  Línea 1 \r\n\r\n   Línea 2   \n\n\n\n  Línea 3  ';
      const parsed = DocumentParser.parse(raw, 'text');
      assert.equal(parsed, 'Línea 1\n\nLínea 2\n\nLínea 3');
    });

    it('transforms CSV tables into semantic prose records', () => {
      const csv = 'id,nombre,precio,stock\nPROD-1,Laptop Pro,1200,15\nPROD-2,Mouse Wireless,35,120';
      const parsed = DocumentParser.parse(csv, 'csv');
      assert.match(parsed, /Fila 1: id: PROD-1; nombre: Laptop Pro; precio: 1200; stock: 15\./);
      assert.match(parsed, /Fila 2: id: PROD-2; nombre: Mouse Wireless; precio: 35; stock: 120\./);
    });

    it('formats JSON data into readable structured statements', () => {
      const json = JSON.stringify({
        company: 'Automat S.A.',
        guaranteeMonths: 12,
        supportHours: '9:00 - 18:00',
      });
      const parsed = DocumentParser.parse(json, 'json');
      assert.match(parsed, /company: Automat S\.A\./);
      assert.match(parsed, /guaranteeMonths: 12/);
      assert.match(parsed, /supportHours: 9:00 - 18:00/);
    });

    it('preserves markdown headers and strips noisy image links', () => {
      const md = '# Política de Envíos\n\n![Camión de entrega](http://example.com/truck.png)\n\nLos envíos se despachan en 24h.';
      const parsed = DocumentParser.parse(md, 'markdown');
      assert.match(parsed, /# Política de Envíos/);
      assert.match(parsed, /Los envíos se despachan en 24h\./);
      assert.ok(!parsed.includes('http://example.com/truck.png'));
    });
  });

  describe('2. TextChunker Sliding Window Algorithm', () => {
    it('estimates token count using standard 4-char heuristic', () => {
      const text = 'Esta es una frase de prueba para conteo de tokens.';
      const tokens = TextChunker.estimateTokens(text);
      assert.equal(tokens, Math.ceil(text.trim().length / 4));
    });

    it('chunks short text into a single chunk', () => {
      const text = 'Texto corto para prueba.';
      const chunks = TextChunker.chunk(text, { chunkSizeTokens: 512, overlapTokens: 64 });
      assert.equal(chunks.length, 1);
      assert.equal(chunks[0].index, 0);
      assert.equal(chunks[0].text, text);
    });

    it('chunks multi-paragraph long text with overlapping context', () => {
      const paragraphs = [
        'Párrafo 1 con descripción inicial extensa del producto y características técnicas generales.',
        'Párrafo 2 con detalles de compatibilidad eléctrica, dimensiones y peso del dispositivo.',
        'Párrafo 3 con instrucciones paso a paso para la instalación y configuración inicial del firmware.',
        'Párrafo 4 con resolución de problemas frecuentes, códigos de error y soporte al cliente.',
      ];
      const fullText = paragraphs.join('\n\n');
      const chunks = TextChunker.chunk(fullText, { chunkSizeTokens: 30, overlapTokens: 10 });
      assert.ok(chunks.length >= 2, `Expected at least 2 chunks, got ${chunks.length}`);
      for (let i = 0; i < chunks.length; i++) {
        assert.equal(chunks[i].index, i);
        assert.ok(chunks[i].text.length > 0);
        assert.ok(chunks[i].tokenCount > 0);
      }
    });
  });

  describe('3. ModelGateway Embedding Generation & Ledger Auditing', () => {
    const mockUow = {
      run: async (_tenantId: number, fn: any) =>
        fn({
          query: async (sql: string) => {
            if (sql.includes('ai_token_cost_ledger')) {
              return { rows: [{ id: 101 }], rowCount: 1 };
            }
            if (sql.includes('tenant_ai_quotas')) {
              return {
                rows: [
                  {
                    monthly_cost_limit_micro_usd: 100000000,
                    current_month_cost_micro_usd: 0,
                    monthly_token_limit: 10000000,
                    current_month_tokens_used: 0,
                    hard_limit_enabled: true,
                    hard_limit_action: 'block',
                  },
                ],
                rowCount: 1,
              };
            }
            return { rows: [], rowCount: 0 };
          },
        }),
    } as any;

    it('generates 1536-dimensional L2-normalized vectors and audits ledger', async () => {
      const gateway = new ModelGateway(
        new ByokService(mockUow),
        new QuotaManager(mockUow),
        new TokenCostLedger(mockUow), undefined, 'synthetic'
      );

      const res = await gateway.embed({
        tenantId: 1,
        model: 'text-embedding-3-small',
        input: ['Consulta de catálogo para agente de ventas.'],
      });

      assert.equal(res.embeddings.length, 1);
      assert.equal(res.embeddings[0].length, 1536);
      assert.ok(res.usage.promptTokens > 0);
      assert.equal(res.model, 'text-embedding-3-small');

      const sumSq = res.embeddings[0].reduce((sum, v) => sum + v * v, 0);
      assert.ok(Math.abs(sumSq - 1.0) < 0.05, `Expected unit vector length ~1.0, got ${sumSq}`);
    });

    it('rejects provider failures instead of generating replacement vectors', async () => {
      const credential = {
        resolveDecryptedCredential: async () => ({ apiKey: 'test-only', baseUrl: null, defaultModel: null, isByok: true }),
      } as unknown as ByokService;
      const quota = { assertWithinQuota: async () => undefined } as unknown as QuotaManager;
      const gateway = new ModelGateway(credential, quota, undefined, async () => new Response('unavailable', { status: 503 }));

      await assert.rejects(gateway.embed({ tenantId: 1, input: ['texto'] }), {
        code: 'EMBEDDING_REQUEST_FAILED', statusCode: 502,
      });
    });
  });

  describe('4. KnowledgeBaseService Ingestion, Search & GDPR Purge', () => {
    const kbService = createMemoryKnowledgeBaseService();

    it('creates and lists knowledge collections per tenant', async () => {
      const coll = await kbService.createCollection(1, {
        name: 'Catálogo Verano 2026',
        description: 'Colección de productos de verano',
        distanceMetric: 'cosine',
      });

      assert.ok(coll.id.startsWith('coll_'));
      assert.equal(coll.name, 'Catálogo Verano 2026');

      const list = await kbService.listCollections(1);
      assert.ok(list.some((c) => c.id === coll.id));

      const listTenant2 = await kbService.listCollections(2);
      assert.ok(!listTenant2.some((c) => c.id === coll.id));
    });

    it('ingests multi-chunk document and executes semantic query', async () => {
      const coll = await kbService.createCollection(1, {
        name: 'Políticas de Devolución',
      });

      const ingestRes = await kbService.ingestDocument(1, {
        collectionId: coll.id,
        documentName: 'garantia.txt',
        fileType: 'text',
        content:
          'Las devoluciones de productos tienen un plazo máximo de 30 días con boleta.\n\n' +
          'Los productos en liquidación no tienen cambio ni devolución según los términos.',
        customerId: 'cust_client_1',
      });

      assert.ok(ingestRes.chunksCreated >= 1);
      assert.ok(ingestRes.chunkIds.length >= 1);

      const queryRes = await kbService.queryKnowledge(1, {
        collectionId: coll.id,
        query: 'plazo de devolucion',
        topK: 3,
        minSimilarity: 0.1,
      });

      assert.ok(queryRes.totalResults >= 1);
      assert.ok(queryRes.chunks[0].similarityScore > 0);
      assert.match(queryRes.chunks[0].content, /devoluciones/i);
    });

    it('executes GDPR Right-to-be-Forgotten purge for a customer', async () => {
      const coll = await kbService.createCollection(1, {
        name: 'Historial de Conversaciones',
      });

      await kbService.ingestDocument(1, {
        collectionId: coll.id,
        documentName: 'chat_gdpr.txt',
        fileType: 'text',
        content: 'El cliente solicita información sobre su cuenta personal.',
        customerId: 'cust_to_purge_99',
      });

      const purgeRes = await kbService.purgeKnowledge(1, {
        scope: 'customer',
        targetId: 'cust_to_purge_99',
        reason: 'GDPR RTBF Exercise',
      });

      assert.equal(purgeRes.success, true);
      assert.equal(purgeRes.scope, 'customer');
      assert.ok(purgeRes.purgedChunksCount >= 1);

      const checkRes = await kbService.queryKnowledge(1, {
        collectionId: coll.id,
        query: 'cuenta personal',
        customerId: 'cust_to_purge_99',
        minSimilarity: 0.1,
      });
      assert.equal(checkRes.totalResults, 0);
    });
  });

  describe('5. Express AI RAG Routes Integration', () => {
    const router = createAiRoutes({ knowledgeBaseService: createMemoryKnowledgeBaseService() });

    it('GET /api/v1/ai/rag/collections requires JWT and returns collections', async () => {
      const unauth = await invokeRoute(router, 'get', '/rag/collections');
      assert.equal(unauth.status, 401);

      const res = await invokeRoute(router, 'get', '/rag/collections', {
        token: tokenTenant1,
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.ok(Array.isArray(res.body.data));
    });

    it('POST /api/v1/ai/rag/collections creates new collection and returns 201', async () => {
      const res = await invokeRoute(router, 'post', '/rag/collections', {
        token: tokenTenant1,
        body: {
          name: 'Manual de Usuario API',
          description: 'Documentación técnica',
          distanceMetric: 'cosine',
        },
      });

      assert.equal(res.status, 201);
      assert.equal(res.body.success, true);
      assert.equal(res.body.data.name, 'Manual de Usuario API');
    });

    it('POST /api/v1/ai/rag/query executes semantic search and returns 200', async () => {
      const res = await invokeRoute(router, 'post', '/rag/query', {
        token: tokenTenant1,
        body: {
          query: 'cómo configurar el token de autenticación?',
          topK: 3,
        },
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.equal(typeof res.body.data.totalResults, 'number');
      assert.ok(Array.isArray(res.body.data.chunks));
    });

    it('DELETE /api/v1/ai/rag/purge executes GDPR purge with validation', async () => {
      // Rejects customer scope without targetId
      const badReq = await invokeRoute(router, 'delete', '/rag/purge', {
        token: tokenTenant1,
        body: {
          scope: 'customer',
          reason: 'Missing target',
        },
      });
      assert.equal(badReq.status, 400);

      // Executes valid tenant purge
      const res = await invokeRoute(router, 'delete', '/rag/purge', {
        token: tokenTenant1,
        body: {
          scope: 'tenant',
          reason: 'Tenant data cleanup',
        },
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.data.scope, 'tenant');
    });
  });
});
