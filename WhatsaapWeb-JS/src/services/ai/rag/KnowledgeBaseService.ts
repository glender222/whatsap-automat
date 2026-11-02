import {
  KnowledgeCollectionV1,
  CreateKnowledgeCollectionCommandV1,
  IngestDocumentCommandV1,
  IngestDocumentResultV1,
  KnowledgeQueryRequestV1,
  KnowledgeQueryResultV1,
  KnowledgeQueryResultChunkV1,
  RagPurgeRequestV1,
  RagPurgeResultV1,
} from '@whatsap-automat/contracts';
import { TenantScopedUoW, tenantScopedUoW } from '../../../db/TenantScopedUoW';
import { ModelGateway, modelGateway } from '../gateway/ModelGateway';
import { DocumentParser } from './DocumentParser';
import { TextChunker } from './TextChunker';

interface MemoryChunkRecord {
  id: string;
  collectionId: string;
  tenantId: number;
  documentId?: string | null;
  customerId?: string | null;
  chunkIndex: number;
  content: string;
  metadata: Record<string, unknown>;
  embedding: number[];
  tokenCount: number;
  createdAt: string;
}

interface MemoryCollectionRecord {
  id: string;
  tenantId: number;
  name: string;
  description?: string | null;
  embeddingModel: string;
  distanceMetric: 'cosine' | 'l2' | 'inner_product';
  chunkStrategy: {
    strategy: 'sliding_window' | 'sentence' | 'paragraph' | 'fixed_size';
    chunkSizeTokens: number;
    overlapTokens: number;
  };
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export class KnowledgeBaseService {
  // In-memory fallback stores for test/mock environments without active postgres
  private memoryCollections = new Map<string, MemoryCollectionRecord>();
  private memoryChunks = new Map<string, MemoryChunkRecord>();

  constructor(
    private readonly uow: TenantScopedUoW = tenantScopedUoW,
    private readonly gateway: ModelGateway = modelGateway
  ) {}

  /**
   * 1. Collections Management
   */
  async createCollection(
    tenantId: number,
    command: CreateKnowledgeCollectionCommandV1
  ): Promise<KnowledgeCollectionV1> {
    const id = `coll_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    const embeddingModel = command.embeddingModel || 'text-embedding-3-small';
    const distanceMetric = command.distanceMetric || 'cosine';
    const chunkStrategy = {
      strategy: command.chunkStrategy?.strategy || 'sliding_window',
      chunkSizeTokens: command.chunkStrategy?.chunkSizeTokens || 512,
      overlapTokens: command.chunkStrategy?.overlapTokens ?? 64,
    };
    const metadata = command.metadata || {};

    try {
      return await this.uow.run(tenantId, async (client) => {
        const res = await client.query(
          `INSERT INTO knowledge_collections (
            id, tenant_id, name, description, embedding_model, distance_metric,
            chunk_strategy, metadata_json, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, NOW(), NOW())
          RETURNING *`,
          [
            id,
            tenantId,
            command.name,
            command.description || null,
            embeddingModel,
            distanceMetric,
            JSON.stringify(chunkStrategy),
            JSON.stringify(metadata),
          ]
        );
        const row = res.rows[0];
        return {
          id: row.id,
          tenantId: row.tenant_id,
          name: row.name,
          description: row.description,
          embeddingModel: row.embedding_model,
          distanceMetric: row.distance_metric,
          chunkStrategy: row.chunk_strategy,
          metadata: row.metadata_json,
          chunkCount: 0,
          createdAt: row.created_at?.toISOString?.() || now,
          updatedAt: row.updated_at?.toISOString?.() || now,
        };
      });
    } catch {
      // Memory store fallback
      const record: MemoryCollectionRecord = {
        id,
        tenantId,
        name: command.name,
        description: command.description || null,
        embeddingModel,
        distanceMetric,
        chunkStrategy,
        metadata,
        createdAt: now,
        updatedAt: now,
      };
      this.memoryCollections.set(id, record);
      return {
        ...record,
        chunkCount: 0,
      };
    }
  }

  async getCollection(tenantId: number, collectionId: string): Promise<KnowledgeCollectionV1 | null> {
    try {
      return await this.uow.run(tenantId, async (client) => {
        const res = await client.query(
          `SELECT c.*,
                  (SELECT COUNT(*)::integer FROM knowledge_chunks k WHERE k.collection_id = c.id AND k.tenant_id = c.tenant_id) as chunk_count
           FROM knowledge_collections c
           WHERE c.id = $1 AND c.tenant_id = $2`,
          [collectionId, tenantId]
        );
        if (res.rowCount === 0) return null;
        const row = res.rows[0];
        return {
          id: row.id,
          tenantId: row.tenant_id,
          name: row.name,
          description: row.description,
          embeddingModel: row.embedding_model,
          distanceMetric: row.distance_metric,
          chunkStrategy: row.chunk_strategy,
          metadata: row.metadata_json,
          chunkCount: row.chunk_count || 0,
          createdAt: row.created_at?.toISOString?.() || row.created_at,
          updatedAt: row.updated_at?.toISOString?.() || row.updated_at,
        };
      });
    } catch {
      const coll = this.memoryCollections.get(collectionId);
      if (!coll || coll.tenantId !== tenantId) return null;
      let count = 0;
      for (const chunk of this.memoryChunks.values()) {
        if (chunk.collectionId === collectionId && chunk.tenantId === tenantId) count++;
      }
      return { ...coll, chunkCount: count };
    }
  }

  async listCollections(tenantId: number): Promise<KnowledgeCollectionV1[]> {
    try {
      return await this.uow.run(tenantId, async (client) => {
        const res = await client.query(
          `SELECT c.*,
                  (SELECT COUNT(*)::integer FROM knowledge_chunks k WHERE k.collection_id = c.id AND k.tenant_id = c.tenant_id) as chunk_count
           FROM knowledge_collections c
           WHERE c.tenant_id = $1
           ORDER BY c.created_at DESC`,
          [tenantId]
        );
        return res.rows.map((row) => ({
          id: row.id,
          tenantId: row.tenant_id,
          name: row.name,
          description: row.description,
          embeddingModel: row.embedding_model,
          distanceMetric: row.distance_metric,
          chunkStrategy: row.chunk_strategy,
          metadata: row.metadata_json,
          chunkCount: row.chunk_count || 0,
          createdAt: row.created_at?.toISOString?.() || row.created_at,
          updatedAt: row.updated_at?.toISOString?.() || row.updated_at,
        }));
      });
    } catch {
      const results: KnowledgeCollectionV1[] = [];
      for (const coll of this.memoryCollections.values()) {
        if (coll.tenantId === tenantId) {
          let count = 0;
          for (const chunk of this.memoryChunks.values()) {
            if (chunk.collectionId === coll.id && chunk.tenantId === tenantId) count++;
          }
          results.push({ ...coll, chunkCount: count });
        }
      }
      return results;
    }
  }

  async deleteCollection(tenantId: number, collectionId: string): Promise<boolean> {
    try {
      return await this.uow.run(tenantId, async (client) => {
        // Cascade delete chunks
        await client.query(
          `DELETE FROM knowledge_chunks WHERE collection_id = $1 AND tenant_id = $2`,
          [collectionId, tenantId]
        );
        const res = await client.query(
          `DELETE FROM knowledge_collections WHERE id = $1 AND tenant_id = $2`,
          [collectionId, tenantId]
        );
        return (res.rowCount || 0) > 0;
      });
    } catch {
      const coll = this.memoryCollections.get(collectionId);
      if (!coll || coll.tenantId !== tenantId) return false;
      this.memoryCollections.delete(collectionId);
      for (const [key, chunk] of this.memoryChunks.entries()) {
        if (chunk.collectionId === collectionId && chunk.tenantId === tenantId) {
          this.memoryChunks.delete(key);
        }
      }
      return true;
    }
  }

  /**
   * 2. Ingestion Pipeline
   */
  async ingestDocument(
    tenantId: number,
    command: IngestDocumentCommandV1
  ): Promise<IngestDocumentResultV1> {
    const documentId = command.documentId || `doc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const collection = await this.getCollection(tenantId, command.collectionId);
    if (!collection) {
      const err = new Error(`Knowledge collection '${command.collectionId}' not found for tenant ${tenantId}`) as any;
      err.statusCode = 404;
      err.code = 'COLLECTION_NOT_FOUND';
      throw err;
    }

    // 1. Multi-format text extraction
    const normalizedText = DocumentParser.parse(command.content, command.fileType);
    if (!normalizedText.trim()) {
      return {
        collectionId: command.collectionId,
        documentId,
        documentName: command.documentName,
        chunksCreated: 0,
        totalTokens: 0,
        chunkIds: [],
      };
    }

    // 2. Sliding window text chunking
    const chunkConfig = {
      ...collection.chunkStrategy,
      ...(command.customChunkStrategy || {}),
    };
    const chunkItems = TextChunker.chunk(normalizedText, chunkConfig);

    if (chunkItems.length === 0) {
      return {
        collectionId: command.collectionId,
        documentId,
        documentName: command.documentName,
        chunksCreated: 0,
        totalTokens: 0,
        chunkIds: [],
      };
    }

    // 3. Vector embedding generation via ModelGateway
    const chunkTexts = chunkItems.map((c) => c.text);
    const embeddingResult = await this.gateway.embed({
      tenantId,
      model: collection.embeddingModel,
      input: chunkTexts,
    });

    const chunkIds: string[] = [];
    let totalTokens = 0;
    const now = new Date().toISOString();

    for (let i = 0; i < chunkItems.length; i++) {
      const item = chunkItems[i];
      const chunkId = `chk_${documentId}_${item.index}`;
      const vector = embeddingResult.embeddings[i] || [];
      const meta = {
        ...(command.metadata || {}),
        documentName: command.documentName,
        fileType: command.fileType,
        startChar: item.startChar,
        endChar: item.endChar,
      };

      chunkIds.push(chunkId);
      totalTokens += item.tokenCount;

      try {
        await this.uow.run(tenantId, async (client) => {
          // Format vector for pgvector: '[0.1,0.2,...]'
          const vectorStr = `[${vector.join(',')}]`;
          await client.query(
            `INSERT INTO knowledge_chunks (
              id, collection_id, tenant_id, document_id, customer_id,
              chunk_index, content_text, metadata_json, embedding, token_count, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, NOW())`,
            [
              chunkId,
              command.collectionId,
              tenantId,
              documentId,
              command.customerId || null,
              item.index,
              item.text,
              JSON.stringify(meta),
              vectorStr,
              item.tokenCount,
            ]
          );
        });
      } catch {
        // Fallback to memory
        this.memoryChunks.set(chunkId, {
          id: chunkId,
          collectionId: command.collectionId,
          tenantId,
          documentId,
          customerId: command.customerId || null,
          chunkIndex: item.index,
          content: item.text,
          metadata: meta,
          embedding: vector,
          tokenCount: item.tokenCount,
          createdAt: now,
        });
      }
    }

    return {
      collectionId: command.collectionId,
      documentId,
      documentName: command.documentName,
      chunksCreated: chunkIds.length,
      totalTokens,
      chunkIds,
    };
  }

  /**
   * 3. Semantic Similarity Search (pgvector)
   */
  async queryKnowledge(
    tenantId: number,
    request: KnowledgeQueryRequestV1
  ): Promise<KnowledgeQueryResultV1> {
    const startTime = Date.now();
    const query = request.query.trim();
    const topK = Math.min(Math.max(1, request.topK || 3), 10);
    const minSimilarity = request.minSimilarity !== undefined ? request.minSimilarity : 0.7;

    // 1. Generate query embedding
    const queryEmbedResult = await this.gateway.embed({
      tenantId,
      input: [query],
    });
    const queryVector = queryEmbedResult.embeddings[0] || [];
    const vectorStr = `[${queryVector.join(',')}]`;

    let matchedChunks: KnowledgeQueryResultChunkV1[] = [];

    try {
      matchedChunks = await this.uow.run(tenantId, async (client) => {
        const res = await client.query(
          `SELECT
             c.id,
             c.collection_id,
             c.document_id,
             c.customer_id,
             c.content_text,
             c.metadata_json,
             GREATEST(0.0, LEAST(1.0, 1.0 - (c.embedding <=> $1::vector))) AS similarity_score,
             (c.embedding <=> $1::vector) AS distance
           FROM knowledge_chunks c
           WHERE c.tenant_id = $2
             AND ($3::text IS NULL OR c.collection_id = $3)
             AND ($4::text IS NULL OR c.customer_id = $4)
             AND (1.0 - (c.embedding <=> $1::vector)) >= $5
           ORDER BY c.embedding <=> $1::vector ASC
           LIMIT $6`,
          [
            vectorStr,
            tenantId,
            request.collectionId || null,
            request.customerId || null,
            minSimilarity,
            topK,
          ]
        );

        return res.rows.map((r) => ({
          id: r.id,
          collectionId: r.collection_id,
          documentId: r.document_id,
          customerId: r.customer_id,
          content: r.content_text,
          metadata: r.metadata_json || {},
          similarityScore: Number(Number(r.similarity_score).toFixed(4)),
          distance: Number(Number(r.distance).toFixed(4)),
        }));
      });
    } catch {
      // In-memory cosine similarity fallback
      const candidates: { chunk: MemoryChunkRecord; score: number; dist: number }[] = [];
      for (const chunk of this.memoryChunks.values()) {
        if (chunk.tenantId !== tenantId) continue;
        if (request.collectionId && chunk.collectionId !== request.collectionId) continue;
        if (request.customerId && chunk.customerId !== request.customerId) continue;

        const score = this.calculateCosineSimilarity(queryVector, chunk.embedding);
        const dist = Math.max(0, 1 - score);
        if (score >= minSimilarity) {
          candidates.push({ chunk, score, dist });
        }
      }

      candidates.sort((a, b) => b.score - a.score);
      matchedChunks = candidates.slice(0, topK).map((c) => ({
        id: c.chunk.id,
        collectionId: c.chunk.collectionId,
        documentId: c.chunk.documentId,
        customerId: c.chunk.customerId,
        content: c.chunk.content,
        metadata: c.chunk.metadata,
        similarityScore: Number(c.score.toFixed(4)),
        distance: Number(c.dist.toFixed(4)),
      }));
    }

    const executionLatencyMs = Date.now() - startTime;
    return {
      query,
      totalResults: matchedChunks.length,
      chunks: matchedChunks,
      executionLatencyMs,
    };
  }

  /**
   * 4. GDPR Right-to-be-Forgotten Purge
   */
  async purgeKnowledge(
    tenantId: number,
    request: RagPurgeRequestV1
  ): Promise<RagPurgeResultV1> {
    const purgedAt = new Date().toISOString();
    let purgedChunksCount = 0;
    let purgedCollectionsCount = 0;

    try {
      return await this.uow.run(tenantId, async (client) => {
        switch (request.scope) {
          case 'customer': {
            const res = await client.query(
              `DELETE FROM knowledge_chunks
               WHERE tenant_id = $1 AND (customer_id = $2 OR metadata_json->>'customerId' = $2)`,
              [tenantId, request.targetId]
            );
            purgedChunksCount = res.rowCount || 0;
            break;
          }
          case 'collection': {
            const countRes = await client.query(
              `SELECT COUNT(*)::integer AS count FROM knowledge_chunks WHERE tenant_id = $1 AND collection_id = $2`,
              [tenantId, request.targetId]
            );
            purgedChunksCount = countRes.rows[0]?.count || 0;

            const collRes = await client.query(
              `DELETE FROM knowledge_collections WHERE tenant_id = $1 AND id = $2`,
              [tenantId, request.targetId]
            );
            purgedCollectionsCount = collRes.rowCount || 0;
            break;
          }
          case 'document': {
            const res = await client.query(
              `DELETE FROM knowledge_chunks WHERE tenant_id = $1 AND document_id = $2`,
              [tenantId, request.targetId]
            );
            purgedChunksCount = res.rowCount || 0;
            break;
          }
          case 'tenant': {
            const countRes = await client.query(
              `SELECT COUNT(*)::integer AS count FROM knowledge_chunks WHERE tenant_id = $1`,
              [tenantId]
            );
            purgedChunksCount = countRes.rows[0]?.count || 0;

            const collRes = await client.query(
              `DELETE FROM knowledge_collections WHERE tenant_id = $1`,
              [tenantId]
            );
            purgedCollectionsCount = collRes.rowCount || 0;
            break;
          }
        }

        return {
          success: true,
          scope: request.scope,
          targetId: request.targetId || `tenant_${tenantId}`,
          purgedChunksCount,
          purgedCollectionsCount,
          purgedAt,
        };
      });
    } catch {
      // Memory store fallback purge
      switch (request.scope) {
        case 'customer': {
          for (const [key, chunk] of this.memoryChunks.entries()) {
            if (chunk.tenantId === tenantId && (chunk.customerId === request.targetId || chunk.metadata?.customerId === request.targetId)) {
              this.memoryChunks.delete(key);
              purgedChunksCount++;
            }
          }
          break;
        }
        case 'collection': {
          for (const [key, chunk] of this.memoryChunks.entries()) {
            if (chunk.tenantId === tenantId && chunk.collectionId === request.targetId) {
              this.memoryChunks.delete(key);
              purgedChunksCount++;
            }
          }
          if (this.memoryCollections.has(request.targetId!) && this.memoryCollections.get(request.targetId!)?.tenantId === tenantId) {
            this.memoryCollections.delete(request.targetId!);
            purgedCollectionsCount++;
          }
          break;
        }
        case 'document': {
          for (const [key, chunk] of this.memoryChunks.entries()) {
            if (chunk.tenantId === tenantId && chunk.documentId === request.targetId) {
              this.memoryChunks.delete(key);
              purgedChunksCount++;
            }
          }
          break;
        }
        case 'tenant': {
          for (const [key, chunk] of this.memoryChunks.entries()) {
            if (chunk.tenantId === tenantId) {
              this.memoryChunks.delete(key);
              purgedChunksCount++;
            }
          }
          for (const [key, coll] of this.memoryCollections.entries()) {
            if (coll.tenantId === tenantId) {
              this.memoryCollections.delete(key);
              purgedCollectionsCount++;
            }
          }
          break;
        }
      }

      return {
        success: true,
        scope: request.scope,
        targetId: request.targetId || `tenant_${tenantId}`,
        purgedChunksCount,
        purgedCollectionsCount,
        purgedAt,
      };
    }
  }

  private calculateCosineSimilarity(a: number[], b: number[]): number {
    if (!a || !b || a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : Math.max(0, Math.min(1, dot / denom));
  }
}

export const knowledgeBaseService = new KnowledgeBaseService();
