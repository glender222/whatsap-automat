import { crashFixture } from './fixtures/metaInboundCrashEnvironment';
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { createHmac, randomInt, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import config from '../config/index';
import pool from '../config/database';
import { TenantScopedUoW } from '../db/TenantScopedUoW';
import { MetaAccountStore } from '../services/whatsapp/meta/MetaAccountStore';

type FixtureMessage = { type: string; inboundProviderMessageId?: string; code?: string; history?: { body: string }[] };

function childEvent(child: ChildProcess, type: string): Promise<FixtureMessage> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      child.off('message', onMessage);
      child.off('exit', onExit);
    };
    const onMessage = (value: unknown) => {
      const event = value as FixtureMessage;
      if (event.type === 'fixture-error') {
        cleanup();
        reject(new Error(`Child fixture failed: ${event.code}`));
      } else if (event.type === type) {
        cleanup();
        resolve(event);
      }
    };
    const onExit = () => {
      cleanup();
      reject(new Error(`Child exited before ${type}`));
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${type}`));
    }, 10_000);
    child.on('message', onMessage);
    child.once('exit', onExit);
  });
}

async function stop(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM') {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  const timeout = setTimeout(() => child.kill('SIGKILL'), 3000);
  try {
    child.kill(signal);
    await exited;
  } finally {
    clearTimeout(timeout);
  }
}

test('an inbound committed before process death retains recoverable response work', {
  skip: process.env.META_INBOUND_CRASH_TEST !== '1' && 'Opt in with a dedicated local _smoke database',
  timeout: 45_000,
}, async (t) => {
  assert.match(config.database.name, /^meta_inbound_recovery_[a-z0-9_]+_smoke$/);
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(config.database.host));
  const { rows: [role] } = await pool.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
  assert.deepEqual(role, { rolsuper: false, rolbypassrls: false });
  const uow = new TenantScopedUoW(pool);
  const tenantId = randomInt(500_000_000, 700_000_000);
  const phoneNumberId = String(randomInt(178_100_000_000_000, 178_200_000_000_000));
  const children = new Set<ChildProcess>();
  let graph: Server | undefined;
  await uow.run(tenantId, async (db) => {
    await db.query("INSERT INTO companies (id, name) VALUES ($1, 'Inbound crash fixture')", [tenantId]);
    await db.query("INSERT INTO tenants (id, name, slug) VALUES ($1, 'Inbound crash fixture', $2)",
      [tenantId, `inbound-crash-${tenantId}`]);
  });
  // A fresh DB is preferable; make repeated runs safe without touching other fixtures.
  t.after(async () => {
    try {
      await Promise.all([...children].map((child) => stop(child)));
      const runningGraph = graph;
      if (runningGraph?.listening) await new Promise<void>((resolve) => {
        runningGraph.close(() => resolve());
        runningGraph.closeAllConnections();
      });
      await uow.run(tenantId, async (db) => {
        await db.query('DELETE FROM conversation_send_claims WHERE tenant_id = $1', [tenantId]);
        await db.query('DELETE FROM whatsapp_webhook_events WHERE company_id = $1', [tenantId]);
        await db.query('DELETE FROM companies WHERE id = $1', [tenantId]);
        await db.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
      });
    } finally {
      await pool.end();
    }
  });
  await new MetaAccountStore().upsertConnection(tenantId, {
    phoneNumberId, accessToken: crashFixture.token,
    graphVersion: crashFixture.graphVersion,
  });

  const graphRequests: Array<{ method?: string; path?: string; recipient: string; text: string; callback: string }> = [];
  const graphPort = Number(process.env.META_INBOUND_CRASH_GRAPH_PORT || 34381);
  const httpPort = Number(process.env.META_INBOUND_CRASH_HTTP_PORT || 34380);
  for (const port of [graphPort, httpPort]) {
    assert.ok(port > 1024 && port <= 65535 && (port < 34262 || port > 34267));
  }
  assert.notEqual(graphPort, httpPort);
  graph = createServer(async (request, response) => {
    const bytes: Buffer[] = [];
    for await (const chunk of request) bytes.push(Buffer.from(chunk));
    assert.equal(request.headers.authorization, `Bearer ${crashFixture.token}`);
    const payload = JSON.parse(Buffer.concat(bytes).toString());
    graphRequests.push({ method: request.method, path: request.url, recipient: payload.to, text: payload.text?.body,
      callback: payload.biz_opaque_callback_data });
    // Graph has accepted the first POST. Keep the connection open before its acknowledgement.
    if (graphRequests.length === 1) return;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ messages: [{ id: `wamid.fixture-outbound-${graphRequests.length}` }] }));
  });
  graph.listen(graphPort, '127.0.0.1');
  await once(graph, 'listening');

  const cutId = `wamid.fixture-crash-${randomUUID()}`;
  const runtimeEntries: FixtureMessage[] = [];
  async function startChild(cut = '', runWorker = false) {
    // Do not inherit real provider credentials, unrelated ports or worker settings.
    const child = fork(path.join(__dirname, 'fixtures/metaInboundCrashServer.ts'), [], {
      execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: {
        PATH: process.env.PATH,
        DB_HOST: config.database.host, DB_PORT: String(config.database.port), DB_NAME: config.database.name,
        DB_USER: config.database.user, DB_PASSWORD: config.database.password,
        META_INBOUND_CRASH_TEST: '1', META_INBOUND_CRASH_TENANT_ID: String(tenantId),
        META_INBOUND_CRASH_HTTP_PORT: String(httpPort),
        META_INBOUND_CRASH_GRAPH_URL: `http://127.0.0.1:${graphPort}`,
        META_INBOUND_CRASH_CUT_ID: cut,
        META_INBOUND_CRASH_FIXTURE_PHONE_ID: phoneNumberId,
        META_INBOUND_CRASH_RUN_WORKER: runWorker ? '1' : '0',
      },
    });
    children.add(child);
    child.on('message', (value) => {
      const event = value as FixtureMessage;
      if (event.type === 'runtime-entered') runtimeEntries.push(event);
    });
    await childEvent(child, 'ready');
    return child;
  }
  const webhookUrl = `http://127.0.0.1:${httpPort}/api/webhooks/meta/whatsapp`;
  function postWebhook(change: object) {
    const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{
      field: 'messages', value: {
        metadata: { phone_number_id: phoneNumberId },
        ...change,
      },
    }] }] });
    return fetch(webhookUrl, {
      method: 'POST', signal: AbortSignal.timeout(10_000),
      headers: { 'Content-Type': 'application/json',
        'x-hub-signature-256': `sha256=${createHmac('sha256', crashFixture.appSecret).update(body).digest('hex')}` },
      body,
    });
  }
  function signedWebhook(id: string) {
    return postWebhook({ messages: [{ id, from: crashFixture.recipient, timestamp: String(Math.floor(Date.now() / 1000)),
      type: 'text', text: { body: 'Synthetic crash test only' } }] });
  }
  async function snapshot() {
    return uow.run(tenantId, async (db) => {
      const { rows: [messages] } = await db.query(`
        SELECT count(*) FILTER (WHERE direction = 'inbound')::integer AS inbound,
          count(*) FILTER (WHERE direction = 'outbound')::integer AS outbound,
          max(id) FILTER (WHERE provider_message_id = $2) AS cut_message_id
        FROM messages WHERE company_id = $1
      `, [tenantId, cutId]);
      const { rows: events } = await db.query(`
        SELECT processing_status FROM whatsapp_webhook_events WHERE company_id = $1 AND provider_message_id = $2
      `, [tenantId, cutId]);
      const { rows: outbox } = await db.query(`
        SELECT id, event_type, status, idempotency_key, correlation_id,
          payload->>'messageId' AS message_reference,
          payload->>'inboundProviderMessageId' AS provider_message_reference
        FROM processing_outbox WHERE tenant_id = $1 ORDER BY created_at, id
      `, [tenantId]);
      const { rows: [runtime] } = await db.query(`
        SELECT count(*)::integer AS started FROM agent_runtime_logs
        WHERE company_id = $1 AND inbound_provider_message_id = $2 AND stage = 'agent_runtime_started'
      `, [tenantId, cutId]);
      const { rows: claims } = await db.query(`
        SELECT c.actor_type, c.state, c.provider_message_id, m.status AS message_status
        FROM conversation_send_claims c JOIN messages m ON m.company_id = c.tenant_id AND m.id = c.message_id
        WHERE c.tenant_id = $1 ORDER BY c.message_id
      `, [tenantId]);
      return { ...messages, events, outbox, claims, runtimeStarted: runtime.started };
    });
  }

  const original = await startChild(cutId);
  const reachedCut = childEvent(original, 'inbound-committed');
  const interruptedRequest = signedWebhook(cutId).then(
    () => 'unexpected-response', () => 'connection-closed',
  );
  await reachedCut;
  const beforeKill = await snapshot(); // A different process/connection sees COMMIT.
  assert.equal(beforeKill.inbound, 1);
  assert.deepEqual(beforeKill.events, [{ processing_status: 'processed' }]);
  assert.equal(beforeKill.outbound, 0);
  assert.equal(beforeKill.runtimeStarted, 0);
  assert.deepEqual(runtimeEntries, []);
  assert.equal(graphRequests.length, 0);
  await stop(original, 'SIGKILL');
  assert.equal(original.signalCode, 'SIGKILL');
  assert.equal(await interruptedRequest, 'connection-closed');

  const receiver = await startChild();
  const replay = await signedWebhook(cutId);
  assert.equal(replay.status, 200);
  const replayBody = await replay.json();
  assert.equal(replayBody.results[0].duplicate, true);
  const afterReplay = await snapshot();
  assert.equal(afterReplay.inbound, 1);
  assert.equal(afterReplay.outbound, 0);
  assert.equal(afterReplay.runtimeStarted, 0);
  assert.deepEqual(runtimeEntries, []);
  assert.equal(graphRequests.length, 0);

  assert.equal(beforeKill.outbox.length, 1,
    'Committed inbound lost its response work before the process could schedule it');
  const [pending] = beforeKill.outbox;
  assert.equal(pending.event_type, 'whatsapp.inbound.received');
  assert.equal(pending.status, 'pending');
  assert.ok(pending.id && pending.idempotency_key);
  assert.equal(pending.message_reference, String(beforeKill.cut_message_id));
  assert.equal(pending.provider_message_reference, cutId);
  assert.deepEqual(afterReplay.outbox, beforeKill.outbox,
    'Redelivery must preserve the same durable work instead of dropping or duplicating it');
  await stop(receiver);

  // Simulate conversation traffic on each side of the recovered message's timestamp.
  await uow.run(tenantId, (db) => db.query(`
    INSERT INTO messages (company_id, conversation_id, direction, channel, provider, external_contact_id,
      body, message_type, status, occurred_at)
    SELECT m.company_id, m.conversation_id, 'inbound', 'whatsapp', 'meta-cloud', m.external_contact_id,
      fixture.body, 'text', 'received', m.occurred_at + fixture.time_shift
    FROM messages m CROSS JOIN (VALUES ('Antes del inbound', interval '-1 second'),
      ('Después del inbound', interval '1 second')) AS fixture(body, time_shift)
    WHERE m.company_id = $1 AND m.id = $2
  `, [tenantId, beforeKill.cut_message_id]));

  async function waitFor(check: () => Promise<boolean>, label: string) {
    const deadline = performance.now() + 8000;
    do {
      if (await check()) return;
      await delay(50);
    } while (performance.now() < deadline);
    assert.fail('Timed out waiting for ' + label);
  }

  const worker = await startChild('', true);
  await waitFor(async () => graphRequests.length === 1, 'the recovered reply at Graph');
  assert.deepEqual(runtimeEntries.map((entry) => entry.inboundProviderMessageId), [cutId]);
  assert.deepEqual(runtimeEntries[0].history, [{ fromMe: false, body: 'Antes del inbound' }]);
  assert.deepEqual(graphRequests[0], { method: 'POST',
    path: `/${crashFixture.graphVersion}/${phoneNumberId}/messages`,
    recipient: crashFixture.recipient, text: `Fixture reply for ${cutId}`, callback: graphRequests[0].callback });
  assert.match(graphRequests[0].callback, /^automat:[a-f0-9-]{36}$/);
  const admitted = await snapshot();
  assert.equal(admitted.outbox[0].id, pending.id);
  assert.equal(admitted.outbox[0].status, 'dispatched');
  assert.deepEqual(admitted.claims, [{ actor_type: 'ai_agent', state: 'unknown_delivery',
    provider_message_id: null, message_status: 'unknown_delivery' }]);
  await stop(worker, 'SIGKILL');
  assert.equal(worker.signalCode, 'SIGKILL');
  await uow.run(tenantId, (db) => db.query(`
    UPDATE processing_outbox SET next_retry_at = clock_timestamp() - interval '1 millisecond'
    WHERE tenant_id = $1 AND id = $2 AND status = 'dispatched'
  `, [tenantId, pending.id]));

  const recovered = await startChild('', true);
  const replayAfterGraph = await signedWebhook(cutId);
  assert.equal(replayAfterGraph.status, 200);
  assert.equal((await replayAfterGraph.json()).results[0].duplicate, true);
  await waitFor(async () => (await snapshot()).outbox[0]?.status === 'delivery_unknown', 'the interrupted runtime outcome');
  assert.equal(graphRequests.length, 1);
  assert.deepEqual(runtimeEntries.map((entry) => entry.inboundProviderMessageId), [cutId]);
  const delivery = await postWebhook({ statuses: [{
    id: 'wamid.fixture-outbound-1', status: 'delivered', recipient_id: crashFixture.recipient,
    timestamp: String(Math.floor(Date.now() / 1000)), biz_opaque_callback_data: graphRequests[0].callback,
  }] });
  assert.equal(delivery.status, 200);
  assert.deepEqual((await snapshot()).claims, [{ actor_type: 'ai_agent', state: 'provider_accepted',
    provider_message_id: 'wamid.fixture-outbound-1', message_status: 'delivered' }]);
  assert.equal(graphRequests.length, 1);

  const controlId = `wamid.fixture-control-${randomUUID()}`;
  const control = await signedWebhook(controlId);
  assert.equal(control.status, 200);
  assert.equal((await control.json()).results[0].duplicate, false);
  await waitFor(async () => (await snapshot()).outbox.some((job) =>
    job.provider_message_reference === controlId && job.status === 'completed'), 'the next inbound after reconciliation');
  assert.deepEqual(runtimeEntries.map((entry) => entry.inboundProviderMessageId), [cutId, controlId]);
  assert.equal(graphRequests.length, 2);
  assert.equal(graphRequests[1].text, `Fixture reply for ${controlId}`);
  await stop(recovered);
});
