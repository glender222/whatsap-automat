import './fixtures/testEnv';
import assert from 'node:assert/strict';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { TenantScopedUoW } from '../db/TenantScopedUoW';
import { saveDraft } from '../services/ai/studio/AgentStudioDrafts';
import { boundedTextCapability } from '../services/ai/gateway/BoundedTextCompletion';
import { AiQuotaReservationStore, type AiQuotaSettlement } from '../services/ai/gateway/AiQuotaReservationStore';
import {
  CatalogRouterCheckpointStore, type CatalogRouterCheckpointAuthorize, type CatalogRouterPrepareCommand,
  type CatalogRouterRoundIntent,
} from '../services/ai/runtime/CatalogRouterCheckpointStore';

const databaseUrl = process.env.STRICT_CATALOG_TEST_DATABASE_URL;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

test('catalog checkpoints preserve tenant-scoped accounting and short-lived encrypted evidence', {
  skip: !databaseUrl && 'STRICT_CATALOG_TEST_DATABASE_URL must select a local _smoke database', timeout: 30_000,
}, async (t) => {
  const url = new URL(databaseUrl!);
  assert.equal(url.hostname, '127.0.0.1');
  assert.match(url.pathname, /_smoke$/);
  const pool = new Pool({ connectionString: databaseUrl });
  t.after(() => pool.end());
  t.mock.method(globalThis, 'fetch', async () => assert.fail('Checkpoint store tests must never contact a provider'));
  const uow = new TenantScopedUoW(pool);
  const store = new CatalogRouterCheckpointStore(uow);
  const quota = new AiQuotaReservationStore(uow);
  const { rows: [role] } = await pool.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user');
  assert.deepEqual(role, { rolsuper: false, rolbypassrls: false });
  const { rows: [rls] } = await pool.query(`SELECT count(*)::integer AS tables,
    bool_and(relrowsecurity AND relforcerowsecurity) AS enforced FROM pg_class WHERE oid IN
    ('catalog_router_runs'::regclass,'catalog_router_rounds'::regclass,'catalog_router_tool_checkpoints'::regclass)`);
  assert.deepEqual(rls, { tables: 3, enforced: true });

  async function tenant() {
    const id = randomInt(700_000_000, 900_000_000);
    const graph = await uow.run(id, async (db) => {
      await db.query("INSERT INTO companies(id,name) VALUES($1,'Catalog checkpoint fixture')", [id]);
      await db.query("INSERT INTO tenants(id,name,slug) VALUES($1,'Catalog checkpoint fixture',$2)", [id,randomUUID()]);
      await db.query('INSERT INTO tenant_ai_quotas(tenant_id,monthly_token_limit,monthly_cost_limit_micro_usd) VALUES($1,1000000,1000000)', [id]);
      return saveDraft(db,id,1,`checkpoint-${randomUUID()}`, {
        entryNodeId: 'router', policyRef: 'checkpoint-fixture',
        nodes: [
          { id: 'router', kind: 'router', config: { profile: 'catalog-router-v1', provider: boundedTextCapability.provider,
            model: boundedTextCapability.model, prompt: 'Choose a route', maxTokens: 128, timeoutMs: 1000 } },
          { id: 'tool', kind: 'tool', config: { toolName: 'catalog.search',schemaVersion: 1,agentId: 1,
            catalogScope: { catalogIds: [1],sectionIds: [] },maxResults: 3 } },
          { id: 'answer', kind: 'agent', config: { provider: boundedTextCapability.provider,model: boundedTextCapability.model,
            prompt: 'Answer',maxTokens: 128,timeoutMs: 1000 } },
          { id: 'end', kind: 'end', config: {} },
        ],
        edges: [{ id: 'catalog',from: 'router',to: 'tool',condition: 'catalog' },
          { id: 'reply',from: 'router',to: 'answer',condition: 'reply' },
          { id: 'tool-done',from: 'tool',to: 'answer' },{ id: 'done',from: 'answer',to: 'end' }],
        limits: { maxSteps: 4,maxDelegations: 0,maxParallelNodes: 1,maxDurationSeconds: 60,
          maxModelTokens: 800256,maxCostMicroUsd: 601152 },
      },true);
    });
    assert.ok(graph);
    const authorize: CatalogRouterCheckpointAuthorize = async (db,expected) => {
      assert.equal(expected,digest(`auth-${id}`));
      const { rows: [context] } = await db.query("SELECT current_setting('app.current_tenant_id') AS tenant");
      assert.equal(context.tenant,String(id));
    };
    return { id,graph,authorize };
  }
  const alpha = await tenant();
  const bravo = await tenant();
  type Tenant = typeof alpha;
  function command(owner: Tenant, overrides: Partial<CatalogRouterPrepareCommand> = {}): CatalogRouterPrepareCommand {
    return { id: randomUUID(),graphId: owner.graph.graphId,version: owner.graph.version,specHash: owner.graph.specHash,
      inputHash: digest('synthetic input'),authorizationHash: digest(`auth-${owner.id}`),
      maxTokens: 1000,maxCostMicroUsd: 1000,maxDurationSeconds: 60,...overrides };
  }
  async function intent(owner: Tenant, run: CatalogRouterPrepareCommand, slot: 'router'|'answer' = 'router') {
    const round: CatalogRouterRoundIntent = { slot,roundId: randomUUID(),requestHash: digest(`${run.id}-${slot}`) };
    await store.ensureRound(owner.id,run.id,round);
    await quota.reserve(owner.id,{ id: round.roundId,requestHash: round.requestHash,operation: 'eval',
      provider: boundedTextCapability.provider,model: boundedTextCapability.model,maxTokens: 10_000,maxCostMicroUsd: 10_000 });
    const claim = await quota.claim(owner.id,round.roundId,round.requestHash);
    assert.ok(claim);
    const settlement: AiQuotaSettlement = { id: round.roundId,claimToken: claim.token,promptTokens: 12,completionTokens: 4,
      costMicroUsd: 27,status: 'success',isByok: false,latencyMs: 1 };
    return { round,settlement };
  }
  async function complete(owner: Tenant, run: CatalogRouterPrepareCommand, slot: 'router'|'answer', output: string,
    patch: Partial<AiQuotaSettlement> = {}) {
    const pending = await intent(owner,run,slot);
    const settlement = { ...pending.settlement,...patch };
    const onSettled = async (db: Parameters<CatalogRouterCheckpointAuthorize>[0],result: { ledgerId: number }) => {
      await store.recordRound(db,owner.id,run.id,{ ...pending.round,ledgerId: result.ledgerId,output });
    };
    const result = await quota.settle(owner.id,settlement,onSettled);
    return { ...pending,settlement,result,onSettled };
  }
  const shift = (owner: Tenant,id: string,seconds: number) => uow.run(owner.id,db => db.query(`
    UPDATE catalog_router_runs SET created_at=created_at-$3*interval '1 second',
      deadline_at=deadline_at-$3*interval '1 second',expires_at=expires_at-$3*interval '1 second'
    WHERE tenant_id=$1 AND id=$2`, [owner.id,id,seconds]));

  await t.test('ciphertext, authorization and immutable identity survive replay without double accounting', async () => {
    const run = command(alpha);
    const initial = await store.prepare(alpha.id,run);
    const routerText = '{"route":"catalog","query":"synthetic","limit":1}';
    const completed = await complete(alpha,run,'router',routerText);
    assert.deepEqual(await quota.settle(alpha.id,completed.settlement,completed.onSettled),completed.result);
    const inspected = await store.getRound(alpha.id,run.id,'router',alpha.authorize);
    assert.equal(inspected?.output,routerText);
    assert.equal(inspected?.reservationStatus,'settled');
    assert.ok(inspected?.claimedAt);
    assert.equal(inspected?.outputHash,digest(routerText));
    const row = await uow.run(alpha.id,async db => (await db.query('SELECT output_encrypted,output_hash FROM catalog_router_rounds WHERE tenant_id=$1 AND run_id=$2', [alpha.id,run.id])).rows[0]);
    assert.match(row.output_encrypted,/^v1:/);
    assert.equal(row.output_encrypted.includes('synthetic'),false);
    assert.equal(row.output_hash,digest(routerText));
    assert.deepEqual(await store.prepare(alpha.id,run),{ ...initial,tokensUsed: 16,costMicroUsd: 27 });
    for (const patch of [{ inputHash: digest('changed') },{ authorizationHash: digest('changed') },{ maxTokens: 1001 }]) {
      await assert.rejects(store.prepare(alpha.id,{ ...run,...patch }),{ code: 'CHECKPOINT_CONFLICT' });
    }
    await assert.rejects(store.ensureRound(alpha.id,run.id,{ ...completed.round,requestHash: digest('changed') }),{ code: 'CHECKPOINT_CONFLICT' });
    await assert.rejects(store.getRound(alpha.id,run.id,'router',async () => { throw new Error('revoked'); }),/revoked/);
    assert.equal((await store.get(alpha.id,run.id))?.tokensUsed,16);
  });

  await t.test('tool checkpoint serializes concurrent reads and authorizes every plaintext replay', async () => {
    const run = command(alpha);
    await store.prepare(alpha.id,run);
    await complete(alpha,run,'router','{"route":"catalog","query":"synthetic","limit":1}');
    const toolCommand = { inputHash: digest('catalog query'),authorizationHash: run.authorizationHash };
    const output = { items: [{ id: 1,name: 'Synthetic product',price: 12 }] };
    let reads = 0;
    const work = async (db: Parameters<CatalogRouterCheckpointAuthorize>[0]) => {
      await alpha.authorize(db,run.authorizationHash);
      reads++;
      await new Promise(resolve => setTimeout(resolve,20));
      return output;
    };
    assert.deepEqual(await Promise.all([1,2].map(() => store.withToolCheckpoint(alpha.id,run.id,toolCommand,work,alpha.authorize))),[output,output]);
    assert.equal(reads,1);
    const saved = await store.getTool(alpha.id,run.id,alpha.authorize);
    assert.deepEqual(saved,{ ...toolCommand,outputHash: digest(JSON.stringify(output)),output });
    await assert.rejects(store.getTool(alpha.id,run.id,async () => { throw new Error('revoked'); }),/revoked/);
    await assert.rejects(store.withToolCheckpoint(alpha.id,run.id,{ ...toolCommand,inputHash: digest('changed') },work,alpha.authorize),{ code: 'CHECKPOINT_CONFLICT' });
    await store.invalidate(alpha.id,run.id);
    assert.equal(await store.getTool(alpha.id,run.id,alpha.authorize),null);
    assert.equal((await store.getRound(alpha.id,run.id,'router',alpha.authorize))?.output,undefined);
    const evidence = await uow.run(alpha.id,async db => (await db.query('SELECT output_encrypted,output_hash FROM catalog_router_tool_checkpoints WHERE tenant_id=$1 AND run_id=$2', [alpha.id,run.id])).rows[0]);
    assert.equal(evidence.output_encrypted,null);
    assert.equal(evidence.output_hash,saved!.outputHash);
    const late = command(alpha,{ maxDurationSeconds: 60 });
    await store.prepare(alpha.id,late);
    await complete(alpha,late,'router','{"route":"catalog","query":"synthetic","limit":1}');
    await assert.rejects(store.withToolCheckpoint(alpha.id,late.id,toolCommand,async () => {
      await new Promise(resolve => setTimeout(resolve,1100));
      return output;
    },alpha.authorize),{ code: 'CHECKPOINT_EXPIRED' });
    assert.equal(await store.getTool(alpha.id,late.id,alpha.authorize),null);
  });

  await t.test('aggregate overrun commits both ledgers exactly once and removes usable output', async () => {
    const run = command(alpha,{ maxTokens: 30,maxCostMicroUsd: 50 });
    await store.prepare(alpha.id,run);
    await complete(alpha,run,'router','{"route":"reply"}');
    const answer = await complete(alpha,run,'answer','Synthetic answer');
    await quota.settle(alpha.id,answer.settlement,answer.onSettled);
    const final = await store.get(alpha.id,run.id);
    assert.equal(final?.state,'blocked');
    assert.equal(final?.tokensUsed,32);
    assert.equal(final?.costMicroUsd,54);
    const round = await store.getRound(alpha.id,run.id,'answer',alpha.authorize);
    assert.equal(round?.state,'terminal');
    assert.equal(round?.output,undefined);
    assert.equal(round?.ledgerId,answer.result.ledgerId);
    const exhausted = command(alpha,{ maxTokens: 16 });
    await store.prepare(alpha.id,exhausted);
    await complete(alpha,exhausted,'router','{"route":"reply"}');
    await assert.rejects(store.ensureRound(alpha.id,exhausted.id,{ slot: 'answer',roundId: randomUUID(),requestHash: digest('answer') }),{ code: 'CHECKPOINT_BUDGET' });
  });

  await t.test('persisted deadline prevents new work while completed output expires without renewal', async () => {
    const run = command(alpha);
    await store.prepare(alpha.id,run);
    await complete(alpha,run,'router','{"route":"reply"}');
    await complete(alpha,run,'answer','Final synthetic answer');
    await shift(alpha,run.id,61);
    assert.equal((await store.getRound(alpha.id,run.id,'answer',alpha.authorize))?.output,'Final synthetic answer');
    const before = await store.get(alpha.id,run.id);
    const replay = await store.prepare(alpha.id,run);
    assert.equal(replay.deadlineAt,before?.deadlineAt);
    assert.equal(replay.expiresAt,before?.expiresAt);
    const waiting = command(alpha);
    await store.prepare(alpha.id,waiting);
    const prepared = await intent(alpha,waiting);
    await shift(alpha,waiting.id,61);
    await assert.rejects(store.ensureRound(alpha.id,waiting.id,prepared.round),{ code: 'CHECKPOINT_EXPIRED' });
    assert.equal((await store.getRound(alpha.id,waiting.id,'router',alpha.authorize))?.reservationStatus,'claimed');
    await shift(alpha,run.id,3600);
    const expired = await store.getRound(alpha.id,run.id,'answer',alpha.authorize);
    assert.equal(expired?.output,undefined);
    assert.ok(expired?.outputHash);
    assert.equal((await store.get(alpha.id,run.id))?.state,'expired');
    assert.equal((await uow.run(alpha.id,db => db.query('SELECT 1 FROM catalog_router_rounds WHERE tenant_id=$1 AND run_id=$2 AND output_encrypted IS NOT NULL',[alpha.id,run.id]))).rowCount,0);
  });

  await t.test('tenant isolation rejects a foreign pin or ledger and cannot expose checkpoints without context', async () => {
    const a = command(alpha);
    const b = command(bravo);
    await store.prepare(alpha.id,a);
    await store.prepare(bravo.id,b);
    const aPending = await intent(alpha,a);
    const bCompleted = await complete(bravo,b,'router','{"route":"reply"}');
    await assert.rejects(uow.run(alpha.id,db => store.recordRound(db,alpha.id,a.id,
      { ...aPending.round,ledgerId: bCompleted.result.ledgerId,output: 'foreign' })),{ code: 'CHECKPOINT_CONFLICT' });
    assert.equal((await store.get(alpha.id,a.id))?.tokensUsed,0);
    await assert.rejects(store.prepare(bravo.id,{ ...a,id: randomUUID(),authorizationHash: b.authorizationHash }),{ code: 'CHECKPOINT_CONFLICT' });
    assert.equal(await store.get(bravo.id,a.id),null);
    assert.equal(await store.getRound(bravo.id,a.id,'router',bravo.authorize),null);
    for (const table of ['catalog_router_runs','catalog_router_rounds','catalog_router_tool_checkpoints']) {
      assert.equal((await pool.query(`SELECT 1 FROM ${table}`)).rowCount,0);
      assert.equal((await uow.run(bravo.id,db => db.query(`SELECT 1 FROM ${table} WHERE tenant_id=$1`,[alpha.id]))).rowCount,0);
    }
  });
});
