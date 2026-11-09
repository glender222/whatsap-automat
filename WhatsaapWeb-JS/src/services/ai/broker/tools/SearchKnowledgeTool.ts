import { ToolDefinitionV1 } from '@whatsap-automat/contracts';
import { IToolImplementation, ToolExecutionContext, ToolValidationResult } from '../types';
import { KnowledgeBaseService, knowledgeBaseService } from '../../rag/KnowledgeBaseService';

export class SearchKnowledgeTool implements IToolImplementation {
  readonly definition: ToolDefinitionV1 = {
    schemaVersion: 1,
    name: 'search_knowledge',
    description: 'Performs semantic similarity vector search over the tenant-isolated pgvector knowledge base.',
    riskLevel: 'read',
    requiredRoles: ['agent', 'operator'],
    parameters: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', minLength: 1 },
        collectionId: { type: 'string' },
        topK: { type: 'integer', minimum: 1, maximum: 10, default: 3 },
        minSimilarity: { type: 'number', minimum: 0, maximum: 1, default: 0.7 },
      },
    },
    timeoutMs: 5000,
    isEgressNetworkTool: false,
  };

  constructor(private readonly kbService: Pick<KnowledgeBaseService, 'queryKnowledge'> = knowledgeBaseService) {}

  validateInput(input: Record<string, unknown>): ToolValidationResult {
    const errors: string[] = [];
    if (!input || typeof input !== 'object') {
      return { valid: false, errors: ['Input must be an object'] };
    }
    if (!input.query || typeof input.query !== 'string' || input.query.trim().length === 0) {
      errors.push("Missing or invalid required parameter 'query'");
    }
    return { valid: errors.length === 0, errors: errors.length > 0 ? errors : undefined };
  }

  async execute(input: Record<string, unknown>, context: ToolExecutionContext): Promise<unknown> {
    const query = String(input.query).trim();
    const topK = typeof input.topK === 'number' ? Math.min(Math.max(1, input.topK), 10) : 3;
    const minSimilarity = typeof input.minSimilarity === 'number' ? input.minSimilarity : 0.7;
    const collectionId = typeof input.collectionId === 'string' ? input.collectionId : undefined;

    const result = await this.kbService.queryKnowledge(context.tenantId, {
      query, collectionId, topK, minSimilarity,
    });
    return {
      query: result.query,
      totalResults: result.totalResults,
      chunks: result.chunks.map((chunk) => ({
        id: chunk.id,
        content: chunk.content,
        metadata: chunk.metadata,
        score: chunk.similarityScore,
      })),
    };
  }
}
