import './fixtures/testEnv';
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import express from 'express';
import { fork, type ChildProcess } from 'node:child_process';
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
import { CatalogExecutionEvaluator } from '../services/ai/studio/CatalogExecutionEvaluator';
const jwt = require('jsonwebtoken') as { sign(claims: Record<string, unknown>, key: string): string };

const databaseUrl = process.env.STRICT_CATALOG_TEST_DATABASE_URL;

test('Studio evaluates catalog tools against durable provider evidence without granting publication', {
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
    const response = await nativeFetch(`http://127.0.0.1:${apiAddress.port}/api/v1/agent-graphs/${tenant.graph.graphId}${path}${path.includes('?') ? '&' : '?'}version=1`, {
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

  await t.test('normal API stores explicit profile and reports bounded form capabilities', async () => {
    const tenant = tenants[0];
    const before = requests.length;
    assert.equal((await request(tenant, '/evaluation-suites', { id: randomUUID(), name: 'Missing profile', scenarios: [scenario(tenant)] })).status, 422);
    assert.equal((await request(tenant, '/evaluation-suites', { id: randomUUID(), name: 'Conflict', profile: 'catalog-router-v1',
      scenarios: [{ ...scenario(tenant), forbiddenTools: ['catalog.search'] }] })).status, 422);
    for (const invalid of [
      { ...scenario(tenant), expectedTools: [], forbiddenTools: [] },
      { ...scenario(tenant), assertions: [{ id: 'approval', type: 'approval_triggered' }] },
    ]) {
      assert.equal((await request(tenant, '/evaluation-suites', { id: randomUUID(), name: 'Unsupported scenario',
        profile: 'catalog-router-v1', scenarios: [invalid] })).status, 422);
    }
    assert.equal((await request(tenant, '/execution', undefined, 'EMPLEADO')).status, 403);
    const state = await request(tenant, '/execution');
    assert.equal(state.status, 200);
    assert.equal(state.body.profile.name, 'catalog-router-v1');
    assert.equal(state.body.profile.minScenarioTimeoutMs, 3000);
    assert.equal(state.body.profile.maxScenarioTimeoutMs, 20000);
    assert.equal(state.body.profile.maxSuiteDurationMs, 20000);
    assert.equal(state.body.profile.maxScenarios, 2);
    assert.equal(state.body.profile.maxInputLength, 1024);
    assert.equal(state.body.profile.publicationAllowed, false);
    assert.equal(requests.length, before);
  });

  await t.test('two companies pass real catalog/reply suites with two ledgers per scenario and no text in API', async () => {
    for (const tenant of tenants) {
      const id = await suite(tenant, [scenario(tenant), scenario(tenant, true)]);
      const evaluated = await evaluate(tenant, id);
      assert.equal(evaluated.status, 200, JSON.stringify(evaluated));
      assert.equal(evaluated.body.status, 'completed', JSON.stringify(evaluated.body));
      assert.equal(evaluated.body.passed, true, JSON.stringify(evaluated.body));
      assert.equal(evaluated.body.profile, 'catalog-router-v1');
      assert.equal(evaluated.body.publicationAllowed, false);
      assert.equal(evaluated.body.totalTokensUsed, 112);
      assert.deepEqual(evaluated.body.scenarios.map((item: { executedTools: string[] }) => item.executedTools), [['catalog.search'], []]);
      assert.equal(new Set(evaluated.body.scenarios.flatMap((item: { ledgerIds: number[] }) => item.ledgerIds)).size, 4);
      assert.equal(JSON.stringify(evaluated.body).includes('costs 12'), false);
      const before = requests.length;
      assert.deepEqual(await evaluate(tenant, id, evaluated.body.runId), evaluated);
      assert.equal(requests.length, before);
      assert.equal((await request(tenant, '/publish', { evaluationId: evaluated.body.runId })).status, 409);
      assert.equal((await request(tenant, '/execute', { attemptId: randomUUID(), input: 'Visible', timeoutMs: 1000 })).status, 409);
      const other = tenants.find((entry) => entry.id !== tenant.id)!;
      assert.equal((await request({ ...other, graph: tenant.graph }, `/evaluations/${evaluated.body.runId}`)).status, 404);
      assert.equal((await evaluate(other, id)).status, 422);
      const { rows: [stored] } = await uow.run(tenant.id, (tx) => tx.query(`SELECT run.execution_profile AS run_profile,suite.execution_profile AS suite_profile
        FROM agent_eval_runs run JOIN agent_eval_suites suite ON suite.id=run.suite_id WHERE run.tenant_id=$1 AND run.id=$2`, [tenant.id,evaluated.body.runId]));
      assert.deepEqual(stored, { run_profile: 'catalog-router-v1', suite_profile: 'catalog-router-v1' });
    }
  });

  await t.test('mentioning catalog.search in model text cannot satisfy expectedTools and actual forbidden reads fail', async () => {
    const tenant = tenants[0];
    const textOnly = await suite(tenant, [{ ...scenario(tenant, true), expectedTools: ['catalog.search'], forbiddenTools: [] }]);
    const absent = await evaluate(tenant, textOnly);
    assert.equal(absent.body.status, 'completed');
    assert.equal(absent.body.passed, false);
    assert.deepEqual(absent.body.scenarios[0].executedTools, []);
    assert.ok(absent.body.scenarios[0].failedAssertions.includes('expected-tool-0'));
    const forbidden = await suite(tenant, [{ ...scenario(tenant), expectedTools: [], forbiddenTools: ['catalog.search'] }]);
    const called = await evaluate(tenant, forbidden);
    assert.equal(called.body.passed, false);
    assert.deepEqual(called.body.scenarios[0].executedTools, ['catalog.search']);
    assert.ok(called.body.scenarios[0].failedAssertions.includes('forbidden-tool-0'));
  });

  await t.test('concurrent evaluation requests share scenario admission and both round ledgers', async () => {
    const tenant = tenants[0];
    const id = await suite(tenant,[scenario(tenant),scenario(tenant,true)]);
    const runId = randomUUID();
    const before = requests.length;
    const results = await Promise.all([evaluate(tenant,id,runId),evaluate(tenant,id,runId)]);
    assert.ok(results.every((result) => [200,202].includes(result.status)), JSON.stringify(results));
    const final = await evaluate(tenant,id,runId);
    assert.equal(final.body.status, 'completed', JSON.stringify(final));
    assert.equal(final.body.passed, true);
    assert.equal(final.body.totalTokensUsed, 112);
    assert.equal(requests.length, before+4);
  });

  await t.test('cancelling during router settlement records its cost and prevents catalog and answer', async () => {
    const tenant = tenants[0];
    const id = await suite(tenant);
    const runId = randomUUID();
    let cancelled: Awaited<ReturnType<typeof request>> | undefined;
    beforeResponse = async () => { cancelled = await request(tenant, `/evaluations/${runId}/cancel`, {}); };
    const before = requests.length;
    const result = await evaluate(tenant, id, runId);
    assert.equal(cancelled?.body.status, 'cancelled');
    assert.equal(result.body.status, 'cancelled');
    assert.equal(result.body.passed, false);
    assert.equal(result.body.totalTokensUsed, 28);
    assert.equal(requests.length, before + 1);
    assert.deepEqual(await evaluate(tenant, id, runId), result);
    assert.equal(requests.length, before + 1);
  });

  await t.test('revocation during the answer preserves accounting but never passes evaluation', async () => {
    const tenant = tenants[0];
    const id = await suite(tenant);
    beforeAnswer = async () => { await uow.run(alpha, (tx) => tx.query(`UPDATE agent_tool_grants SET is_enabled=false
      WHERE tenant_id=$1 AND agent_graph_id=$2`, [alpha,tenant.graph.graphId])); };
    const result = await evaluate(tenant, id);
    assert.equal(result.body.status, 'failed');
    assert.equal(result.body.passed, false);
    assert.equal(result.body.totalTokensUsed, 56);
    await uow.run(alpha, (tx) => tx.query(`UPDATE agent_tool_grants SET is_enabled=true WHERE tenant_id=$1 AND agent_graph_id=$2`, [alpha,tenant.graph.graphId]));
    const before = requests.length;
    assert.deepEqual(await evaluate(tenant, id, result.body.runId), result);
    assert.equal(requests.length, before);
  });

  await t.test('incomplete durable broker evidence cannot approve a claimed completed runtime result', async () => {
    const tenant = tenants[0];
    const id = await suite(tenant);
    const real = new CatalogRouterCheckpointRuntime(uow, undefined, undefined, execution);
    for (const damage of ['snapshot', 'reservation', 'chronology']) {
      const evaluator = new CatalogExecutionEvaluator(uow, { execute: async (command, guard) => {
        const result = await real.execute(command, guard);
        assert.equal(result.status, 'completed');
        await uow.run(command.tenantId, (tx) => damage === 'reservation'
          ? tx.query(`UPDATE ai_quota_reservations SET request_hash=repeat('a',64) WHERE tenant_id=$1 AND id=$2`,
            [command.tenantId,catalogRoundId(command.tenantId,command.runId,'answer')])
          : tx.query(`UPDATE catalog_router_tool_checkpoints SET ${damage === 'snapshot' ? 'output_encrypted=NULL' : "created_at=clock_timestamp()+interval '1 minute'"}
            WHERE tenant_id=$1 AND run_id=$2`, [command.tenantId,command.runId]));
        return result;
      } });
      const result = await evaluator.evaluate({ tenantId: alpha, graphId: tenant.graph.graphId, version: 1, suiteId: id, runId: randomUUID(), timeoutMs: 4000 });
      assert.equal(result.status, 'failed');
      assert.equal(result.passed, false);
      assert.equal(result.totalTokensUsed, 56);
      assert.equal((await request(tenant, `/evaluations/${result.runId}`)).body.passed, false);
      assert.equal((await request(tenant, '/publish', { evaluationId: result.runId })).status, 409);
    }
  });

  await t.test('rechecking earlier cases prevents a pass after revocation between scenarios', async () => {
    const tenant = tenants[0];
    const id = await suite(tenant, [scenario(tenant), scenario(tenant, true)]);
    const real = new CatalogRouterCheckpointRuntime(uow, undefined, undefined, execution);
    const evaluator = new CatalogExecutionEvaluator(uow, { execute: async (command, guard) => {
      const result = await real.execute(command, guard);
      if (command.input.includes('Greeting')) {
        await uow.run(alpha, (tx) => tx.query('UPDATE products SET ai_enabled=false WHERE company_id=$1 AND id=$2', [alpha,tenant.item.id]));
      }
      return result;
    } });
    const result = await evaluator.evaluate({ tenantId: alpha, graphId: tenant.graph.graphId, version: 1, suiteId: id, runId: randomUUID(), timeoutMs: 4000 });
    assert.equal(result.status, 'failed');
    assert.equal(result.passed, false);
    assert.equal('failureCode' in result && result.failureCode, 'CATALOG_EVIDENCE_INCOMPLETE');
    assert.equal(result.totalTokensUsed, 112);
    await uow.run(alpha, (tx) => tx.query('UPDATE products SET ai_enabled=true WHERE company_id=$1 AND id=$2', [alpha,tenant.item.id]));
  });

  await t.test('oversized suite budget or shortened timeout is rejected before provider admission', async () => {
    const tenant = tenants[0];
    const id = await suite(tenant, [0,1,2].map((index) => ({ ...scenario(tenant), id: 'case-' + index })));
    const before = requests.length;
    assert.equal((await evaluate(tenant,id)).status, 422);
    const single = await suite(tenant);
    assert.equal((await request(tenant,'/evaluations',{ suiteId: single,runId: randomUUID(),timeoutMs: 1000 })).status, 422);
    assert.equal(requests.length, before);
  });

  await t.test('process death after router or final checkpoint resumes the same evaluation through the API', async () => {
    const tenant = tenants[1];
    for (const slot of ['router', 'answer']) {
      const suiteId = await suite(tenant);
      const runId = randomUUID();
      const before = requests.length;
      const input = { tenantId: bravo, graphId: tenant.graph.graphId, version: 1, suiteId, runId, timeoutMs: 4000 };
      const child: ChildProcess = fork('src/test/fixtures/catalogEvaluationCrashWorker.ts', [`http://127.0.0.1:${address.port}/v1/chat/completions`, JSON.stringify(input), slot],
        { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      const exited = once(child, 'exit');
      t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
      const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
      try {
        const message: unknown = (await once(child, 'message'))[0];
        assert.deepEqual(message, { checkpoint: slot });
        assert.equal(child.kill('SIGKILL'), true);
        assert.deepEqual(await exited, [null, 'SIGKILL']);
      } finally { clearTimeout(timeout); }
      const observed = await request(tenant, `/evaluations/${runId}`);
      assert.equal(observed.body.status, 'running');
      assert.equal(observed.body.admittedScenarioId, 'lookup');
      const recovered = await evaluate(tenant, suiteId, runId);
      assert.equal(recovered.body.status, 'completed', JSON.stringify(recovered.body));
      assert.equal(recovered.body.passed, true);
      assert.equal(recovered.body.totalTokensUsed, 56);
      assert.equal(requests.length, before + 2, 'The two rounds are dispatched only once across SIGKILL');
    }
  });

  await t.test('unknown provider acknowledgement and replay remain failed without another POST', async () => {
    const tenant = tenants[1];
    const id = await suite(tenant);
    dropResponse = true;
    const before = requests.length;
    const result = await evaluate(tenant, id);
    assert.equal(result.body.status, 'failed');
    assert.equal(result.body.passed, false);
    assert.equal(result.body.scenarios[0].outcome, 'uncertain');
    assert.deepEqual(await evaluate(tenant, id, result.body.runId), result);
    assert.equal(requests.length, before + 1);
  });
  assert.deepEqual(providerErrors, []);
  assert.equal(deniedFetch.mock.callCount(), 0);
});
