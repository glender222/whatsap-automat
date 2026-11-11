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
import { HitlApprovalService } from '../services/ai/broker/HitlApprovalService';

const { hashPassword } = require('../utils/password') as { hashPassword(password: string): Promise<string> };

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
    try {
      await uow.run(tenantId, async (sql) => {
        await sql.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
        await sql.query('DELETE FROM usuarios WHERE company_id = $1', [tenantId]);
        await sql.query('DELETE FROM companies WHERE id = $1', [tenantId]);
      });
    } finally { await db.end(); }
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
    overrides: { tenantId?: number; runId?: string; toolInput?: Record<string, unknown>; timeoutMs?: number;
      approvalRequired?: boolean; holdApprovalInsert?: boolean; risk?: 'write' | 'financial' } = {}) {
    const child = fork(join(__dirname, 'fixtures/toolBrokerEffectWorker.ts'), [JSON.stringify({ tenantId, effectKey, runId, log, mode, ...overrides })], {
      execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    let effectRecorded!: () => void;
    const effect = new Promise<void>((resolve) => { effectRecorded = resolve; });
    let approvalInsertReached!: () => void;
    const approvalInsert = new Promise<void>((resolve) => { approvalInsertReached = resolve; });
    let resultReceived!: (result: ToolExecutionResultV1) => void;
    let result: ToolExecutionResultV1 | undefined;
    const response = new Promise<ToolExecutionResultV1>((resolve) => { resultReceived = resolve; });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    child.on('message', (message: unknown) => {
      const event = message as { event: string; result: ToolExecutionResultV1 };
      if (event.event === 'effect') effectRecorded();
      if (event.event === 'approval_insert') approvalInsertReached();
      if (event.event === 'result') { result = event.result; resultReceived(event.result); }
    });
    return { effect, approvalInsert, response, exited, release: () => { if (child.connected) child.send({ release: true }); }, result: () => result };
  }
  async function reviewer() {
    const password = 'approval-fixture-' + randomUUID();
    const passwordHash = await hashPassword(password);
    const actorId = await uow.run(tenantId, async (db) => {
      await db.query("INSERT INTO companies (id, name) VALUES ($1, 'Approval fixture')", [tenantId]);
      const { rows: [actor] } = await db.query(
        "INSERT INTO usuarios (nombre, email, password_hash, rol, company_id) VALUES ('Reviewer', $1, $2, 'ADMIN', $3) RETURNING id",
        [randomUUID() + '@example.invalid', passwordHash, tenantId],
      );
      await db.query("INSERT INTO workspaces (tenant_id, name, slug, is_default) VALUES ($1, 'Approval fixture', 'approval-fixture', true)", [tenantId]);
      await db.query("INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'admin')", [tenantId, actor.id]);
      return String(actor.id);
    });
    return { actorId, password, sessionRole: 'ADMIN' as const };
  }
  return { worker, uow, db, tenantId, effectKey, runId, reviewer,
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

test('approval uniqueness migration preserves historical decisions and enforces RLS after a repeatable upgrade', options, async (t) => {
  const local = await fixture(t);
  const client = await local.db.connect();
  try {
    await client.query('BEGIN');
    const schema = 'fixture_approval_' + randomUUID().replace(/-/g, '');
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET LOCAL search_path TO ${schema}, public`);
    await client.query(`CREATE TABLE approval_requests (LIKE public.approval_requests INCLUDING DEFAULTS INCLUDING CONSTRAINTS)`);
    await client.query('ALTER TABLE approval_requests DROP COLUMN historical_effect_key_conflict');
    await client.query(`ALTER TABLE approval_requests ENABLE ROW LEVEL SECURITY;
      ALTER TABLE approval_requests FORCE ROW LEVEL SECURITY;
      CREATE POLICY tenant_isolation_policy ON approval_requests
        USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)
        WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::integer)`);
    const bravo = local.tenantId + 1;
    for (const [tenant, id, status, key] of [
      [local.tenantId, 'old-approved', 'approved', 'duplicated'],
      [local.tenantId, 'old-rejected', 'rejected', 'duplicated'],
      [local.tenantId, 'old-pending', 'pending', 'single'],
      [bravo, 'bravo-pending', 'pending', 'duplicated'],
    ] as const) {
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [String(tenant)]);
      await client.query(`INSERT INTO approval_requests (id, tenant_id, run_id, tool_name, effect_key,
        proposed_action_hash, risk, status, input_payload, decided_by, decided_at, version, expires_at)
        VALUES ($1, $2, 'historical-run', 'fixture_local_effect', $3, $4, 'write', $5,
          '{"value":12}', '12', '2026-01-01T00:00:00Z', 2, '2026-12-01T00:00:00Z')`,
      [id, tenant, key, 'a'.repeat(64), status]);
    }
    const read = async (tenantId: number) => {
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [String(tenantId)]);
      return (await client.query('SELECT to_jsonb(request) AS value FROM approval_requests request ORDER BY id')).rows.map(({ value }) => value);
    };
    const before = [await read(local.tenantId), await read(bravo)];
    const migration = await readFile(join(__dirname, '../db/migrations/068_approval_effect_uniqueness.sql'), 'utf8');
    await client.query(migration);
    await client.query(migration);
    for (const [index, tenant] of [local.tenantId, bravo].entries()) {
      const after = await read(tenant);
      assert.equal(after.length, before[index].length);
      assert.deepEqual(after.map(({ historical_effect_key_conflict, ...record }) => record), before[index]);
      assert.deepEqual(after.map((record) => record.historical_effect_key_conflict),
        index === 0 ? [true, false, true] : [false]);
    }
    const { rows: [rls] } = await client.query(
      'SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = $1::regclass', [schema + '.approval_requests'],
    );
    assert.deepEqual(rls, { relrowsecurity: true, relforcerowsecurity: true });
    await client.query("SELECT set_config('app.current_tenant_id', '', true)");
    assert.deepEqual((await client.query('SELECT id FROM approval_requests')).rows, []);
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [String(local.tenantId)]);
    await client.query('SAVEPOINT expected_conflict');
    await assert.rejects(client.query(`INSERT INTO approval_requests (id, tenant_id, run_id, tool_name, effect_key,
      proposed_action_hash, risk, status, expires_at)
      VALUES ('duplicate-single', $1, 'new-run', 'fixture_local_effect', 'single', $2, 'write', 'pending', clock_timestamp())`,
    [local.tenantId, 'b'.repeat(64)]), { code: '23505' });
    await client.query('ROLLBACK TO SAVEPOINT expected_conflict');
    assert.deepEqual((await read(local.tenantId)).map(({ historical_effect_key_conflict, ...record }) => record), before[0]);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

test('concurrent requests for one effect expose one approval and execute once after reviewer reauthentication', options, async (t) => {
  const local = await fixture(t);
  const first = local.worker('complete', { risk: 'financial', holdApprovalInsert: true });
  const second = local.worker('complete', { risk: 'financial', holdApprovalInsert: true });
  await Promise.all([first.approvalInsert, second.approvalInsert]);
  first.release();
  second.release();

  const [a, b] = await Promise.all([first.response, second.response]);
  assert.equal(a.status, 'awaiting_approval');
  assert.equal(b.status, 'awaiting_approval');
  assert.ok(a.approvalId);
  assert.equal(a.approvalId, b.approvalId, 'Retries of one effect must return the same approval identity');
  assert.deepEqual([a.error?.code, b.error?.code].sort(), ['HITL_PENDING', 'HITL_REQUIRED']);
  const { rows } = await local.uow.run(local.tenantId, (db) => db.query(
    'SELECT id FROM approval_requests WHERE tenant_id = $1 AND effect_key = $2', [local.tenantId, local.effectKey],
  ));
  assert.deepEqual(rows, [{ id: a.approvalId }]);
  assert.equal(await local.state(), undefined);
  assert.deepEqual(await local.receipts(), []);

  const { actorId, password } = await local.reviewer();
  const approvals = new HitlApprovalService(local.uow);
  const command = { tenantId: local.tenantId, actorId, sessionRole: 'ADMIN', approvalId: a.approvalId,
    decision: 'approved' as const, expectedVersion: 1, reason: 'Confirm synthetic effect', idempotencyKey: randomUUID() };
  await assert.rejects(approvals.decideReviewerApproval({ ...command, password: 'incorrect' }),
    { code: 'APPROVAL_REAUTH_INVALID' });
  assert.equal((await approvals.getApprovalById(local.tenantId, a.approvalId))?.status, 'pending');
  const approved = await approvals.decideReviewerApproval({ ...command, password });
  assert.equal(approved.status, 'approved');
  assert.deepEqual(await approvals.decideReviewerApproval({ ...command, password }), approved);
  assert.equal((await local.worker('complete', { risk: 'financial' }).response).status, 'executed');
  assert.equal((await local.worker('complete', { risk: 'financial' }).response).status, 'cached');
  assert.equal((await local.worker('complete', { approvalRequired: true }).response).error?.code, 'APPROVAL_ACTION_MISMATCH');
  assert.equal((await local.receipts()).length, 1);
  await local.uow.run(local.tenantId, (db) => db.query(
    'UPDATE approval_requests SET historical_effect_key_conflict = true WHERE tenant_id = $1 AND id = $2',
    [local.tenantId, a.approvalId],
  ));
  assert.deepEqual(await approvals.decideReviewerApproval({ ...command, password }), approved,
    'A recorded decision retains its exact idempotent response after historical conflict discovery');
  assert.equal((await local.worker('complete', { risk: 'financial' }).response).error?.code, 'APPROVAL_EFFECT_CONFLICT');
  assert.equal((await local.receipts()).length, 1);
});

test('competing proposals cannot borrow the approval identity of a different action', options, async (t) => {
  const local = await fixture(t);
  const first = local.worker('complete', { approvalRequired: true, holdApprovalInsert: true, toolInput: { count: 1 } });
  const second = local.worker('complete', { approvalRequired: true, holdApprovalInsert: true, toolInput: { count: 2 } });
  await Promise.all([first.approvalInsert, second.approvalInsert]);
  first.release();
  second.release();

  const results = await Promise.all([first.response, second.response]);
  const accepted = results.find((result) => result.status === 'awaiting_approval');
  const denied = results.find((result) => result.status === 'unauthorized');
  assert.ok(accepted?.approvalId);
  assert.equal(denied?.error?.code, 'APPROVAL_ACTION_MISMATCH');
  assert.equal(denied?.approvalId, null);
  const { rows } = await local.uow.run(local.tenantId, (db) => db.query(
    'SELECT id FROM approval_requests WHERE tenant_id = $1 AND effect_key = $2', [local.tenantId, local.effectKey],
  ));
  assert.deepEqual(rows, [{ id: accepted.approvalId }]);
  assert.deepEqual(await local.receipts(), []);
});

test('ambiguous historical approvals preserve both decisions and authorize no effect', options, async (t) => {
  const local = await fixture(t);
  const attempt = await local.worker('complete', { approvalRequired: true }).response;
  assert.ok(attempt.approvalId);
  await local.uow.run(local.tenantId, async (db) => {
    await db.query(`UPDATE approval_requests SET historical_effect_key_conflict = true,
      status = 'approved', decided_by = '12', decided_at = clock_timestamp(), version = 2
      WHERE tenant_id = $1 AND id = $2`, [local.tenantId, attempt.approvalId]);
    await db.query(`INSERT INTO approval_requests (id, tenant_id, run_id, tool_name, effect_key,
      proposed_action_hash, risk, status, decided_by, decided_at, version, expires_at, historical_effect_key_conflict)
      SELECT 'historical-fixture-' || id, tenant_id, run_id, tool_name, effect_key,
        proposed_action_hash, risk, 'rejected', '13', clock_timestamp(), 2, expires_at, true
      FROM approval_requests WHERE tenant_id = $1 AND id = $2`, [local.tenantId, attempt.approvalId]);
    await db.query(`INSERT INTO approval_requests (id, tenant_id, run_id, tool_name, effect_key,
      proposed_action_hash, risk, status, version, expires_at, historical_effect_key_conflict)
      SELECT 'pending-fixture-' || id, tenant_id, run_id, tool_name, effect_key,
        proposed_action_hash, risk, 'pending', 1, expires_at, true
      FROM approval_requests WHERE tenant_id = $1 AND id = $2`, [local.tenantId, attempt.approvalId]);
  });
  const records = () => local.uow.run(local.tenantId, async (db) => (await db.query(
    `SELECT id, status, decided_by, decided_at, version FROM approval_requests
     WHERE tenant_id = $1 AND effect_key = $2 ORDER BY id`, [local.tenantId, local.effectKey],
  )).rows);
  const before = await records();
  const denied = await local.worker('complete', { approvalRequired: true }).response;
  assert.equal(denied.error?.code, 'APPROVAL_EFFECT_CONFLICT');
  assert.equal(denied.approvalId, null);
  assert.equal(await local.state(), undefined);
  assert.deepEqual(await local.receipts(), []);
  assert.equal(before.length, 3);
  assert.deepEqual(await records(), before);

  const reviewer = await local.reviewer();
  const service = new HitlApprovalService(local.uow);
  const approvalId = 'pending-fixture-' + attempt.approvalId;
  await assert.rejects(service.findApprovalByEffectKey(local.tenantId, local.effectKey), { code: 'APPROVAL_EFFECT_CONFLICT' });
  assert.equal((await service.getApprovalById(local.tenantId, approvalId))?.executionBlocker, 'APPROVAL_EFFECT_CONFLICT');
  const command = { ...reviewer, tenantId: local.tenantId, approvalId, decision: 'approved' as const,
    expectedVersion: 1, reason: 'Review duplicate', idempotencyKey: randomUUID() };
  await assert.rejects(service.decideReviewerApproval(command), { code: 'APPROVAL_EFFECT_CONFLICT' });
  await assert.rejects(service.decideApproval({ ...command, actorRole: 'admin' }), { code: 'APPROVAL_EFFECT_CONFLICT' });
  assert.deepEqual(await records(), before);

  const rejected = await service.decideReviewerApproval({ ...command, decision: 'rejected', idempotencyKey: randomUUID() });
  assert.equal(rejected.status, 'rejected');
  const after = await records();
  assert.deepEqual(after.filter(({ id }) => id !== approvalId), before.filter(({ id }) => id !== approvalId));
  assert.equal(after.find(({ id }) => id === approvalId)?.status, 'rejected');
  assert.equal((await local.worker('complete', { approvalRequired: true }).response).error?.code, 'APPROVAL_EFFECT_CONFLICT');
  assert.deepEqual(await local.receipts(), []);
});

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
