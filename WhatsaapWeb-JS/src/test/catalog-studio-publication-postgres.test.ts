import './fixtures/testEnv';
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import express from 'express';
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
import createAgentStudioRoutes from '../routes/agentStudioRoutes';
import { createStudioProviderAccess } from '../services/ai/studio/StudioVerification';
import { StrictWhatsappRuntimeStore } from '../services/ai/runtime/StrictWhatsappRuntimeStore';
import { CatalogRouterCheckpointStore } from '../services/ai/runtime/CatalogRouterCheckpointStore';
const jwt = require('jsonwebtoken') as { sign(claims: Record<string, unknown>, key: string): string };

const databaseUrl = process.env.STRICT_CATALOG_TEST_DATABASE_URL;

test('Studio publishes catalog evidence without granting execution or WhatsApp binding', {
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
      limits: { maxSteps: 4, maxDelegations: 0, maxParallelNodes: 1, maxDurationSeconds: 20,
        maxModelTokens: budget.maxTokens * 4, maxCostMicroUsd: budget.maxCostMicroUsd * 4 },
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

  const routeText = JSON.stringify({ route: 'catalog', query: 'Visible', limit: 3 });
  const requests: string[] = [];
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
      assert.equal(req.headers.authorization, `Bearer catalog-fixture-${name}`);
      assert.equal(body.model, boundedTextCapability.model);
      assert.equal(body.messages.length, 2);
      assert.equal(body.tools, undefined);
      requests.push(name);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ model: body.model, service_tier: 'default',
        usage: { prompt_tokens: 12, completion_tokens: 16, total_tokens: 28 },
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: slot === 'router' ? (body.messages[1].content.includes('Greeting') ? '{"route":"reply"}' : routeText) : `Visible ${name} costs 12 USD; catalog.search is a tool name` } }] }));
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
  const execution = createTenantBoundedModelExecution(uow, transport);
  const access = createStudioProviderAccess(uow, execution);
  const app = express();
  app.use(express.json());
  app.use('/api/v1/agent-graphs', createAgentStudioRoutes(uow, undefined, access));
  app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(500).json({ code: 'TEST_SERVER_ERROR' }));
  const apiServer = app.listen(0, '127.0.0.1');
  await once(apiServer, 'listening');
  t.after(() => new Promise<void>((resolve) => { apiServer.close(() => resolve()); apiServer.closeAllConnections(); }));
  const apiAddress = apiServer.address();
  assert.ok(apiAddress && typeof apiAddress !== 'string');
  const request = async (tenant: typeof tenants[number], path: string, body?: unknown, role = 'ADMIN') => {
    const token = jwt.sign({ tenantId: tenant.id, userId: 20, rol: role }, process.env.JWT_SECRET!);
    const response = await nativeFetch(`http://127.0.0.1:${apiAddress.port}/api/v1/agent-graphs/${tenant.graph.graphId}${path}${path.includes('?') ? '&' : '?'}version=${tenant.graph.version}`, {
      method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-tenant-id': String(bravo) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const scenario = (tenant: typeof tenants[number], greeting = false) => ({ id: greeting ? 'greeting' : 'lookup', name: greeting ? 'Greeting' : 'Catalog lookup',
    mockInput: `${greeting ? 'Greeting' : 'Find Visible'} ${tenant.name}`, expectedTextPatterns: [`Visible ${tenant.name}`],
    expectedTools: greeting ? [] : ['catalog.search'], forbiddenTools: greeting ? ['catalog.search'] : ['order.upsertPreorder'] });
  const suite = async (tenant: typeof tenants[number], scenarios = [scenario(tenant)]) => {
    const result = await request(tenant, '/evaluation-suites', { id: randomUUID(), name: 'Durable catalog suite', profile: 'catalog-router-v1', scenarios });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body.id as string;
  };
  const evaluate = (tenant: typeof tenants[number], suiteId: string, runId = randomUUID()) =>
    request(tenant, '/evaluations', { suiteId, runId, timeoutMs: 4000 });

  const approved = new Map<number, Awaited<ReturnType<typeof evaluate>>>();
  const published = new Map<number, Awaited<ReturnType<typeof request>>>();
  const persisted = new Map<number, unknown>();
  type Tenant = typeof tenants[number];
  const publicationRow = (tenant: Tenant) => uow.run(tenant.id, async (tx) => {
    const { rows } = await tx.query(`SELECT to_jsonb(publication) AS receipt FROM agent_studio_publications publication
      WHERE tenant_id=$1 AND graph_id=$2 AND version=$3`, [tenant.id, tenant.graph.graphId, tenant.graph.version]);
    return rows;
  });
  const revision = async (tenant: Tenant) => {
    const { graph } = tenant;
    const saved = await uow.run(tenant.id, (tx) => saveDraft(tx, tenant.id, 20, graph.graphId, {
      entryNodeId: graph.entryNodeId, policyRef: graph.policyRef, limits: graph.limits, edges: graph.edges,
      nodes: graph.nodes.map((node) => node.id === 'answer'
        ? { ...node, config: { ...node.config, prompt: `Answer ${randomUUID()} ${tenant.name}` } } : node),
    }, false));
    assert.ok(saved);
    return { ...tenant, graph: saved };
  };
  const candidate = async (tenant: Tenant, scenarios?: ReturnType<typeof scenario>[]) => {
    const pending = await revision(tenant);
    assert.equal((await publicationRow(pending)).length, 0, 'Each negative starts from an unpublished revision');
    const suiteId = await suite(pending, scenarios ?? [scenario(pending), scenario(pending, true)]);
    const evaluated = await evaluate(pending, suiteId);
    assert.equal(evaluated.status, 200, JSON.stringify(evaluated));
    assert.equal(evaluated.body.status, 'completed', JSON.stringify(evaluated.body));
    assert.equal(evaluated.body.passed, true, JSON.stringify(evaluated.body));
    return { tenant: pending, evaluated };
  };
  const deny = async (input: Awaited<ReturnType<typeof candidate>>, status = 409) => {
    const before = requests.length;
    const response = await request(input.tenant, '/publish', { evaluationId: input.evaluated.body.runId });
    assert.equal(response.status, status, JSON.stringify(response.body));
    assert.equal((await publicationRow(input.tenant)).length, 0);
    assert.equal(requests.length, before, 'Rejecting publication cannot execute any model or tool');
    return response;
  };
  const notReady = async (input: Awaited<ReturnType<typeof candidate>>, blocker: string) => {
    const response = await request(input.tenant, `/evaluations/${input.evaluated.body.runId}`);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.status, 'completed');
    assert.equal(response.body.passed, true, 'Historical evaluation outcomes remain unchanged');
    assert.equal(response.body.publicationAllowed, false);
    assert.equal(response.body.publicationEvidence, false);
    assert.equal(response.body.publicationBlocker, blocker);
  };
  await t.test('two companies publish their own confirmed catalog and reply evidence', async () => {
    for (const tenant of tenants) {
      const suiteId = await suite(tenant, [scenario(tenant), scenario(tenant, true)]);
      const result = await evaluate(tenant, suiteId);
      assert.equal(result.status, 200, JSON.stringify(result));
      assert.equal(result.body.status, 'completed', JSON.stringify(result.body));
      assert.equal(result.body.passed, true, JSON.stringify(result.body));
      assert.equal(result.body.evidenceVersion, 'catalog-evaluation-v1');
      assert.equal(result.body.publicationAllowed, true);
      assert.equal(result.body.publicationEvidence, true);
      assert.equal(result.body.publicationBlocker, null);
      assert.equal(result.body.totalTokensUsed, 112);
      assert.equal(new Set(result.body.scenarios.flatMap((entry: { ledgerIds: number[] }) => entry.ledgerIds)).size, 4);
      approved.set(tenant.id, result);
    }
    const before = requests.length;
    for (const tenant of tenants) {
      const result = await request(tenant, '/publish', { evaluationId: approved.get(tenant.id)!.body.runId });
      assert.equal(result.status, 200, 'Confirmed catalog evidence should publish through Studio: ' + JSON.stringify(result.body));
      assert.equal(result.body.profile, 'catalog-router-v1');
      assert.equal(result.body.evidenceVersion, 'catalog-publication-v1');
      assert.match(result.body.evidenceHash, /^[0-9a-f]{64}$/);
      assert.match(result.body.authorizationHash, /^[0-9a-f]{64}$/);
      assert.equal(result.body.executionAllowed, false);
      assert.equal(result.body.whatsappBindingAllowed, false);
      assert.equal(result.body.graphId, tenant.graph.graphId);
      assert.equal(result.body.version, tenant.graph.version);
      assert.equal(result.body.specHash, tenant.graph.specHash);
      assert.equal(result.body.evaluationId, approved.get(tenant.id)!.body.runId);
      published.set(tenant.id, result);
      const rows = await publicationRow(tenant);
      assert.equal(rows.length, 1);
      persisted.set(tenant.id, rows[0].receipt);
      const raw = JSON.stringify(rows[0].receipt);
      assert.equal(raw.includes('costs 12'), false, 'Publication stores proof, never the model answer');
      assert.equal(raw.includes('Find Visible'), false, 'Publication stores no scenario input');
      assert.equal(raw.includes(`Visible ${tenant.name}`), false, 'Publication stores no product or assertion text');
      assert.ok(raw.includes(result.body.evidenceHash));
      assert.ok(raw.includes(result.body.authorizationHash));
    }
    assert.equal(requests.length, before, 'Publication revalidates stored evidence without invoking a provider');
  });

  await t.test('publication replay is idempotent and never grants manual execution or WhatsApp binding', async () => {
    for (const tenant of tenants) {
      const before = requests.length;
      const again = await request(tenant, '/publish', { evaluationId: approved.get(tenant.id)!.body.runId });
      assert.deepEqual(again, published.get(tenant.id));
      assert.equal((await publicationRow(tenant)).length, 1);
      const state = await request(tenant, '/execution');
      assert.deepEqual(state.body.active, again.body);
      assert.equal((await request(tenant, '/execute', { attemptId: randomUUID(), input: 'Visible', timeoutMs: 1000 })).status, 409);
      const store = new StrictWhatsappRuntimeStore(uow);
      for (const mode of ['suggest', 'auto'] as const) {
        await assert.rejects(store.bind(tenant.id, { graphId: tenant.graph.graphId, version: tenant.graph.version,
          specHash: tenant.graph.specHash, mode, actorId: 20 }, null), { code: 'STRICT_WHATSAPP_BINDING_INVALID' });
      }
      assert.equal(await store.getBinding(tenant.id), null);
      assert.equal(requests.length, before);
    }
  });

  await t.test('a catalog replay cannot become a legacy text replay after model compatibility changes', async () => {
    const tenant = tenants[1];
    const model = Object.getOwnPropertyDescriptor(boundedTextCapability, 'model');
    assert.ok(model);
    const before = requests.length;
    // node:test isolates this file in its own process; restore the descriptor before another scenario runs.
    try {
      Object.defineProperty(boundedTextCapability, 'model', { ...model, value: 'unavailable-fixture-model' });
      assert.equal(compileCatalogRouterExecutionProfile(tenant.graph).compatible, false);
      const replay = await request(tenant, '/publish', { evaluationId: approved.get(bravo)!.body.runId });
      assert.equal(replay.status, 409, JSON.stringify(replay.body));
      assert.equal(replay.body.code, 'CONFLICT');
      assert.ok(JSON.stringify(replay.body).includes('CATALOG_PUBLICATION_EVIDENCE'));
      const state = await request(tenant, '/execution');
      assert.equal(state.status, 200);
      assert.deepEqual(state.body.active, published.get(bravo)!.body);
      assert.deepEqual((await publicationRow(tenant))[0].receipt, persisted.get(bravo));
      assert.equal(requests.length, before, 'A changed compiler cannot bypass replay verification or call a provider');
    } finally {
      Object.defineProperty(boundedTextCapability, 'model', model);
    }
    assert.equal(compileCatalogRouterExecutionProfile(tenant.graph).compatible, true);
  });

  await t.test('tenant, foreign suite and employee boundaries cannot publish another company evidence', async () => {
    const [a, b] = tenants;
    const before = requests.length;
    assert.equal((await request({ ...b, graph: a.graph }, '/publish', { evaluationId: approved.get(a.id)!.body.runId })).status, 404);
    assert.equal((await request(a, '/publish', { evaluationId: approved.get(b.id)!.body.runId })).status, 409);
    assert.equal((await request(a, '/publish', { evaluationId: approved.get(a.id)!.body.runId }, 'EMPLEADO')).status, 403);
    assert.equal((await evaluate(a, approved.get(b.id)!.body.suiteId)).status, 422);
    assert.equal(requests.length, before);
    const foreignRows = await uow.run(b.id, (tx) => tx.query('SELECT graph_id FROM agent_studio_publications WHERE tenant_id=$1', [a.id]));
    assert.equal(foreignRows.rowCount, 0);
    const mixed = await candidate(a);
    await uow.run(a.id, (tx) => tx.query('UPDATE agent_eval_runs SET suite_id=$3 WHERE tenant_id=$1 AND id=$2',
      [a.id, mixed.evaluated.body.runId, approved.get(b.id)!.body.suiteId]));
    await deny(mixed);
  });

  await t.test('grant, product and policy revocation between evaluation and publication cannot be revived by restoration', async () => {
    const tenant = tenants[0];
    for (const resource of ['grant', 'product', 'policy'] as const) {
      const pending = await candidate(tenant);
      if (resource === 'grant') {
        await uow.run(tenant.id, (tx) => tx.query(`UPDATE agent_tool_grants SET is_enabled=false WHERE tenant_id=$1 AND agent_graph_id=$2`,
          [tenant.id, tenant.graph.graphId]));
      } else if (resource === 'product') {
        await uow.run(tenant.id, (tx) => tx.query('UPDATE products SET ai_enabled=false WHERE company_id=$1 AND id=$2', [tenant.id, tenant.item.id]));
      } else await execution.policy.transition(tenant.id, 'paused');
      try {
        await deny(pending, resource === 'policy' ? 503 : 409);
        await notReady(pending, 'CATALOG_PUBLICATION_AUTHORIZATION');
      } finally {
        if (resource === 'grant') {
          await uow.run(tenant.id, (tx) => tx.query(`UPDATE agent_tool_grants SET is_enabled=true WHERE tenant_id=$1 AND agent_graph_id=$2`,
            [tenant.id, tenant.graph.graphId]));
        } else if (resource === 'product') {
          await uow.run(tenant.id, (tx) => tx.query('UPDATE products SET ai_enabled=true WHERE company_id=$1 AND id=$2', [tenant.id, tenant.item.id]));
        } else await execution.policy.transition(tenant.id, 'strict');
      }
      await deny(pending);
    }
  });

  await t.test('missing snapshot, altered reservation, failed ledger and wrong chronology cannot publish a passed scorecard', async () => {
    for (const damage of ['snapshot', 'reservation', 'ledger', 'chronology'] as const) {
      const pending = await candidate(tenants[0]);
      const evidence = pending.evaluated.body.scenarios[0];
      await uow.run(pending.tenant.id, (tx) => {
        if (damage === 'reservation') return tx.query(`UPDATE ai_quota_reservations SET request_hash=repeat('a',64)
          WHERE tenant_id=$1 AND id=$2`, [pending.tenant.id, catalogRoundId(pending.tenant.id, evidence.runtimeRunId, 'answer')]);
        if (damage === 'ledger') return tx.query(`UPDATE ai_token_cost_ledger SET status='failed' WHERE tenant_id=$1 AND id=$2`,
          [pending.tenant.id, evidence.rounds.find((round: { slot: string }) => round.slot === 'answer').ledgerId]);
        return tx.query(`UPDATE catalog_router_tool_checkpoints
          SET ${damage === 'snapshot' ? 'output_encrypted=NULL' : "created_at=clock_timestamp()+interval '1 minute'"}
          WHERE tenant_id=$1 AND run_id=$2`, [pending.tenant.id, evidence.runtimeRunId]);
      });
      assert.equal((await request(pending.tenant, `/evaluations/${pending.evaluated.body.runId}`)).body.passed, true,
        'The historical scorecard alone cannot authorize publication');
      await deny(pending);
    }
  });

  await t.test('publication requires positive catalog coverage and an explicit no-catalog reply case', async () => {
    const tenant = tenants[0];
    for (const cases of [
      [scenario(tenant)],
      [scenario(tenant, true)],
      [scenario(tenant), { ...scenario(tenant, true), forbiddenTools: ['order.upsertPreorder'] }],
    ]) {
      const pending = await candidate(tenant, cases);
      const response = await deny(pending);
      assert.ok(JSON.stringify(response.body).includes('CATALOG_PUBLICATION_COVERAGE'), JSON.stringify(response.body));
      await notReady(pending, 'CATALOG_PUBLICATION_COVERAGE');
    }
  });

  await t.test('unversioned historical evaluations and expired snapshots never authorize a new publication', async () => {
    const legacy = await candidate(tenants[1]);
    await uow.run(bravo, (tx) => tx.query(`UPDATE agent_eval_runs SET execution_evidence_version=NULL WHERE tenant_id=$1 AND id=$2`,
      [bravo, legacy.evaluated.body.runId]));
    await deny(legacy);
    await notReady(legacy, 'CATALOG_PUBLICATION_VERSION');
    const expired = await candidate(tenants[1]);
    const ids = expired.evaluated.body.scenarios.map((entry: { runtimeRunId: string }) => entry.runtimeRunId);
    await uow.run(bravo, (tx) => tx.query(`UPDATE catalog_router_runs SET created_at=created_at-interval '2 hours',
      deadline_at=deadline_at-interval '2 hours', expires_at=expires_at-interval '2 hours' WHERE tenant_id=$1 AND id=ANY($2::uuid[])`, [bravo, ids]));
    await deny(expired);
    await notReady(expired, 'CATALOG_PUBLICATION_EVIDENCE');
  });

  await t.test('confirmed publication remains historical after plaintext cleanup and cannot be rewritten', async () => {
    const tenant = tenants[0];
    const ids = approved.get(alpha)!.body.scenarios.map((entry: { runtimeRunId: string }) => entry.runtimeRunId);
    await uow.run(alpha, (tx) => tx.query(`UPDATE catalog_router_runs SET created_at=created_at-interval '2 hours',
      deadline_at=deadline_at-interval '2 hours', expires_at=expires_at-interval '2 hours' WHERE tenant_id=$1 AND id=ANY($2::uuid[])`, [alpha, ids]));
    await new CatalogRouterCheckpointStore(uow).eraseExpired(alpha);
    const { rows: [payloads] } = await uow.run(alpha, (tx) => tx.query(`SELECT
      (SELECT count(*)::int FROM catalog_router_rounds WHERE tenant_id=$1 AND run_id=ANY($2::uuid[]) AND output_encrypted IS NOT NULL) AS rounds,
      (SELECT count(*)::int FROM catalog_router_tool_checkpoints WHERE tenant_id=$1 AND run_id=ANY($2::uuid[]) AND output_encrypted IS NOT NULL) AS tools`, [alpha, ids]));
    assert.deepEqual(payloads, { rounds: 0, tools: 0 });
    assert.deepEqual((await publicationRow(tenant))[0].receipt, persisted.get(alpha));
    assert.deepEqual((await request(tenant, '/execution')).body.active, published.get(alpha)!.body);
    const before = requests.length;
    assert.equal((await request(tenant, '/publish', { evaluationId: approved.get(alpha)!.body.runId })).status, 409,
      'An exact POST replay revalidates evidence even while the publication remains readable as history');
    assert.deepEqual((await publicationRow(tenant))[0].receipt, persisted.get(alpha));
    assert.equal(requests.length, before);
    await assert.rejects(uow.run(alpha, (tx) => tx.query(`UPDATE agent_studio_publications SET spec_hash=repeat('a',64)
      WHERE tenant_id=$1 AND graph_id=$2 AND version=$3`, [alpha, tenant.graph.graphId, tenant.graph.version])), { code: '55000' });
    assert.equal((await request(tenant, '/execute', { attemptId: randomUUID(), input: 'Visible', timeoutMs: 1000 })).status, 409);
  });

  await t.test('a newer draft does not move a published pin; a new reviewed publication preserves the old receipt', async () => {
    const tenant = tenants[0];
    const pending = await candidate(tenant);
    assert.deepEqual((await request(pending.tenant, '/execution')).body.active, published.get(alpha)!.body);
    assert.deepEqual((await publicationRow(tenant))[0].receipt, persisted.get(alpha));
    const before = requests.length;
    const newer = await request(pending.tenant, '/publish', { evaluationId: pending.evaluated.body.runId });
    assert.equal(newer.status, 200, JSON.stringify(newer));
    assert.equal(newer.body.version, pending.tenant.graph.version);
    assert.notEqual(newer.body.specHash, tenant.graph.specHash);
    assert.equal(newer.body.executionAllowed, false);
    assert.equal(newer.body.whatsappBindingAllowed, false);
    assert.deepEqual((await request(pending.tenant, '/execution')).body.active, newer.body);
    assert.deepEqual((await publicationRow(tenant))[0].receipt, persisted.get(alpha));
    assert.equal((await request(pending.tenant, '/execute', { attemptId: randomUUID(), input: 'Visible', timeoutMs: 1000 })).status, 409);
    assert.equal(requests.length, before);
  });

  await t.test('catalog supersedes text globally while an existing WhatsApp binding keeps its reviewed text revision', async () => {
    const tenant = tenants[0];
    const textGraph = await uow.run(alpha, (tx) => saveDraft(tx, alpha, 20, `upgrade-${randomUUID()}`, {
      entryNodeId: 'answer', policyRef: 'strict-profile-upgrade-fixture', limits: tenant.graph.limits,
      nodes: [{ id: 'answer', kind: 'agent', config: { provider: 'openai', model: boundedTextCapability.model,
        prompt: `Answer ${tenant.name}`, maxTokens: 128 } }, { id: 'end', kind: 'end', config: {} }],
      edges: [{ id: 'finish', from: 'answer', to: 'end' }],
    }, true));
    assert.ok(textGraph);
    assert.equal(textGraph.version, 1);
    const textTenant = { ...tenant, graph: textGraph };
    const textSuite = await request(textTenant, '/evaluation-suites', { id: randomUUID(), name: 'Text before catalog',
      scenarios: [{ id: 'text', name: 'Text answer', mockInput: 'Greeting Alfa', expectedTextPatterns: ['Visible Alfa'] }] });
    assert.equal(textSuite.status, 200, JSON.stringify(textSuite.body));
    const textEvaluation = await evaluate(textTenant, textSuite.body.id);
    assert.equal(textEvaluation.status, 200, JSON.stringify(textEvaluation.body));
    assert.equal(textEvaluation.body.passed, true);
    const textPublication = await request(textTenant, '/publish', { evaluationId: textEvaluation.body.runId });
    assert.equal(textPublication.status, 200, JSON.stringify(textPublication.body));
    assert.equal(textPublication.body.profile, undefined, 'The existing text publication DTO stays compatible');
    const textReceipt = (await publicationRow(textTenant))[0].receipt;
    assert.equal(textReceipt.execution_profile, 'linear-text-v1');
    const bindingStore = new StrictWhatsappRuntimeStore(uow);
    const pinned = await bindingStore.bind(alpha, { graphId: textGraph.graphId, version: 1,
      specHash: textGraph.specHash, mode: 'suggest', actorId: 20 }, null);

    const catalogGraph = await uow.run(alpha, async (tx) => {
      const graph = await saveDraft(tx, alpha, 20, textGraph.graphId, {
        entryNodeId: tenant.graph.entryNodeId, policyRef: tenant.graph.policyRef, limits: tenant.graph.limits,
        nodes: tenant.graph.nodes, edges: tenant.graph.edges,
      }, false);
      await tx.query(`INSERT INTO agent_tool_grants(tenant_id,agent_graph_id,tool_name,required_roles,is_enabled)
        VALUES($1,$2,'catalog.search',ARRAY['agent'],true)`, [alpha, textGraph.graphId]);
      return graph;
    });
    assert.ok(catalogGraph);
    assert.equal(catalogGraph.version, 2);
    const catalogTenant = { ...tenant, graph: catalogGraph };
    const catalogSuite = await suite(catalogTenant, [scenario(catalogTenant), scenario(catalogTenant, true)]);
    const evaluated = await evaluate(catalogTenant, catalogSuite);
    assert.equal(evaluated.status, 200, JSON.stringify(evaluated.body));
    assert.equal(evaluated.body.publicationAllowed, true);
    const before = requests.length;
    const [first, concurrent] = await Promise.all([1, 2].map(() => request(catalogTenant, '/publish', { evaluationId: evaluated.body.runId })));
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.deepEqual(concurrent, first, 'Concurrent identical publication returns one immutable receipt');
    assert.equal((await publicationRow(catalogTenant)).length, 1);
    assert.equal(first.body.profile, 'catalog-router-v1');
    assert.equal(first.body.version, 2);
    const oldRevisionState = await request(textTenant, '/execution');
    assert.equal(oldRevisionState.status, 200);
    assert.deepEqual(oldRevisionState.body.active, first.body, 'Viewing text v1 cannot hide the global catalog v2 publication');
    const providerAccess = await access(alpha);
    assert.ok(providerAccess);
    const active = await uow.run(alpha, (tx) => providerAccess.studio.publications.loadActive(tx, alpha, textGraph.graphId));
    assert.deepEqual(active?.publication, first.body);
    assert.equal(active?.graph.version, 2);
    assert.deepEqual((await publicationRow(textTenant))[0].receipt, textReceipt);
    assert.deepEqual(await bindingStore.getBinding(alpha), pinned, 'Publishing never silently changes the existing WhatsApp pin');
    await assert.rejects(bindingStore.bind(alpha, { graphId: catalogGraph.graphId, version: 2,
      specHash: catalogGraph.specHash, mode: 'suggest', actorId: 20 }, pinned.revision), { code: 'STRICT_WHATSAPP_BINDING_INVALID' });
    assert.deepEqual(await bindingStore.getBinding(alpha), pinned);
    assert.equal((await request(textTenant, '/execute', { attemptId: randomUUID(), input: 'Visible', timeoutMs: 1000 })).status, 409,
      'Manual execution must not fall back to the superseded text publication');
    assert.equal(requests.length, before);
  });
  assert.deepEqual(providerErrors, []);
  assert.equal(deniedFetch.mock.callCount(), 0);
});
