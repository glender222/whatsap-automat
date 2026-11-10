import { randomUUID } from 'node:crypto';
import { tenantScopedUoW, type TenantScopedUoW } from '../../../db/TenantScopedUoW';
import type { Queryable } from '../../../shared/UnitOfWorkPort';

export type TenantAiDispatchMode = 'legacy' | 'draining' | 'strict' | 'paused';
type PolicyRows = { rows: { mode: TenantAiDispatchMode }[] };

const transitions: Record<TenantAiDispatchMode, readonly TenantAiDispatchMode[]> = {
  legacy: ['draining'],
  draining: ['legacy', 'strict'],
  strict: ['paused'],
  paused: ['strict'],
};

export class AiDispatchUnavailableError extends Error {
  readonly code = 'AI_ADMISSION_UNAVAILABLE';
  readonly statusCode = 503;

  constructor() { super('AI dispatch is unavailable under the current company policy'); }
}

export class TenantAiDispatchPolicy {
  constructor(private readonly uow: TenantScopedUoW = tenantScopedUoW) {}

  async mode(tenantId: number): Promise<TenantAiDispatchMode> {
    return this.uow.run(tenantId, async (db) => {
      const { rows: [policy] }: PolicyRows = await db.query(
        'SELECT mode FROM tenant_ai_dispatch_policies WHERE tenant_id = $1', [tenantId],
      );
      return policy?.mode ?? 'legacy';
    });
  }

  async assertStrict(db: Queryable, tenantId: number): Promise<void> {
    const { rows: [policy] }: PolicyRows = await db.query(
      'SELECT mode FROM tenant_ai_dispatch_policies WHERE tenant_id = $1 FOR SHARE', [tenantId],
    );
    if (policy?.mode !== 'strict') throw new AiDispatchUnavailableError();
  }

  async withLegacyDispatch<T>(tenantId: number, operation: () => Promise<T>): Promise<T> {
    const id = randomUUID();
    try {
      await this.uow.run(tenantId, async (db) => {
        if (await this.lockPolicy(db, tenantId) !== 'legacy') throw new AiDispatchUnavailableError();
        await db.query('INSERT INTO tenant_ai_legacy_dispatches (tenant_id, id) VALUES ($1, $2)', [tenantId, id]);
      });
    } catch {
      throw new AiDispatchUnavailableError();
    }
    try {
      return await operation();
    } finally {
      // A process killed before cleanup leaves a durable marker. An operator must
      // verify that attempt before admitting a strict cutover for this company.
      await this.uow.run(tenantId, (db) => db.query(
        'DELETE FROM tenant_ai_legacy_dispatches WHERE tenant_id = $1 AND id = $2', [tenantId, id],
      )).catch(() => console.warn('AI legacy dispatch completion could not be recorded', { tenantId, id }));
    }
  }

  async transition(tenantId: number, next: TenantAiDispatchMode): Promise<void> {
    await this.uow.run(tenantId, async (db) => {
      const current = await this.lockPolicy(db, tenantId);
      if (current === next) return;
      if (!transitions[current].includes(next)) {
        throw Object.assign(new Error('Invalid AI dispatch policy transition'), { code: 'AI_ADMISSION_TRANSITION', statusCode: 409 });
      }
      if (current === 'draining' && next === 'strict') {
        const active = await db.query('SELECT 1 FROM tenant_ai_legacy_dispatches WHERE tenant_id = $1 LIMIT 1', [tenantId]);
        if (active.rows.length) {
          throw Object.assign(new Error('Legacy AI dispatches still require completion or reconciliation'), {
            code: 'AI_LEGACY_DISPATCH_IN_FLIGHT', statusCode: 409,
          });
        }
      }
      await db.query('UPDATE tenant_ai_dispatch_policies SET mode = $2, updated_at = clock_timestamp() WHERE tenant_id = $1',
        [tenantId, next]);
    });
  }

  private async lockPolicy(db: Queryable, tenantId: number): Promise<TenantAiDispatchMode> {
    await db.query('INSERT INTO tenant_ai_dispatch_policies (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING', [tenantId]);
    const { rows: [policy] }: PolicyRows = await db.query(
      'SELECT mode FROM tenant_ai_dispatch_policies WHERE tenant_id = $1 FOR UPDATE', [tenantId],
    );
    if (!policy) throw new AiDispatchUnavailableError();
    return policy.mode;
  }
}

export const tenantAiDispatchPolicy = new TenantAiDispatchPolicy();
