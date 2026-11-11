import './fixtures/testEnv';
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { Pool } from 'pg';
import type { AgentGraphVersionV1 } from '@whatsap-automat/contracts';
import type { AiAgent } from '../modules/ai/domain/agent.types';
import type { Catalog, Product } from '../modules/inventory/domain/inventory.types';
import { TenantScopedUoW } from '../db/TenantScopedUoW';
import { CatalogRepositoryPg } from '../modules/inventory/infra/db/CatalogRepositoryPg';
import { ProductRepositoryPg } from '../modules/inventory/infra/db/ProductRepositoryPg';
import { AgentRepositoryPg } from '../modules/ai/infra/db/AgentRepositoryPg';
import { CommercialCatalogToolService } from '../modules/ai/application/tools/CommercialCatalogToolService';
import { saveDraft } from '../services/ai/studio/AgentStudioDrafts';
import { compileAgentExecutionProfile } from '../services/ai/studio/AgentExecutionProfile';
import { boundedTextBudget, boundedTextCapability } from '../services/ai/gateway/BoundedTextCompletion';
import { compileCatalogRouterExecutionProfile } from '../services/ai/studio/CatalogRouterExecutionProfile';
import { catalogRoundId } from '../services/ai/runtime/CatalogRouterReadProbe';
import { createTenantBoundedModelExecution } from '../services/ai/gateway/TenantBoundedModelExecution';
import { ByokService } from '../services/ai/gateway/byok/ByokService';
import { preflightBoundedAgentDispatch } from '../services/ai/studio/BoundedAgentDispatch';

import { CatalogRouterCheckpointRuntime } from '../services/ai/runtime/CatalogRouterCheckpointRuntime';
import { CatalogRouterCheckpointStore } from '../services/ai/runtime/CatalogRouterCheckpointStore';

const databaseUrl = process.env.STRICT_CATALOG_TEST_DATABASE_URL;

test('a strict catalog router recovers confirmed rounds and tool results without redispatch', {
  skip: !databaseUrl && 'STRICT_CATALOG_TEST_DATABASE_URL must select a local _smoke database', timeout: 60000,
}, async (t) => {
  const url = new URL(databaseUrl!);
  assert.equal(url.hostname, '127.0.0.1');
  assert.match(url.pathname, /_smoke$/);
  const db = new Pool({ connectionString: databaseUrl });
  t.after(() => db.end());
  const uow = new TenantScopedUoW(db);
  const { rows: [role] } = await db.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
  assert.deepEqual(role, { rolsuper: false, rolbypassrls: false });
  const catalogs = new CatalogRepositoryPg(db);
  const products = new ProductRepositoryPg(db);
  const agents = new AgentRepositoryPg(db);
  const search = new CommercialCatalogToolService(products);
  const alpha = randomInt(500000000, 600000000);
  const bravo = alpha + 1;
  const tenants: Array<{ id: number; name: string; graph: AgentGraphVersionV1; agent: AiAgent;
    catalog: Catalog; hidden: Catalog; item: Product }> = [];
  const budget = boundedTextBudget(128, 1000)!;
  for (const [id, name] of [[alpha, 'Alfa'], [bravo, 'Bravo']] as const) {
    await uow.run(id, async (tx) => {
      await tx.query('INSERT INTO companies(id,name) VALUES($1,$2)', [id, `Catalog fixture ${name}`]);
      await tx.query('INSERT INTO tenants(id,name,slug) VALUES($1,$2,$3)', [id, name, randomUUID()]);
      await tx.query(`INSERT INTO tenant_ai_quotas(tenant_id,monthly_token_limit,monthly_cost_limit_micro_usd)
        VALUES($1,20000000,20000000)`, [id]);
    });
    await agents.setAutomatorMode(id, 'mixed');
    const catalog = await catalogs.create(id, { name: `Allowed ${name}`, status: 'active', aiEnabled: true });
    const hidden = await catalogs.create(id, { name: `Hidden ${name}`, status: 'active', aiEnabled: true });
    const item = await products.create(id, { name: `Visible ${name}`, status: 'active', aiEnabled: true,
      itemType: 'physical_product', price: 12, priceMode: 'fixed', currency: 'USD',
      catalogAssignments: [{ catalogId: catalog.id }], images: [{ imageUrl: '/uploads/commercial-items/catalog-fixture.png', isPrimary: true }] });
    await products.create(id, { name: `Private ${name}`, status: 'active', aiEnabled: true,
      catalogAssignments: [{ catalogId: hidden.id }], images: [{ imageUrl: '/uploads/commercial-items/private-fixture.png', isPrimary: true }] });
    const agent = await agents.create(id, null, { name: `Catalog reader ${name}`, purpose: 'support',
      status: 'active', mode: 'suggest', moduleAccess: { catalog: true }, toolAccess: { catalogSearch: true },
      catalogScope: { catalogIds: [catalog.id], sectionIds: [] } });
    const graph = await uow.run(id, (tx) => saveDraft(tx, id, 1, `catalog-${randomUUID()}`, {
      entryNodeId: 'route', policyRef: 'strict-catalog-read-fixture',
      nodes: [
        { id: 'route', kind: 'router', config: { profile: 'catalog-router-v1', provider: 'openai',
          model: boundedTextCapability.model, prompt: `Router ${name}`, maxTokens: 128, timeoutMs: 1000 } },
        { id: 'lookup', kind: 'tool', config: { toolName: 'catalog.search', schemaVersion: 1, agentId: agent.id,
          catalogScope: { catalogIds: [catalog.id], sectionIds: [] }, maxResults: 3 } },
        { id: 'answer', kind: 'agent', config: { provider: 'openai', model: boundedTextCapability.model,
          prompt: `Answer ${name}`, maxTokens: 128, timeoutMs: 1000 } },
        { id: 'end', kind: 'end', config: {} },
      ],
      edges: [
        { id: 'catalog', from: 'route', to: 'lookup', condition: 'catalog' },
        { id: 'reply', from: 'route', to: 'answer', condition: 'reply' },
        { id: 'found', from: 'lookup', to: 'answer' }, { id: 'finish', from: 'answer', to: 'end' },
      ],
      limits: { maxSteps: 4, maxDelegations: 0, maxParallelNodes: 1, maxDurationSeconds: 3,
        maxModelTokens: budget.maxTokens * 2, maxCostMicroUsd: budget.maxCostMicroUsd * 2 },
    }, true));
    assert.ok(graph);
    const result = await search.search({ companyId: id, conversationId: null, chatId: null, agentId: agent.id,
      agentPurpose: 'support', companyMode: 'mixed', agentMode: 'suggest',
      moduleAccess: agent.moduleAccess, toolAccess: agent.toolAccess ?? {}, catalogScope: agent.catalogScope,
      inboundProviderMessageId: null, actorUserId: null }, { q: 'Visible', limit: 3 });
    assert.equal(result.status, 'ok');
    assert.deepEqual((result.output as { items: { id: number }[] }).items.map((entry) => entry.id), [item.id]);
    tenants.push({ id, name, graph, agent, catalog, hidden, item });
    await uow.run(id, (tx) => tx.query(`INSERT INTO agent_tool_grants(tenant_id,agent_graph_id,tool_name,required_roles,is_enabled)
      VALUES($1,$2,'catalog.search',ARRAY['agent'],true)`, [id, graph.graphId]));
    await new ByokService(undefined, uow).saveCredential(id, 'openai', `catalog-fixture-${name}`);
    const { policy } = createTenantBoundedModelExecution(uow);
    await policy.transition(id, 'draining');
    await policy.transition(id, 'strict');
  }
  const isolation = await uow.run(bravo, (tx) => tx.query('SELECT id FROM products WHERE company_id=$1', [alpha]));
  assert.equal(isolation.rowCount, 0);
  for (const tenant of tenants) {
    assert.equal(compileAgentExecutionProfile(tenant.graph).compatible, false, 'A text publication must never acquire tools implicitly');
    assert.equal(compileCatalogRouterExecutionProfile(tenant.graph).compatible, true);
    assert.deepEqual(preflightBoundedAgentDispatch({ tenantId: tenant.id, graph: tenant.graph, input: 'Visible', timeoutMs: 1000 }),
      { ok: false, code: 'REVISION_PROFILE' }, 'The production dispatcher remains closed to the unfinished profile');
  }

  let routeText = JSON.stringify({ route: 'catalog', query: 'Visible', limit: 3 });
  let beforeResponse: (() => Promise<void>) | undefined;
  let dropResponse = false;
  const requests: string[] = [];
  const bodies: Array<{ name: string; slot: string; input: string }> = [];
  let beforeAnswer: (() => Promise<void>) | undefined;
  const providerErrors: unknown[] = [];
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.method, 'POST');
      assert.equal(req.url, '/v1/chat/completions');
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const name = body.messages[0].content.endsWith('Alfa') ? 'Alfa' : 'Bravo';
      const slot = body.messages[0].content.includes('Return exactly one JSON') ? 'router' : 'answer';
      bodies.push({ name, slot, input: body.messages[1].content });
      assert.equal(req.headers.authorization, `Bearer catalog-fixture-${name}`);
      assert.equal(body.model, boundedTextCapability.model);
      assert.equal(body.messages.length, 2);
      assert.equal(body.tools, undefined);
      requests.push(name);
      const hook = beforeResponse;
      beforeResponse = undefined;
      await hook?.();
      if (slot === 'answer') { const hook = beforeAnswer; beforeAnswer = undefined; await hook?.(); }
      if (dropResponse) { dropResponse = false; req.socket.destroy(); return; }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ model: body.model, service_tier: 'default',
        usage: { prompt_tokens: 12, completion_tokens: 16, total_tokens: 28 },
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: slot === 'router' ? routeText : `Visible ${name} costs 12 USD` } }] }));
    } catch (error) { providerErrors.push(error); res.writeHead(500).end(); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const nativeFetch = globalThis.fetch;
  const deniedFetch = t.mock.method(globalThis, 'fetch', async () => assert.fail('No external provider or Graph call is allowed'));
  const transport: ConstructorParameters<typeof CatalogRouterCheckpointRuntime>[1] = async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(init?.redirect, 'error');
    return nativeFetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, init);
  };
  const runtime = (store?: CatalogRouterCheckpointStore) => new CatalogRouterCheckpointRuntime(uow, transport, store);
  const command = (tenant: typeof tenants[number], runId = randomUUID()) => ({
    tenantId: tenant.id, runId, graphId: tenant.graph.graphId, version: tenant.graph.version,
    specHash: tenant.graph.specHash, input: `Find Visible ${tenant.name}`,
  });

  class StopAfterRound extends CatalogRouterCheckpointStore {
    constructor(private readonly stop: 'router' | 'answer') { super(uow); }
    override async getRound(...args: Parameters<CatalogRouterCheckpointStore['getRound']>) {
      const result = await super.getRound(...args);
      if (args[2] === this.stop && result?.state === 'completed') throw new Error('Simulated process exit after commit');
      return result;
    }
  }
  class StopDuringRoundCommit extends CatalogRouterCheckpointStore {
    override async recordRound(...args: Parameters<CatalogRouterCheckpointStore['recordRound']>) {
      await super.recordRound(...args);
      throw new Error('Simulated process exit before commit');
    }
  }
  class StopAtTool extends CatalogRouterCheckpointStore {
    constructor(private readonly position: 'before' | 'after') { super(uow); }
    override async withToolCheckpoint(...args: Parameters<CatalogRouterCheckpointStore['withToolCheckpoint']>) {
      if (this.position === 'after') {
        await super.withToolCheckpoint(...args);
        throw new Error('Simulated process exit after tool commit');
      }
      const work = args[3];
      args[3] = async (tx) => { await work(tx); throw new Error('Simulated process exit before tool commit'); };
      return super.withToolCheckpoint(...args);
    }
  }
  const counts = (tenantId: number, runId: string) => uow.run(tenantId, async (tx) => {
    const { rows: [row] } = await tx.query(`SELECT
      (SELECT count(*)::int FROM catalog_router_rounds WHERE tenant_id=$1 AND run_id=$2 AND ledger_id IS NOT NULL) AS rounds,
      (SELECT count(*)::int FROM catalog_router_tool_checkpoints WHERE tenant_id=$1 AND run_id=$2) AS tools,
      (SELECT count(*)::int FROM ai_token_cost_ledger WHERE tenant_id=$1 AND metadata_json->>'reservationId'=ANY($3::text[])) AS charges`,
    [tenantId, runId, [catalogRoundId(tenantId, runId, 'router'), catalogRoundId(tenantId, runId, 'answer')]]);
    return row;
  });

  await t.test('both companies recover final output with one charge per durable round and no cross-company reuse', async () => {
    const shared = randomUUID();
    for (const tenant of tenants) {
      const input = command(tenant, shared);
      const result = await runtime().execute(input);
      assert.equal(result.status, 'completed', JSON.stringify(result));
      assert.ok('output' in result);
      assert.equal(result.output, `Visible ${tenant.name} costs 12 USD`);
      assert.equal(result.tokensUsed, 56);
      assert.equal(result.publicationEvidence, false);
      assert.equal(result.deliveryAllowed, false);
      const before = requests.length;
      assert.deepEqual(await runtime().execute(input), result);
      assert.equal(requests.length, before, 'A restarted runtime reuses both confirmed rounds');
      assert.deepEqual(await counts(tenant.id, shared), { rounds: 2, tools: 1, charges: 2 });
      const changed = await runtime().execute({ ...input, input: 'Another question' });
      assert.equal('code' in changed && changed.code, 'CHECKPOINT_CONFLICT');
      const answer = bodies.find((body) => body.name === tenant.name && body.slot === 'answer')!;
      assert.ok(answer.input.includes(`Visible ${tenant.name}`));
      assert.equal(answer.input.includes(tenant.name === 'Alfa' ? 'Bravo' : 'Alfa'), false);
      assert.equal(answer.input.includes('authorizationHash'), false);
      assert.equal(answer.input.includes('Private'), false);
    }
    const before = requests.length;
    assert.equal((await runtime().execute({ ...command(tenants[0], shared), tenantId: bravo })).status, 'blocked');
    assert.equal(requests.length, before);
    const foreign = await uow.run(bravo, (tx) => tx.query('SELECT id FROM catalog_router_runs WHERE tenant_id=$1', [alpha]));
    assert.equal(foreign.rowCount, 0);
  });

  await t.test('two workers share reservations and checkpoints without duplicate provider requests', async () => {
    const input = command(tenants[0]);
    const before = requests.length;
    const replies = await Promise.all([runtime().execute(input), runtime().execute(input)]);
    assert.ok(replies.some((reply) => reply.status === 'completed'), JSON.stringify(replies));
    assert.ok(replies.every((reply) => ['completed', 'in_progress'].includes(reply.status)), JSON.stringify(replies));
    assert.equal((await runtime().execute(input)).status, 'completed');
    assert.equal(requests.length, before + 2);
    assert.deepEqual(await counts(alpha, input.runId), { rounds: 2, tools: 1, charges: 2 });
  });

  await t.test('router checkpoint survives process exit and continues through catalog to final answer', async () => {
    const input = command(tenants[0]);
    const before = requests.length;
    assert.equal((await runtime(new StopAfterRound('router')).execute(input)).status, 'blocked');
    assert.deepEqual(await counts(alpha, input.runId), { rounds: 1, tools: 0, charges: 1 });
    assert.equal((await runtime().execute(input)).status, 'completed');
    assert.equal(requests.length, before + 2);
    assert.deepEqual(await counts(alpha, input.runId), { rounds: 2, tools: 1, charges: 2 });
  });

  await t.test('failure before model checkpoint commit rolls back charge and output together and never resends', async () => {
    const input = command(tenants[1]);
    const before = requests.length;
    assert.equal((await runtime(new StopDuringRoundCommit(uow)).execute(input)).status, 'uncertain');
    assert.deepEqual(await counts(bravo, input.runId), { rounds: 0, tools: 0, charges: 0 });
    await uow.run(bravo, (tx) => tx.query(`UPDATE ai_quota_reservations SET claimed_at=clock_timestamp()-interval '10 seconds'
      WHERE tenant_id=$1 AND id=$2 AND status='claimed'`, [bravo, catalogRoundId(bravo, input.runId, 'router')]));
    assert.equal((await runtime().execute(input)).status, 'uncertain');
    assert.equal(requests.length, before + 1, 'Unknown execution is retained for reconciliation, never redispatched');
  });

  await t.test('read transaction rolls back before snapshot; confirmed snapshot survives lost acknowledgement', async () => {
    for (const position of ['before', 'after'] as const) {
      const input = command(tenants[0]);
      const before = requests.length;
      assert.equal((await runtime(new StopAtTool(position)).execute(input)).status, 'blocked');
      assert.deepEqual(await counts(alpha, input.runId), { rounds: 1, tools: position === 'before' ? 0 : 1, charges: 1 });
      assert.equal((await runtime().execute(input)).status, 'completed');
      assert.equal(requests.length, before + 2);
      assert.deepEqual(await counts(alpha, input.runId), { rounds: 2, tools: 1, charges: 2 });
    }
  });

  await t.test('final answer checkpoint survives lost response without a second model call', async () => {
    const input = command(tenants[1]);
    assert.equal((await runtime(new StopAfterRound('answer')).execute(input)).status, 'blocked');
    const before = requests.length;
    const result = await runtime().execute(input);
    assert.equal(result.status, 'completed');
    assert.equal(requests.length, before);
    assert.deepEqual(await counts(bravo, input.runId), { rounds: 2, tools: 1, charges: 2 });
  });

  await t.test('a concurrent invalidation after final round confirmation cannot release its in-memory answer', async () => {
    class InvalidateBeforeReceipt extends CatalogRouterCheckpointStore {
      override async getTool(...args: Parameters<CatalogRouterCheckpointStore['getTool']>) {
        await this.invalidate(args[0], args[1]);
        return super.getTool(...args);
      }
    }
    const input = command(tenants[1]);
    const result = await runtime(new InvalidateBeforeReceipt(uow)).execute(input);
    assert.equal('code' in result && result.code, 'CHECKPOINT_INVALIDATED');
    assert.equal('output' in result, false);
    assert.deepEqual(await counts(bravo, input.runId), { rounds: 2, tools: 1, charges: 2 });
  });

  await t.test('an unknown provider response cannot be retried by another worker', async () => {
    const input = command(tenants[1]);
    const before = requests.length;
    dropResponse = true;
    assert.equal((await runtime().execute(input)).status, 'uncertain');
    const replay = await runtime().execute(input);
    assert.ok(['in_progress', 'uncertain'].includes(replay.status));
    assert.equal(requests.length, before + 1);
  });

  await t.test('revocation while answering records consumption but withholds the confirmed answer', async () => {
    const tenant = tenants[0];
    const input = command(tenant);
    beforeAnswer = async () => { await uow.run(alpha, (tx) => tx.query(`UPDATE agent_tool_grants SET is_enabled=false
      WHERE tenant_id=$1 AND agent_graph_id=$2`, [alpha, tenant.graph.graphId])); };
    const result = await runtime().execute(input);
    assert.equal(result.status, 'blocked');
    assert.equal('output' in result, false);
    assert.deepEqual(await counts(alpha, input.runId), { rounds: 2, tools: 1, charges: 2 });
    await uow.run(alpha, (tx) => tx.query(`UPDATE agent_tool_grants SET is_enabled=true
      WHERE tenant_id=$1 AND agent_graph_id=$2`, [alpha, tenant.graph.graphId]));
    const before = requests.length;
    assert.equal((await runtime().execute(input)).status, 'blocked', 'Restoring the permission cannot revive the old run');
    assert.equal(requests.length, before);
  });

  await t.test('revoking and restoring a grant between restarts invalidates its pinned permission generation', async () => {
    const tenant = tenants[0];
    const input = command(tenant);
    await runtime(new StopAfterRound('router')).execute(input);
    assert.deepEqual(await counts(alpha, input.runId), { rounds: 1, tools: 0, charges: 1 });
    await uow.run(alpha, (tx) => tx.query(`UPDATE agent_tool_grants SET is_enabled=false WHERE tenant_id=$1 AND agent_graph_id=$2`, [alpha, tenant.graph.graphId]));
    await uow.run(alpha, (tx) => tx.query(`UPDATE agent_tool_grants SET is_enabled=true WHERE tenant_id=$1 AND agent_graph_id=$2`, [alpha, tenant.graph.graphId]));
    const before = requests.length;
    assert.equal((await runtime().execute(input)).status, 'blocked');
    assert.equal(requests.length, before);
  });

  await t.test('retiring catalog data invalidates a snapshot and an already confirmed answer', async () => {
    const tenant = tenants[0];
    for (const final of [false, true]) {
      const input = command(tenant);
      await runtime(final ? new StopAfterRound('answer') : new StopAtTool('after')).execute(input);
      assert.deepEqual(await counts(alpha, input.runId), { rounds: final ? 2 : 1, tools: 1, charges: final ? 2 : 1 });
      await uow.run(alpha, (tx) => tx.query('UPDATE products SET ai_enabled=false WHERE company_id=$1 AND id=$2', [alpha, tenant.item.id]));
      const before = requests.length;
      const result = await runtime().execute(input);
      assert.equal(result.status, 'blocked');
      assert.equal('output' in result, false);
      assert.equal(requests.length, before);
      await uow.run(alpha, (tx) => tx.query('UPDATE products SET ai_enabled=true WHERE company_id=$1 AND id=$2', [alpha, tenant.item.id]));
      assert.equal((await runtime().execute(input)).status, 'blocked');
    }
  });

  await t.test('stored deadlines and TTL cannot be extended by restarting the runtime', async () => {
    const input = command(tenants[1]);
    await runtime(new StopAfterRound('router')).execute(input);
    await uow.run(bravo, (tx) => tx.query(`UPDATE catalog_router_runs SET created_at=created_at-interval '10 seconds', deadline_at=deadline_at-interval '10 seconds', expires_at=expires_at-interval '10 seconds'
      WHERE tenant_id=$1 AND id=$2`, [bravo, input.runId]));
    const before = requests.length;
    assert.equal((await runtime().execute(input)).status, 'blocked');
    assert.equal(requests.length, before);
    const completed = command(tenants[1]);
    assert.equal((await runtime().execute(completed)).status, 'completed');
    await uow.run(bravo, (tx) => tx.query(`UPDATE catalog_router_runs SET created_at=created_at-interval '2 hours', deadline_at=deadline_at-interval '2 hours', expires_at=expires_at-interval '2 hours'
      WHERE tenant_id=$1 AND id=$2`, [bravo, completed.runId]));
    assert.equal((await runtime().execute(completed)).status, 'blocked');
    await new CatalogRouterCheckpointStore(uow).eraseExpired(bravo);
    const { rows: [erased] } = await uow.run(bravo, (tx) => tx.query(`SELECT count(*)::int AS count
      FROM catalog_router_rounds WHERE tenant_id=$1 AND run_id=$2 AND output_encrypted IS NOT NULL`, [bravo, completed.runId]));
    assert.equal(erased.count, 0);
  });

  await t.test('router reply path has two bounded rounds and no tool snapshot', async () => {
    routeText = JSON.stringify({ route: 'reply' });
    const input = command(tenants[0]);
    const result = await runtime().execute(input);
    assert.equal(result.status, 'completed');
    assert.equal('tool' in result, false);
    assert.deepEqual(await counts(alpha, input.runId), { rounds: 2, tools: 0, charges: 2 });
    routeText = JSON.stringify({ route: 'catalog', query: 'Visible', limit: 3 });
  });

  await t.test('shared quota can block the answer without losing the router charge or manufacturing a new round', async () => {
    const input = command(tenants[0]);
    await runtime(new StopAfterRound('router')).execute(input);
    assert.deepEqual(await counts(alpha, input.runId), { rounds: 1, tools: 0, charges: 1 });
    await uow.run(alpha, (tx) => tx.query(`UPDATE tenant_ai_quotas SET monthly_token_limit=current_month_tokens_used+100 WHERE tenant_id=$1`, [alpha]));
    const before = requests.length;
    const blocked = await runtime().execute(input);
    assert.equal('code' in blocked && blocked.code, 'AI_QUOTA_EXHAUSTED');
    assert.equal(requests.length, before);
    assert.deepEqual(await counts(alpha, input.runId), { rounds: 1, tools: 1, charges: 1 });
    await uow.run(alpha, (tx) => tx.query('UPDATE tenant_ai_quotas SET monthly_token_limit=20000000 WHERE tenant_id=$1', [alpha]));
    assert.equal((await runtime().execute(input)).status, 'completed');
    assert.equal(requests.length, before + 1);
    assert.deepEqual(await counts(alpha, input.runId), { rounds: 2, tools: 1, charges: 2 });
  });

  await t.test('saving a later revision neither changes the pinned run nor consumes another permission with its UUID', async () => {
    const tenant = tenants[1];
    const input = command(tenant);
    await runtime(new StopAfterRound('router')).execute(input);
    const next = await uow.run(bravo, (tx) => saveDraft(tx, bravo, 1, tenant.graph.graphId, {
      entryNodeId: tenant.graph.entryNodeId, edges: tenant.graph.edges, policyRef: tenant.graph.policyRef, limits: tenant.graph.limits,
      nodes: tenant.graph.nodes.map((node) => node.id === 'answer'
        ? { ...node, config: { ...node.config, prompt: 'Changed answer Bravo' } } : node),
    }, false));
    assert.ok(next);
    const before = requests.length;
    const changed = await runtime().execute({ ...input, version: next.version, specHash: next.specHash });
    assert.equal('code' in changed && changed.code, 'CHECKPOINT_CONFLICT');
    assert.equal(requests.length, before);
    const original = await runtime().execute(input);
    assert.equal(original.status, 'completed');
    assert.ok('version' in original);
    assert.equal(original.version, tenant.graph.version);
    assert.equal(requests.length, before + 1);
  });

  for (const tenant of tenants) {
    await uow.run(tenant.id, async (tx) => {
      const { rows: [totals] } = await tx.query(`SELECT
        (SELECT current_month_tokens_used FROM tenant_ai_quotas WHERE tenant_id=$1)::int AS quota,
        (SELECT COALESCE(sum(total_tokens),0) FROM ai_token_cost_ledger WHERE tenant_id=$1)::int AS ledger,
        (SELECT COALESCE(sum(tokens_used),0) FROM catalog_router_runs WHERE tenant_id=$1)::int AS checkpoints`, [tenant.id]);
      assert.equal(totals.quota, totals.ledger);
      assert.equal(totals.checkpoints, totals.ledger);
      const leak = await tx.query(`SELECT id FROM ai_token_cost_ledger WHERE tenant_id=$1 AND
        (metadata_json::text LIKE '%Visible%' OR metadata_json::text LIKE '%customer%')`, [tenant.id]);
      assert.equal(leak.rowCount, 0, 'No customer, catalog, or answer text belongs in the accounting ledger');
      for (const table of ['customer_orders', 'tool_execution_effects', 'approval_requests']) {
        const result = await tx.query(`SELECT count(*)::int AS count FROM ${table} WHERE ${table === 'customer_orders' ? 'company_id' : 'tenant_id'}=$1`, [tenant.id]);
        assert.equal(result.rows[0].count, 0);
      }
    });
  }
  assert.deepEqual(providerErrors, []);
  assert.equal(deniedFetch.mock.callCount(), 0);
});
