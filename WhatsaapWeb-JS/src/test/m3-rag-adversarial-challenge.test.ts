// Environment variables initialized before modules load
process.env.JWT_SECRET = 'test-only-jwt-secret-with-at-least-32-characters-for-testing';
process.env.DB_PASSWORD = 'test-only-database-password';
process.env.META_TOKEN_ENCRYPTION_KEY = 'test-encryption-key-with-at-least-32-chars-for-aes256';

import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import { KnowledgeBaseService } from '../services/ai/rag/KnowledgeBaseService';
import { TextChunker } from '../services/ai/rag/TextChunker';
import { DocumentParser } from '../services/ai/rag/DocumentParser';
import { ModelGateway } from '../services/ai/gateway/ModelGateway';
import { ByokService } from '../services/ai/gateway/byok/ByokService';
import { QuotaManager } from '../services/ai/gateway/QuotaManager';
import { TokenCostLedger } from '../services/ai/gateway/TokenCostLedger';
import { CostCalculator } from '../services/ai/gateway/CostCalculator';
import createAiRoutes from '../routes/ai.routes';
import {
  calculateCostMicroUsd,
  MODEL_RATE_CARDS,
  ragPurgeRequestV1Schema,
  chunkingConfigV1Schema,
} from '@whatsap-automat/contracts';

// Helper to simulate Express route invocation with JWT tokens
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
    setHeader() {
      return res;
    },
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

describe('M3 Adversarial Challenge: RAG Knowledge Base, Multi-Tenant Isolation & GDPR RTBF', () => {
  const { generateAccessToken } = require('../utils/jwt');
  const tokenTenant1 = generateAccessToken({
    id: 101,
    sub: 'user_t1',
    tenantId: 1,
    companyId: 1,
    role: 'admin',
    rol: 'ADMIN',
  });
  const tokenTenant2 = generateAccessToken({
    id: 202,
    sub: 'user_t2',
    tenantId: 2,
    companyId: 2,
    role: 'admin',
    rol: 'ADMIN',
  });

  // ===========================================================================
  // SECTION 1: Cross-Tenant Vector Query Isolation
  // ===========================================================================
  describe('1. Cross-Tenant Vector Query & Knowledge Isolation', () => {
    let kbService: KnowledgeBaseService;

    beforeEach(() => {
      kbService = new KnowledgeBaseService();
    });

    it('denies Tenant B semantic query access to Tenant A collection and documents', async () => {
      // 1. Tenant 1 creates a private financial collection and ingests confidential data
      const collTenant1 = await kbService.createCollection(1, {
        name: 'Tenant 1 Confidential Financials',
        description: 'Internal financial audit reports',
        distanceMetric: 'cosine',
      });

      await kbService.ingestDocument(1, {
        collectionId: collTenant1.id,
        documentName: 'q4_financials.txt',
        fileType: 'text',
        content: 'Confidential Q4 financial report: EBITDA $50,000,000 USD, customer PIN 987654.',
        customerId: 'cust_t1_vip',
      });

      // 2. Tenant 2 creates their own independent catalog collection
      const collTenant2 = await kbService.createCollection(2, {
        name: 'Tenant 2 Public Catalog',
        description: 'Retail products',
        distanceMetric: 'cosine',
      });

      await kbService.ingestDocument(2, {
        collectionId: collTenant2.id,
        documentName: 'catalog.txt',
        fileType: 'text',
        content: 'Retail items: Black leather shoes $120, cotton white t-shirt $25, socks $10.',
        customerId: 'cust_t2_shopper',
      });

      // 3. Attack 1: Tenant 2 explicitly requests Tenant 1 collectionId
      const crossCollQuery = await kbService.queryKnowledge(2, {
        collectionId: collTenant1.id,
        query: 'EBITDA financial report PIN',
        minSimilarity: 0.0,
        topK: 10,
      });
      assert.equal(
        crossCollQuery.totalResults,
        0,
        'Tenant 2 query to Tenant 1 collectionId MUST return 0 results'
      );
      assert.equal(crossCollQuery.chunks.length, 0);

      // 4. Attack 2: A third tenant (Tenant 3) with NO documents queries unscoped with minSimilarity: 0.0
      const emptyTenantQuery = await kbService.queryKnowledge(3, {
        query: 'EBITDA financial report 987654',
        minSimilarity: 0.0,
        topK: 10,
      });
      assert.equal(
        emptyTenantQuery.totalResults,
        0,
        'Tenant 3 (empty knowledge base) MUST receive 0 results and never see Tenant 1 chunks'
      );

      // 5. Attack 3: Tenant 2 (with own documents) queries unscoped with minSimilarity: 0.0
      const unscopedQuery = await kbService.queryKnowledge(2, {
        query: 'EBITDA financial report 987654',
        minSimilarity: 0.0,
        topK: 10,
      });
      // All returned chunks MUST strictly belong to Tenant 2, zero chunks from Tenant 1
      const leakedChunks = unscopedQuery.chunks.filter(
        (c) => c.collectionId === collTenant1.id || c.content.includes('EBITDA') || c.customerId === 'cust_t1_vip'
      );
      assert.equal(
        leakedChunks.length,
        0,
        'Tenant 2 unscoped query MUST NOT leak Tenant 1 confidential chunks'
      );
      for (const chunk of unscopedQuery.chunks) {
        assert.equal(chunk.collectionId, collTenant2.id);
        assert.notEqual(chunk.collectionId, collTenant1.id);
      }

      // 6. Verification: Tenant 1 querying their own collection receives matches
      const tenant1Query = await kbService.queryKnowledge(1, {
        collectionId: collTenant1.id,
        query: 'EBITDA financial report',
        minSimilarity: 0.1,
      });
      assert.ok(tenant1Query.totalResults >= 1);
      assert.match(tenant1Query.chunks[0].content, /EBITDA \$50,000,000/);
    });

    it('prevents cross-tenant document ingestion, inspection, and deletion', async () => {
      const collTenant1 = await kbService.createCollection(1, {
        name: 'Tenant 1 Sacred Vault',
      });

      // Attack: Tenant 2 attempts to get Tenant 1 collection metadata
      const inspection = await kbService.getCollection(2, collTenant1.id);
      assert.equal(inspection, null, 'Tenant 2 MUST receive null inspecting Tenant 1 collection');

      // Attack: Tenant 2 attempts to ingest document into Tenant 1 collection
      await assert.rejects(
        async () => {
          await kbService.ingestDocument(2, {
            collectionId: collTenant1.id,
            documentName: 'trojan.txt',
            fileType: 'text',
            content: 'Malicious payload injection',
          });
        },
        (err: any) => {
          assert.equal(err.statusCode, 404);
          assert.equal(err.code, 'COLLECTION_NOT_FOUND');
          return true;
        },
        'Tenant 2 MUST be rejected when attempting to ingest into Tenant 1 collection'
      );

      // Attack: Tenant 2 attempts to delete Tenant 1 collection
      const deleteAttempt = await kbService.deleteCollection(2, collTenant1.id);
      assert.equal(deleteAttempt, false, 'Tenant 2 MUST NOT be able to delete Tenant 1 collection');

      // Verify Tenant 1 collection remains alive
      const verifyT1 = await kbService.getCollection(1, collTenant1.id);
      assert.ok(verifyT1 !== null);
      assert.equal(verifyT1?.id, collTenant1.id);
    });

    it('enforces isolation in mock PostgreSQL queries with parameterized tenant_id binding', async () => {
      const executedQueries: { sql: string; params: any[] }[] = [];

      const mockDbUow = {
        run: async (tenantId: number, fn: any) => {
          return fn({
            query: async (sql: string, params: any[] = []) => {
              executedQueries.push({ sql, params });
              if (sql.includes('SELECT') && sql.includes('knowledge_chunks')) {
                // Return rows only matching tenantId parameter
                assert.equal(
                  params[1],
                  tenantId,
                  'SQL query parameter $2 MUST strictly match active tenantId'
                );
                return { rows: [] };
              }
              if (sql.includes('INSERT INTO knowledge_collections')) {
                return {
                  rows: [
                    {
                      id: params[0],
                      tenant_id: params[1],
                      name: params[2],
                      description: params[3],
                      embedding_model: params[4],
                      distance_metric: params[5],
                      chunk_strategy: JSON.parse(params[6]),
                      metadata_json: JSON.parse(params[7]),
                      created_at: new Date(),
                      updated_at: new Date(),
                    },
                  ],
                };
              }
              return { rows: [], rowCount: 0 };
            },
          });
        },
      } as any;

      const dbKbService = new KnowledgeBaseService(mockDbUow);

      // Query from tenant 2
      await dbKbService.queryKnowledge(2, {
        collectionId: 'coll_mock_foreign',
        query: 'secret data leak probe',
        topK: 5,
        minSimilarity: 0.5,
      });

      const chunkQuery = executedQueries.find(
        (q) => q.sql.includes('FROM knowledge_chunks') && q.sql.includes('c.tenant_id = $2')
      );
      assert.ok(chunkQuery, 'Knowledge chunk query MUST include c.tenant_id = $2 filter');
      assert.equal(chunkQuery.params[1], 2, 'Tenant parameter MUST be bound to 2');
    });

    it('enforces cross-tenant isolation at REST route level via JWT claims', async () => {
      const router = createAiRoutes();

      // Tenant 1 creates a collection via API
      const createRes = await invokeRoute(router, 'post', '/rag/collections', {
        token: tokenTenant1,
        body: {
          name: 'T1 API Exclusive Collection',
          distanceMetric: 'cosine',
        },
      });
      assert.equal(createRes.status, 201);
      const t1CollId = createRes.body.data.id;

      // Tenant 2 attempts to query Tenant 1 collection via REST API
      const crossQueryRes = await invokeRoute(router, 'post', '/rag/query', {
        token: tokenTenant2,
        body: {
          collectionId: t1CollId,
          query: 'any confidential information',
        },
      });
      assert.equal(crossQueryRes.status, 200);
      assert.equal(
        crossQueryRes.body.data.totalResults,
        0,
        'REST query cross-tenant MUST return 0 results'
      );
      assert.equal(crossQueryRes.body.data.chunks.length, 0);

      // Tenant 2 attempts to ingest a document into Tenant 1 collection via REST API
      const crossIngestRes = await invokeRoute(
        router,
        'post',
        '/rag/collections/:id/documents',
        {
          token: tokenTenant2,
          params: { id: t1CollId },
          body: {
            collectionId: t1CollId,
            documentName: 'unauthorized.txt',
            fileType: 'text',
            content: 'attempted cross tenant write',
          },
        }
      );
      assert.equal(crossIngestRes.status, 404, 'Cross-tenant ingestion MUST return 404');

      // Tenant 2 attempts to delete Tenant 1 collection via REST API
      const crossDeleteRes = await invokeRoute(router, 'delete', '/rag/collections/:id', {
        token: tokenTenant2,
        params: { id: t1CollId },
      });
      assert.equal(crossDeleteRes.status, 404, 'Cross-tenant deletion MUST return 404');
    });
  });

  // ===========================================================================
  // SECTION 2: GDPR Right-to-be-Forgotten (RTBF) Across All 4 Scopes
  // ===========================================================================
  describe('2. GDPR Right-to-be-Forgotten (RTBF) Purge Across All 4 Scopes', () => {
    let kbService: KnowledgeBaseService;

    beforeEach(() => {
      kbService = new KnowledgeBaseService();
    });

    it('Scope 1 (customer): purges target customer chunks completely while leaving peer customers intact', async () => {
      const coll = await kbService.createCollection(1, {
        name: 'Customer Support Transcripts',
      });

      // Ingest for customer C1 (target for purge)
      await kbService.ingestDocument(1, {
        collectionId: coll.id,
        documentName: 'c1_chat1.txt',
        fileType: 'text',
        content: 'Customer Alice passport 123456 credit card 9999-8888-7777-6666.',
        customerId: 'cust_alice',
      });
      await kbService.ingestDocument(1, {
        collectionId: coll.id,
        documentName: 'c1_chat2.txt',
        fileType: 'text',
        content: 'Customer Alice residential address: 123 Elm Street, Springfield.',
        customerId: 'cust_alice',
      });

      // Ingest for customer C2 (peer customer - MUST NOT be deleted)
      await kbService.ingestDocument(1, {
        collectionId: coll.id,
        documentName: 'c2_chat1.txt',
        fileType: 'text',
        content: 'Customer Bob inquiry regarding product shipping schedule.',
        customerId: 'cust_bob',
      });

      // Cross-Tenant attempt: Tenant 2 attempts to purge Alice's data from Tenant 1
      const attackPurge = await kbService.purgeKnowledge(2, {
        scope: 'customer',
        targetId: 'cust_alice',
        reason: 'Cross-tenant purge attack attempt',
      });
      assert.equal(
        attackPurge.purgedChunksCount,
        0,
        'Tenant 2 purge of Alice MUST purge 0 chunks'
      );

      // Execute legitimate GDPR RTBF purge for Tenant 1 customer Alice
      const legitPurge = await kbService.purgeKnowledge(1, {
        scope: 'customer',
        targetId: 'cust_alice',
        reason: 'GDPR Article 17 Right to erasure request verified by DPO',
      });
      assert.equal(legitPurge.success, true);
      assert.equal(legitPurge.scope, 'customer');
      assert.equal(legitPurge.purgedChunksCount, 2);

      // Verify Alice chunks can no longer be retrieved
      const aliceQuery = await kbService.queryKnowledge(1, {
        collectionId: coll.id,
        query: 'passport credit card residential address',
        customerId: 'cust_alice',
        minSimilarity: 0.1,
      });
      assert.equal(
        aliceQuery.totalResults,
        0,
        'Purged customer Alice data MUST be completely unretrievable'
      );

      // Verify Bob chunks are 100% intact and retrievable
      const bobQuery = await kbService.queryKnowledge(1, {
        collectionId: coll.id,
        query: 'shipping schedule',
        customerId: 'cust_bob',
        minSimilarity: 0.1,
      });
      assert.ok(bobQuery.totalResults >= 1);
      assert.match(bobQuery.chunks[0].content, /Customer Bob inquiry/);
    });

    it('Scope 2 (document): removes only chunks associated with the specific documentId', async () => {
      const coll = await kbService.createCollection(1, {
        name: 'Contract Archive',
      });

      const docA = await kbService.ingestDocument(1, {
        collectionId: coll.id,
        documentId: 'doc_contract_revoked_01',
        documentName: 'revoked_contract.txt',
        fileType: 'text',
        content: 'Terminated vendor contract: NDA terms and clauses for Acme Corp.',
      });

      const docB = await kbService.ingestDocument(1, {
        collectionId: coll.id,
        documentId: 'doc_contract_active_02',
        documentName: 'active_contract.txt',
        fileType: 'text',
        content: 'Active vendor agreement: Service level agreement 99.9% uptime for Zenith Ltd.',
      });

      // Purge document A
      const purgeRes = await kbService.purgeKnowledge(1, {
        scope: 'document',
        targetId: 'doc_contract_revoked_01',
        reason: 'Revocation of contract terms',
      });

      assert.equal(purgeRes.purgedChunksCount, docA.chunksCreated);

      // Query for revoked document content
      const revokedQuery = await kbService.queryKnowledge(1, {
        collectionId: coll.id,
        query: 'Terminated vendor contract NDA terms',
        minSimilarity: 0.1,
      });
      const hasRevoked = revokedQuery.chunks.some((c) => c.documentId === 'doc_contract_revoked_01');
      assert.equal(hasRevoked, false, 'Revoked document chunks MUST NOT be returned');

      // Query for active document content
      const activeQuery = await kbService.queryKnowledge(1, {
        collectionId: coll.id,
        query: 'Active vendor agreement uptime Zenith',
        minSimilarity: 0.1,
      });
      assert.ok(activeQuery.totalResults >= 1);
      assert.equal(activeQuery.chunks[0].documentId, 'doc_contract_active_02');
    });

    it('Scope 3 (collection): completely deletes target collection and cascades chunk deletion', async () => {
      const coll1 = await kbService.createCollection(1, { name: 'To Be Purged Coll' });
      const coll2 = await kbService.createCollection(1, { name: 'Preserved Coll' });

      await kbService.ingestDocument(1, {
        collectionId: coll1.id,
        documentName: 'doc1.txt',
        fileType: 'text',
        content: 'Temporary data for ephemeral campaign.',
      });

      await kbService.ingestDocument(1, {
        collectionId: coll2.id,
        documentName: 'doc2.txt',
        fileType: 'text',
        content: 'Permanent core company knowledge base guidelines.',
      });

      const purgeRes = await kbService.purgeKnowledge(1, {
        scope: 'collection',
        targetId: coll1.id,
        reason: 'Campaign end de-provisioning',
      });

      assert.equal(purgeRes.success, true);
      assert.equal(purgeRes.purgedCollectionsCount, 1);
      assert.ok(purgeRes.purgedChunksCount >= 1);

      // Collection 1 should no longer exist
      const checkColl1 = await kbService.getCollection(1, coll1.id);
      assert.equal(checkColl1, null);

      // Collection 2 should remain healthy with chunks
      const checkColl2 = await kbService.getCollection(1, coll2.id);
      assert.ok(checkColl2 !== null);
      assert.equal(checkColl2?.chunkCount, 1);
    });

    it('Scope 4 (tenant): purges all collections and chunks for the tenant without affecting other tenants', async () => {
      // Tenant 1 sets up 2 collections with data
      const t1CollA = await kbService.createCollection(1, { name: 'T1 Coll A' });
      const t1CollB = await kbService.createCollection(1, { name: 'T1 Coll B' });
      await kbService.ingestDocument(1, { collectionId: t1CollA.id, documentName: 'a.txt', content: 'T1 data A' });
      await kbService.ingestDocument(1, { collectionId: t1CollB.id, documentName: 'b.txt', content: 'T1 data B' });

      // Tenant 2 sets up 1 collection with data
      const t2Coll = await kbService.createCollection(2, { name: 'T2 Coll Permanent' });
      await kbService.ingestDocument(2, { collectionId: t2Coll.id, documentName: 't2.txt', content: 'T2 protected data' });

      // Execute tenant-wide purge on Tenant 1
      const purgeT1 = await kbService.purgeKnowledge(1, {
        scope: 'tenant',
        reason: 'Tenant account termination / full offboarding',
      });

      assert.equal(purgeT1.success, true);
      assert.equal(purgeT1.purgedCollectionsCount, 2);
      assert.equal(purgeT1.purgedChunksCount, 2);

      // Verify Tenant 1 has 0 collections left
      const t1List = await kbService.listCollections(1);
      assert.equal(t1List.length, 0);

      // Verify Tenant 2 collections and chunks are completely intact
      const t2List = await kbService.listCollections(2);
      assert.equal(t2List.length, 1);
      assert.equal(t2List[0].id, t2Coll.id);

      const t2Query = await kbService.queryKnowledge(2, {
        collectionId: t2Coll.id,
        query: 'T2 protected data',
        minSimilarity: 0.1,
      });
      assert.equal(t2Query.totalResults, 1);
    });

    it('validates GDPR RTBF schema requirements strictly (rejects missing targetId / missing reason)', () => {
      // 1. Customer scope without targetId must fail schema validation
      const missingCustomerTarget = ragPurgeRequestV1Schema.safeParse({
        scope: 'customer',
        reason: 'Legal compliance',
      });
      assert.equal(missingCustomerTarget.success, false);

      // 2. Document scope with empty whitespace targetId must fail schema validation
      const emptyDocTarget = ragPurgeRequestV1Schema.safeParse({
        scope: 'document',
        targetId: '   ',
        reason: 'Document cleanup',
      });
      assert.equal(emptyDocTarget.success, false);

      // 3. Collection scope without reason must fail schema validation
      const missingReason = ragPurgeRequestV1Schema.safeParse({
        scope: 'collection',
        targetId: 'coll_123',
      });
      assert.equal(missingReason.success, false);

      // 4. Tenant scope without targetId is valid (targetId is optional for tenant scope)
      const validTenantScope = ragPurgeRequestV1Schema.safeParse({
        scope: 'tenant',
        reason: 'Full tenant deletion',
      });
      assert.equal(validTenantScope.success, true);
    });
  });

  // ===========================================================================
  // SECTION 3: Sliding-Window Chunker Edge Cases
  // ===========================================================================
  describe('3. TextChunker Sliding-Window Edge Cases & Boundary Conditions', () => {
    it('handles empty and whitespace-only input gracefully without crashing', () => {
      // 1. Empty string
      const emptyChunks = TextChunker.chunk('');
      assert.deepEqual(emptyChunks, []);

      // 2. Whitespace only with mixed tabs, spaces, newlines, carriage returns
      const whitespaceChunks = TextChunker.chunk('   \t\t\n\r\n   \n\n\t   ');
      assert.deepEqual(whitespaceChunks, []);

      // 3. Single space
      const singleSpace = TextChunker.chunk(' ');
      assert.deepEqual(singleSpace, []);

      // 4. Token estimation on empty/whitespace returns safe minimum of 1
      assert.equal(TextChunker.estimateTokens(''), 1);
      assert.equal(TextChunker.estimateTokens('   '), 1);
    });

    it('handles single character and single token input correctly', () => {
      const singleChar = TextChunker.chunk('A');
      assert.equal(singleChar.length, 1);
      assert.equal(singleChar[0].index, 0);
      assert.equal(singleChar[0].text, 'A');
      assert.equal(singleChar[0].tokenCount, 1);
      assert.equal(singleChar[0].startChar, 0);
      assert.equal(singleChar[0].endChar, 1);

      const singleWord = TextChunker.chunk('Palabra');
      assert.equal(singleWord.length, 1);
      assert.equal(singleWord[0].text, 'Palabra');
      assert.equal(singleWord[0].tokenCount, 2); // 7 chars / 4 = 1.75 -> ceil = 2
    });

    it('handles enormous single-line paragraphs (50,000 chars) without crashing', () => {
      const startMs = Date.now();

      // Case A: 50,000 characters without punctuation (continuous single token/line)
      const hugeParagraphNoPunctuation = 'palabra '.repeat(6250); // 50,000 chars
      const chunksA = TextChunker.chunk(hugeParagraphNoPunctuation, {
        chunkSizeTokens: 128,
        overlapTokens: 32,
      });

      assert.ok(chunksA.length >= 1, 'Chunker must produce chunks for huge paragraph');
      assert.ok(Date.now() - startMs < 500, 'Chunking 50k chars must complete in < 500ms');

      // Case B: 50,000 characters structured as sentences
      const hugeParagraphWithSentences = 'Esta es una oración de longitud estándar con detalles. '.repeat(900); // ~50,400 chars
      const chunksB = TextChunker.chunk(hugeParagraphWithSentences, {
        chunkSizeTokens: 128,
        overlapTokens: 32,
      });

      assert.ok(chunksB.length > 10, 'Sentences must be split across multiple chunks');
      for (let i = 0; i < chunksB.length; i++) {
        assert.equal(chunksB[i].index, i);
        assert.ok(chunksB[i].text.length > 0);
        assert.ok(chunksB[i].tokenCount > 0);
      }
    });

    it('handles unicode emoji combinations, multibyte ZWJ sequences, and international scripts', () => {
      const unicodeSample = [
        '👨‍👩‍👧‍👦 Familia moderna en videoconferencia internacional.',
        '👩‍💻 Ingeniera de software depurando microservicios en Kubernetes 🚀.',
        '🏳️‍🌈 Bandera de diversidad con soporte Unicode UTF-8 estándar.',
        'Palabras con tildes y diéresis: Pingüino, lingüística, comunicación, perdón, año.',
        'Texto en Japonés: こんにちは世界、AIエージェントの検証です。',
        'Texto en Árabe: مرحبًا بك في نظام الذكاء الاصطناعي متعدد المستأجرين.',
        'Texto en Ruso: Проверка многоарендной изоляции векторной базы данных.',
      ].join('\n\n');

      const chunks = TextChunker.chunk(unicodeSample, {
        chunkSizeTokens: 64,
        overlapTokens: 16,
      });

      assert.ok(chunks.length >= 1);
      // Verify emojis and multibyte sequences remain intact in chunk text
      const fullChunkText = chunks.map((c) => c.text).join(' ');
      assert.ok(fullChunkText.includes('👨‍👩‍👧‍👦'));
      assert.ok(fullChunkText.includes('👩‍💻'));
      assert.ok(fullChunkText.includes('🚀'));
      assert.ok(fullChunkText.includes('Pingüino'));
      assert.ok(fullChunkText.includes('こんにちは世界'));
      assert.ok(fullChunkText.includes('مرحبًا'));
      assert.ok(fullChunkText.includes('Проверка'));
    });

    it('handles overlap >= chunkSize boundary condition safely without infinite looping', () => {
      const text = [
        'Párrafo 1 con información relevante del sistema.',
        'Párrafo 2 con configuraciones avanzadas del gateway de inteligencia artificial.',
        'Párrafo 3 con auditorías de seguridad y controles criptográficos.',
        'Párrafo 4 con balance de costos y límites de consumo mensual.',
      ].join('\n\n');

      // 1. Boundary: overlapTokens === chunkSizeTokens
      const chunksEqual = TextChunker.chunk(text, {
        chunkSizeTokens: 64,
        overlapTokens: 64,
      });
      assert.ok(Array.isArray(chunksEqual));
      assert.ok(chunksEqual.length >= 1);

      // 2. Boundary: overlapTokens > chunkSizeTokens (adversarial inverted config)
      const chunksInverted = TextChunker.chunk(text, {
        chunkSizeTokens: 32,
        overlapTokens: 128,
      });
      assert.ok(Array.isArray(chunksInverted));
      assert.ok(chunksInverted.length >= 1);

      // 3. Boundary: overlapTokens === 0 (zero overlap, strictly disjoint windows)
      const chunksZeroOverlap = TextChunker.chunk(text, {
        chunkSizeTokens: 32,
        overlapTokens: 0,
      });
      assert.ok(Array.isArray(chunksZeroOverlap));
      assert.ok(chunksZeroOverlap.length >= 2);
    });

    it('processes very large 1MB text efficiently', () => {
      const largeParagraph = 'El sistema procesa grandes volúmenes de documentos con alta fidelidad y rendimiento. ';
      const hugeText = largeParagraph.repeat(12000); // ~700,000 - 1,000,000 chars

      const start = Date.now();
      const chunks = TextChunker.chunk(hugeText, {
        chunkSizeTokens: 512,
        overlapTokens: 64,
      });
      const duration = Date.now() - start;

      assert.ok(chunks.length > 50);
      assert.ok(duration < 2000, `Expected 1MB chunking in < 2000ms, took ${duration}ms`);
    });
  });

  // ===========================================================================
  // SECTION 4: ModelGateway.embed() Embedding Ledger Accounting
  // ===========================================================================
  describe('4. ModelGateway.embed() Token Estimation, Rate Cards & Ledger Accounting', () => {
    it('accurately estimates prompt tokens using the 4-char heuristic across single and multiple inputs', async () => {
      const mockUow = {
        run: async (_t: number, fn: any) => fn({ query: async () => ({ rows: [], rowCount: 1 }) }),
      } as any;
      const gateway = new ModelGateway(
        new ByokService(mockUow),
        new QuotaManager(mockUow),
        new TokenCostLedger(mockUow)
      );

      // 1. Single string 4 chars -> 1 token
      const res1 = await gateway.embed({
        tenantId: 1,
        input: ['1234'],
      });
      assert.equal(res1.usage.promptTokens, 1);
      assert.equal(res1.usage.totalTokens, 1);

      // 2. Single string 5 chars -> ceil(5/4) = 2 tokens
      const res2 = await gateway.embed({
        tenantId: 1,
        input: ['12345'],
      });
      assert.equal(res2.usage.promptTokens, 2);

      // 3. Multiple strings: 12 chars + 8 chars = 20 chars -> ceil(20/4) = 5 tokens
      const res3 = await gateway.embed({
        tenantId: 1,
        input: ['Hello World!', 'Testing!'],
      });
      assert.equal(res3.usage.promptTokens, 5);

      // 4. Empty strings -> minimum 1 token
      const res4 = await gateway.embed({
        tenantId: 1,
        input: [''],
      });
      assert.equal(res4.usage.promptTokens, 1);
    });

    it('charges exact micro-USD for text-embedding-3-small according to rate card (20,000 µUSD / 1M)', async () => {
      // 20,000 micro-USD per 1M tokens ($0.02 / 1M)
      assert.equal(MODEL_RATE_CARDS['text-embedding-3-small'].promptPerM, 20000);
      assert.equal(MODEL_RATE_CARDS['text-embedding-3-small'].completionPerM, 0);

      // Test pure math via calculateCostMicroUsd
      // 1,000,000 tokens -> exactly 20,000 micro-USD ($0.02)
      assert.equal(calculateCostMicroUsd('text-embedding-3-small', 1000000, 0), 20000);

      // 100,000 tokens -> exactly 2,000 micro-USD ($0.002)
      assert.equal(calculateCostMicroUsd('text-embedding-3-small', 100000, 0), 2000);

      // 50 tokens -> round((50 * 20000)/1000000) = 1 micro-USD
      assert.equal(calculateCostMicroUsd('text-embedding-3-small', 50, 0), 1);

      // 10 tokens -> round((10 * 20000)/1000000) = round(0.2) = 0 micro-USD
      assert.equal(calculateCostMicroUsd('text-embedding-3-small', 10, 0), 0);

      // Gateway execution check
      const mockUow = {
        run: async (_t: number, fn: any) => fn({ query: async () => ({ rows: [], rowCount: 1 }) }),
      } as any;
      const gateway = new ModelGateway(
        new ByokService(mockUow),
        new QuotaManager(mockUow),
        new TokenCostLedger(mockUow)
      );

      // 400 chars -> 100 tokens -> round((100 * 20000)/1000000) = 2 micro-USD
      const text100Tokens = 'a'.repeat(400);
      const res = await gateway.embed({
        tenantId: 1,
        model: 'text-embedding-3-small',
        input: [text100Tokens],
      });

      assert.equal(res.usage.promptTokens, 100);
      assert.equal(res.costMicroUsd, 2);
    });

    it('charges exact micro-USD for text-embedding-3-large according to rate card (130,000 µUSD / 1M)', async () => {
      // 130,000 micro-USD per 1M tokens ($0.13 / 1M)
      assert.equal(MODEL_RATE_CARDS['text-embedding-3-large'].promptPerM, 130000);

      // 1,000,000 tokens -> exactly 130,000 micro-USD
      assert.equal(calculateCostMicroUsd('text-embedding-3-large', 1000000, 0), 130000);

      // 50,000 tokens -> exactly 6,500 micro-USD
      assert.equal(calculateCostMicroUsd('text-embedding-3-large', 50000, 0), 6500);

      // Gateway execution check: 800 chars -> 200 tokens -> round((200 * 130000)/1000000) = 26 micro-USD
      const mockUow = {
        run: async (_t: number, fn: any) => fn({ query: async () => ({ rows: [], rowCount: 1 }) }),
      } as any;
      const gateway = new ModelGateway(
        new ByokService(mockUow),
        new QuotaManager(mockUow),
        new TokenCostLedger(mockUow)
      );

      const res = await gateway.embed({
        tenantId: 1,
        model: 'text-embedding-3-large',
        input: ['b'.repeat(800)],
      });

      assert.equal(res.usage.promptTokens, 200);
      assert.equal(res.costMicroUsd, 26);
    });

    it('strictly charges zero-cost (0 µUSD) for local nomic-embed-text and local_openai provider', async () => {
      // nomic-embed-text rate card verification
      assert.equal(MODEL_RATE_CARDS['nomic-embed-text'].promptPerM, 0);
      assert.equal(MODEL_RATE_CARDS['nomic-embed-text'].completionPerM, 0);
      assert.equal(calculateCostMicroUsd('nomic-embed-text', 5000000, 0), 0);

      const mockUow = {
        run: async (_t: number, fn: any) => fn({ query: async () => ({ rows: [], rowCount: 1 }) }),
      } as any;
      const gateway = new ModelGateway(
        new ByokService(mockUow),
        new QuotaManager(mockUow),
        new TokenCostLedger(mockUow)
      );

      // Test 1: Explicit nomic-embed-text model
      const resNomic = await gateway.embed({
        tenantId: 1,
        model: 'nomic-embed-text',
        input: ['c'.repeat(40000)], // 10,000 tokens
      });
      assert.equal(resNomic.usage.promptTokens, 10000);
      assert.equal(resNomic.costMicroUsd, 0, 'Local nomic embeddings MUST have zero cost');

      // Test 2: Local provider 'local_openai' with default model resolution
      const resLocalProvider = await gateway.embed({
        tenantId: 1,
        provider: 'local_openai',
        input: ['d'.repeat(20000)],
      });
      assert.equal(resLocalProvider.model, 'nomic-embed-text');
      assert.equal(resLocalProvider.costMicroUsd, 0, 'Local provider embeddings MUST have zero cost');
    });

    it('records immutable audit ledger entries and consumes quota with exact values', async () => {
      const ledgerRecords: any[] = [];
      const quotaConsumptions: any[] = [];

      const mockLedger: any = {
        record: async (entry: any) => {
          ledgerRecords.push(entry);
          return { id: 777, ...entry };
        },
      };

      const mockQuotaManager: any = {
        assertWithinQuota: async (_tenantId: number) => true,
        consume: async (tenantId: number, costMicroUsd: number, tokens: number) => {
          quotaConsumptions.push({ tenantId, costMicroUsd, tokens });
        },
      };

      const mockByokService: any = {
        resolveDecryptedCredential: async () => ({
          apiKey: null,
          baseUrl: null,
          defaultModel: null,
          isByok: true,
        }),
      };

      const gateway = new ModelGateway(mockByokService, mockQuotaManager, mockLedger);

      const embedRes = await gateway.embed({
        tenantId: 42,
        model: 'text-embedding-3-small',
        input: ['Prueba de auditoría contable para el registro de tokens y costo en micro-USD.'],
      });

      // 1. Verify ledger entry structure and parameters
      assert.equal(ledgerRecords.length, 1);
      const entry = ledgerRecords[0];
      assert.equal(entry.tenantId, 42);
      assert.equal(entry.provider, 'openai');
      assert.equal(entry.model, 'text-embedding-3-small');
      assert.equal(entry.operation, 'embedding');
      assert.equal(entry.promptTokens, embedRes.usage.promptTokens);
      assert.equal(entry.completionTokens, 0);
      assert.equal(entry.totalTokens, embedRes.usage.totalTokens);
      assert.equal(entry.costMicroUsd, embedRes.costMicroUsd);
      assert.equal(entry.isByok, true);
      assert.equal(entry.status, 'success');
      assert.equal(entry.metadataJson.inputCount, 1);

      // 2. Verify quota manager consumption
      assert.equal(quotaConsumptions.length, 1);
      assert.equal(quotaConsumptions[0].tenantId, 42);
      assert.equal(quotaConsumptions[0].costMicroUsd, embedRes.costMicroUsd);
      assert.equal(quotaConsumptions[0].tokens, embedRes.usage.totalTokens);
    });

    it('blocks embedding generation when monthly quota hard limit is reached (RATE_LIMITED / 429)', async () => {
      const mockQuotaManager: any = {
        assertWithinQuota: async (tenantId: number) => {
          const quotaErr = new Error(
            `Tenant ${tenantId} exceeded monthly AI budget limit of 100000000 micro-USD`
          ) as any;
          quotaErr.code = 'RATE_LIMITED';
          quotaErr.statusCode = 429;
          throw quotaErr;
        },
        consume: async () => {},
      };

      const gateway = new ModelGateway(
        new ByokService(),
        mockQuotaManager,
        new TokenCostLedger()
      );

      await assert.rejects(
        async () => {
          await gateway.embed({
            tenantId: 99,
            model: 'text-embedding-3-small',
            input: ['Attempted embedding while over budget quota'],
          });
        },
        (err: any) => {
          assert.equal(err.code, 'RATE_LIMITED');
          assert.equal(err.statusCode, 429);
          return true;
        },
        'ModelGateway.embed() MUST reject when quota limit is exceeded'
      );
    });

    it('generates deterministic L2-normalized 1536-dimensional vectors', () => {
      const gateway = new ModelGateway();

      const textA = 'Vector determinista de prueba para agente de soporte.';
      const vecA1 = gateway.generateDeterministicVector(textA);
      const vecA2 = gateway.generateDeterministicVector(textA);

      // Dimensionality verification
      assert.equal(vecA1.length, 1536);
      assert.equal(vecA2.length, 1536);

      // Determinism verification (identical text produces identical vector)
      assert.deepEqual(vecA1, vecA2);

      // L2-normalization verification: sqrt(sum(v_i^2)) ~ 1.0
      const normSq = vecA1.reduce((sum, val) => sum + val * val, 0);
      assert.ok(
        Math.abs(normSq - 1.0) < 0.05,
        `Expected L2 unit vector norm ~ 1.0, got ${normSq}`
      );

      // Divergence verification (different text produces different vector)
      const textB = 'Texto completamente diferente para contrastar distancias.';
      const vecB = gateway.generateDeterministicVector(textB);
      assert.notDeepEqual(vecA1, vecB);
    });
  });

  // ===========================================================================
  // SECTION 5: Advanced Adversarial Security & Concurrency Probing
  // ===========================================================================
  describe('5. Advanced Adversarial Boundaries, SQL Injection Neutralization & Concurrency', () => {
    let kbService: KnowledgeBaseService;

    beforeEach(() => {
      kbService = new KnowledgeBaseService();
    });

    it('neutralizes SQL injection payloads in collectionId, customerId, query, and purge targetId', async () => {
      const coll = await kbService.createCollection(1, {
        name: 'Injection Testing Collection',
      });

      const sqlPayloads = [
        "' OR '1'='1",
        "'; DROP TABLE knowledge_chunks; --",
        "1; SELECT * FROM pg_user; --",
        "' UNION SELECT id, name, null, null FROM users --",
        "admin'--",
      ];

      for (const payload of sqlPayloads) {
        // 1. Ingestion with payload in customerId
        const ingest = await kbService.ingestDocument(1, {
          collectionId: coll.id,
          documentName: 'injection_test.txt',
          content: `Test content for payload ${payload}`,
          customerId: payload,
        });
        assert.ok(ingest.chunksCreated >= 1);

        // 2. Query with payload in query and customerId
        const queryRes = await kbService.queryKnowledge(1, {
          collectionId: coll.id,
          query: payload,
          customerId: payload,
          minSimilarity: 0.0,
        });
        assert.ok(Array.isArray(queryRes.chunks));

        // 3. Purge with payload in targetId
        const purgeRes = await kbService.purgeKnowledge(1, {
          scope: 'customer',
          targetId: payload,
          reason: `SQL Injection audit test with payload ${payload}`,
        });
        assert.equal(purgeRes.success, true);
        assert.ok(purgeRes.purgedChunksCount >= 1);
      }
    });

    it('purges customer chunks when customerId is embedded in metadata_json', async () => {
      const coll = await kbService.createCollection(1, {
        name: 'Metadata Customer Tracking',
      });

      // Ingest document where customerId is in metadata rather than top-level column
      await kbService.ingestDocument(1, {
        collectionId: coll.id,
        documentName: 'meta_customer.txt',
        content: 'Customer specific sensitive information stored with customerId in metadata.',
        metadata: {
          customerId: 'cust_in_metadata_777',
          accountType: 'premium',
        },
      });

      // Execute purge for this customer
      const purge = await kbService.purgeKnowledge(1, {
        scope: 'customer',
        targetId: 'cust_in_metadata_777',
        reason: 'GDPR RTBF for metadata-tracked customer',
      });

      assert.equal(purge.success, true);
      assert.equal(purge.purgedChunksCount, 1);

      // Verify no chunks remain for this collection
      const listColl = await kbService.getCollection(1, coll.id);
      assert.equal(listColl?.chunkCount, 0);
    });

    it('handles high-concurrency query and ingestion bursts without race conditions or memory corruption', async () => {
      const coll = await kbService.createCollection(1, {
        name: 'High Concurrency Stress',
      });

      // 1. Ingest 25 documents concurrently
      const ingestPromises = Array.from({ length: 25 }, (_, i) =>
        kbService.ingestDocument(1, {
          collectionId: coll.id,
          documentName: `stress_doc_${i}.txt`,
          content: `Concurrent document payload batch index #${i} with specialized content keyword_${i}.`,
          customerId: `cust_stress_${i % 5}`,
        })
      );

      const ingestResults = await Promise.all(ingestPromises);
      assert.equal(ingestResults.length, 25);
      const totalCreated = ingestResults.reduce((sum, r) => sum + r.chunksCreated, 0);
      assert.equal(totalCreated, 25);

      // 2. Fire 30 concurrent semantic search queries
      const queryPromises = Array.from({ length: 30 }, (_, i) =>
        kbService.queryKnowledge(1, {
          collectionId: coll.id,
          query: `keyword_${i % 25}`,
          topK: 3,
          minSimilarity: 0.1,
        })
      );

      const queryResults = await Promise.all(queryPromises);
      assert.equal(queryResults.length, 30);
      for (const res of queryResults) {
        assert.ok(res.totalResults >= 1);
        assert.ok(res.executionLatencyMs >= 0);
      }

      // 3. Concurrent purges of different customers
      const purgePromises = [0, 1, 2].map((i) =>
        kbService.purgeKnowledge(1, {
          scope: 'customer',
          targetId: `cust_stress_${i}`,
          reason: `Concurrent customer purge ${i}`,
        })
      );

      const purgeResults = await Promise.all(purgePromises);
      assert.equal(purgeResults.length, 3);
      for (const p of purgeResults) {
        assert.equal(p.success, true);
        assert.equal(p.purgedChunksCount, 5); // 25 / 5 = 5 per customer
      }

      // Verify remaining chunks: 25 - 15 = 10
      const remainingColl = await kbService.getCollection(1, coll.id);
      assert.equal(remainingColl?.chunkCount, 10);
    });
  });
});
