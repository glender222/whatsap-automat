import './fixtures/testEnv';
import assert from 'node:assert/strict';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { Pool } from 'pg';
import config from '../config/index';
import { TenantScopedUoW } from '../db/TenantScopedUoW';
import { saveDraft } from '../services/ai/studio/AgentStudioDrafts';
import { boundedTextCapability } from '../services/ai/gateway/BoundedTextCompletion';
import { AiQuotaReservationStore } from '../services/ai/gateway/AiQuotaReservationStore';
import { CatalogRouterCheckpointStore } from '../services/ai/runtime/CatalogRouterCheckpointStore';
import { startCatalogCheckpointRetention } from '../services/ai/runtime/CatalogCheckpointRetention';

const databaseUrl = process.env.STRICT_CATALOG_TEST_DATABASE_URL;
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
async function until(condition: () => Promise<boolean>) {
  for (let i = 0; i < 250; i++) { if (await condition()) return; await delay(20); }
  assert.fail('Expired catalog payloads were not erased without endpoint traffic');
}

test('App periodically erases inactive tenants ciphertext and preserves accounting under PostgreSQL RLS', {
  skip: !databaseUrl && 'STRICT_CATALOG_TEST_DATABASE_URL must select a local _smoke database', timeout: 30_000,
}, async (t) => {
  const url = new URL(databaseUrl!);
  assert.equal(url.hostname, '127.0.0.1');
  assert.match(url.pathname, /_smoke$/);
  const db = new Pool({ connectionString: databaseUrl });
  t.after(() => db.end());
  t.mock.method(globalThis, 'fetch', async () => assert.fail('Retention must not contact a provider'));
  const uow = new TenantScopedUoW(db);
  const store = new CatalogRouterCheckpointStore(uow);
  const quota = new AiQuotaReservationStore(uow);
  const { rows: [role] } = await db.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user');
  assert.deepEqual(role, { rolsuper: false, rolbypassrls: false });
  const tenantIds = [randomInt(700_000_000, 800_000_000), randomInt(800_000_000, 900_000_000)];
  const tenants = await Promise.all(tenantIds.map(async (id) => {
    const graph = await uow.run(id, async (tx) => {
      await tx.query("INSERT INTO companies(id,name) VALUES($1,'Inactive retention fixture')", [id]);
      await tx.query("INSERT INTO tenants(id,name,slug) VALUES($1,'Inactive retention fixture',$2)", [id, randomUUID()]);
      await tx.query('INSERT INTO tenant_ai_quotas(tenant_id) VALUES($1)', [id]);
      return saveDraft(tx, id, 1, `retention-${randomUUID()}`, {
        entryNodeId: 'router', policyRef: 'retention-fixture',
        nodes: [
          { id: 'router', kind: 'router', config: { profile: 'catalog-router-v1', provider: 'openai', model: boundedTextCapability.model,
            prompt: 'Route', maxTokens: 128, timeoutMs: 1000 } },
          { id: 'catalog', kind: 'tool', config: { toolName: 'catalog.search', schemaVersion: 1, agentId: 1,
            catalogScope: { catalogIds: [1], sectionIds: [] }, maxResults: 1 } },
          { id: 'answer', kind: 'agent', config: { provider: 'openai', model: boundedTextCapability.model, prompt: 'Answer', maxTokens: 128, timeoutMs: 1000 } },
          { id: 'end', kind: 'end', config: {} },
        ],
        edges: [{ id: 'catalog', from: 'router', to: 'catalog', condition: 'catalog' }, { id: 'reply', from: 'router', to: 'answer', condition: 'reply' },
          { id: 'read', from: 'catalog', to: 'answer' }, { id: 'done', from: 'answer', to: 'end' }],
        limits: { maxSteps: 4, maxDelegations: 0, maxParallelNodes: 1, maxDurationSeconds: 60, maxModelTokens: 800256, maxCostMicroUsd: 601152 },
      }, true);
    });
    assert.ok(graph);
    async function completedRun() {
      const runId = randomUUID();
      await store.prepare(id, { id: runId, graphId: graph!.graphId, version: 1, specHash: graph!.specHash,
        inputHash: digest('Synthetic question'), authorizationHash: digest(String(id)), maxTokens: 1000, maxCostMicroUsd: 1000, maxDurationSeconds: 60 });
      for (const slot of ['router', 'answer'] as const) {
        const round = { slot, roundId: randomUUID(), requestHash: digest(`${runId}-${slot}`) };
        await store.ensureRound(id, runId, round);
        await quota.reserve(id, { id: round.roundId, requestHash: round.requestHash, operation: 'eval',
          provider: boundedTextCapability.provider, model: boundedTextCapability.model, maxTokens: 1000, maxCostMicroUsd: 1000 });
        const claim = await quota.claim(id, round.roundId, round.requestHash);
        assert.ok(claim);
        await quota.settle(id, { id: round.roundId, claimToken: claim.token, promptTokens: 12, completionTokens: 4,
          costMicroUsd: 27, status: 'success', isByok: false, latencyMs: 1 }, (tx, result) => store.recordRound(tx, id, runId, {
          ...round, ledgerId: result.ledgerId, output: slot === 'router' ? '{"route":"catalog","query":"fixture","limit":1}' : 'Synthetic answer',
        }));
        if (slot === 'router') await store.withToolCheckpoint(id, runId, { inputHash: digest('fixture'), authorizationHash: digest(String(id)) },
          async () => ({ items: [{ id: 1, name: 'Synthetic catalog item' }] }), async () => {});
      }
      return runId;
    }
    return { id, expired: await completedRun(), fresh: await completedRun() };
  }));
  const expire = (id: number, run: string) => uow.run(id, (tx) => tx.query(`UPDATE catalog_router_runs SET
    created_at=created_at-interval '2 hours',deadline_at=deadline_at-interval '2 hours',expires_at=expires_at-interval '2 hours'
    WHERE tenant_id=$1 AND id=$2`, [id, run]));
  const snapshot = (id: number) => uow.run(id, async (tx) => ({
    runs: (await tx.query('SELECT id,tokens_used,cost_micro_usd,input_hash,authorization_hash FROM catalog_router_runs WHERE tenant_id=$1 ORDER BY id', [id])).rows,
    rounds: (await tx.query('SELECT run_id,slot,round_id,ledger_id,request_hash,output_hash,tokens_used,cost_micro_usd FROM catalog_router_rounds WHERE tenant_id=$1 ORDER BY run_id,slot', [id])).rows,
    tools: (await tx.query('SELECT run_id,input_hash,authorization_hash,output_hash FROM catalog_router_tool_checkpoints WHERE tenant_id=$1 ORDER BY run_id', [id])).rows,
    ledger: (await tx.query('SELECT id,total_tokens,cost_micro_usd,status FROM ai_token_cost_ledger WHERE tenant_id=$1 ORDER BY id', [id])).rows,
    reservations: (await tx.query('SELECT id,status,ledger_id,settlement_hash FROM ai_quota_reservations WHERE tenant_id=$1 ORDER BY id', [id])).rows,
    quota: (await tx.query('SELECT current_month_cost_micro_usd,current_month_tokens_used FROM tenant_ai_quotas WHERE tenant_id=$1', [id])).rows,
  }));
  const payloads = (id: number, run: string) => uow.run(id, async (tx) => ({
    run: (await tx.query('SELECT state FROM catalog_router_runs WHERE tenant_id=$1 AND id=$2', [id, run])).rows[0],
    rounds: (await tx.query('SELECT output_encrypted FROM catalog_router_rounds WHERE tenant_id=$1 AND run_id=$2', [id, run])).rows,
    tool: (await tx.query('SELECT output_encrypted FROM catalog_router_tool_checkpoints WHERE tenant_id=$1 AND run_id=$2', [id, run])).rows[0],
  }));
  const before = await Promise.all(tenants.map(({ id }) => snapshot(id)));
  const freshBefore = await Promise.all(tenants.map(({ id, fresh }) => payloads(id, fresh)));
  await Promise.all(tenants.map(({ id, expired }) => expire(id, expired)));

  await t.test('App.start cleans both idle companies without any HTTP request', async () => {
    const child = fork('src/test/fixtures/catalogRetentionApp.ts', [], {
      execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: { ...process.env, HOST: '127.0.0.1', PORT: '0', WHATSAPP_PROVIDER: 'meta-cloud',
        DB_HOST: url.hostname, DB_PORT: url.port || '5432', DB_NAME: url.pathname.slice(1),
        DB_USER: decodeURIComponent(url.username), DB_PASSWORD: decodeURIComponent(url.password),
        META_WA_ACCESS_TOKEN: 'synthetic-local-token', META_WA_PHONE_NUMBER_ID: '109000000000001', META_WABA_ID: '109000000000002',
        META_WEBHOOK_VERIFY_TOKEN: 'synthetic-retention-verify', META_APP_SECRET: 'synthetic-retention-secret' },
    });
    let ready = false;
    let unexpectedNetwork = false;
    child.on('message', (message) => {
      const state = message as { ready?: boolean; unexpectedNetwork?: boolean };
      ready ||= Boolean(state.ready); unexpectedNetwork ||= Boolean(state.unexpectedNetwork);
    });
    child.stderr?.resume();
    try {
      await until(async () => { assert.equal(child.exitCode, null, 'The local App exited before listening'); return ready; });
      await until(async () => (await Promise.all(tenants.map(async ({ id, expired }) => (await payloads(id, expired)).run.state === 'expired'))).every(Boolean));
      for (const [index, { id, expired, fresh }] of tenants.entries()) {
        const cleaned = await payloads(id, expired);
        assert.equal(cleaned.rounds.length, 2);
        assert.ok(cleaned.rounds.every((round) => round.output_encrypted === null));
        assert.equal(cleaned.tool.output_encrypted, null);
        assert.deepEqual(await payloads(id, fresh), freshBefore[index]);
        assert.deepEqual(await snapshot(id), before[index]);
      }
      assert.equal(unexpectedNetwork, false);
      const exited = once(child, 'exit');
      child.send({ stop: true });
      const [code] = await Promise.race([exited, delay(3000).then(() => { throw new Error('Retention prevented App shutdown'); })]);
      assert.equal(code, 0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    }
  });

  await t.test('concurrent sweepers skip a locked run and preserve every accounting row', async () => {
    const [{ id, fresh }, other] = tenants;
    await Promise.all(tenants.map(({ id, fresh }) => expire(id, fresh)));
    const client = await db.connect();
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_tenant_id',$1,true)", [String(id)]);
    await client.query('SELECT id FROM catalog_router_runs WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [id, fresh]);
    const stopA = startCatalogCheckpointRetention(db, store, 5);
    const stopB = startCatalogCheckpointRetention(db, store, 5);
    try {
      await until(async () => (await payloads(other.id, other.fresh)).run.state === 'expired');
      assert.ok((await payloads(id, fresh)).rounds.every((round) => round.output_encrypted !== null));
      await client.query('COMMIT');
      await until(async () => (await payloads(id, fresh)).run.state === 'expired');
      for (const [index, owner] of tenants.entries()) assert.deepEqual(await snapshot(owner.id), before[index]);
    } finally { await client.query('ROLLBACK'); client.release(); await Promise.all([stopA(), stopB()]); }
  });

  await t.test('a tenant backlog is erased in batches of at most 100 without deleting accounting', async () => {
    const { id, fresh } = tenants[0];
    const ids = await uow.run(id, async (tx) => {
      const inserted = await tx.query(`INSERT INTO catalog_router_runs
        (tenant_id,id,graph_id,graph_version,spec_hash,input_hash,authorization_hash,max_tokens,max_cost_micro_usd,
          max_duration_seconds,created_at,deadline_at,expires_at)
        SELECT tenant_id,gen_random_uuid(),graph_id,graph_version,spec_hash,input_hash,authorization_hash,max_tokens,max_cost_micro_usd,
          max_duration_seconds,created_at,deadline_at,expires_at FROM catalog_router_runs CROSS JOIN generate_series(1,101)
        WHERE tenant_id=$1 AND id=$2 RETURNING id`, [id, fresh]);
      const runIds = inserted.rows.map((row) => row.id);
      await tx.query(`INSERT INTO catalog_router_tool_checkpoints(tenant_id,run_id,input_hash,authorization_hash,output_hash,output_encrypted)
        SELECT tenant_id,new_run,input_hash,authorization_hash,output_hash,$3 FROM catalog_router_tool_checkpoints,
          unnest($4::uuid[]) AS new_run WHERE tenant_id=$1 AND run_id=$2`, [id, fresh, freshBefore[0].tool.output_encrypted, runIds]);
      return runIds;
    });
    const previousKey = config.security.tokenEncryptionKey;
    config.security.tokenEncryptionKey = '';
    try { assert.equal(await new CatalogRouterCheckpointStore(uow).eraseExpired(id), 100); }
    finally { config.security.tokenEncryptionKey = previousKey; }
    const remaining = () => uow.run(id, async (tx) => (await tx.query(`SELECT count(*)::integer AS n
      FROM catalog_router_tool_checkpoints WHERE tenant_id=$1 AND run_id=ANY($2::uuid[]) AND output_encrypted IS NOT NULL`, [id, ids])).rows[0].n);
    assert.equal(await remaining(), 1);
    const stop = startCatalogCheckpointRetention(db, store, 5);
    try { await until(async () => await remaining() === 0); }
    finally { await stop(); }
    const after = await snapshot(id);
    assert.deepEqual(after.ledger, before[0].ledger);
    assert.deepEqual(after.reservations, before[0].reservations);
    assert.deepEqual(after.quota, before[0].quota);
    assert.equal(after.runs.length, before[0].runs.length + 101);
    assert.equal(after.tools.length, before[0].tools.length + 101);
  });

  await t.test('pre-migration storage is retryable and stoppable without encryption or provider access', async (context) => {
    const schema = 'retention_' + randomUUID().replaceAll('-', '');
    await db.query(`CREATE SCHEMA ${schema}`);
    const isolated = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    const warnings: unknown[][] = [];
    context.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args); });
    const previousKey = config.security.tokenEncryptionKey;
    let stop: (() => Promise<void>) | undefined;
    try {
      await isolated.query('CREATE TABLE companies(id integer PRIMARY KEY)');
      await isolated.query('INSERT INTO companies(id) VALUES(1),(2)');
      config.security.tokenEncryptionKey = '';
      stop = startCatalogCheckpointRetention(isolated, new CatalogRouterCheckpointStore(new TenantScopedUoW(isolated)), 5);
      await until(async () => warnings.length >= 4);
      await stop();
      assert.ok(warnings.every((warning) => (warning[1] as { code: string }).code === '42P01'));
      assert.equal((await isolated.query('SELECT count(*)::integer AS n FROM companies')).rows[0].n, 2);
    } finally {
      await stop?.(); config.security.tokenEncryptionKey = previousKey;
      await isolated.end(); await db.query(`DROP SCHEMA ${schema} CASCADE`);
    }
  });
  assert.equal((await db.query('SELECT id FROM catalog_router_runs')).rowCount, 0);
});
