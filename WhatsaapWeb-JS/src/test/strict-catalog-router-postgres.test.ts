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
import { CatalogRouterReadProbe, catalogRoundId } from '../services/ai/runtime/CatalogRouterReadProbe';
import { createTenantBoundedModelExecution } from '../services/ai/gateway/TenantBoundedModelExecution';
import { ByokService } from '../services/ai/gateway/byok/ByokService';
import { preflightBoundedAgentDispatch } from '../services/ai/studio/BoundedAgentDispatch';

const databaseUrl = process.env.STRICT_CATALOG_TEST_DATABASE_URL;

test('a strict catalog router uses only the pinned company catalog and never inherits text publication permissions', {
  skip: !databaseUrl && 'STRICT_CATALOG_TEST_DATABASE_URL must select a local _smoke database', timeout: 30000,
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
        VALUES($1,3000000,3000000)`, [id]);
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
  const providerErrors: unknown[] = [];
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.method, 'POST');
      assert.equal(req.url, '/v1/chat/completions');
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const name = body.messages[0].content.endsWith('Router Alfa') ? 'Alfa' : 'Bravo';
      assert.equal(req.headers.authorization, `Bearer catalog-fixture-${name}`);
      assert.equal(body.model, boundedTextCapability.model);
      assert.equal(body.messages.length, 2);
      assert.equal(body.tools, undefined);
      requests.push(name);
      const hook = beforeResponse;
      beforeResponse = undefined;
      await hook?.();
      if (dropResponse) { dropResponse = false; req.socket.destroy(); return; }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ model: body.model, service_tier: 'default',
        usage: { prompt_tokens: 12, completion_tokens: 16, total_tokens: 28 },
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: routeText } }] }));
    } catch (error) { providerErrors.push(error); res.writeHead(500).end(); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const nativeFetch = globalThis.fetch;
  const deniedFetch = t.mock.method(globalThis, 'fetch', async () => assert.fail('No external provider or Graph call is allowed'));
  const probe = new CatalogRouterReadProbe(uow, async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(init?.redirect, 'error');
    return nativeFetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, init);
  });
  const command = (tenant: typeof tenants[number], runId = randomUUID()) => ({
    tenantId: tenant.id, runId, graphId: tenant.graph.graphId, version: tenant.graph.version,
    specHash: tenant.graph.specHash, input: `Find Visible ${tenant.name}`,
  });

  await t.test('both companies complete a real router and existing read tool through distinct tenant credentials', async () => {
    const sharedRunId = randomUUID();
    for (const tenant of tenants) {
      const input = command(tenant, sharedRunId);
      const before = requests.length;
      const contenders = await Promise.all([probe.execute(input), probe.execute(input)]);
      assert.deepEqual(contenders.map((result) => result.status).sort(), ['not_dispatched', 'tool_result_ready']);
      const result = contenders.find((result) => result.status === 'tool_result_ready')!;
      assert.equal(result.status, 'tool_result_ready');
      assert.equal(result.publicationEvidence, false);
      assert.equal(result.deliveryAllowed, false);
      assert.ok('tool' in result);
      const output = result.tool.result as { items: { id: number; name: string }[]; authorizationHash: string; inputHash: string; outputHash: string };
      assert.deepEqual(output.items.map((item) => item.id), [tenant.item.id]);
      assert.equal(JSON.stringify(output).includes('Private'), false);
      assert.equal(JSON.stringify(output).includes('Hidden'), false);
      assert.match(output.authorizationHash, /^[0-9a-f]{64}$/);
      assert.match(output.outputHash, /^[0-9a-f]{64}$/);
      assert.equal(result.roundId, catalogRoundId(tenant.id, sharedRunId, 'router'));
      assert.equal(requests.length, before + 1);
      assert.equal((await probe.execute(input)).status, 'not_dispatched', 'A process restart cannot repeat a settled model round without its checkpoint');
      assert.equal(requests.length, before + 1);
      const changed = await probe.execute({ ...input, input: 'Different question with the same durable identity' });
      assert.equal(changed.status, 'blocked');
      assert.equal('code' in changed && changed.code, 'AI_QUOTA_RESERVATION_CONFLICT');
      assert.equal(requests.length, before + 1);
      const next = await uow.run(tenant.id, (tx) => saveDraft(tx, tenant.id, 1, tenant.graph.graphId, {
        entryNodeId: tenant.graph.entryNodeId, edges: tenant.graph.edges, policyRef: tenant.graph.policyRef, limits: tenant.graph.limits,
        nodes: tenant.graph.nodes.map((node) => node.id === 'route'
          ? { ...node, config: { ...node.config, prompt: `Changed router ${tenant.name}` } } : node),
      }, false));
      assert.ok(next);
      const changedRevision = await probe.execute({ ...input, version: next.version, specHash: next.specHash });
      assert.equal('code' in changedRevision && changedRevision.code, 'AI_QUOTA_RESERVATION_CONFLICT');
      assert.equal(requests.length, before + 1, 'A revision change must not manufacture a new router round UUID');
    }
    assert.notEqual(catalogRoundId(alpha, sharedRunId, 'router'), catalogRoundId(bravo, sharedRunId, 'router'));
    assert.notEqual(catalogRoundId(alpha, sharedRunId, 'router'), catalogRoundId(alpha, sharedRunId, 'answer'));
  });

  await t.test('a foreign revision and missing or revoked explicit read permission dispatch nothing', async () => {
    const [a, b] = tenants;
    const before = requests.length;
    assert.equal((await probe.execute({ ...command(a), tenantId: b.id })).status, 'blocked');
    await uow.run(a.id, async (tx) => {
      await tx.query(`DELETE FROM agent_tool_grants WHERE tenant_id=$1 AND agent_graph_id=$2`, [a.id, a.graph.graphId]);
      await tx.query(`INSERT INTO agent_tool_grants(tenant_id,tool_name,required_roles,is_enabled)
        VALUES($1,'catalog.search',ARRAY['agent'],true)`, [a.id]);
    });
    assert.equal((await probe.execute(command(a))).status, 'blocked', 'A global tool grant cannot stand in for an explicit graph grant');
    await uow.run(a.id, (tx) => tx.query(`INSERT INTO agent_tool_grants(tenant_id,agent_graph_id,tool_name,required_roles,is_enabled)
      VALUES($1,$2,'catalog.search',ARRAY['agent'],true)`, [a.id, a.graph.graphId]));
    await uow.run(a.id, (tx) => tx.query(`UPDATE agent_tool_grants SET is_enabled=false WHERE tenant_id=$1 AND agent_graph_id=$2`, [a.id, a.graph.graphId]));
    assert.equal((await probe.execute(command(a))).status, 'blocked');
    await uow.run(a.id, (tx) => tx.query(`UPDATE agent_tool_grants SET is_enabled=true WHERE tenant_id=$1 AND agent_graph_id=$2`, [a.id, a.graph.graphId]));
    await uow.run(a.id, (tx) => tx.query(`UPDATE ai_agents SET tool_access_json='{}'::jsonb WHERE company_id=$1 AND id=$2`, [a.id, a.agent.id]));
    assert.equal((await probe.execute(command(a))).status, 'blocked');
    assert.equal(requests.length, before);
    await uow.run(a.id, (tx) => tx.query(`UPDATE ai_agents SET tool_access_json='{"catalogSearch":true}'::jsonb WHERE company_id=$1 AND id=$2`, [a.id, a.agent.id]));
    await uow.run(a.id, (tx) => tx.query(`UPDATE agent_tool_grants SET limits_override='{"maxResults":1}'::jsonb
      WHERE tenant_id=$1 AND agent_graph_id=$2`, [a.id, a.graph.graphId]));
    assert.equal((await probe.execute(command(a))).status, 'blocked', 'An unsupported grant restriction cannot be silently ignored');
    await uow.run(a.id, (tx) => tx.query(`UPDATE agent_tool_grants SET limits_override='{}'::jsonb
      WHERE tenant_id=$1 AND agent_graph_id=$2`, [a.id, a.graph.graphId]));
    assert.equal(requests.length, before);
  });

  await t.test('current scope may narrow but never expand the scope pinned by the graph', async () => {
    const a = tenants[0];
    await uow.run(a.id, (tx) => tx.query(`UPDATE ai_agents SET catalog_scope_json=$3 WHERE company_id=$1 AND id=$2`,
      [a.id, a.agent.id, JSON.stringify({ catalogIds: [a.catalog.id, a.hidden.id], sectionIds: [] })]));
    const result = await probe.execute(command(a));
    assert.equal(result.status, 'tool_result_ready');
    assert.ok('tool' in result);
    assert.deepEqual((result.tool.result as { items: { id: number }[] }).items.map((item) => item.id), [a.item.id]);
    await uow.run(a.id, (tx) => tx.query(`UPDATE ai_agents SET catalog_scope_json=$3 WHERE company_id=$1 AND id=$2`,
      [a.id, a.agent.id, JSON.stringify({ catalogIds: [a.hidden.id], sectionIds: [] })]));
    const before = requests.length;
    assert.equal((await probe.execute(command(a))).status, 'blocked');
    assert.equal(requests.length, before);
    await uow.run(a.id, (tx) => tx.query(`UPDATE ai_agents SET catalog_scope_json=$3 WHERE company_id=$1 AND id=$2`,
      [a.id, a.agent.id, JSON.stringify({ catalogIds: [a.catalog.id], sectionIds: [] })]));
  });

  await t.test('revocation while the router is running blocks catalog output', async () => {
    const a = tenants[0];
    beforeResponse = async () => { await uow.run(a.id, (tx) => tx.query(`UPDATE agent_tool_grants SET is_enabled=false
      WHERE tenant_id=$1 AND agent_graph_id=$2`, [a.id, a.graph.graphId])); };
    const result = await probe.execute(command(a));
    assert.equal(result.status, 'blocked');
    assert.equal('tool' in result, false);
    await uow.run(a.id, (tx) => tx.query(`UPDATE agent_tool_grants SET is_enabled=true WHERE tenant_id=$1 AND agent_graph_id=$2`, [a.id, a.graph.graphId]));
  });

  await t.test('router cannot smuggle a write, scope override, chained call or unbounded output', async () => {
    for (const malicious of [
      { route: 'catalog', query: 'Visible', limit: 1, toolName: 'order.upsertPreorder' },
      { route: 'catalog', query: 'Visible', limit: 1, tenantId: bravo },
      { route: 'catalog', query: 'Visible', limit: 1, catalogIds: [tenants[0].hidden.id] },
      [{ route: 'catalog', query: 'Visible', limit: 1 }],
      { route: 'catalog', query: 'Visible', limit: 200 },
    ]) {
      routeText = JSON.stringify(malicious);
      const result = await probe.execute(command(tenants[0]));
      assert.equal(result.status, 'blocked');
      assert.equal('code' in result && result.code, 'ROUTER_OUTPUT');
      assert.equal('tool' in result, false);
    }
    routeText = JSON.stringify({ route: 'reply' });
    const reply = await probe.execute(command(tenants[0]));
    assert.equal(reply.status, 'route_ready');
    assert.equal(reply.deliveryAllowed, false);
    routeText = JSON.stringify({ route: 'catalog', query: 'Visible', limit: 3 });
  });

  await t.test('unknown provider outcome is fenced with the same round UUID and no retry', async () => {
    const input = command(tenants[1]);
    const before = requests.length;
    dropResponse = true;
    assert.equal((await probe.execute(input)).status, 'uncertain');
    assert.equal((await probe.execute(input)).status, 'not_dispatched');
    assert.equal(requests.length, before + 1);
  });

  await t.test('unavailable persistence and a contended permission lock fail closed before model dispatch', async () => {
    const closed = new Pool({ connectionString: databaseUrl });
    await closed.end();
    const before = requests.length;
    const failed = await new CatalogRouterReadProbe(new TenantScopedUoW(closed)).execute(command(tenants[0]));
    assert.equal('code' in failed && failed.code, 'PROBE_STORE_UNAVAILABLE');
    let release!: () => void;
    let locked!: () => void;
    const lockReady = new Promise<void>((resolve) => { locked = resolve; });
    const holding = new Promise<void>((resolve) => { release = resolve; });
    const held = uow.run(alpha, async (tx) => {
      await tx.query('SELECT id FROM ai_agents WHERE company_id=$1 AND id=$2 FOR UPDATE', [alpha, tenants[0].agent.id]);
      locked();
      await holding;
    });
    await lockReady;
    try {
      const began = Date.now();
      const blocked = await probe.execute(command(tenants[0]));
      assert.equal(blocked.status, 'blocked');
      assert.ok(Date.now() - began < 5000, 'Permission locks must not leave an unbounded pending probe');
    } finally { release(); await held; }
    assert.equal(requests.length, before);
  });

  await t.test('shared quota admission blocks a new router attempt without a provider call', async () => {
    const before = requests.length;
    await uow.run(alpha, (tx) => tx.query(`UPDATE tenant_ai_quotas SET monthly_token_limit=current_month_tokens_used+100 WHERE tenant_id=$1`, [alpha]));
    const result = await probe.execute(command(tenants[0]));
    assert.equal('code' in result && result.code, 'AI_QUOTA_EXHAUSTED');
    assert.equal(requests.length, before);
  });
  for (const tenant of tenants) {
    const { rows: [accounting] } = await uow.run(tenant.id, (tx) => tx.query(`SELECT q.current_month_tokens_used,
      (SELECT COALESCE(sum(total_tokens),0) FROM ai_token_cost_ledger WHERE tenant_id=$1) AS accounted,
      (SELECT count(*) FROM customer_orders WHERE company_id=$1) AS orders,
      (SELECT count(*) FROM approval_requests WHERE tenant_id=$1) AS approvals,
      (SELECT count(*) FROM tool_execution_effects WHERE tenant_id=$1) AS effects
      FROM tenant_ai_quotas q WHERE tenant_id=$1`, [tenant.id]));
    assert.equal(String(accounting.current_month_tokens_used), String(accounting.accounted));
    assert.equal(Number(accounting.orders), 0);
    assert.equal(Number(accounting.approvals), 0);
    assert.equal(Number(accounting.effects), 0);
  }
  assert.deepEqual(providerErrors, []);
  assert.equal(deniedFetch.mock.callCount(), 0, 'No unconfigured transport, Graph send or network tool was invoked');
});
