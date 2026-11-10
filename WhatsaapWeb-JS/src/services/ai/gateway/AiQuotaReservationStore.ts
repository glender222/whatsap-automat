import { createHash, randomUUID } from 'node:crypto';
import { tenantScopedUoW, type TenantScopedUoW } from '../../../db/TenantScopedUoW';
import type { Queryable } from '../../../shared/UnitOfWorkPort';
import { TokenCostLedger } from './TokenCostLedger';
import type { CreateTokenLedgerEntryCommandV1 } from './types';

const MAX_PG_INTEGER = 2_147_483_647;
const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const sha256 = /^[\da-f]{64}$/;
const quotaColumns = `period_start, reset_at, current_month_cost_micro_usd, current_month_tokens_used,
  monthly_cost_limit_micro_usd, monthly_token_limit`;

export interface AiQuotaReservation {
  id: string;
  requestHash: string;
  operation: CreateTokenLedgerEntryCommandV1['operation'];
  provider: string;
  model: string;
  maxCostMicroUsd: number;
  maxTokens: number;
}

export interface AiQuotaSettlement {
  id: string;
  claimToken: string;
  promptTokens: number;
  completionTokens: number;
  costMicroUsd: number;
  status: CreateTokenLedgerEntryCommandV1['status'];
  isByok: boolean;
  latencyMs: number;
}

interface LockedQuota {
  period_start: Date;
  reset_at: Date;
  current_month_cost_micro_usd: string;
  current_month_tokens_used: string;
  monthly_cost_limit_micro_usd: string;
  monthly_token_limit: string;
}

export class AiQuotaReservationConflictError extends Error {
  readonly code = 'AI_QUOTA_RESERVATION_CONFLICT';

  constructor() {
    super('AI quota reservation does not match the requested operation');
  }
}

export class AiQuotaCapacityError extends Error {
  readonly statusCode = 429;
  readonly code = 'RATE_LIMITED';

  constructor() {
    super('Insufficient monthly AI quota to reserve the requested cost and tokens');
  }
}

function isAmount(value: number, max = Number.MAX_SAFE_INTEGER): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= max;
}

/** Internal accounting protocol for bounded provider attempts. */
export class AiQuotaReservationStore {
  constructor(
    private readonly uow: TenantScopedUoW = tenantScopedUoW,
    private readonly ledger = new TokenCostLedger(uow)
  ) {}

  async reserve(tenantId: number, reservation: AiQuotaReservation): Promise<void> {
    const { id, requestHash, operation, provider, model, maxCostMicroUsd, maxTokens } = reservation;
    if (!uuid.test(id) || !sha256.test(requestHash) || !provider.trim() || provider.length > 60 ||
        !model.trim() || model.length > 120 || !isAmount(maxCostMicroUsd) ||
        !isAmount(maxTokens, MAX_PG_INTEGER) || maxTokens === 0) {
      throw new TypeError('Invalid AI quota reservation');
    }

    await this.uow.run(tenantId, async (client) => {
      const quota = await this.lockQuota(client, tenantId);
      const { rows: [existing] } = await client.query(
        `SELECT request_hash, operation, provider, model, max_cost_micro_usd, max_tokens
         FROM ai_quota_reservations WHERE tenant_id = $1 AND id = $2`, [tenantId, id]
      );
      if (existing) {
        if (existing.request_hash !== requestHash || existing.operation !== operation || existing.provider !== provider ||
            existing.model !== model || BigInt(existing.max_cost_micro_usd) !== BigInt(maxCostMicroUsd) ||
            existing.max_tokens !== maxTokens) throw new AiQuotaReservationConflictError();
        return;
      }

      await this.assertCapacity(client, tenantId, quota, maxCostMicroUsd, maxTokens);

      await client.query(
        `INSERT INTO ai_quota_reservations
         (tenant_id, id, request_hash, operation, provider, model, max_cost_micro_usd, max_tokens, period_start, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, LEAST($10, clock_timestamp() + INTERVAL '5 minutes'))`,
        [tenantId, id, requestHash, operation, provider, model, maxCostMicroUsd, maxTokens, quota.period_start, quota.reset_at]
      );
    });
  }

  /** Only the caller that receives a token may dispatch the bound attempt. */
  async claim(tenantId: number, id: string, requestHash: string): Promise<{ token: string; dispatchBefore: Date } | null> {
    return this.uow.run(tenantId, async (client) => {
      const quota = await this.lockQuota(client, tenantId);
      const { rows: [claimed] } = await client.query(
        `UPDATE ai_quota_reservations SET status = 'claimed', claim_token = $5, claimed_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2 AND request_hash = $3 AND period_start = $4
           AND status = 'reserved' AND expires_at > clock_timestamp()
         RETURNING claim_token, expires_at`, [tenantId, id, requestHash, quota.period_start, randomUUID()]
      );
      if (!claimed) return null;
      // Usage may have changed after reserve, including a previously claimed attempt overrunning its bound.
      await this.assertCapacity(client, tenantId, quota);
      return { token: claimed.claim_token, dispatchBefore: claimed.expires_at };
    });
  }

  async release(tenantId: number, id: string, requestHash: string): Promise<boolean> {
    return this.uow.run(tenantId, async (client) => {
      const { rowCount } = await client.query(
        `UPDATE ai_quota_reservations SET status = 'released'
         WHERE tenant_id = $1 AND id = $2 AND request_hash = $3 AND status = 'reserved'`,
        [tenantId, id, requestHash]
      );
      return rowCount === 1;
    });
  }

  async settle(tenantId: number, settlement: AiQuotaSettlement): Promise<{ ledgerId: number; overrun: boolean }> {
    const { id, claimToken, promptTokens, completionTokens, costMicroUsd, status, isByok, latencyMs } = settlement;
    const totalTokens = promptTokens + completionTokens;
    if (!uuid.test(id) || !uuid.test(claimToken) || !isAmount(promptTokens, MAX_PG_INTEGER) ||
        !isAmount(completionTokens, MAX_PG_INTEGER) || !isAmount(totalTokens, MAX_PG_INTEGER) ||
        !isAmount(costMicroUsd) || !isAmount(latencyMs, MAX_PG_INTEGER)) {
      throw new TypeError('Invalid AI quota settlement');
    }
    const hash = createHash('sha256')
      .update(JSON.stringify([promptTokens, completionTokens, costMicroUsd, status, isByok, latencyMs])).digest('hex');

    return this.uow.run(tenantId, async (client) => {
      const quota = await this.lockQuota(client, tenantId);
      const { rows: [reservation] } = await client.query(
        `SELECT operation, provider, model, max_cost_micro_usd, max_tokens, period_start, status, ledger_id, settlement_hash
         FROM ai_quota_reservations WHERE tenant_id = $1 AND id = $2 AND claim_token = $3 FOR UPDATE`,
        [tenantId, id, claimToken]
      );
      if (!reservation) throw new AiQuotaReservationConflictError();

      const overrun = BigInt(costMicroUsd) > BigInt(reservation.max_cost_micro_usd) || totalTokens > reservation.max_tokens;
      if (reservation.status === 'settled') {
        if (reservation.settlement_hash !== hash) throw new AiQuotaReservationConflictError();
        return { ledgerId: Number(reservation.ledger_id), overrun };
      }

      const ledgerId = await this.ledger.record({
        tenantId, operation: reservation.operation, provider: reservation.provider, model: reservation.model,
        promptTokens, completionTokens, totalTokens, costMicroUsd, status, isByok, latencyMs,
        metadataJson: { reservationId: id, reservationPeriodStart: reservation.period_start.toISOString(), quotaOverrun: overrun },
      }, { client, activeTenantId: tenantId });

      if (reservation.period_start.getTime() === quota.period_start.getTime()) {
        await client.query(
          `UPDATE tenant_ai_quotas SET current_month_cost_micro_usd = current_month_cost_micro_usd + $2,
             current_month_tokens_used = current_month_tokens_used + $3, updated_at = NOW() WHERE tenant_id = $1`,
          [tenantId, costMicroUsd, totalTokens]
        );
      }
      await client.query(
        `UPDATE ai_quota_reservations SET status = 'settled', ledger_id = $3, settlement_hash = $4
         WHERE tenant_id = $1 AND id = $2`, [tenantId, id, ledgerId, hash]
      );
      return { ledgerId, overrun };
    });
  }

  private async lockQuota(client: Queryable, tenantId: number): Promise<LockedQuota> {
    await client.query('INSERT INTO tenant_ai_quotas (tenant_id) VALUES ($1) ON CONFLICT (tenant_id) DO NOTHING', [tenantId]);
    const { rows: [quota] } = await client.query(
      `SELECT ${quotaColumns} FROM tenant_ai_quotas WHERE tenant_id = $1 FOR UPDATE`, [tenantId]
    );
    if (!quota) throw new Error('Tenant AI quota row unavailable');
    const { rows: [rolledOver] } = await client.query(
      `UPDATE tenant_ai_quotas SET current_month_cost_micro_usd = 0, current_month_tokens_used = 0,
         period_start = date_trunc('month', statement_timestamp()),
         reset_at = date_trunc('month', statement_timestamp()) + INTERVAL '1 month', updated_at = NOW()
       WHERE tenant_id = $1 AND reset_at <= statement_timestamp() RETURNING ${quotaColumns}`, [tenantId]
    );
    return rolledOver ?? quota;
  }

  private async assertCapacity(client: Queryable, tenantId: number, quota: LockedQuota, additionalCost = 0, additionalTokens = 0) {
    const { rows: [held] } = await client.query(
      `SELECT COALESCE(SUM(max_cost_micro_usd), 0) AS cost, COALESCE(SUM(max_tokens), 0) AS tokens
       FROM ai_quota_reservations
       WHERE tenant_id = $1 AND period_start = $2 AND status IN ('reserved', 'claimed')
         AND (status = 'claimed' OR expires_at > clock_timestamp())`, [tenantId, quota.period_start]
    );
    const cost = BigInt(quota.current_month_cost_micro_usd) + BigInt(held.cost) + BigInt(additionalCost);
    const tokens = BigInt(quota.current_month_tokens_used) + BigInt(held.tokens) + BigInt(additionalTokens);
    if (cost > BigInt(quota.monthly_cost_limit_micro_usd) || tokens > BigInt(quota.monthly_token_limit)) {
      throw new AiQuotaCapacityError();
    }
  }
}
