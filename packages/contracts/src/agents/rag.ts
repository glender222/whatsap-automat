import { z } from 'zod';

/**
 * Supported Distance Metrics for Vector Similarity Search
 */
export const DISTANCE_METRICS = ['cosine', 'l2', 'inner_product'] as const;
export type DistanceMetric = (typeof DISTANCE_METRICS)[number];
export const distanceMetricSchema = z.enum(DISTANCE_METRICS);

/**
 * Chunking Strategies
 */
export const CHUNKING_STRATEGIES = ['sliding_window', 'sentence', 'paragraph', 'fixed_size'] as const;
export type ChunkingStrategyType = (typeof CHUNKING_STRATEGIES)[number];
export const chunkingStrategyTypeSchema = z.enum(CHUNKING_STRATEGIES);

/**
 * Chunking Configuration Parameters
 */
export const chunkingConfigV1Schema = z.object({
  strategy: chunkingStrategyTypeSchema.default('sliding_window'),
  chunkSizeTokens: z.number().int().min(128).max(2048).default(512),
  overlapTokens: z.number().int().min(0).max(256).default(64),
  separator: z.string().optional(),
});
export type ChunkingConfigV1 = z.infer<typeof chunkingConfigV1Schema>;

/**
 * Knowledge Collection Entity
 */
export const knowledgeCollectionV1Schema = z.object({
  id: z.string().min(1),
  tenantId: z.union([z.string().min(1), z.number().int().positive()]),
  name: z.string().min(1).max(120),
  description: z.string().nullable().optional(),
  embeddingModel: z.string().min(1).default('text-embedding-3-small'),
  distanceMetric: distanceMetricSchema.default('cosine'),
  chunkStrategy: chunkingConfigV1Schema.default({
    strategy: 'sliding_window',
    chunkSizeTokens: 512,
    overlapTokens: 64,
  }),
  metadata: z.record(z.unknown()).default({}),
  chunkCount: z.number().int().nonnegative().optional(),
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
});
export type KnowledgeCollectionV1 = z.infer<typeof knowledgeCollectionV1Schema>;

/**
 * Command to Create a Knowledge Collection (POST /api/v1/ai/rag/collections)
 */
export const createKnowledgeCollectionCommandV1Schema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().optional(),
  embeddingModel: z.string().min(1).default('text-embedding-3-small'),
  distanceMetric: distanceMetricSchema.default('cosine'),
  chunkStrategy: chunkingConfigV1Schema.partial().optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type CreateKnowledgeCollectionCommandV1 = z.infer<typeof createKnowledgeCollectionCommandV1Schema>;

/**
 * Knowledge Chunk Entity (with optional embedding vector)
 */
export const knowledgeChunkV1Schema = z.object({
  id: z.string().min(1),
  collectionId: z.string().min(1),
  tenantId: z.union([z.string().min(1), z.number().int().positive()]),
  documentId: z.string().nullable().optional(),
  customerId: z.string().nullable().optional(),
  chunkIndex: z.number().int().nonnegative(),
  content: z.string().min(1),
  metadata: z.record(z.unknown()).default({}),
  tokenCount: z.number().int().nonnegative(),
  embedding: z.array(z.number()).optional(),
  createdAt: z.string().datetime().optional(),
});
export type KnowledgeChunkV1 = z.infer<typeof knowledgeChunkV1Schema>;

/**
 * Ingestion Command (POST /api/v1/ai/rag/collections/:id/documents)
 */
export const ingestDocumentCommandV1Schema = z.object({
  collectionId: z.string().min(1),
  documentId: z.string().optional(),
  documentName: z.string().min(1).max(255),
  fileType: z.enum(['text', 'markdown', 'pdf', 'csv', 'json']).default('text'),
  content: z.string().min(1, 'Document content cannot be empty'),
  customerId: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  customChunkStrategy: chunkingConfigV1Schema.partial().optional(),
});
export type IngestDocumentCommandV1 = z.infer<typeof ingestDocumentCommandV1Schema>;

export const ingestDocumentResultV1Schema = z.object({
  collectionId: z.string().min(1),
  documentId: z.string().min(1),
  documentName: z.string().min(1),
  chunksCreated: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  chunkIds: z.array(z.string()),
});
export type IngestDocumentResultV1 = z.infer<typeof ingestDocumentResultV1Schema>;

/**
 * Semantic Vector Query Request (POST /api/v1/ai/rag/query)
 */
export const knowledgeQueryRequestV1Schema = z.object({
  collectionId: z.string().optional(),
  query: z.string().min(1, 'Query cannot be empty'),
  topK: z.number().int().min(1).max(10).default(3),
  minSimilarity: z.number().min(0).max(1).default(0.7),
  customerId: z.string().optional(),
  filterMetadata: z.record(z.unknown()).optional(),
});
export type KnowledgeQueryRequestV1 = z.infer<typeof knowledgeQueryRequestV1Schema>;

export const knowledgeQueryResultChunkV1Schema = z.object({
  id: z.string().min(1),
  collectionId: z.string().min(1),
  documentId: z.string().nullable().optional(),
  customerId: z.string().nullable().optional(),
  content: z.string().min(1),
  metadata: z.record(z.unknown()),
  similarityScore: z.number().min(0).max(1),
  distance: z.number().nonnegative(),
});
export type KnowledgeQueryResultChunkV1 = z.infer<typeof knowledgeQueryResultChunkV1Schema>;

export const knowledgeQueryResultV1Schema = z.object({
  query: z.string(),
  totalResults: z.number().int().nonnegative(),
  chunks: z.array(knowledgeQueryResultChunkV1Schema),
  executionLatencyMs: z.number().int().nonnegative(),
});
export type KnowledgeQueryResultV1 = z.infer<typeof knowledgeQueryResultV1Schema>;

/**
 * GDPR Right-to-be-Forgotten Purge Request (DELETE /api/v1/ai/rag/purge)
 */
export const RAG_PURGE_SCOPES = ['tenant', 'customer', 'collection', 'document'] as const;
export type RagPurgeScope = (typeof RAG_PURGE_SCOPES)[number];
export const ragPurgeScopeSchema = z.enum(RAG_PURGE_SCOPES);

export const ragPurgeRequestV1Schema = z
  .object({
    scope: ragPurgeScopeSchema,
    targetId: z.string().optional(), // Required unless scope === 'tenant'
    reason: z.string().min(1, 'Purge reason must be documented for GDPR audit compliance'),
    actorId: z.string().optional(),
  })
  .refine(
    (data) => {
      if (data.scope !== 'tenant' && (!data.targetId || data.targetId.trim().length === 0)) {
        return false;
      }
      return true;
    },
    {
      message: "Field 'targetId' is required when scope is 'customer', 'collection', or 'document'",
    }
  );
export type RagPurgeRequestV1 = z.infer<typeof ragPurgeRequestV1Schema>;

export const ragPurgeResultV1Schema = z.object({
  success: z.boolean(),
  scope: ragPurgeScopeSchema,
  targetId: z.string(),
  purgedChunksCount: z.number().int().nonnegative(),
  purgedCollectionsCount: z.number().int().nonnegative(),
  purgedAt: z.string().datetime(),
});
export type RagPurgeResultV1 = z.infer<typeof ragPurgeResultV1Schema>;
