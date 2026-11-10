import './fixtures/testEnv';
import assert from 'node:assert/strict';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { TenantScopedUoW } from '../db/TenantScopedUoW';
import {
  AiQuotaCapacityError, AiQuotaReservationConflictError, AiQuotaReservationStore,
  type AiQuotaReservation, type AiQuotaSettlement,
} from '../services/ai/gateway/AiQuotaReservationStore';
import { TokenCostLedger } from '../services/ai/gateway/TokenCostLedger';
import { QuotaManager } from '../services/ai/gateway/QuotaManager';

const connectionString = process.env.AI_QUOTA_RESERVATIONS_TEST_DATABASE_URL;

function request(cost = 60, tokens = 40): AiQuotaReservation {
  const id = randomUUID();
  return {
    id, requestHash: createHash('sha256').update(id).digest('hex'), operation: 'eval',
    provider: 'openai', model: 'gpt-4o-mini', maxCostMicroUsd: cost, maxTokens: tokens,
  };
}

function usage(id: string, claimToken: string): AiQuotaSettlement {
  return { id, claimToken, promptTokens: 16, completionTokens: 4, costMicroUsd: 20, status: 'success', isByok: true, latencyMs: 50 };
}

test('AI quota reservations against PostgreSQL FORCE RLS', {
  skip: !connectionString && 'AI_QUOTA_RESERVATIONS_TEST_DATABASE_URL is required',
}, async (t) => {
  const pool = new Pool({ connectionString });
  t.after(() => pool.end());
  const uow = new TenantScopedUoW(pool);
  const store = new AiQuotaReservationStore(uow);
  const { rows: [role] } = await pool.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
  assert.deepEqual(role, { rolsuper: false, rolbypassrls: false });
  const { rows: [rls] } = await pool.query(
    `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'ai_quota_reservations'::regclass`
  );
  assert.deepEqual(rls, { relrowsecurity: true, relforcerowsecurity: true });

  async function tenant() {
    const id = randomInt(500_000_000, 900_000_000);
    await uow.run(id, async (db) => {
      await db.query('INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)', [id, 'AI quota test', `quota-${randomUUID()}`]);
      await db.query(
        `INSERT INTO tenant_ai_quotas (tenant_id, monthly_cost_limit_micro_usd, monthly_token_limit, hard_limit_enabled)
         VALUES ($1, 100, 100, false)`, [id]
      );
    });
    return id;
  }

  async function claim(tenantId: number, reservation: AiQuotaReservation) {
    const permit = await store.claim(tenantId, reservation.id, reservation.requestHash);
    assert.ok(permit);
    return permit.token;
  }

  function balance(tenantId: number) {
    return uow.run(tenantId, async (db) => (await db.query(
      `SELECT current_month_cost_micro_usd AS cost, current_month_tokens_used AS tokens
       FROM tenant_ai_quotas WHERE tenant_id = $1`, [tenantId]
    )).rows[0]);
  }

  await t.test('concurrent reservations serialize cost and token capacity, with exact-key replay', async () => {
    const tenantId = await tenant();
    const reservations = Array.from({ length: 8 }, () => request());
    const outcomes = await Promise.allSettled(reservations.map((item) => store.reserve(tenantId, item)));
    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') assert.ok(outcome.reason instanceof AiQuotaCapacityError);
    }
    const accepted = reservations[outcomes.findIndex((outcome) => outcome.status === 'fulfilled')];
    await Promise.all([store.reserve(tenantId, accepted), store.reserve(tenantId, accepted)]);
    await assert.rejects(store.reserve(tenantId, { ...accepted, model: 'different' }), AiQuotaReservationConflictError);
    await assert.rejects(store.reserve(tenantId, request(1, 61)), AiQuotaCapacityError);
    assert.equal(await store.release(tenantId, accepted.id, accepted.requestHash), true);
    assert.equal(await store.release(tenantId, accepted.id, accepted.requestHash), false);
    await store.reserve(tenantId, accepted);
    assert.equal(await store.claim(tenantId, accepted.id, accepted.requestHash), null);
    await store.reserve(tenantId, request(100, 100));
  });

  await t.test('one CAS winner and one ledger debit across retries, isolated by tenant', async () => {
    const tenantId = await tenant();
    const other = await tenant();
    const item = request();
    await store.reserve(tenantId, item);
    assert.equal(await store.claim(other, item.id, item.requestHash), null);
    assert.equal(await store.claim(tenantId, item.id, 'a'.repeat(64)), null);
    assert.equal((await pool.query('SELECT id FROM ai_quota_reservations WHERE id = $1', [item.id])).rowCount, 0);
    assert.equal((await uow.run(other, (db) => db.query('SELECT id FROM ai_quota_reservations WHERE id = $1', [item.id]))).rowCount, 0);
    const permits = await Promise.all(Array.from({ length: 6 }, () => store.claim(tenantId, item.id, item.requestHash)));
    const winners = permits.filter((permit) => permit !== null);
    assert.equal(winners.length, 1);
    assert.ok(winners[0].dispatchBefore > new Date());
    const actual = usage(item.id, winners[0].token);
    await assert.rejects(store.settle(other, actual), AiQuotaReservationConflictError);
    await assert.rejects(store.settle(tenantId, { ...actual, claimToken: randomUUID() }), AiQuotaReservationConflictError);
    const settled = await Promise.all([store.settle(tenantId, actual), store.settle(tenantId, actual)]);
    assert.deepEqual(settled[0], settled[1]);
    assert.equal(settled[0].overrun, false);
    await assert.rejects(store.settle(tenantId, { ...actual, costMicroUsd: 21 }), AiQuotaReservationConflictError);
    assert.deepEqual(await balance(tenantId), { cost: '20', tokens: '20' });
    const ledger = await new TokenCostLedger(uow).query(tenantId);
    assert.equal(ledger.items.length, 1);
    assert.equal(ledger.items[0].operation, 'eval');
    assert.equal(ledger.items[0].costMicroUsd, 20);
    assert.equal((await new TokenCostLedger(uow).query(other)).items.length, 0);
    await store.reserve(tenantId, request(80, 80));
  });

  await t.test('settlement rolls back the inserted ledger if the transaction fails', async () => {
    const tenantId = await tenant();
    const item = request();
    await store.reserve(tenantId, item);
    const actual = usage(item.id, await claim(tenantId, item));
    class InterruptedLedger extends TokenCostLedger {
      override async record(...args: Parameters<TokenCostLedger['record']>): Promise<number> {
        await super.record(...args);
        throw new Error('simulated interruption after ledger insert');
      }
    }
    const interrupted = new AiQuotaReservationStore(uow, new InterruptedLedger(uow));
    await assert.rejects(interrupted.settle(tenantId, actual), /simulated interruption/);
    assert.deepEqual(await balance(tenantId), { cost: '0', tokens: '0' });
    assert.equal((await new TokenCostLedger(uow).query(tenantId)).items.length, 0);
    assert.equal(await store.claim(tenantId, item.id, item.requestHash), null);
    assert.equal(await store.release(tenantId, item.id, item.requestHash), false);
    await assert.rejects(store.reserve(tenantId, request(41, 1)), AiQuotaCapacityError);
    assert.equal((await store.settle(tenantId, actual)).overrun, false);
  });

  await t.test('expired unused holds free capacity while an uncertain claim retains only its own bound', async () => {
    const tenantId = await tenant();
    const expired = request(100, 100);
    const uncertain = request(70, 70);
    const expire = (id: string) => uow.run(tenantId, (db) => db.query(
      `UPDATE ai_quota_reservations SET expires_at = clock_timestamp() - INTERVAL '1 second'
       WHERE tenant_id = $1 AND id = $2`, [tenantId, id]
    ));
    await store.reserve(tenantId, expired);
    await expire(expired.id);
    assert.equal(await store.claim(tenantId, expired.id, expired.requestHash), null);
    await store.reserve(tenantId, uncertain);
    await claim(tenantId, uncertain);
    await expire(uncertain.id);
    assert.equal(await store.release(tenantId, uncertain.id, uncertain.requestHash), false);
    await assert.rejects(store.reserve(tenantId, request(31, 30)), AiQuotaCapacityError);
    await store.reserve(tenantId, { ...request(30, 30), operation: 'embedding' });
  });

  await t.test('known overrun records actual cost and blocks later claims before dispatch', async () => {
    const tenantId = await tenant();
    const overrun = request(60, 60);
    const later = request(40, 40);
    await store.reserve(tenantId, overrun);
    await store.reserve(tenantId, later);
    const actual = { ...usage(overrun.id, await claim(tenantId, overrun)), costMicroUsd: 61 };
    assert.equal((await store.settle(tenantId, actual)).overrun, true);
    assert.deepEqual(await balance(tenantId), { cost: '61', tokens: '20' });
    await assert.rejects(store.claim(tenantId, later.id, later.requestHash), AiQuotaCapacityError);
    assert.equal(await store.release(tenantId, later.id, later.requestHash), true);
    await store.reserve(tenantId, request(39, 80));
  });

  await t.test('claim rechecks usage already recorded by the existing quota manager', async () => {
    const tenantId = await tenant();
    const item = request(40, 60);
    await store.reserve(tenantId, item);
    await new QuotaManager(uow).consume(tenantId, 0, 41);
    await assert.rejects(store.claim(tenantId, item.id, item.requestHash), AiQuotaCapacityError);
    assert.equal(await store.release(tenantId, item.id, item.requestHash), true);
  });

  await t.test('previous-period claims never redispatch or debit the new period', async () => {
    const tenantId = await tenant();
    const claimed = request();
    const unclaimed = request(40, 60);
    await store.reserve(tenantId, claimed);
    await store.reserve(tenantId, unclaimed);
    const actual = usage(claimed.id, await claim(tenantId, claimed));
    await uow.run(tenantId, async (db) => {
      await db.query(`UPDATE tenant_ai_quotas SET period_start = date_trunc('month', NOW()) - INTERVAL '1 month',
        reset_at = date_trunc('month', NOW()) WHERE tenant_id = $1`, [tenantId]);
      await db.query(`UPDATE ai_quota_reservations SET period_start = date_trunc('month', NOW()) - INTERVAL '1 month',
        expires_at = date_trunc('month', NOW()) WHERE tenant_id = $1`, [tenantId]);
    });
    assert.equal(await store.claim(tenantId, unclaimed.id, unclaimed.requestHash), null);
    assert.equal(await store.claim(tenantId, claimed.id, claimed.requestHash), null);
    await store.reserve(tenantId, request(100, 100));
    assert.equal((await store.settle(tenantId, actual)).overrun, false);
    assert.deepEqual(await balance(tenantId), { cost: '0', tokens: '0' });
    assert.equal((await new TokenCostLedger(uow).query(tenantId)).items[0].costMicroUsd, 20);
  });
});
