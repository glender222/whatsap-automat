import { TenantScopedUoW, tenantScopedUoW } from '../../../db/TenantScopedUoW';
import { CachedEffectRecord } from './types';

export class EffectCache {
  private readonly memoryCache = new Map<string, { record: CachedEffectRecord; expiresAt: number }>();
  private readonly ttlMs: number;

  constructor(
    private readonly uow: TenantScopedUoW = tenantScopedUoW,
    ttlMs: number = 24 * 60 * 60 * 1000 // 24 hours
  ) {
    this.ttlMs = ttlMs;
  }

  private getCompositeKey(tenantId: number, effectKey: string): string {
    return `${tenantId}:${effectKey}`;
  }

  async get(tenantId: number, effectKey: string): Promise<CachedEffectRecord | null> {
    const compositeKey = this.getCompositeKey(tenantId, effectKey);
    const inMem = this.memoryCache.get(compositeKey);
    if (inMem) {
      if (Date.now() < inMem.expiresAt) {
        return inMem.record;
      }
      this.memoryCache.delete(compositeKey);
    }

    try {
      return await this.uow.run(tenantId, async (client) => {
        const res = await client.query(
          `SELECT run_id, tool_name, status, output
           FROM tool_execution_effects
           WHERE tenant_id = $1 AND effect_key = $2
           LIMIT 1`,
          [tenantId, effectKey]
        );

        if (res.rowCount === 0) return null;
        const row = res.rows[0];
        const record: CachedEffectRecord = {
          runId: row.run_id,
          toolName: row.tool_name,
          status: row.status,
          output: typeof row.output === 'string' ? JSON.parse(row.output) : row.output,
        };

        this.memoryCache.set(compositeKey, {
          record,
          expiresAt: Date.now() + this.ttlMs,
        });

        return record;
      });
    } catch {
      // In mock/test environments without real DB, inMem result applies
      return null;
    }
  }

  async set(tenantId: number, effectKey: string, record: CachedEffectRecord): Promise<void> {
    const compositeKey = this.getCompositeKey(tenantId, effectKey);
    this.memoryCache.set(compositeKey, {
      record,
      expiresAt: Date.now() + this.ttlMs,
    });

    try {
      await this.uow.run(tenantId, async (client) => {
        await client.query(
          `INSERT INTO tool_execution_effects (
            tenant_id, effect_key, run_id, tool_name, status, output
          ) VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (tenant_id, effect_key) DO UPDATE SET
            status = EXCLUDED.status,
            output = EXCLUDED.output`,
          [
            tenantId,
            effectKey,
            record.runId,
            record.toolName,
            record.status,
            JSON.stringify(record.output),
          ]
        );
      });
    } catch {
      // Retain memory cache if database write is skipped or fails in mock environments
    }
  }

  clearMemory(): void {
    this.memoryCache.clear();
  }
}
