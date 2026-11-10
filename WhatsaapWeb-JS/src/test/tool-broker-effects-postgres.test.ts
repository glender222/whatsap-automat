import './fixtures/testEnv';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomInt, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Pool } from 'pg';
import type { ToolExecutionResultV1 } from '@whatsap-automat/contracts';
import { TenantScopedUoW } from '../db/TenantScopedUoW';
import { EffectCache } from '../services/ai/broker/EffectCache';

const connectionString = process.env.TOOL_BROKER_TEST_DATABASE_URL;
const options = { skip: !connectionString && 'TOOL_BROKER_TEST_DATABASE_URL is required', timeout: 30_000 };

async function fixture(t: TestContext) {
  const connection = new URL(connectionString!);
  assert.equal(connection.hostname, '127.0.0.1');
  assert.ok(connection.pathname.endsWith('_smoke'));
  const db = new Pool({ connectionString });
  const uow = new TenantScopedUoW(db);
  const tenantId = randomInt(600_000_000, 700_000_000);
  t.after(async () => {
    try { await uow.run(tenantId, (sql) => sql.query('DELETE FROM tenants WHERE id = $1', [tenantId])); }
    finally { await db.end(); }
  });
  const { rows: [role] } = await db.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
  assert.deepEqual(role, { rolsuper: false, rolbypassrls: false });
  const { rows: [rls] } = await db.query(`
    SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'tool_execution_effects'::regclass
  `);
  assert.deepEqual(rls, { relrowsecurity: true, relforcerowsecurity: true });
  await uow.run(tenantId, (sql) => sql.query(
    "INSERT INTO tenants (id, name, slug) VALUES ($1, 'Fixture broker effects', $2)", [tenantId, `broker-${randomUUID()}`],
  ));
  const directory = await mkdtemp('/tmp/tool-broker-effects-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const log = join(directory, 'receipts.log');
  const effectKey = randomUUID();
  const runId = randomUUID();

  function worker(mode: 'hold' | 'crash' | 'complete' | 'completion_ack_lost' | 'completion_not_saved' | 'late',
    overrides: { tenantId?: number; runId?: string; toolInput?: Record<string, unknown>; timeoutMs?: number } = {}) {
    const child = fork(join(__dirname, 'fixtures/toolBrokerEffectWorker.ts'), [JSON.stringify({ tenantId, effectKey, runId, log, mode, ...overrides })], {
      execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    let effectRecorded!: () => void;
    const effect = new Promise<void>((resolve) => { effectRecorded = resolve; });
    let resultReceived!: (result: ToolExecutionResultV1) => void;
    let result: ToolExecutionResultV1 | undefined;
    const response = new Promise<ToolExecutionResultV1>((resolve) => { resultReceived = resolve; });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    child.on('message', (message: unknown) => {
      const event = message as { event: string; result: ToolExecutionResultV1 };
      if (event.event === 'effect') effectRecorded();
      if (event.event === 'result') { result = event.result; resultReceived(event.result); }
    });
    return { effect, response, exited, release: () => { if (child.connected) child.send({ release: true }); }, result: () => result };
  }
  return { worker, uow, db, tenantId, effectKey, runId,
    receipts: async () => {
      try { return (await readFile(log, 'utf8')).trim().split('\n'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    },
    state: () => uow.run(tenantId, async (sql) => (await sql.query(
      'SELECT status, output, action_hash FROM tool_execution_effects WHERE tenant_id = $1 AND effect_key = $2',
      [tenantId, effectKey],
    )).rows[0]),
  };
}

test('a timed-out tool can still produce its effect later, and remains fenced from retry', options, async (t) => {
  const local = await fixture(t);
  const late = local.worker('late', { timeoutMs: 20 });
  await late.exited;
  assert.equal(late.result()?.error?.code, 'EFFECT_OUTCOME_UNKNOWN');
  assert.equal((await local.receipts()).length, 1, 'the original invocation completed after the timeout');
  const retry = local.worker('complete');
  await retry.exited;
  assert.equal(retry.result()?.error?.code, 'EFFECT_OUTCOME_UNKNOWN');
  assert.equal((await local.receipts()).length, 1);
});

test('PostgreSQL refusal to store a claim never falls back to executing the tool in memory', options, async (t) => {
  const local = await fixture(t);
  await local.db.query(`
    CREATE FUNCTION fixture_broker_reject_claim() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic effect storage failure'; END $$;
    CREATE TRIGGER fixture_broker_reject_claim BEFORE INSERT ON tool_execution_effects
      FOR EACH ROW WHEN (NEW.tool_name = 'fixture_local_effect') EXECUTE FUNCTION fixture_broker_reject_claim();
  `);
  try {
    const attempt = local.worker('complete');
    await attempt.exited;
    assert.equal(attempt.result()?.error?.code, 'EFFECT_STORE_UNAVAILABLE');
    assert.equal((await local.receipts()).length, 0);
    assert.equal(await local.state(), undefined);
  } finally {
    await local.db.query('DROP FUNCTION fixture_broker_reject_claim() CASCADE');
  }
});

test('historical unbound results remain intact and cannot authorize a new dispatch', options, async (t) => {
  const local = await fixture(t);
  const store = new EffectCache(local.uow);
  const historical = { runId: local.runId, toolName: 'fixture_local_effect', status: 'executed', output: 'historical-result' };
  await store.set(local.tenantId, local.effectKey, historical);
  const attempt = local.worker('complete');
  await attempt.exited;
  assert.equal(attempt.result()?.error?.code, 'EFFECT_LEGACY_UNBOUND');
  assert.equal((await local.receipts()).length, 0);
  assert.deepEqual(await store.get(local.tenantId, local.effectKey), historical);
  assert.equal((await local.state()).action_hash, null);
});

test('only the original claim can record one immutable result, and uncertainty cannot overwrite it', options, async (t) => {
  const local = await fixture(t);
  const store = new EffectCache(local.uow);
  const claim = await store.claim(local.tenantId, local.effectKey, {
    runId: local.runId, toolName: 'fixture_local_effect', actionHash: 'a'.repeat(64),
  }, 10_000);
  assert.equal(claim.kind, 'claimed');
  if (claim.kind !== 'claimed') return;
  await assert.rejects(store.complete(local.tenantId, local.effectKey, randomUUID(), 'forged'));
  await store.markUnknown(local.tenantId, local.effectKey, randomUUID());
  assert.equal((await local.state()).status, 'processing');
  await store.complete(local.tenantId, local.effectKey, claim.token, 'confirmed');
  await store.markUnknown(local.tenantId, local.effectKey, claim.token);
  await assert.rejects(store.complete(local.tenantId, local.effectKey, claim.token, 'overwritten'));
  assert.equal((await store.get(local.tenantId, local.effectKey))?.output, 'confirmed');
});

test('two broker processes do not execute the same mutative effect concurrently', options, async (t) => {
  const local = await fixture(t);
  const first = local.worker('hold');
  await first.effect;
  const second = local.worker('hold');
  const contender = await Promise.race([second.effect.then(() => 'effect'), second.response.then(() => 'result')]);
  first.release();
  if (contender === 'effect') second.release();
  await Promise.all([first.exited, second.exited]);
  assert.equal((await local.receipts()).length, 1, 'only one physical side effect is permitted across processes');
  assert.equal(first.result()?.success, true);
  assert.equal(second.result()?.error?.code, 'EFFECT_IN_PROGRESS');
  const replay = local.worker('complete');
  await replay.exited;
  assert.equal(replay.result()?.status, 'cached');
  assert.equal((await local.receipts()).length, 1);
});

test('a broker process killed after the physical effect cannot repeat it on restart', options, async (t) => {
  const local = await fixture(t);
  const crashed = local.worker('crash');
  assert.equal((await crashed.exited).signal, 'SIGKILL');
  const restarted = local.worker('complete');
  await restarted.exited;
  assert.equal((await local.receipts()).length, 1, 'an unconfirmed effect must be reconciled rather than replayed');
  assert.equal(restarted.result()?.success, false, 'missing completion evidence cannot be reported as successful');
  await local.uow.run(local.tenantId, (sql) => sql.query(`
    UPDATE tool_execution_effects SET dispatch_deadline = clock_timestamp() - interval '1 second'
    WHERE tenant_id = $1 AND effect_key = $2
  `, [local.tenantId, local.effectKey]));
  const stale = local.worker('complete');
  await stale.exited;
  assert.equal(stale.result()?.error?.code, 'EFFECT_OUTCOME_UNKNOWN');
  assert.equal((await local.state()).status, 'delivery_unknown');
  assert.equal((await local.receipts()).length, 1);
});

test('a different action or run cannot borrow an existing effect key, including while it is in flight', options, async (t) => {
  const local = await fixture(t);
  const original = local.worker('hold', { toolInput: { amount: 1 } });
  await original.effect;
  const changed = local.worker('complete', { toolInput: { amount: 2 } });
  await changed.exited;
  assert.equal(changed.result()?.error?.code, 'EFFECT_KEY_CONFLICT');
  assert.equal((await local.receipts()).length, 1);
  original.release();
  await original.exited;
  const differentRun = local.worker('complete', { runId: randomUUID(), toolInput: { amount: 1 } });
  await differentRun.exited;
  assert.equal(differentRun.result()?.error?.code, 'EFFECT_KEY_CONFLICT');
  const replay = local.worker('complete', { toolInput: { amount: 1 } });
  await replay.exited;
  assert.equal(replay.result()?.status, 'cached');
  assert.equal((await local.receipts()).length, 1);
});

test('Bravo neither reads nor reuses Alfa effects and revoked authorization is checked before cache replay', options, async (t) => {
  const local = await fixture(t);
  const bravo = local.tenantId + 1;
  await local.uow.run(bravo, (sql) => sql.query(
    "INSERT INTO tenants (id, name, slug) VALUES ($1, 'Fixture broker Bravo', $2)", [bravo, `broker-${randomUUID()}`],
  ));
  const alfaEffect = local.worker('complete');
  await alfaEffect.exited;
  assert.equal((await new EffectCache(local.uow).get(bravo, local.effectKey)), null);
  assert.equal((await local.uow.run(bravo, (sql) => sql.query(
    'SELECT * FROM tool_execution_effects WHERE tenant_id = $1 AND effect_key = $2', [local.tenantId, local.effectKey],
  ))).rowCount, 0);
  const bravoEffect = local.worker('complete', { tenantId: bravo });
  await bravoEffect.exited;
  assert.equal(bravoEffect.result()?.status, 'executed');
  assert.equal((bravoEffect.result()?.output as { tenantId: number }).tenantId, bravo);
  assert.equal((await local.receipts()).length, 2);
  await local.uow.run(local.tenantId, (sql) => sql.query(`
    INSERT INTO agent_tool_grants (tenant_id, tool_name, is_enabled, required_roles)
    VALUES ($1, 'fixture_local_effect', false, ARRAY['admin'])
  `, [local.tenantId]));
  const denied = local.worker('complete');
  await denied.exited;
  assert.equal(denied.result()?.status, 'unauthorized');
  assert.equal(denied.result()?.output, null);
  assert.equal((await local.receipts()).length, 2);
  await local.uow.run(bravo, (sql) => sql.query('DELETE FROM tenants WHERE id = $1', [bravo]));
});

for (const mode of ['completion_ack_lost', 'completion_not_saved'] as const) {
  test(`${mode} reports uncertainty and never dispatches the effect again`, options, async (t) => {
    const local = await fixture(t);
    const first = local.worker(mode);
    await first.exited;
    assert.equal(first.result()?.error?.code, 'EFFECT_OUTCOME_UNKNOWN');
    assert.equal(first.result()?.success, false);
    const replay = local.worker('complete');
    await replay.exited;
    if (mode === 'completion_ack_lost') assert.equal(replay.result()?.status, 'cached');
    else {
      assert.equal(replay.result()?.error?.code, 'EFFECT_OUTCOME_UNKNOWN');
      assert.equal((await local.state()).status, 'delivery_unknown');
    }
    assert.equal((await local.receipts()).length, 1);
  });
}
