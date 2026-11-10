import { crashFixture } from './fixtures/metaInboundCrashEnvironment';
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import config from '../config/index';
import pool from '../config/database';
import { TenantScopedUoW } from '../db/TenantScopedUoW';
import { OutboxRepository } from '../services/outbox/OutboxRepository';
import { MetaInboxStore } from '../services/whatsapp/meta/MetaInboxStore';
import {
  InvalidMetaInboundWorkError, META_INBOUND_EVENT_TYPE, MetaInboundWorkRepository,
  metaInboundWorkKey, type MetaInboundClaim, type MetaInboundOutcome,
} from '../services/whatsapp/meta/MetaInboundWorkRepository';
import { MetaInboundWorker, type MetaInboundAuthority } from '../services/whatsapp/meta/MetaInboundWorker';

type WorkRow = {
  id: string;
  tenant_id: number;
  event_id: string;
  event_type: string;
  idempotency_key: string;
  correlation_id: string;
  payload: Record<string, any>;
  status: string;
  lease_token: string | null;
  next_retry_at: Date | null;
  retry_count: number;
  last_error: string | null;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function barrier<T>(promise: Promise<T>, description: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error(`Fixture never reached ${description}`)), 10_000);
    })]);
  } finally {
    clearTimeout(timeout);
  }
}

test('Meta inbound work preserves PostgreSQL atomicity, fencing and conservative runtime recovery', {
  skip: process.env.META_INBOUND_CRASH_TEST !== '1' && 'Opt in with a dedicated local _smoke database',
  timeout: 60_000,
  concurrency: false,
}, async (t) => {
  assert.match(config.database.name, /^meta_inbound_recovery_[a-z0-9_]+_smoke$/);
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(config.database.host));
  t.after(() => pool.end());
  const { rows: [role] } = await pool.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
  assert.deepEqual(role, { rolsuper: false, rolbypassrls: false });
  const { rows: [rls] } = await pool.query(`
    SELECT count(*)::integer AS tables, bool_and(relrowsecurity AND relforcerowsecurity) AS enforced
    FROM pg_class WHERE oid IN ('processing_outbox'::regclass, 'meta_inbound_work_tenants'::regclass)
  `);
  assert.deepEqual(rls, { tables: 2, enforced: true });

  const uow = new TenantScopedUoW(pool);
  const repository = new MetaInboundWorkRepository(pool, uow);
  const genericOutbox = new OutboxRepository(uow);

  async function tenant(context: TestContext) {
    const companyId = randomInt(500_000_000, 700_000_000);
    await uow.run(companyId, async (db) => {
      await db.query("INSERT INTO companies (id, name) VALUES ($1, 'Meta inbound work fixture')", [companyId]);
      await db.query("INSERT INTO tenants (id, name, slug) VALUES ($1, 'Meta inbound work fixture', $2)",
        [companyId, `meta-inbound-work-${companyId}`]);
    });
    context.after(() => uow.run(companyId, async (db) => {
      // The receipt FK is ON DELETE SET NULL; delete fixture receipts first.
      await db.query('DELETE FROM whatsapp_webhook_events WHERE company_id = $1', [companyId]);
      await db.query('DELETE FROM companies WHERE id = $1', [companyId]);
      await db.query('DELETE FROM tenants WHERE id = $1', [companyId]);
    }));
    return companyId;
  }

  function inbound(id = `wamid.work-${randomUUID()}`, phoneNumberId: string | null = crashFixture.phoneNumberId) {
    return {
      message: {
        id, from: crashFixture.recipient, timestamp: String(Math.floor(Date.now() / 1000)),
        type: 'text', text: { body: 'Synthetic PostgreSQL inbound work fixture' },
      },
      contact: null,
      metadata: phoneNumberId ? { phone_number_id: phoneNumberId } : {},
      value: {},
    };
  }

  function inbox(companyId: number) { return new MetaInboxStore({ db: pool, companyId }); }

  async function rows(companyId: number): Promise<WorkRow[]> {
    return uow.run(companyId, async (db) => (await db.query(`
      SELECT id, tenant_id, event_id, event_type, idempotency_key, correlation_id, payload,
        status, lease_token, next_retry_at, retry_count, last_error
      FROM processing_outbox WHERE tenant_id = $1 ORDER BY created_at, id
    `, [companyId])).rows);
  }

  async function work(companyId: number, input = inbound()): Promise<WorkRow> {
    assert.equal((await inbox(companyId).persistInboundMessage(input)).duplicate, false);
    const matches = (await rows(companyId)).filter((row) => row.correlation_id === input.message.id);
    assert.equal(matches.length, 1);
    return matches[0];
  }

  async function claim(companyId: number): Promise<MetaInboundClaim> {
    const value = await repository.claim(companyId, 10_000);
    assert.ok(value);
    return value;
  }

  async function expire(companyId: number, jobId: string) {
    await uow.run(companyId, (db) => db.query(`
      UPDATE processing_outbox SET next_retry_at = clock_timestamp() - interval '1 second'
      WHERE tenant_id = $1 AND id = $2
    `, [companyId, jobId]));
  }

  function worker(execute: ConstructorParameters<typeof MetaInboundWorker>[0]['execute'], runtimeTimeoutMs = 10_000) {
    return new MetaInboundWorker({ repository, execute, leaseMs: 10_000, runtimeTimeoutMs });
  }

  await t.test('a failure after the real enqueue rolls back the receipt, message and recovery work together', async (context) => {
    const companyId = await tenant(context);
    const input = inbound();
    const original = MetaInboundWorkRepository.prototype.enqueue;
    let insertedId: string | undefined;
    const failure = new Error('FIXTURE_AFTER_REAL_ENQUEUE');
    MetaInboundWorkRepository.prototype.enqueue = async function (...args) {
      const result = await original.apply(this, args);
      insertedId = result.id;
      const { rows: [visible] } = await args[2].query(`
        SELECT (SELECT count(*)::integer FROM processing_outbox WHERE tenant_id = $1) AS jobs,
          (SELECT count(*)::integer FROM messages WHERE company_id = $1) AS messages,
          (SELECT count(*)::integer FROM whatsapp_webhook_events WHERE company_id = $1) AS receipts,
          (SELECT count(*)::integer FROM meta_inbound_work_tenants WHERE tenant_id = $1) AS discovery
      `, [companyId]);
      assert.deepEqual(visible, { jobs: 1, messages: 1, receipts: 1, discovery: 1 });
      throw failure;
    };
    try {
      await assert.rejects(inbox(companyId).persistInboundMessage(input), (error) => error === failure);
    } finally {
      MetaInboundWorkRepository.prototype.enqueue = original;
    }
    assert.ok(insertedId, 'The injected failure must occur after an actual PostgreSQL outbox insert');
    const counts = await uow.run(companyId, async (db) => (await db.query(`
      SELECT (SELECT count(*)::integer FROM messages WHERE company_id = $1) AS messages,
        (SELECT count(*)::integer FROM contacts WHERE company_id = $1) AS contacts,
        (SELECT count(*)::integer FROM conversations WHERE company_id = $1) AS conversations,
        (SELECT count(*)::integer FROM whatsapp_webhook_events WHERE company_id = $1) AS receipts,
        (SELECT count(*)::integer FROM processing_outbox WHERE tenant_id = $1) AS jobs,
        (SELECT count(*)::integer FROM meta_inbound_work_tenants WHERE tenant_id = $1) AS discovery
    `, [companyId])).rows[0]);
    assert.deepEqual(counts, { messages: 0, contacts: 0, conversations: 0, receipts: 0, jobs: 0, discovery: 0 });
    const retried = await work(companyId, input);
    assert.notEqual(retried.id, insertedId);
    assert.equal(retried.status, 'pending');
  });

  await t.test('concurrent redelivery produces one stable job and preserves its durable message reference', async (context) => {
    const companyId = await tenant(context);
    const input = inbound();
    const results = await Promise.all(Array.from({ length: 6 }, () => inbox(companyId).persistInboundMessage(input)));
    assert.equal(results.filter((result) => result.duplicate === false).length, 1);
    assert.equal(results.filter((result) => result.duplicate === true).length, 5);
    const before = await rows(companyId);
    assert.equal(before.length, 1);
    assert.equal(before[0].event_type, META_INBOUND_EVENT_TYPE);
    assert.equal(before[0].idempotency_key, metaInboundWorkKey(companyId, crashFixture.phoneNumberId, input.message.id));
    assert.equal(before[0].correlation_id, input.message.id);
    const { messageId, conversationId } = before[0].payload;
    assert.deepEqual(before[0].payload, {
      schemaVersion: 1, messageId, conversationId, phoneNumberId: crashFixture.phoneNumberId,
      inboundProviderMessageId: input.message.id,
    });
    const evidence = await uow.run(companyId, async (db) => (await db.query(`
      SELECT id::text AS id, conversation_id::text AS conversation_id, provider_message_id,
        metadata_json #>> '{metadata,phone_number_id}' AS phone_number_id
      FROM messages WHERE company_id = $1
    `, [companyId])).rows);
    assert.deepEqual(evidence, [{ id: messageId, conversation_id: conversationId,
      provider_message_id: input.message.id, phone_number_id: crashFixture.phoneNumberId }]);
    assert.ok((await repository.getTenantIds()).includes(companyId));
    await Promise.all(Array.from({ length: 3 }, () => inbox(companyId).persistInboundMessage(input)));
    assert.deepEqual(await rows(companyId), before);
  });

  await t.test('tenant identity is independent while a duplicate wamid on another line is rejected', async (context) => {
    const companyA = await tenant(context);
    const companyB = await tenant(context);
    const input = inbound();
    const first = await work(companyA, input);
    const second = await work(companyB, input);
    assert.notEqual(first.id, second.id);
    assert.notEqual(first.idempotency_key, second.idempotency_key);
    const otherPhone = '178000000000099';
    assert.notEqual(metaInboundWorkKey(companyA, otherPhone, input.message.id), first.idempotency_key);
    await assert.rejects(inbox(companyA).persistInboundMessage(inbound(input.message.id, otherPhone)),
      { code: 'META_INBOUND_PHONE_CONFLICT' });
    assert.deepEqual(await rows(companyA), [first]);
    assert.deepEqual(await rows(companyB), [second]);
    const hidden = await uow.run(companyA, (db) => db.query(
      'SELECT id FROM processing_outbox WHERE tenant_id = $1 AND id = $2', [companyB, second.id]));
    assert.equal(hidden.rowCount, 0);
    const owned = await claim(companyA);
    const foreign = { ...owned, companyId: companyB };
    await assert.rejects(repository.load(foreign), InvalidMetaInboundWorkError);
    assert.equal(await repository.enterRuntime(foreign, 10_000), false);
    assert.equal(await repository.isCurrent(foreign), false);
    assert.deepEqual(await rows(companyB), [second]);
  });

  await t.test('history without a phone remains history and does not acquire work on redelivery', async (context) => {
    const companyId = await tenant(context);
    const input = inbound(`wamid.history-${randomUUID()}`, null);
    assert.equal((await inbox(companyId).persistInboundMessage(input)).duplicate, false);
    assert.deepEqual(await rows(companyId), []);
    assert.equal((await inbox(companyId).persistInboundMessage(inbound(input.message.id))).duplicate, true);
    assert.deepEqual(await rows(companyId), []);
    assert.ok(!(await repository.getTenantIds()).includes(companyId));
  });

  await t.test('concurrent claims have one owner and expired processing cannot dispatch with its stale token', async (context) => {
    const companyId = await tenant(context);
    const job = await work(companyId);
    const candidates = await Promise.all([repository.claim(companyId, 10_000), repository.claim(companyId, 10_000)]);
    const owners = candidates.filter((value): value is MetaInboundClaim => value !== null);
    assert.equal(owners.length, 1);
    const stale = owners[0];
    assert.equal(stale.jobId, job.id);
    await expire(companyId, job.id);
    assert.equal(await repository.enterRuntime(stale, 10_000), false, 'Expiry fences even before another worker reclaims');
    assert.equal(await repository.failBeforeRuntime(stale, false), false);
    const current = await claim(companyId);
    assert.equal(current.jobId, stale.jobId);
    assert.notEqual(current.leaseToken, stale.leaseToken);
    assert.equal(await repository.enterRuntime(stale, 10_000), false);
    assert.equal(await repository.failBeforeRuntime(stale, true), false);
    assert.equal(await repository.enterRuntime(current, 10_000), true);
    assert.equal(await repository.enterRuntime(current, 10_000), false, 'One lease may enter runtime only once');
    assert.equal(await repository.isCurrent(stale), false);
    assert.equal(await repository.isCurrent(current), true);
    assert.equal(await repository.finish(stale, { status: 'completed' }), false);
    assert.equal(await repository.finish(stale, { status: 'uncertain' }), false);
    assert.equal(await repository.finish(current, { status: 'completed' }), true);
    assert.equal(await repository.isCurrent(current), false);
    assert.equal((await rows(companyId))[0].status, 'completed');
  });

  await t.test('expired dispatched work becomes uncertain without callback entry or automatic replay', async (context) => {
    const companyId = await tenant(context);
    const input = inbound();
    const job = await work(companyId, input);
    const owner = await claim(companyId);
    assert.equal(await repository.enterRuntime(owner, 10_000), true);
    await expire(companyId, job.id);
    assert.equal(await repository.isCurrent(owner), false);
    assert.equal(await repository.finish(owner, { status: 'completed' }), false);
    let entered = 0;
    const restarted = worker(async () => { entered++; return { status: 'completed' }; });
    assert.equal(await restarted.processBatch(companyId), 0);
    const [unknown] = await rows(companyId);
    assert.equal(unknown.status, 'delivery_unknown');
    assert.equal(unknown.lease_token, null);
    assert.equal(unknown.next_retry_at, null);
    assert.equal(unknown.last_error, 'META_INBOUND_RUNTIME_INTERRUPTED');
    assert.equal(await repository.finish(owner, { status: 'completed' }), false);
    assert.equal(await repository.finish(owner, { status: 'uncertain' }), false);
    assert.equal((await inbox(companyId).persistInboundMessage(input)).duplicate, true);
    for (let index = 0; index < 3; index++) assert.equal(await restarted.processBatch(companyId), 0);
    assert.equal(entered, 0);
    assert.deepEqual(await rows(companyId), [unknown]);
  });

  await t.test('the generic relay ignores both pending and uncertain Meta work', async (context) => {
    const companyId = await tenant(context);
    const uncertain = await work(companyId);
    const owner = await claim(companyId);
    assert.equal(await repository.enterRuntime(owner, 10_000), true);
    assert.equal(await repository.finish(owner, { status: 'uncertain' }), true);
    const pending = await work(companyId);
    const generic = await genericOutbox.enqueue(companyId, {
      eventType: 'fixture.unrelated', correlationId: randomUUID(), idempotencyKey: randomUUID(), payload: {},
    });
    const before = (await rows(companyId)).filter((row) => row.event_type === META_INBOUND_EVENT_TYPE);
    assert.deepEqual(new Set(before.map((row) => row.id)), new Set([uncertain.id, pending.id]));
    const genericClaims = await genericOutbox.claimPending(companyId, 10);
    assert.deepEqual(genericClaims.map((row) => row.id), [generic.id]);
    assert.deepEqual((await rows(companyId)).filter((row) => row.event_type === META_INBOUND_EVENT_TYPE), before);
    assert.equal((await claim(companyId)).jobId, pending.id);
  });

  await t.test('claim rejects a modified key and load rejects a reference into a different tenant', async (context) => {
    const companyA = await tenant(context);
    const companyB = await tenant(context);
    const invalidKey = await work(companyA);
    await uow.run(companyA, (db) => db.query(
      'UPDATE processing_outbox SET idempotency_key = $1 WHERE tenant_id = $2 AND id = $3',
      [`tampered-${randomUUID()}`, companyA, invalidKey.id]));
    let entered = 0;
    const guarded = worker(async () => { entered++; return { status: 'completed' }; });
    assert.equal(await guarded.processBatch(companyA), 0);
    assert.equal((await rows(companyA))[0].status, 'dead_letter');
    assert.equal((await rows(companyA))[0].last_error, 'META_INBOUND_REFERENCE_INVALID');

    const target = await work(companyB);
    const tampered = await work(companyA);
    await uow.run(companyA, (db) => db.query(`
      UPDATE processing_outbox SET payload = payload || $1::jsonb WHERE tenant_id = $2 AND id = $3
    `, [JSON.stringify({ messageId: target.payload.messageId, conversationId: target.payload.conversationId }),
      companyA, tampered.id]));
    assert.equal(await guarded.processBatch(companyA), 1);
    const rejected = (await rows(companyA)).find((row) => row.id === tampered.id)!;
    assert.equal(rejected.status, 'dead_letter');
    assert.equal(rejected.last_error, 'META_INBOUND_REFERENCE_INVALID');
    assert.equal(rejected.lease_token, null);
    assert.equal(entered, 0);
    assert.deepEqual(await rows(companyB), [target]);
  });

  await t.test('a phone reference with a matching recomputed key must still match the durable message', async (context) => {
    const companyId = await tenant(context);
    const job = await work(companyId);
    const otherPhone = '178000000000098';
    await uow.run(companyId, (db) => db.query(`
      UPDATE processing_outbox SET payload = payload || jsonb_build_object('phoneNumberId', $1::text),
        idempotency_key = $2 WHERE tenant_id = $3 AND id = $4
    `, [otherPhone, metaInboundWorkKey(companyId, otherPhone, job.payload.inboundProviderMessageId), companyId, job.id]));
    let entered = 0;
    await worker(async () => { entered++; return { status: 'completed' }; }).processBatch(companyId);
    assert.equal(entered, 0);
    assert.equal((await rows(companyId))[0].status, 'dead_letter');
  });

  await t.test('a changed raw sender cannot redirect a job away from its stored conversation', async (context) => {
    const companyId = await tenant(context);
    const job = await work(companyId);
    await uow.run(companyId, (db) => db.query(`
      UPDATE messages SET raw_payload_json = raw_payload_json || jsonb_build_object('from', $1::text)
      WHERE company_id = $2 AND id = $3
    `, ['12025550999', companyId, job.payload.messageId]));
    let entered = 0;
    assert.equal(await worker(async () => {
      entered++;
      return { status: 'completed' };
    }).processBatch(companyId), 1);
    assert.equal(entered, 0);
    const [rejected] = await rows(companyId);
    assert.equal(rejected.status, 'dead_letter');
    assert.equal(rejected.last_error, 'META_INBOUND_REFERENCE_INVALID');
  });

  await t.test('a pending retry and an active runtime serialize their conversation without blocking another one', async (context) => {
    const companyId = await tenant(context);
    const first = await work(companyId);
    const successor = await work(companyId);
    const otherInput = inbound();
    otherInput.message.from = '12025550124';
    const independent = await work(companyId, otherInput);
    assert.equal(first.payload.conversationId, successor.payload.conversationId);
    assert.notEqual(first.payload.conversationId, independent.payload.conversationId);

    const initial = await claim(companyId);
    assert.equal(initial.jobId, first.id);
    assert.equal(await repository.failBeforeRuntime(initial, false), true);
    const other = await claim(companyId);
    assert.equal(other.jobId, independent.id, 'A delayed predecessor must not let its successor overtake');
    assert.equal(await repository.enterRuntime(other, 10_000), true);
    assert.equal(await repository.claim(companyId, 10_000), null);
    await expire(companyId, first.id);
    const retried = await claim(companyId);
    assert.equal(retried.jobId, first.id);
    assert.notEqual(retried.leaseToken, initial.leaseToken);
    assert.equal(await repository.enterRuntime(retried, 10_000), true);
    assert.equal(await repository.claim(companyId, 10_000), null);

    await expire(companyId, first.id);
    assert.equal(await repository.recoverExpired(companyId), 1);
    const next = await claim(companyId);
    assert.equal(next.jobId, successor.id, 'Unknown history must not prevent new inbound processing');
    assert.equal(await repository.enterRuntime(next, 10_000), true);
    assert.equal(await repository.isCurrent(other), true);
    assert.equal(await repository.finish(retried, { status: 'completed' }), false);
    assert.equal(await repository.finish(next, { status: 'skipped' }), true);
    assert.equal(await repository.finish(other, { status: 'completed' }), true);
    const completed = await rows(companyId);
    assert.equal(completed.find((row) => row.id === first.id)?.status, 'delivery_unknown');
    assert.equal(completed.find((row) => row.id === successor.id)?.status, 'completed');
  });

  await t.test('the worker runs another conversation while keeping the same-conversation successor pending', async (context) => {
    const companyId = await tenant(context);
    const first = await work(companyId);
    const successor = await work(companyId);
    const otherInput = inbound();
    otherInput.message.from = '12025550125';
    const independent = await work(companyId, otherInput);
    const firstEntered = deferred<void>();
    const independentEntered = deferred<void>();
    const release = deferred<MetaInboundOutcome>();
    const entries: string[] = [];
    const runtime = new MetaInboundWorker({
      repository, maxConcurrency: 2, leaseMs: 10_000, runtimeTimeoutMs: 10_000,
      execute: async (execution) => {
        entries.push(execution.jobId);
        if (execution.jobId === first.id) {
          firstEntered.resolve();
          return release.promise;
        }
        if (execution.jobId === independent.id) independentEntered.resolve();
        return { status: 'completed' };
      },
    });
    const active = runtime.processBatch(companyId);
    try {
      await barrier(independentEntered.promise, 'the independent conversation runtime');
      await barrier(firstEntered.promise, 'the held conversation runtime');
      assert.deepEqual(new Set(entries), new Set([first.id, independent.id]));
      assert.equal((await rows(companyId)).find((row) => row.id === successor.id)?.status, 'pending');
      assert.equal(await repository.claim(companyId, 10_000), null);
    } finally {
      release.resolve({ status: 'completed' });
      assert.equal(await active, 2);
    }
    assert.equal(await runtime.processBatch(companyId), 1);
    assert.deepEqual(new Set(entries.slice(0, 2)), new Set([first.id, independent.id]));
    assert.equal(entries[2], successor.id);
    assert.equal(entries.length, 3);
    assert.ok((await rows(companyId)).every((row) => row.status === 'completed'));
  });

  for (const outcome of ['completed', 'skipped', 'uncertain', 'throw', 'invalid'] as const) {
    await t.test(`worker records ${outcome} after the dispatched commit and never replays it`, async (context) => {
      const companyId = await tenant(context);
      const input = inbound();
      const job = await work(companyId, input);
      let entered = 0;
      let observed: {
        jobId: string; companyId: number; message: Record<string, any>;
        aborted: boolean; current: boolean; state: WorkRow;
      } | undefined;
      const runtime = worker(async (execution, authority) => {
        entered++;
        observed = {
          jobId: execution.jobId, companyId: execution.companyId, message: execution.message,
          aborted: authority.signal.aborted, current: await authority.isCurrent(), state: (await rows(companyId))[0],
        };
        if (outcome === 'throw') throw new Error('Synthetic runtime failure after entry');
        if (outcome === 'invalid') return { status: 'invalid' } as unknown as MetaInboundOutcome;
        return { status: outcome, code: 'FIXTURE_RUNTIME_RESULT' };
      });
      assert.equal(await runtime.processBatch(companyId), 1);
      assert.equal(entered, 1);
      // Assert outside execute: the worker intentionally absorbs callback throws.
      assert.ok(observed);
      assert.equal(observed.jobId, job.id);
      assert.equal(observed.companyId, companyId);
      assert.deepEqual(observed.message, input.message);
      assert.equal(observed.aborted, false);
      assert.equal(observed.current, true);
      assert.equal(observed.state.status, 'dispatched', 'The runtime boundary must be committed on another connection');
      assert.ok(observed.state.lease_token);
      const [finished] = await rows(companyId);
      const uncertain = outcome === 'uncertain' || outcome === 'throw' || outcome === 'invalid';
      assert.equal(finished.status, uncertain ? 'delivery_unknown' : 'completed');
      assert.equal(finished.lease_token, null);
      assert.equal(finished.next_retry_at, null);
      assert.equal(finished.payload.outcome.status, uncertain ? 'uncertain' : outcome);
      assert.equal(finished.last_error, uncertain
        ? (outcome === 'uncertain' ? 'FIXTURE_RUNTIME_RESULT' : 'META_INBOUND_RUNTIME_UNCERTAIN') : null);
      assert.equal((await inbox(companyId).persistInboundMessage(input)).duplicate, true);
      assert.equal(await runtime.processBatch(companyId), 0);
      assert.equal(await worker(async () => {
        entered++;
        return { status: 'completed' };
      }).processBatch(companyId), 0);
      assert.equal(entered, 1);
      assert.deepEqual(await rows(companyId), [finished]);
    });
  }

  await t.test('two live workers cannot overlap while one callback is held inside runtime', async (context) => {
    const companyId = await tenant(context);
    await work(companyId);
    const started = deferred<void>();
    const release = deferred<MetaInboundOutcome>();
    let entries = 0;
    const first = worker(async () => {
      entries++;
      started.resolve();
      return release.promise;
    });
    const second = worker(async () => { entries++; return { status: 'completed' }; });
    const running = first.processBatch(companyId);
    try {
      await barrier(started.promise, 'the first worker runtime');
      assert.equal(await second.processBatch(companyId), 0);
      assert.equal(entries, 1);
    } finally {
      release.resolve({ status: 'completed' });
      await running;
    }
    assert.equal((await rows(companyId))[0].status, 'completed');
    assert.equal(await second.processBatch(companyId), 0);
    assert.equal(entries, 1);
  });

  await t.test('timeout aborts the authority and a late completed result cannot erase uncertainty', async (context) => {
    const companyId = await tenant(context);
    const job = await work(companyId);
    const release = deferred<MetaInboundOutcome>();
    const callbackReturned = deferred<void>();
    let authority: MetaInboundAuthority | undefined;
    let entries = 0;
    const runtime = worker(async (_execution, guard) => {
      authority = guard;
      entries++;
      try { return await release.promise; } finally { callbackReturned.resolve(); }
    }, 100);
    try {
      assert.equal(await runtime.processBatch(companyId), 1);
      assert.equal(entries, 1);
      assert.ok(authority);
      assert.equal(authority.signal.aborted, true);
      assert.equal(await authority.isCurrent(), false);
      const [unknown] = await rows(companyId);
      assert.equal(unknown.id, job.id);
      assert.equal(unknown.status, 'delivery_unknown');
      assert.equal(unknown.last_error, 'META_INBOUND_RUNTIME_INTERRUPTED');
      release.resolve({ status: 'completed' });
      await barrier(callbackReturned.promise, 'the late callback completion');
      assert.equal(await runtime.processBatch(companyId), 0);
      assert.deepEqual(await rows(companyId), [unknown]);
      assert.equal(entries, 1);
    } finally {
      release.resolve({ status: 'uncertain' });
      if (authority) await barrier(callbackReturned.promise, 'the timeout callback cleanup');
    }
  });

  await t.test('stop during the dispatched commit does not start a new runtime callback', async (context) => {
    const companyId = await tenant(context);
    await work(companyId);
    const dispatched = deferred<void>();
    const release = deferred<void>();
    class PausedDispatchRepository extends MetaInboundWorkRepository {
      override async enterRuntime(owner: MetaInboundClaim, timeoutMs: number) {
        const entered = await super.enterRuntime(owner, timeoutMs);
        if (entered) {
          dispatched.resolve();
          await release.promise;
        }
        return entered;
      }
    }
    let entries = 0;
    const runtime = new MetaInboundWorker({
      repository: new PausedDispatchRepository(pool, uow), leaseMs: 10_000, runtimeTimeoutMs: 10_000,
      execute: async () => { entries++; return { status: 'completed' }; },
    });
    const active = runtime.processBatch(companyId);
    let stopped: Promise<void> | undefined;
    try {
      await barrier(dispatched.promise, 'the committed dispatch boundary');
      stopped = runtime.stop();
      await nextTurn(); // Let stop sweep existing controllers while enterRuntime remains held.
    } finally {
      release.resolve();
      await Promise.all([active, stopped]);
    }
    assert.equal(entries, 0);
    assert.equal((await rows(companyId))[0].status, 'delivery_unknown');
    assert.equal(await runtime.processBatch(companyId), 0);
  });

  await t.test('stop waits for a manual poll whose committed claim has not returned yet', async (context) => {
    const companyId = await tenant(context);
    const job = await work(companyId);
    const claimed = deferred<MetaInboundClaim>();
    const release = deferred<void>();
    class PausedClaimRepository extends MetaInboundWorkRepository {
      override async claim(tenantId: number, leaseMs: number) {
        const owner = await super.claim(tenantId, leaseMs);
        if (owner) {
          claimed.resolve(owner);
          await release.promise;
        }
        return owner;
      }
    }
    let entries = 0;
    let stopFinished = false;
    const runtime = new MetaInboundWorker({
      repository: new PausedClaimRepository(pool, uow), leaseMs: 10_000, runtimeTimeoutMs: 10_000,
      execute: async () => { entries++; return { status: 'completed' }; },
    });
    const active = runtime.processBatch(companyId);
    let stopped: Promise<void> | undefined;
    let originalOwner: MetaInboundClaim | undefined;
    try {
      originalOwner = await barrier(claimed.promise, 'the committed claim in a manual poll');
      const [visible] = await rows(companyId);
      assert.equal(visible.id, job.id);
      assert.equal(visible.status, 'processing');
      assert.equal(visible.lease_token, originalOwner.leaseToken);
      stopped = runtime.stop().then(() => { stopFinished = true; });
      await nextTurn();
      assert.equal(stopFinished, false, 'stop must wait for polling before a claim enters activeJobs');
      assert.equal(entries, 0);
    } finally {
      release.resolve();
      await barrier(Promise.all([active, stopped]), 'the stopped manual poll cleanup');
    }
    assert.equal(stopFinished, true);
    assert.equal(entries, 0);
    assert.ok(originalOwner);
    const [recoverable] = await rows(companyId);
    assert.equal(recoverable.id, job.id);
    assert.equal(recoverable.status, 'processing');
    assert.equal(recoverable.lease_token, originalOwner.leaseToken);
    assert.ok(recoverable.next_retry_at);
    assert.equal(recoverable.retry_count, 0);
    await expire(companyId, job.id);
    const replacement = await claim(companyId);
    assert.equal(replacement.jobId, job.id);
    assert.notEqual(replacement.leaseToken, originalOwner.leaseToken);
    assert.equal((await repository.load(replacement)).message.id, job.correlation_id);
    assert.equal(entries, 0);
  });
});
