import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  knowledgeCollectionV1Schema,
  createKnowledgeCollectionCommandV1Schema,
  knowledgeChunkV1Schema,
  ingestDocumentCommandV1Schema,
  ingestDocumentResultV1Schema,
  knowledgeQueryRequestV1Schema,
  knowledgeQueryResultV1Schema,
  ragPurgeRequestV1Schema,
  ragPurgeResultV1Schema,
  evalScenarioV1Schema,
  evalSuiteV1Schema,
  evalRunResultV1Schema,
  evalScorecardV1Schema,
  publicationGateResultV1Schema,
  evalSimulateRequestV1Schema,
  computeAgentSpecHash,
  calculateCostMicroUsd,
  MODEL_RATE_CARDS,
  type AgentGraphVersionV1,
} from '../src';

describe('PR-F5-03: RAG, Eval Simulator & Deterministic Spec Hash Contracts', () => {
  describe('1. RAG Knowledge Base Contracts', () => {
    it('validates a valid knowledgeCollectionV1Schema with defaults', () => {
      const collection = knowledgeCollectionV1Schema.parse({
        id: 'coll_catalog_1',
        tenantId: 1,
        name: 'Catálogo de Productos',
        description: 'Vectores de productos de la tienda',
      });

      assert.equal(collection.id, 'coll_catalog_1');
      assert.equal(collection.embeddingModel, 'text-embedding-3-small');
      assert.equal(collection.distanceMetric, 'cosine');
      assert.equal(collection.chunkStrategy.strategy, 'sliding_window');
      assert.equal(collection.chunkStrategy.chunkSizeTokens, 512);
      assert.equal(collection.chunkStrategy.overlapTokens, 64);
    });

    it('validates createKnowledgeCollectionCommandV1Schema with custom chunking', () => {
      const command = createKnowledgeCollectionCommandV1Schema.parse({
        name: 'FAQ y Políticas',
        description: 'Políticas de garantía',
        distanceMetric: 'l2',
        chunkStrategy: {
          strategy: 'sentence',
          chunkSizeTokens: 256,
          overlapTokens: 32,
        },
      });

      assert.equal(command.name, 'FAQ y Políticas');
      assert.equal(command.distanceMetric, 'l2');
      assert.equal(command.chunkStrategy?.chunkSizeTokens, 256);
    });

    it('validates knowledgeChunkV1Schema with embedding vector', () => {
      const chunk = knowledgeChunkV1Schema.parse({
        id: 'chk_101',
        collectionId: 'coll_catalog_1',
        tenantId: 1,
        documentId: 'doc_faq_2026',
        customerId: 'cust_777',
        chunkIndex: 0,
        content: 'El plazo de entrega es de 24 a 48 horas hábiles.',
        metadata: { category: 'shipping' },
        tokenCount: 14,
        embedding: [0.12, -0.45, 0.88],
      });

      assert.equal(chunk.id, 'chk_101');
      assert.equal(chunk.tokenCount, 14);
      assert.equal(chunk.embedding?.length, 3);
    });

    it('validates ingestDocumentCommandV1Schema and ingestDocumentResultV1Schema', () => {
      const ingestCmd = ingestDocumentCommandV1Schema.parse({
        collectionId: 'coll_catalog_1',
        documentName: 'catalogo.csv',
        fileType: 'csv',
        content: 'id,nombre,precio\n1,Laptop,1200\n2,Mouse,25',
      });

      assert.equal(ingestCmd.fileType, 'csv');

      const ingestRes = ingestDocumentResultV1Schema.parse({
        collectionId: 'coll_catalog_1',
        documentId: 'doc_csv_1',
        documentName: 'catalogo.csv',
        chunksCreated: 2,
        totalTokens: 60,
        chunkIds: ['chk_1', 'chk_2'],
      });

      assert.equal(ingestRes.chunksCreated, 2);
    });

    it('validates knowledgeQueryRequestV1Schema with default topK and minSimilarity', () => {
      const queryReq = knowledgeQueryRequestV1Schema.parse({
        query: 'cuanto tarda el envio?',
      });

      assert.equal(queryReq.topK, 3);
      assert.equal(queryReq.minSimilarity, 0.7);

      const queryRes = knowledgeQueryResultV1Schema.parse({
        query: 'cuanto tarda el envio?',
        totalResults: 1,
        chunks: [
          {
            id: 'chk_101',
            collectionId: 'coll_catalog_1',
            content: 'El plazo de entrega es de 24 a 48 horas hábiles.',
            metadata: { category: 'shipping' },
            similarityScore: 0.89,
            distance: 0.11,
          },
        ],
        executionLatencyMs: 42,
      });

      assert.equal(queryRes.chunks[0].similarityScore, 0.89);
      assert.equal(queryRes.executionLatencyMs, 42);
    });

    it('validates ragPurgeRequestV1Schema scope rules for GDPR Right-to-be-Forgotten', () => {
      // Tenant scope does not require targetId
      const tenantPurge = ragPurgeRequestV1Schema.parse({
        scope: 'tenant',
        reason: 'Tenant offboarding data sanitization',
      });
      assert.equal(tenantPurge.scope, 'tenant');

      // Customer scope requires targetId
      const customerPurge = ragPurgeRequestV1Schema.parse({
        scope: 'customer',
        targetId: 'cust_gdpr_999',
        reason: 'GDPR Article 17 Right to be Forgotten request',
      });
      assert.equal(customerPurge.targetId, 'cust_gdpr_999');

      // Rejects customer scope without targetId
      assert.throws(() => {
        ragPurgeRequestV1Schema.parse({
          scope: 'customer',
          reason: 'Missing target ID',
        });
      });

      const purgeRes = ragPurgeResultV1Schema.parse({
        success: true,
        scope: 'customer',
        targetId: 'cust_gdpr_999',
        purgedChunksCount: 15,
        purgedCollectionsCount: 0,
        purgedAt: new Date().toISOString(),
      });
      assert.equal(purgeRes.purgedChunksCount, 15);
    });
  });

  describe('2. Evaluation Simulator & Scorecard Contracts', () => {
    it('validates evalScenarioV1Schema and assertions', () => {
      const scenario = evalScenarioV1Schema.parse({
        id: 'scen_01',
        name: 'Consulta de stock sin fuga de datos',
        mockInput: 'Tienen stock del producto PROD-101?',
        expectedTools: ['inventory.check_stock'],
        forbiddenTools: ['database_purge', 'delete_account'],
        expectedTextPatterns: ['disponible', 'stock'],
        forbiddenTextPatterns: ['api_key', 'bearer'],
        assertions: [
          {
            id: 'as_1',
            type: 'expected_tool_called',
            target: 'inventory.check_stock',
          },
          {
            id: 'as_2',
            type: 'forbidden_tool_not_called',
            target: 'database_purge',
          },
        ],
      });

      assert.equal(scenario.expectedTools[0], 'inventory.check_stock');
      assert.equal(scenario.assertions.length, 2);
    });

    it('validates evalSuiteV1Schema and rejects empty scenarios', () => {
      const suite = evalSuiteV1Schema.parse({
        id: 'suite_sales_v1',
        tenantId: 1,
        agentGraphId: 'graph_sales',
        name: 'Suite de Calidad Ventas',
        passThresholdPercent: 95.0,
        scenarios: [
          {
            id: 'scen_01',
            name: 'Saludo y horario',
            mockInput: 'Hola, estan atendiendo?',
          },
        ],
      });

      assert.equal(suite.passThresholdPercent, 95.0);

      assert.throws(() => {
        evalSuiteV1Schema.parse({
          id: 'suite_invalid',
          tenantId: 1,
          agentGraphId: 'graph_sales',
          name: 'Empty suite',
          scenarios: [],
        });
      });
    });

    it('validates evalRunResultV1Schema and evalScorecardV1Schema with baseline comparison', () => {
      const runResult = evalRunResultV1Schema.parse({
        scenarioId: 'scen_01',
        scenarioName: 'Saludo y horario',
        passed: true,
        durationMs: 120,
        tokensUsed: 350,
        costMicroUsd: 1200,
        traceSteps: [
          {
            step: 1,
            nodeId: 'node_trigger',
            nodeKind: 'trigger',
            status: 'completed',
            durationMs: 10,
            tokensUsed: 0,
            costMicroUsd: 0,
          },
        ],
        executedTools: [],
        assertionsResults: [
          {
            assertionId: 'as_1',
            type: 'forbidden_tool_not_called',
            passed: true,
            message: 'No forbidden tool called',
          },
        ],
      });

      assert.equal(runResult.passed, true);

      const scorecard = evalScorecardV1Schema.parse({
        suiteId: 'suite_sales_v1',
        suiteName: 'Suite de Calidad Ventas',
        agentGraphId: 'graph_sales',
        graphVersion: 2,
        passRatePercent: 98.5,
        totalScenarios: 20,
        passedCount: 19,
        failedCount: 1,
        p50LatencyMs: 140,
        p95LatencyMs: 380,
        totalCostMicroUsd: 25000,
        totalTokensUsed: 8400,
        regressionDetected: false,
        securityToolLeaks: [],
        baselineVersion: 1,
        baselineComparison: {
          passRateDelta: 3.5,
          p95LatencyDeltaMs: -40,
          costDeltaMicroUsd: -1200,
          newFailures: [],
          resolvedFailures: ['scen_faq_old'],
        },
        scenarioResults: [runResult],
        timestamp: new Date().toISOString(),
      });

      assert.equal(scorecard.passRatePercent, 98.5);
      assert.equal(scorecard.regressionDetected, false);
      assert.equal(scorecard.securityToolLeaks.length, 0);
    });

    it('validates publicationGateResultV1Schema blockers', () => {
      const gateResult = publicationGateResultV1Schema.parse({
        allowed: false,
        blockers: [
          {
            code: 'PASS_RATE_BELOW_THRESHOLD',
            message: 'Pass rate 92% is below the required 95% threshold',
            remediation: 'Fix scenario failures',
          },
          {
            code: 'SECURITY_TOOL_LEAK',
            message: 'Forbidden tool leaked',
            remediation: 'Revoke ungranted tools',
          },
        ],
        computedSpecHash: 'hash_abc',
        declaredSpecHash: 'hash_abc',
        passRatePercent: 92.0,
        securityToolLeaksCount: 1,
        cycleDetected: false,
        evaluatedAt: new Date().toISOString(),
      });

      assert.equal(gateResult.allowed, false);
      assert.equal(gateResult.blockers.length, 2);
    });
  });

  describe('3. Deterministic Spec Hash (`computeAgentSpecHash`)', () => {
    const baseGraph: AgentGraphVersionV1 = {
      schemaVersion: 1,
      graphId: 'agent_graph_sales',
      version: 1,
      tenantId: '1',
      entryNodeId: 'node_trigger',
      nodes: [
        { id: 'node_trigger', kind: 'agent', config: { channel: 'whatsapp' } },
        { id: 'node_reasoner', kind: 'agent', config: { model: 'gpt-4o', temperature: 0.3 } },
        { id: 'node_tool', kind: 'tool', config: { name: 'catalog.search' } },
      ],
      edges: [
        { id: 'e1', from: 'node_trigger', to: 'node_reasoner' },
        { id: 'e2', from: 'node_reasoner', to: 'node_tool', condition: 'tool_call' },
      ],
      policyRef: 'policy_standard_v1',
      limits: {
        maxSteps: 15,
        maxDelegations: 3,
        maxParallelNodes: 2,
        maxDurationSeconds: 60,
        maxModelTokens: 4000,
        maxCostMicroUsd: 500000,
      },
      status: 'draft',
      specHash: '',
    };

    it('produces a deterministic SHA-256 hash', () => {
      const hash1 = computeAgentSpecHash(baseGraph);
      const hash2 = computeAgentSpecHash(baseGraph);

      assert.equal(typeof hash1, 'string');
      assert.equal(hash1.length, 64);
      assert.equal(hash1, hash2);
    });

    it('returns the same hash regardless of node array ordering', () => {
      const shuffledGraph: AgentGraphVersionV1 = {
        ...baseGraph,
        nodes: [baseGraph.nodes[2], baseGraph.nodes[0], baseGraph.nodes[1]],
        edges: [baseGraph.edges[1], baseGraph.edges[0]],
      };

      const hashOriginal = computeAgentSpecHash(baseGraph);
      const hashShuffled = computeAgentSpecHash(shuffledGraph);

      assert.equal(hashOriginal, hashShuffled);
    });

    it('produces a different hash when nodes, edges, limits, or policies change', () => {
      const originalHash = computeAgentSpecHash(baseGraph);

      // Modified config
      const modifiedConfigGraph = {
        ...baseGraph,
        nodes: [
          baseGraph.nodes[0],
          { ...baseGraph.nodes[1], config: { model: 'gpt-4o', temperature: 0.7 } },
          baseGraph.nodes[2],
        ],
      };
      assert.notEqual(computeAgentSpecHash(modifiedConfigGraph), originalHash);

      // Modified limit
      const modifiedLimitGraph = {
        ...baseGraph,
        limits: {
          ...baseGraph.limits,
          maxSteps: 10,
        },
      };
      assert.notEqual(computeAgentSpecHash(modifiedLimitGraph), originalHash);

      // Modified policyRef
      const modifiedPolicyGraph = {
        ...baseGraph,
        policyRef: 'policy_enterprise_v2',
      };
      assert.notEqual(computeAgentSpecHash(modifiedPolicyGraph), originalHash);
    });
  });

  describe('4. Token Accounting for Embedding Models', () => {
    it('defines rates for text-embedding-3-small and text-embedding-3-large', () => {
      assert.equal(MODEL_RATE_CARDS['text-embedding-3-small'].promptPerM, 20000);
      assert.equal(MODEL_RATE_CARDS['text-embedding-3-small'].completionPerM, 0);
      assert.equal(MODEL_RATE_CARDS['text-embedding-3-large'].promptPerM, 130000);
      assert.equal(MODEL_RATE_CARDS['nomic-embed-text'].promptPerM, 0);
    });

    it('calculates deterministic micro-USD costs for embeddings', () => {
      // 50,000 prompt tokens with text-embedding-3-small ($0.02 / 1M = 20,000 µUSD / 1M) = 1,000 micro-USD ($0.001)
      const costSmall = calculateCostMicroUsd('text-embedding-3-small', 50000, 0);
      assert.equal(costSmall, 1000);

      // 1,000,000 prompt tokens with text-embedding-3-large ($0.13 / 1M) = 130,000 micro-USD
      const costLarge = calculateCostMicroUsd('text-embedding-3-large', 1000000, 0);
      assert.equal(costLarge, 130000);

      // Local embeddings cost 0 micro-USD
      const costLocal = calculateCostMicroUsd('nomic-embed-text', 500000, 0);
      assert.equal(costLocal, 0);
    });
  });
});
