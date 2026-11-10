import { randomUUID } from 'node:crypto';
import { TenantScopedUoW, tenantScopedUoW } from '../../../db/TenantScopedUoW';
import { CachedEffectRecord } from './types';

export type EffectBinding = { runId: string; toolName: string; actionHash: string };
export type EffectClaim =
  | { kind: 'claimed'; token: string }
  | { kind: 'cached'; record: CachedEffectRecord }
  | { kind: 'in_progress' }
  | { kind: 'unknown' }
  | { kind: 'conflict' }
  | { kind: 'unbound' };

/** Durable effect ledger. The historical class name remains for compatibility. */
export class EffectCache {
  constructor(private readonly uow: TenantScopedUoW = tenantScopedUoW, _ttlMs?: number) {}

  async claim(tenantId: number, effectKey: string, binding: EffectBinding, timeoutMs: number): Promise<EffectClaim> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !/^[0-9a-f]{64}$/.test(binding.actionHash)) {
      throw new Error('Invalid effect claim');
    }
    const token = randomUUID();
    return this.uow.run(tenantId, async (db) => {
      const inserted = await db.query(`
        INSERT INTO tool_execution_effects
          (tenant_id, effect_key, run_id, tool_name, status, action_hash, claim_token, dispatch_deadline)
        VALUES ($1, $2, $3, $4, 'processing', $5, $6, clock_timestamp() + $7 * interval '1 millisecond')
        ON CONFLICT (tenant_id, effect_key) DO NOTHING RETURNING id
      `, [tenantId, effectKey, binding.runId, binding.toolName, binding.actionHash, token, timeoutMs]);
      if (inserted.rowCount === 1) return { kind: 'claimed', token };

      const { rows: [existing] } = await db.query(`
        SELECT run_id, tool_name, status, output, action_hash,
          dispatch_deadline <= clock_timestamp() AS expired
        FROM tool_execution_effects WHERE tenant_id = $1 AND effect_key = $2 FOR UPDATE
      `, [tenantId, effectKey]);
      if (!existing) throw new Error('Effect claim could not be verified');
      if (existing.run_id !== binding.runId || existing.tool_name !== binding.toolName ||
          (existing.action_hash !== null && existing.action_hash !== binding.actionHash)) return { kind: 'conflict' };
      if (existing.action_hash === null) return { kind: 'unbound' };
      if (existing.status === 'executed') {
        return { kind: 'cached', record: {
          runId: existing.run_id, toolName: existing.tool_name, status: existing.status, output: existing.output,
        } };
      }
      if (existing.status === 'processing' && !existing.expired) return { kind: 'in_progress' };
      if (existing.status === 'processing') {
        await db.query(`
          UPDATE tool_execution_effects SET status = 'delivery_unknown', error_details = $3
          WHERE tenant_id = $1 AND effect_key = $2 AND status = 'processing'
        `, [tenantId, effectKey, JSON.stringify({ code: 'EFFECT_OUTCOME_UNKNOWN' })]);
      }
      return { kind: 'unknown' };
    });
  }

  async complete(tenantId: number, effectKey: string, token: string, output: unknown): Promise<void> {
    await this.uow.run(tenantId, async (db) => {
      const result = await db.query(`
        UPDATE tool_execution_effects SET status = 'executed', output = $4,
          completed_at = clock_timestamp(), error_details = NULL
        WHERE tenant_id = $1 AND effect_key = $2 AND claim_token = $3
          AND status IN ('processing', 'delivery_unknown')
        RETURNING id
      `, [tenantId, effectKey, token, JSON.stringify(output ?? null)]);
      if (result.rowCount !== 1) throw new Error('Effect completion could not be confirmed');
    });
  }

  async markUnknown(tenantId: number, effectKey: string, token: string): Promise<void> {
    await this.uow.run(tenantId, (db) => db.query(`
      UPDATE tool_execution_effects SET status = 'delivery_unknown', error_details = $4
      WHERE tenant_id = $1 AND effect_key = $2 AND claim_token = $3 AND status = 'processing'
    `, [tenantId, effectKey, token, JSON.stringify({ code: 'EFFECT_OUTCOME_UNKNOWN' })]));
  }

  /** Compatibility read for persisted results; never supplies permission to dispatch. */
  async get(tenantId: number, effectKey: string): Promise<CachedEffectRecord | null> {
    return this.uow.run(tenantId, async (db) => {
      const { rows: [record] } = await db.query(`
        SELECT run_id, tool_name, status, output FROM tool_execution_effects
        WHERE tenant_id = $1 AND effect_key = $2 AND status = 'executed'
      `, [tenantId, effectKey]);
      return record ? { runId: record.run_id, toolName: record.tool_name, status: record.status, output: record.output } : null;
    });
  }

  /** Compatibility import for historical results; cannot overwrite a live claim or prior result. */
  async set(tenantId: number, effectKey: string, record: CachedEffectRecord): Promise<void> {
    await this.uow.run(tenantId, (db) => db.query(`
      INSERT INTO tool_execution_effects (tenant_id, effect_key, run_id, tool_name, status, output)
      VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (tenant_id, effect_key) DO NOTHING
    `, [tenantId, effectKey, record.runId, record.toolName, record.status, JSON.stringify(record.output ?? null)]));
  }

  clearMemory(): void { /* Process-local evidence never authorizes or reports execution. */ }
}
