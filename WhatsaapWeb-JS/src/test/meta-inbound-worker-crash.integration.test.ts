import { crashFixture } from './fixtures/metaInboundCrashEnvironment';
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { randomInt, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import config from '../config/index';
import pool from '../config/database';
import { TenantScopedUoW } from '../db/TenantScopedUoW';
import { MetaInboxStore } from '../services/whatsapp/meta/MetaInboxStore';

function event(child: ChildProcess, type: string): Promise<any> {
  return new Promise((resolve, reject) => {
    function cleanup() { clearTimeout(timeout); child.off('message', receive); child.off('exit', exited); }
    function receive(value: any) {
      if (value.type === 'fixture-error') { cleanup(); reject(new Error('Worker fixture failed')); }
      if (value.type === type) { cleanup(); resolve(value); }
    }
    function exited() { cleanup(); reject(new Error(`Worker exited before ${type}`)); }
    const timeout = setTimeout(() => { cleanup(); reject(new Error(`Worker did not reach ${type}`)); }, 10_000);
    child.on('message', receive);
    child.once('exit', exited);
  });
}

async function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
}

test('worker restart distinguishes unentered runtime from an uncertain external effect', {
  skip: process.env.META_INBOUND_CRASH_TEST !== '1' && 'Dedicated local smoke DB required',
  timeout: 40_000,
}, async (t) => {
  assert.match(config.database.name, /^meta_inbound_recovery_[a-z0-9_]+_smoke$/);
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(config.database.host));
  const uow = new TenantScopedUoW(pool);
  t.after(() => pool.end());
  const effects: string[] = [];
  const graph = createServer(async (req, res) => {
    assert.equal(req.url, '/effect');
    assert.equal(req.method, 'POST');
    const bytes: Buffer[] = [];
    for await (const chunk of req) bytes.push(Buffer.from(chunk));
    effects.push(JSON.parse(Buffer.concat(bytes).toString()).jobId);
    res.writeHead(200).end('{}');
  });
  graph.listen(34383, '127.0.0.1');
  await once(graph, 'listening');
  t.after(() => new Promise<void>((resolve) => { graph.close(() => resolve()); graph.closeAllConnections(); }));

  for (const stage of ['claimed', 'reserved', 'effect'] as const) {
    await t.test(`SIGKILL at ${stage}`, async (s) => {
      const companyId = randomInt(700_000_000, 800_000_000);
      const children: ChildProcess[] = [];
      s.after(async () => {
        await Promise.all(children.map(kill));
        await uow.run(companyId, async (db) => {
          await db.query('DELETE FROM whatsapp_webhook_events WHERE company_id = $1', [companyId]);
          await db.query('DELETE FROM companies WHERE id = $1', [companyId]);
          await db.query('DELETE FROM tenants WHERE id = $1', [companyId]);
        });
      });
      await uow.run(companyId, async (db) => {
        await db.query("INSERT INTO companies (id,name) VALUES ($1,'Worker crash fixture')", [companyId]);
        await db.query("INSERT INTO tenants (id,name,slug) VALUES ($1,'Worker crash fixture',$2)", [companyId, `worker-crash-${companyId}`]);
      });
      await new MetaInboxStore({ companyId }).persistInboundMessage({
        metadata: { phone_number_id: crashFixture.phoneNumberId },
        message: { id: `wamid.${randomUUID()}`, from: crashFixture.recipient,
          type: 'text', text: { body: 'Local worker crash fixture' }, timestamp: String(Math.floor(Date.now() / 1000)) },
      });
      const read = () => uow.run(companyId, async (db) => {
        const { rows: [job] } = await db.query(`
          SELECT id, status, lease_token FROM processing_outbox WHERE tenant_id = $1
        `, [companyId]);
        return job;
      });
      async function start(cutStage = '') {
        const child = fork(path.join(__dirname, 'fixtures/metaInboundWorkProcess.ts'), [], {
          execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
          env: {
            PATH: process.env.PATH,
            DB_HOST: config.database.host, DB_PORT: String(config.database.port), DB_NAME: config.database.name,
            DB_USER: config.database.user, DB_PASSWORD: config.database.password,
            META_INBOUND_CRASH_TEST: '1', META_INBOUND_CRASH_TENANT_ID: String(companyId),
            META_INBOUND_CRASH_GRAPH_URL: 'http://127.0.0.1:34383', META_INBOUND_WORK_CUT_STAGE: cutStage,
          },
        });
        children.push(child);
        await event(child, 'ready');
        return child;
      }
      const original = await start(stage);
      const atCut = event(original, stage);
      original.send('run');
      await atCut;
      const before = await read();
      assert.equal(before.status, stage === 'claimed' ? 'processing' : 'dispatched');
      assert.ok(before.lease_token);
      assert.equal(effects.filter((id) => id === before.id).length, stage === 'effect' ? 1 : 0);
      await kill(original);
      assert.equal(original.signalCode, 'SIGKILL');
      // Advance only this fixture's durable deadline instead of sleeping or
      // changing the server clock. A fresh process performs real recovery SQL.
      await uow.run(companyId, (db) => db.query(`
        UPDATE processing_outbox SET next_retry_at = clock_timestamp() - interval '1 second'
        WHERE tenant_id = $1 AND id = $2
      `, [companyId, before.id]));
      for (let attempt = 0; attempt < 2; attempt++) {
        const restarted = await start();
        const finished = event(restarted, 'done');
        const exited = once(restarted, 'exit');
        restarted.send('run');
        const result = await finished;
        await exited;
        assert.equal(result.processed, stage === 'claimed' && attempt === 0 ? 1 : 0);
      }
      const after = await read();
      assert.equal(after.id, before.id);
      assert.equal(after.status, stage === 'claimed' ? 'completed' : 'delivery_unknown');
      assert.equal(after.lease_token, null);
      assert.equal(effects.filter((id) => id === before.id).length, stage === 'reserved' ? 0 : 1);
    });
  }
});
