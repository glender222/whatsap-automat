import type { TenantScopedUoW } from '../../db/TenantScopedUoW';
import { ModelGateway } from '../../services/ai/gateway/ModelGateway';
import { ByokService } from '../../services/ai/gateway/byok/ByokService';
import { QuotaManager } from '../../services/ai/gateway/QuotaManager';
import { TokenCostLedger } from '../../services/ai/gateway/TokenCostLedger';
import { KnowledgeBaseService } from '../../services/ai/rag/KnowledgeBaseService';

const disabledDatabase = {
  async run() { throw new Error('Test fixture has no database'); },
} as unknown as TenantScopedUoW;

export function createSyntheticEmbeddingGateway(): ModelGateway {
  return new ModelGateway(
    new ByokService(disabledDatabase),
    new QuotaManager(disabledDatabase),
    new TokenCostLedger(disabledDatabase),
    undefined,
    'synthetic'
  );
}

export function createMemoryKnowledgeBaseService(): KnowledgeBaseService {
  return new KnowledgeBaseService(disabledDatabase, createSyntheticEmbeddingGateway(), { allowMemoryFallback: true });
}
import jwt from 'jsonwebtoken';
import config from '../../config/index';

export function createFixtureAccessToken(claims: Record<string, unknown>): string {
  return jwt.sign(claims, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' });
}
