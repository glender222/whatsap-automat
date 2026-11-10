import { crashFixture } from './fixtures/metaInboundCrashEnvironment';
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { createHmac, randomInt, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import config from '../config/index';
import pool from '../config/database';
import { TenantScopedUoW } from '../db/TenantScopedUoW';
import { MetaAccountStore } from '../services/whatsapp/meta/MetaAccountStore';

type FixtureMessage = { type: string; inboundProviderMessageId?: string; code?: string };

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
  timeout: 30_000,
}, async (t) => {
  assert.match(config.database.name, /^meta_inbound_recovery_[a-z0-9_]+_smoke$/);
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(config.database.host));
  const { rows: [role] } = await pool.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
  assert.deepEqual(role, { rolsuper: false, rolbypassrls: false });
  const uow = new TenantScopedUoW(pool);
  const tenantId = randomInt(500_000_000, 700_000_000);
  await uow.run(tenantId, async (db) => {
    await db.query("INSERT INTO companies (id, name) VALUES ($1, 'Inbound crash fixture')", [tenantId]);
    await db.query("INSERT INTO tenants (id, name, slug) VALUES ($1, 'Inbound crash fixture', $2)",
      [tenantId, `inbound-crash-${tenantId}`]);
  });
  // A fresh DB is preferable; make repeated runs safe without touching other fixtures.
  t.after(async () => {
    try {
      await uow.run(tenantId, async (db) => {
        await db.query('DELETE FROM companies WHERE id = $1', [tenantId]);
        await db.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
      });
    } finally {
      await pool.end();
    }
  });
  await new MetaAccountStore().upsertConnection(tenantId, {
    phoneNumberId: crashFixture.phoneNumberId, accessToken: crashFixture.token,
    graphVersion: crashFixture.graphVersion,
  });

  const graphRequests: Array<{ method?: string; path?: string; recipient: string; text: string }> = [];
  const graphPort = Number(process.env.META_INBOUND_CRASH_GRAPH_PORT || 34381);
  const httpPort = Number(process.env.META_INBOUND_CRASH_HTTP_PORT || 34380);
  for (const port of [graphPort, httpPort]) {
    assert.ok(port > 1024 && port <= 65535 && (port < 34262 || port > 34267));
  }
  assert.notEqual(graphPort, httpPort);
  const graph = createServer(async (request, response) => {
    const bytes: Buffer[] = [];
    for await (const chunk of request) bytes.push(Buffer.from(chunk));
    assert.equal(request.headers.authorization, `Bearer ${crashFixture.token}`);
    const payload = JSON.parse(Buffer.concat(bytes).toString());
    graphRequests.push({ method: request.method, path: request.url, recipient: payload.to, text: payload.text?.body });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ messages: [{ id: `wamid.fixture-outbound-${graphRequests.length}` }] }));
  });
  graph.listen(graphPort, '127.0.0.1');
  await once(graph, 'listening');
  t.after(() => new Promise<void>((resolve) => {
    graph.close(() => resolve());
    graph.closeAllConnections();
  }));

  const cutId = `wamid.fixture-crash-${randomUUID()}`;
  const runtimeEntries: string[] = [];
  async function startChild(context: TestContext, cut = '') {
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
      },
    });
    context.after(() => stop(child));
    child.on('message', (value) => {
      const event = value as FixtureMessage;
      if (event.type === 'runtime-entered') runtimeEntries.push(event.inboundProviderMessageId!);
    });
    await childEvent(child, 'ready');
    return child;
  }
  const webhookUrl = `http://127.0.0.1:${httpPort}/api/webhooks/meta/whatsapp`;
  function signedWebhook(id: string) {
    const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{
      field: 'messages', value: {
        metadata: { phone_number_id: crashFixture.phoneNumberId },
        messages: [{ id, from: crashFixture.recipient, timestamp: String(Math.floor(Date.now() / 1000)),
          type: 'text', text: { body: 'Synthetic crash test only' } }],
      },
    }] }] });
    return fetch(webhookUrl, {
      method: 'POST', signal: AbortSignal.timeout(10_000),
      headers: { 'Content-Type': 'application/json',
        'x-hub-signature-256': `sha256=${createHmac('sha256', crashFixture.appSecret).update(body).digest('hex')}` },
      body,
    });
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
      return { ...messages, events, outbox, runtimeStarted: runtime.started };
    });
  }

  const original = await startChild(t, cutId);
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

  await startChild(t);
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

  await t.test('the restarted HTTP/runtime/Graph path sends one healthy control reply', async () => {
    const controlId = `wamid.fixture-control-${randomUUID()}`;
    const response = await signedWebhook(controlId);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).results[0].duplicate, false);
    assert.deepEqual(runtimeEntries, [controlId]);
    assert.deepEqual(graphRequests, [{ method: 'POST',
      path: `/${crashFixture.graphVersion}/${crashFixture.phoneNumberId}/messages`,
      recipient: crashFixture.recipient, text: `Fixture reply for ${controlId}` }]);
    assert.equal((await snapshot()).outbound, 1);
  });

  t.diagnostic(JSON.stringify({
    cut: 'after inbound commit, before handler resumes', killedWith: original.signalCode,
    committedInbound: beforeKill.inbound, processedWebhook: beforeKill.events.length,
    jobsAtCommit: beforeKill.outbox.length, replayHttpStatus: replay.status,
    replayDuplicate: replayBody.results[0].duplicate, jobsAfterReplay: afterReplay.outbox.length,
    runtimeForInterruptedInbound: afterReplay.runtimeStarted, outboundForInterruptedInbound: afterReplay.outbound,
    healthyControlGraphPosts: graphRequests.length,
  }));
  // This is intentionally RED at ba9ed81. The worker is not started: the first
  // recovery invariant is that durable pending work survives before any dispatch.
  assert.equal(beforeKill.outbox.length, 1,
    'Committed inbound lost its response work before the process could schedule it');
  const [pending] = beforeKill.outbox;
  assert.equal(pending.event_type, 'whatsapp.inbound.received');
  assert.equal(pending.status, 'pending');
  assert.ok(pending.id && pending.idempotency_key);
  assert.ok(pending.message_reference === String(beforeKill.cut_message_id) ||
    pending.provider_message_reference === cutId, 'Pending work must identify the committed inbound for recovery');
  assert.deepEqual(afterReplay.outbox, beforeKill.outbox,
    'Redelivery must preserve the same durable work instead of dropping or duplicating it');
});
