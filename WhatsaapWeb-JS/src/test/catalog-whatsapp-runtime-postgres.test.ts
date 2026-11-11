import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { fork } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AgentGraphVersionV1 } from '@whatsap-automat/contracts';
import type { Pool } from 'pg';

const databaseUrl = process.env.CATALOG_WHATSAPP_TEST_DATABASE_URL;

test('published catalog agents bind explicitly to their own company WhatsApp runtime', {
  skip: !databaseUrl && 'CATALOG_WHATSAPP_TEST_DATABASE_URL must select a local _smoke database', timeout: 60_000,
}, async (t) => {
  const database = new URL(databaseUrl!);
  assert.equal(database.hostname, '127.0.0.1');
  assert.match(database.pathname, /_smoke$/);
  const providerRequests: Array<{ name: string; slot: 'router'|'answer'; input: string; prompt: string }> = [];
  const graphCredentials = new Map<string,string>();
  const graphSends: Array<{ phoneId: string; to: string; text: string }> = [];
  const transportErrors: unknown[] = [];
  let dropGraphAck = false;
  let dropModelAck: string | undefined;
  let intervention: { name: string;slot: 'router'|'answer';work: () => Promise<void> } | undefined;
  const server = createServer(async (req,res) => {
    try {
      res.setHeader('Content-Type','application/json');
      if (req.url?.startsWith('/v25.0/')) {
        const phoneId = req.url.split('/')[2].split('?')[0];
        assert.ok(graphCredentials.has(phoneId),'Only a seeded company phone may use Graph');
        assert.equal(req.headers.authorization,`Bearer ${graphCredentials.get(phoneId)}`);
        if (req.method === 'GET') {
          assert.equal(req.url,`/v25.0/${phoneId}?fields=id`);
          res.end(JSON.stringify({ id: phoneId }));
          return;
        }
        assert.equal(req.method,'POST');
        assert.equal(req.url,`/v25.0/${phoneId}/messages`);
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        assert.equal(body.messaging_product,'whatsapp');
        assert.equal(body.type,'text');
        graphSends.push({ phoneId,to: body.to,text: body.text.body });
        if (dropGraphAck) { dropGraphAck = false; req.socket.destroy(); return; }
        res.end(JSON.stringify({ messages: [{ id: `wamid.catalog-local-${randomUUID()}` }] }));
        return;
      }
      assert.equal(req.method,'POST');
      assert.equal(req.url,'/v1/chat/completions');
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const name = req.headers.authorization === 'Bearer catalog-whatsapp-Alfa-provider' ? 'Alfa' : 'Bravo';
      assert.equal(req.headers.authorization,`Bearer catalog-whatsapp-${name}-provider`);
      assert.equal(body.model,'gpt-5.4-mini-2026-03-17');
      assert.equal(body.messages.length,2);
      assert.equal(body.tools,undefined,'The model receives a bounded protocol, never native tool authority');
      assert.ok(body.messages[0].content.endsWith(name));
      const slot = body.messages[0].content.includes('Return exactly one JSON') ? 'router' : 'answer';
      if (slot === 'answer') {
        const answerInput = JSON.parse(body.messages[1].content);
        if (answerInput.route === 'catalog') {
          assert.equal(answerInput.catalog.items.length,1);
          const [item] = answerInput.catalog.items;
          assert.deepEqual(Object.keys(item).sort(),['currency','id','name','price','priceMode']);
          assert.equal(item.name,`Visible ${name}`);
          assert.equal(Number(item.price),name === 'Alfa' ? 12 : 34);
          assert.equal(item.currency,'USD');
        } else {
          assert.equal(answerInput.route,'reply');
          assert.equal(answerInput.catalog,undefined);
        }
      }
      providerRequests.push({ name,slot,input: body.messages[1].content,prompt: body.messages[0].content });
      if (intervention?.name === name && intervention.slot === slot) {
        const hook = intervention.work;
        intervention = undefined;
        await hook();
      }
      if (dropModelAck === name && slot === 'answer') { dropModelAck = undefined; req.socket.destroy(); return; }
      const content = slot === 'router'
        ? JSON.stringify(body.messages[1].content.includes('Greeting') ? { route: 'reply' }
          : { route: 'catalog',query: 'Visible',limit: 3 })
        : `Visible ${name} costs ${name === 'Alfa' ? 12 : 34} USD`;
      res.end(JSON.stringify({ model: body.model,service_tier: 'default',
        usage: { prompt_tokens: 12,completion_tokens: 16,total_tokens: 28 },
        choices: [{ finish_reason: 'stop',message: { role: 'assistant',content } }] }));
    } catch (error) { transportErrors.push(error); res.writeHead(500).end(); }
  });
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const providerUrl = `http://127.0.0.1:${address.port}`;

  // Application singletons must see the isolated database and synthetic credentials on first import.
  Object.assign(process.env, {
    NODE_ENV: 'test',DOTENV_CONFIG_PATH: '/dev/null',WHATSAPP_PROVIDER: 'meta-cloud',AI_PROVIDER: 'opencode',
    DB_HOST: database.hostname,DB_PORT: database.port || '5432',DB_NAME: database.pathname.slice(1),
    DB_USER: decodeURIComponent(database.username),DB_PASSWORD: decodeURIComponent(database.password),
    JWT_SECRET: 'catalog-whatsapp-test-jwt-secret-0000000000',
    META_TOKEN_ENCRYPTION_KEY: 'catalog-whatsapp-test-cipher-0000000000000',
    META_APP_SECRET: 'catalog-whatsapp-test-signature',META_WA_ACCESS_TOKEN: 'catalog-whatsapp-test-meta-token',
    META_WA_PHONE_NUMBER_ID: '177000000000001',META_WABA_ID: '177000000000002',
    META_WEBHOOK_VERIFY_TOKEN: 'catalog-whatsapp-test-verify',OPENAI_API_KEY: '',
    OPENCODE_API_URL: providerUrl,OPENCODE_API_KEY: '',OPENCODE_MODEL: 'fixture-local',OPENCODE_CHAT_PATH: '/v1/chat/completions',
  });
  const nativeFetch = globalThis.fetch;
  t.mock.method(globalThis,'fetch',(input: string|URL|Request,init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === 'https://api.openai.com') {
      assert.equal(url.pathname,'/v1/chat/completions');
      assert.equal(init?.redirect,'error');
      return nativeFetch(`${providerUrl}${url.pathname}`,init);
    }
    if (url.origin === 'https://graph.facebook.com') return nativeFetch(`${providerUrl}${url.pathname}${url.search}`,init);
    assert.fail('Only official bounded provider and Graph URLs may reach the loopback fixture');
  });
  const pool = require('../config/database') as Pool;
  t.after(() => pool.end());
  const pg = require('pg') as typeof import('pg');
  const originalQuery = pg.Client.prototype.query as (...args: any[]) => any;
  let catalogSelects = 0;
  // Observe actual SQL transport without substituting queries or their results.
  t.mock.method(pg.Client.prototype,'query',function(this: import('pg').Client,...args: any[]) {
    const statement = typeof args[0] === 'string' ? args[0] : args[0]?.text;
    if (typeof statement === 'string' && statement.includes('FROM catalog_items ci_agent')) catalogSelects++;
    return originalQuery.apply(this,args);
  });
  const express = (await import('express')).default;
  const jwt = require('jsonwebtoken') as { sign(claims: Record<string,unknown>,key: string): string };
  const { TenantScopedUoW } = await import('../db/TenantScopedUoW');
  const { CatalogRepositoryPg } = await import('../modules/inventory/infra/db/CatalogRepositoryPg');
  const { ProductRepositoryPg } = await import('../modules/inventory/infra/db/ProductRepositoryPg');
  const { AgentRepositoryPg } = await import('../modules/ai/infra/db/AgentRepositoryPg');
  const { createTenantBoundedModelExecution } = await import('../services/ai/gateway/TenantBoundedModelExecution');
  const { ByokService } = await import('../services/ai/gateway/byok/ByokService');
  const { boundedTextBudget,boundedTextCapability } = await import('../services/ai/gateway/BoundedTextCompletion');
  const { saveDraft } = await import('../services/ai/studio/AgentStudioDrafts');
  const { createStudioProviderAccess } = await import('../services/ai/studio/StudioVerification');
  const { default: createAgentStudioRoutes } = await import('../routes/agentStudioRoutes');
  const { default: createStrictWhatsappBindingRoutes,createStrictWhatsappSuggestionRoutes } = await import('../routes/strictWhatsappBindingRoutes');
  const { default: createConversationV1Routes } = await import('../routes/conversationV1Routes');
  const { ConversationQueryService } = await import('../services/conversations/ConversationQueryService');
  const uow = new TenantScopedUoW(pool);
  const { rows: [role] } = await pool.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user');
  assert.deepEqual(role,{ rolsuper: false,rolbypassrls: false });
  const catalogs = new CatalogRepositoryPg(pool);
  const products = new ProductRepositoryPg(pool);
  const agents = new AgentRepositoryPg(pool);
  const bounded = createTenantBoundedModelExecution(uow);
  const alpha = randomInt(500_000_000,600_000_000);
  const tenants: Array<{ id: number;name: string;phoneId: string;graph: AgentGraphVersionV1;productId: number }> = [];
  const budget = boundedTextBudget(128,3000)!;
  for (const [id,name,price] of [[alpha,'Alfa',12],[alpha+1,'Bravo',34]] as const) {
    await uow.run(id,async db => {
      await db.query('INSERT INTO companies(id,name) VALUES($1,$2)',[id,`Catalog WhatsApp ${name}`]);
      await db.query('INSERT INTO tenants(id,name,slug) VALUES($1,$2,$3)',[id,name,randomUUID()]);
      await db.query('INSERT INTO tenant_ai_quotas(tenant_id,monthly_token_limit,monthly_cost_limit_micro_usd) VALUES($1,20000000,20000000)',[id]);
    });
    await agents.setAutomatorMode(id,'automator');
    const catalog = await catalogs.create(id,{ name: `Allowed ${name}`,status: 'active',aiEnabled: true });
    const product = await products.create(id,{ name: `Visible ${name}`,itemType: 'physical_product',status: 'active',aiEnabled: true,
      price,priceMode: 'fixed',currency: 'USD',catalogAssignments: [{ catalogId: catalog.id }],
      images: [{ imageUrl: '/uploads/commercial-items/catalog-whatsapp-fixture.png',isPrimary: true }] });
    const reader = await agents.create(id,null,{ name: `Catalog reader ${name}`,purpose: 'support',status: 'active',mode: 'auto',
      moduleAccess: { catalog: true },toolAccess: { catalogSearch: true },catalogScope: { catalogIds: [catalog.id],sectionIds: [] } });
    const graph = await uow.run(id,db => saveDraft(db,id,20,`catalog-whatsapp-${randomUUID()}`,{
      entryNodeId: 'route',policyRef: 'catalog-whatsapp-fixture',
      nodes: [
        { id: 'route',kind: 'router',config: { profile: 'catalog-router-v1',provider: boundedTextCapability.provider,
          model: boundedTextCapability.model,prompt: `Router ${name}`,maxTokens: 128,timeoutMs: 3000 } },
        { id: 'lookup',kind: 'tool',config: { toolName: 'catalog.search',schemaVersion: 1,agentId: reader.id,
          catalogScope: { catalogIds: [catalog.id],sectionIds: [] },maxResults: 3 } },
        { id: 'answer',kind: 'agent',config: { provider: boundedTextCapability.provider,model: boundedTextCapability.model,
          prompt: `Answer ${name}`,maxTokens: 128,timeoutMs: 3000 } },
        { id: 'end',kind: 'end',config: {} },
      ],
      edges: [{ id: 'catalog',from: 'route',to: 'lookup',condition: 'catalog' },
        { id: 'reply',from: 'route',to: 'answer',condition: 'reply' },
        { id: 'result',from: 'lookup',to: 'answer' },{ id: 'finish',from: 'answer',to: 'end' }],
      limits: { maxSteps: 4,maxDelegations: 0,maxParallelNodes: 1,maxDurationSeconds: 30,
        maxModelTokens: budget.maxTokens*4,maxCostMicroUsd: budget.maxCostMicroUsd*4 },
    },true));
    assert.ok(graph);
    await uow.run(id,db => db.query(`INSERT INTO agent_tool_grants(tenant_id,agent_graph_id,tool_name,required_roles,is_enabled)
      VALUES($1,$2,'catalog.search',ARRAY['agent'],true)`,[id,graph.graphId]));
    await new ByokService(undefined,uow).saveCredential(id,'openai',`catalog-whatsapp-${name}-provider`);
    await bounded.policy.transition(id,'draining');
    await bounded.policy.transition(id,'strict');
    const phoneId = String(177000000000000+id);
    graphCredentials.set(phoneId,`catalog-whatsapp-${name}-graph`);
    tenants.push({ id,name,phoneId,graph,productId: product.id });
  }

  const app = express();
  app.use(express.json());
  app.use('/api/v1/agent-graphs',createAgentStudioRoutes(uow,undefined,createStudioProviderAccess(uow,bounded)));
  app.use('/api/v1/ai/whatsapp-binding',createStrictWhatsappBindingRoutes(uow));
  app.use('/api/v1/ai/whatsapp-suggestions',createStrictWhatsappSuggestionRoutes(uow));
  app.use('/api/v1/conversations',createConversationV1Routes(undefined,new ConversationQueryService(uow)));
  const apiErrors: unknown[] = [];
  app.use((error: unknown,_req: any,res: any,_next: any) => { apiErrors.push(error); res.status(500).json({ code: 'TEST_SERVER_ERROR' }); });
  const apiServer = app.listen(0,'127.0.0.1');
  await once(apiServer,'listening');
  t.after(() => new Promise<void>(resolve => { apiServer.close(() => resolve()); apiServer.closeAllConnections(); }));
  const apiAddress = apiServer.address();
  assert.ok(apiAddress && typeof apiAddress !== 'string');
  type Tenant = typeof tenants[number];
  const request = async (tenant: Tenant,path: string,method = 'GET',body?: unknown,role = 'ADMIN') => {
    const token = jwt.sign({ tenantId: tenant.id,userId: 20,rol: role },process.env.JWT_SECRET!);
    const response = await nativeFetch(`http://127.0.0.1:${apiAddress.port}${path}`,{
      method,headers: { authorization: `Bearer ${token}`,'content-type': 'application/json','x-tenant-id': String(alpha+1) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status,body: response.status === 204 ? null : await response.json() };
  };
  const publications = new Map<number,{ evidenceHash: string;profile: string;evidenceVersion: string }>();
  const publish = async (tenant: Tenant) => {
    const path = `/api/v1/agent-graphs/${tenant.graph.graphId}`;
    const version = `?version=${tenant.graph.version}`;
    const suiteId = randomUUID();
    const suite = await request(tenant,`${path}/evaluation-suites${version}`,'POST',{
      id: suiteId,name: 'Catalog WhatsApp publication',profile: 'catalog-router-v1',
      scenarios: [
        { id: 'lookup',name: 'Catalog lookup',mockInput: `Find Visible ${tenant.name}`,
          expectedTextPatterns: [`Visible ${tenant.name}`],expectedTools: ['catalog.search'],forbiddenTools: ['order.upsertPreorder'] },
        { id: 'greeting',name: 'Greeting',mockInput: `Greeting ${tenant.name}`,
          expectedTextPatterns: [`Visible ${tenant.name}`],expectedTools: [],forbiddenTools: ['catalog.search'] },
      ],
    });
    assert.equal(suite.status,200,JSON.stringify(suite.body));
    const runId = randomUUID();
    const evaluation = await request(tenant,`${path}/evaluations${version}`,'POST',{ suiteId,runId,timeoutMs: 8000 });
    assert.equal(evaluation.status,200,JSON.stringify(evaluation.body));
    assert.equal(evaluation.body.status,'completed',JSON.stringify(evaluation.body));
    assert.equal(evaluation.body.passed,true,JSON.stringify(evaluation.body));
    assert.equal(evaluation.body.publicationAllowed,true,JSON.stringify(evaluation.body));
    const publication = await request(tenant,`${path}/publish${version}`,'POST',{ evaluationId: runId });
    assert.equal(publication.status,200,JSON.stringify(publication.body));
    assert.equal(publication.body.profile,'catalog-router-v1');
    assert.equal(publication.body.evidenceVersion,'catalog-publication-v1');
    assert.match(publication.body.evidenceHash,/^[0-9a-f]{64}$/);
    return publication.body;
  };
  for (const tenant of tenants) publications.set(tenant.id,await publish(tenant));
  assert.deepEqual(providerRequests.map(({ name,slot }) => `${name}:${slot}`),[
    'Alfa:router','Alfa:answer','Alfa:router','Alfa:answer','Bravo:router','Bravo:answer','Bravo:router','Bravo:answer',
  ]);
  assert.equal(graphSends.length,0,'Publishing a catalog cannot send a WhatsApp message');
  assert.deepEqual(transportErrors,[]);
  assert.deepEqual(apiErrors,[]);
  assert.equal(publications.size,2,'Both companies must publish real provider evidence before testing the product gap');
  const beforeBinding = providerRequests.length;
  const pins = new Map<number,Record<string,unknown>>();
  for (const tenant of tenants) {
    const receipt = publications.get(tenant.id)!;
    const { rows } = await uow.run(tenant.id,db => db.query(`SELECT execution_profile,evidence_version,evidence_hash
      FROM agent_studio_publications WHERE tenant_id=$1 AND graph_id=$2 AND version=$3 AND spec_hash=$4 AND execution_mode='provider'`,
    [tenant.id,tenant.graph.graphId,tenant.graph.version,tenant.graph.specHash]));
    assert.deepEqual(rows,[{ execution_profile: 'catalog-router-v1',evidence_version: 'catalog-publication-v1',evidence_hash: receipt.evidenceHash }]);
    const historicalBody = { graphId: tenant.graph.graphId,version: tenant.graph.version,specHash: tenant.graph.specHash,
      mode: 'suggest',expectedRevision: null };
    const implicit = await request(tenant,'/api/v1/ai/whatsapp-binding','PUT',historicalBody);
    assert.equal(implicit.status,409,'Catalog rights must never be inferred from the historical text binding DTO');
    pins.set(tenant.id,{ ...historicalBody,profile: 'catalog-router-v1',evidenceVersion: 'catalog-publication-v1',evidenceHash: receipt.evidenceHash });
  }
  const bindings: Array<Awaited<ReturnType<typeof request>>> = [];
  for (const tenant of tenants) bindings.push(await request(tenant,'/api/v1/ai/whatsapp-binding','PUT',pins.get(tenant.id)));
  t.diagnostic(`Both companies published; explicit catalog binding statuses: ${bindings.map(result => result.status).join(', ')}`);
  assert.deepEqual(bindings.map(result => result.status),[200,200],
    'Product gap: each administrator must be able to explicitly pin its published catalog agent to WhatsApp');
  for (let index=0;index<tenants.length;index++) {
    const tenant = tenants[index];
    const binding = bindings[index].body.binding;
    assert.equal(binding.graphId,tenant.graph.graphId);
    assert.equal(binding.version,tenant.graph.version);
    assert.equal(binding.specHash,tenant.graph.specHash);
    assert.equal(binding.profile,'catalog-router-v1');
    assert.equal(binding.evidenceVersion,'catalog-publication-v1');
    assert.equal(binding.evidenceHash,publications.get(tenant.id)!.evidenceHash);
    assert.match(binding.revision,/^[0-9a-f-]{36}$/);
    const read = await request(tenant,'/api/v1/ai/whatsapp-binding');
    assert.equal(read.status,200);
    assert.deepEqual(read.body.binding,binding);
  }
  assert.equal(providerRequests.length,beforeBinding,'Binding and reloading a pin cannot call a model');
  assert.equal(graphSends.length,0,'Binding cannot send a WhatsApp message');
  assert.deepEqual(apiErrors,[]);

  await t.test('binding requires an administrator, current CAS revision and own publication evidence',async () => {
    const [a,b] = tenants;
    const before = providerRequests.length;
    const revision = bindings[0].body.binding.revision;
    const current = { ...pins.get(a.id),expectedRevision: revision };
    assert.equal((await request(a,'/api/v1/ai/whatsapp-binding','GET',undefined,'EMPLEADO')).status,403);
    assert.equal((await request(a,'/api/v1/ai/whatsapp-binding','PUT',current,'EMPLEADO')).status,403);
    for (const ownership of [{ tenantId: b.id },{ actorId: 999 }]) {
      assert.equal((await request(a,'/api/v1/ai/whatsapp-binding','PUT',{ ...current,...ownership })).status,422);
    }
    const stale = await request(a,'/api/v1/ai/whatsapp-binding','PUT',pins.get(a.id));
    assert.equal(stale.status,409);
    assert.equal(stale.body.code,'BINDING_CONFLICT');
    const foreign = await request(a,'/api/v1/ai/whatsapp-binding','PUT',{ ...pins.get(b.id),expectedRevision: revision });
    assert.equal(foreign.status,409);
    const incorrectEvidence = await request(a,'/api/v1/ai/whatsapp-binding','PUT',{ ...current,evidenceHash: '0'.repeat(64) });
    assert.equal(incorrectEvidence.status,409);
    assert.deepEqual((await request(a,'/api/v1/ai/whatsapp-binding')).body.binding,bindings[0].body.binding);
    assert.deepEqual((await request(b,'/api/v1/ai/whatsapp-binding')).body.binding,bindings[1].body.binding);
    assert.equal(providerRequests.length,before);
    assert.equal(graphSends.length,0);
  });

  await t.test('publishing v2 leaves the explicit v1 evidence and binding revision intact',async () => {
    for (let index=0;index<tenants.length;index++) {
      const tenant = tenants[index];
      const graph = await uow.run(tenant.id,db => saveDraft(db,tenant.id,20,tenant.graph.graphId,{
        entryNodeId: tenant.graph.entryNodeId,policyRef: tenant.graph.policyRef,limits: tenant.graph.limits,edges: tenant.graph.edges,
        nodes: tenant.graph.nodes.map(node => node.id === 'answer'
          ? { ...node,config: { ...node.config,prompt: `Answer v2 ${tenant.name}` } } : node),
      },false));
      assert.ok(graph);
      assert.equal(graph.version,2);
      const receipt = await publish({ ...tenant,graph });
      assert.equal(receipt.version,2);
      assert.notEqual(receipt.specHash,tenant.graph.specHash);
      const binding = await request(tenant,'/api/v1/ai/whatsapp-binding');
      assert.deepEqual(binding.body.binding,bindings[index].body.binding);
    }
  });

  const { MetaInboxStore } = await import('../services/whatsapp/meta/MetaInboxStore');
  const { MetaInboundWorkRepository } = await import('../services/whatsapp/meta/MetaInboundWorkRepository');
  const { MetaInboundWorker } = await import('../services/whatsapp/meta/MetaInboundWorker');
  const { default: WhatsAppService } = await import('../services/whatsappService');
  const { StrictWhatsappRuntimeStore } = await import('../services/ai/runtime/StrictWhatsappRuntimeStore');
  const { IaPauseOverrideRepositoryPg } = await import('../modules/ai/infra/db/IaPauseOverrideRepositoryPg');
  const runtime = new WhatsAppService();
  const repository = new MetaInboundWorkRepository(pool,uow);
  const workerErrors: unknown[] = [];
  const worker = new MetaInboundWorker({ repository,
    execute: (work,authority) => runtime.processMetaInbound(work,authority),
    afterCompleted: (work,outcome) => runtime.publishMetaInboundOutcome(work,outcome),
    onError: error => workerErrors.push(error),
  });
  t.after(() => worker.stop());
  const strictStore = new StrictWhatsappRuntimeStore(uow);
  const pauses = new IaPauseOverrideRepositoryPg(pool);
  const source = `wamid.catalog-whatsapp-${randomUUID()}`;
  const workState = (tenant: Tenant,id: string) => uow.run(tenant.id,async db => (await db.query(`
    SELECT id,payload->>'messageId' AS message_id,payload->>'conversationId' AS conversation_id,status,payload->'outcome' AS outcome
    FROM processing_outbox WHERE tenant_id=$1 AND correlation_id=$2 AND event_type='whatsapp.inbound.received'`,[tenant.id,id])).rows[0]);
  const seed = async (tenant: Tenant,id: string,from: string) => {
    const result = await new MetaInboxStore({ db: pool,companyId: tenant.id }).persistInboundMessage({
      message: { id,from,timestamp: String(Math.floor(Date.now()/1000)),type: 'text',text: { body: `Find Visible ${tenant.name}` } },
      metadata: { phone_number_id: tenant.phoneId },contact: null,value: {},
    });
    assert.equal(result.duplicate,false);
    return workState(tenant,id);
  };
  const runFor = (tenant: Tenant,jobId: string) => uow.run(tenant.id,async db => (await db.query(`
    SELECT id,attempt_id,graph_version,state,ledger_id,output_encrypted FROM strict_whatsapp_runs
    WHERE tenant_id=$1 AND job_id=$2`,[tenant.id,jobId])).rows[0]);
  const cleanCompletion = async (tenant: Tenant,job: { id: string;message_id: string },expectedClaim = 'provider_accepted') => {
    const run = await runFor(tenant,job.id);
    const evidence = await uow.run(tenant.id,async db => {
      const parent = (await db.query(`SELECT id,strict_whatsapp_run_id,operation FROM catalog_router_runs
        WHERE tenant_id=$1 AND id=$2`,[tenant.id,run.id])).rows[0];
      const rounds = (await db.query(`SELECT round.slot,round.ledger_id,round.output_hash,round.output_encrypted,ledger.operation
        FROM catalog_router_rounds round JOIN ai_token_cost_ledger ledger ON ledger.tenant_id=round.tenant_id AND ledger.id=round.ledger_id
        WHERE round.tenant_id=$1 AND round.run_id=$2 ORDER BY round.slot`,[tenant.id,run.id])).rows;
      const tool = (await db.query('SELECT output_hash,output_encrypted FROM catalog_router_tool_checkpoints WHERE tenant_id=$1 AND run_id=$2',[tenant.id,run.id])).rows[0];
      const claims = (await db.query(`SELECT claim.state,message.id,message.body FROM conversation_send_claims claim
        JOIN messages message ON message.company_id=claim.tenant_id AND message.id=claim.message_id
        WHERE claim.tenant_id=$1 AND claim.inbound_message_id=$2`,[tenant.id,job.message_id])).rows;
      return { parent,rounds,tool,claims };
    });
    assert.deepEqual(evidence.parent,{ id: run.id,strict_whatsapp_run_id: run.id,operation: 'completion' });
    assert.equal(evidence.rounds.length,2);
    assert.ok(evidence.rounds.every(row => row.operation === 'completion' && row.output_encrypted === null && row.output_hash));
    assert.equal(Number(evidence.rounds.find(row => row.slot === 'answer')!.ledger_id),Number(run.ledger_id));
    assert.equal(evidence.tool.output_encrypted,null);
    assert.match(evidence.tool.output_hash,/^[0-9a-f]{64}$/);
    assert.equal(evidence.claims.length,1);
    assert.equal(evidence.claims[0].state,expectedClaim);
    assert.ok(evidence.claims[0].id && evidence.claims[0].body);
  };

  await t.test('real inbound work produces isolated reloadable catalog suggestions without Graph delivery',async () => {
    for (const tenant of tenants) {
      const before = providerRequests.length;
      await seed(tenant,`${source}-suggest`,'12025550201');
      assert.equal(await worker.processBatch(tenant.id),1);
      const job = await workState(tenant,`${source}-suggest`);
      assert.equal(job.status,'completed');
      assert.deepEqual(job.outcome,{ status: 'completed',code: 'AI_STRICT_SUGGESTION_READY' });
      assert.deepEqual(providerRequests.slice(before).map(({ name,slot }) => `${name}:${slot}`),[`${tenant.name}:router`,`${tenant.name}:answer`]);
      assert.equal(providerRequests[providerRequests.length - 1]!.prompt.endsWith(`Answer ${tenant.name}`),true,'The worker must execute v1, never silently follow v2');
      const own = await request(tenant,`/api/v1/ai/whatsapp-suggestions?conversationId=${job.conversation_id}`,'GET',undefined,'EMPLEADO');
      assert.equal(own.status,200);
      assert.equal(own.body.suggestion.reply,`Visible ${tenant.name} costs ${tenant.name === 'Alfa' ? 12 : 34} USD`);
      assert.equal(own.body.suggestion.version,1);
      assert.equal(own.body.suggestion.specHash,tenant.graph.specHash);
      assert.equal(own.body.suggestion.inboundMessageId,job.message_id);
      const other = tenants.find(candidate => candidate.id !== tenant.id)!;
      assert.deepEqual((await request(other,`/api/v1/ai/whatsapp-suggestions?conversationId=${job.conversation_id}`)).body,{ suggestion: null });
      const run = await runFor(tenant,job.id);
      assert.equal(run.graph_version,1);
      assert.equal(run.state,'ready');
      assert.match(run.output_encrypted,/^v1:/);
      assert.equal(run.output_encrypted.includes(own.body.suggestion.reply),false);
      const outbox = await uow.run(tenant.id,async db => (await db.query('SELECT payload::text FROM processing_outbox WHERE tenant_id=$1 AND id=$2',[tenant.id,job.id])).rows[0].payload);
      assert.equal(outbox.includes(own.body.suggestion.reply),false);
      assert.deepEqual(await new StrictWhatsappRuntimeStore(uow).getSuggestion(tenant.id,job.conversation_id),own.body.suggestion);
      assert.equal(await worker.processBatch(tenant.id),0);
      assert.equal(providerRequests.length,before+2);
    }
    assert.equal(graphSends.length,0);
  });

  for (const tenant of tenants) {
    const previous = (await request(tenant,'/api/v1/ai/whatsapp-binding')).body.binding;
    const automatic = await request(tenant,'/api/v1/ai/whatsapp-binding','PUT',{
      ...pins.get(tenant.id),mode: 'auto',expectedRevision: previous.revision,
    });
    assert.equal(automatic.status,200,JSON.stringify(automatic.body));
    assert.notEqual(automatic.body.binding.revision,previous.revision);
    await runtime.saveCompanyConnection(tenant.id,{ phoneNumberId: tenant.phoneId,
      accessToken: graphCredentials.get(tenant.phoneId),graphVersion: 'v25.0' });
  }

  await t.test('automatic catalog replies use the canonical tenant send claim exactly once',async () => {
    for (const tenant of tenants) {
      const before = providerRequests.length;
      const sendsBefore = graphSends.length;
      await seed(tenant,`${source}-auto`,'12025550202');
      assert.equal(await worker.processBatch(tenant.id),1);
      const job = await workState(tenant,`${source}-auto`);
      assert.equal(job.status,'completed');
      assert.equal(job.outcome.status,'completed');
      assert.equal(providerRequests.length,before+2);
      assert.equal(graphSends.length,sendsBefore+1);
      assert.deepEqual(graphSends[graphSends.length - 1],{ phoneId: tenant.phoneId,to: '12025550202',
        text: `Visible ${tenant.name} costs ${tenant.name === 'Alfa' ? 12 : 34} USD` });
      const run = await runFor(tenant,job.id);
      assert.equal(run.state,'completed');
      assert.equal(run.output_encrypted,null);
      await cleanCompletion(tenant,job);
      const { rows: claims } = await uow.run(tenant.id,db => db.query(`SELECT claim.state,claim.actor_type,message.body
        FROM conversation_send_claims claim JOIN messages message ON message.company_id=claim.tenant_id AND message.id=claim.message_id
        WHERE claim.tenant_id=$1 AND claim.inbound_message_id=$2`,[tenant.id,job.message_id]));
      assert.deepEqual(claims,[{ state: 'provider_accepted',actor_type: 'ai_agent',body: graphSends[graphSends.length - 1]!.text }]);
      assert.equal(await worker.processBatch(tenant.id),0);
      assert.equal(providerRequests.length,before+2);
      assert.equal(graphSends.length,sendsBefore+1);
    }
  });

  for (const [stage,from] of [['before','12025550210'],['after','12025550211'],['router','12025550215'],['snapshot','12025550216']] as const) {
    await t.test(`SIGKILL at ${stage} checkpoint resumes only unconfirmed work`,async context => {
      const tenant = tenants[0];
      const job = await seed(tenant,`${source}-crash-${stage}`,from);
      const before = providerRequests.length;
      const sendsBefore = graphSends.length;
      const child = fork(join(__dirname,'fixtures/catalogWhatsappCrashWorker.ts'),[providerUrl,String(tenant.id),stage],{
        execArgv: ['--import','tsx'],env: { ...process.env },stdio: ['ignore','ignore','ignore','ipc'],
      });
      context.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
      const stopped = await new Promise<{ checkpoint: string;runId: string }>((resolve,reject) => {
        const timer = setTimeout(() => reject(new Error('Child did not reach the committed checkpoint')),15000);
        child.once('error',error => { clearTimeout(timer); reject(error); });
        child.once('exit',() => { clearTimeout(timer); reject(new Error('Child exited before reaching the checkpoint')); });
        child.once('message',message => {
          clearTimeout(timer);
          const value = message as { checkpoint: string;runId: string;failed?: boolean };
          if (value.failed || value.checkpoint !== stage) reject(new Error('Child failed before the requested checkpoint'));
          else resolve(value);
        });
      });
      const beforeCrash = await runFor(tenant,job.id);
      assert.equal(beforeCrash.id,stopped.runId);
      assert.equal(beforeCrash.state,stage === 'after' ? 'ready' : 'prepared');
      const lifetimeBefore = await uow.run(tenant.id,async db => (await db.query(`
        SELECT created_at,deadline_at,expires_at FROM catalog_router_runs WHERE tenant_id=$1 AND id=$2`,[tenant.id,beforeCrash.id])).rows[0]);
      const rounds = await uow.run(tenant.id,async db => (await db.query(`
        SELECT round.slot,round.round_id,round.ledger_id,ledger.operation,run.strict_whatsapp_run_id
        FROM catalog_router_rounds round JOIN catalog_router_runs run ON run.tenant_id=round.tenant_id AND run.id=round.run_id
        JOIN ai_token_cost_ledger ledger ON ledger.tenant_id=round.tenant_id AND ledger.id=round.ledger_id
        WHERE round.tenant_id=$1 AND round.run_id=$2 ORDER BY round.slot`,[tenant.id,beforeCrash.id])).rows);
      const completeAnswer = stage === 'before' || stage === 'after';
      assert.equal(rounds.length,completeAnswer ? 2 : 1);
      assert.ok(rounds.every(row => row.operation === 'completion' && row.strict_whatsapp_run_id === beforeCrash.id));
      assert.equal(providerRequests.length,before+(completeAnswer ? 2 : 1));
      assert.equal(graphSends.length,sendsBefore);
      const exited = once(child,'exit');
      child.kill('SIGKILL');
      assert.deepEqual(await exited,[null,'SIGKILL']);
      const snapshotBefore = await uow.run(tenant.id,async db => (await db.query(`
        SELECT input_hash,output_hash,created_at FROM catalog_router_tool_checkpoints WHERE tenant_id=$1 AND run_id=$2`,[tenant.id,beforeCrash.id])).rows[0]);
      await uow.run(tenant.id,db => db.query(`UPDATE processing_outbox SET next_retry_at=clock_timestamp()-interval '1 second'
        WHERE tenant_id=$1 AND id=$2`,[tenant.id,job.id]));
      const selectsBefore = catalogSelects;
      assert.equal(await worker.processBatch(tenant.id),1,'Confirmed catalog progress must resume through the real outbox recovery');
      assert.equal(catalogSelects-selectsBefore,stage === 'router' ? 1 : 0,'A confirmed catalog SELECT must not be repeated');
      assert.equal((await workState(tenant,`${source}-crash-${stage}`)).outcome.status,'completed');
      const recovered = await runFor(tenant,job.id);
      assert.equal(recovered.id,beforeCrash.id);
      assert.equal(recovered.attempt_id,beforeCrash.attempt_id);
      assert.equal(recovered.state,'completed');
      const lifetimeAfter = await uow.run(tenant.id,async db => (await db.query(`
        SELECT created_at,deadline_at,expires_at FROM catalog_router_runs WHERE tenant_id=$1 AND id=$2`,[tenant.id,recovered.id])).rows[0]);
      assert.deepEqual(lifetimeAfter,lifetimeBefore,'Restart must preserve the original deadline and TTL');
      const after = await uow.run(tenant.id,async db => (await db.query(`
        SELECT round.slot,round.round_id,round.ledger_id,ledger.operation,run.strict_whatsapp_run_id
        FROM catalog_router_rounds round JOIN catalog_router_runs run ON run.tenant_id=round.tenant_id AND run.id=round.run_id
        JOIN ai_token_cost_ledger ledger ON ledger.tenant_id=round.tenant_id AND ledger.id=round.ledger_id
        WHERE round.tenant_id=$1 AND round.run_id=$2 ORDER BY round.slot`,[tenant.id,recovered.id])).rows);
      assert.equal(after.length,2);
      assert.deepEqual(after.filter(row => rounds.some(saved => saved.slot === row.slot)),rounds);
      if (snapshotBefore) {
        const snapshotAfter = await uow.run(tenant.id,async db => (await db.query(`
          SELECT input_hash,output_hash,created_at FROM catalog_router_tool_checkpoints WHERE tenant_id=$1 AND run_id=$2`,[tenant.id,recovered.id])).rows[0]);
        assert.deepEqual(snapshotAfter,snapshotBefore);
      }
      assert.equal(providerRequests.length,before+2);
      assert.equal(graphSends.length,sendsBefore+1);
      assert.equal(await worker.processBatch(tenant.id),0);
      await cleanCompletion(tenant,job);
    });
  }

  for (const [change,from] of [['pause','12025550203'],['human','12025550204'],['pause and resume','12025550205']] as const) {
    await t.test(`${change} during the answer prevents catalog auto delivery`,async () => {
      const tenant = tenants[0];
      const id = `${source}-${from}`;
      const job = await seed(tenant,id,from);
      const before = providerRequests.length;
      const sendsBefore = graphSends.length;
      intervention = { name: tenant.name,slot: 'answer',work: async () => {
        if (change === 'human') {
          await uow.run(tenant.id,db => db.query(`UPDATE conversations SET owner_type='human',owner_id='catalog-fixture-operator',
            ownership_epoch=ownership_epoch+1 WHERE company_id=$1 AND id=$2`,[tenant.id,job.conversation_id]));
        } else {
          await pauses.pause({ companyId: tenant.id,conversationId: Number(job.conversation_id) });
          if (change === 'pause and resume') await pauses.resume(tenant.id,Number(job.conversation_id));
        }
      } };
      assert.equal(await worker.processBatch(tenant.id),1);
      assert.equal((await workState(tenant,id)).outcome.status,'skipped');
      assert.equal(providerRequests.length,before+2);
      assert.equal(graphSends.length,sendsBefore);
      assert.equal(await strictStore.getSuggestion(tenant.id,job.conversation_id),null);
      assert.equal(await worker.processBatch(tenant.id),0);
    });
  }

  await t.test('a lost Graph acknowledgement remains visible and a fresh worker process never repeats the POST',async context => {
    const tenant = tenants[0];
    const id = `${source}-graph-unknown`;
    const job = await seed(tenant,id,'12025550212');
    const before = providerRequests.length;
    const sendsBefore = graphSends.length;
    dropGraphAck = true;
    assert.equal(await worker.processBatch(tenant.id),1);
    const unknown = await workState(tenant,id);
    assert.equal(unknown.status,'delivery_unknown');
    assert.deepEqual(unknown.outcome,{ status: 'uncertain',code: 'META_REPLY_DELIVERY_UNCONFIRMED' });
    assert.equal(graphSends.length,sendsBefore+1);
    await cleanCompletion(tenant,job,'unknown_delivery');
    const conversation = await request(tenant,`/api/v1/conversations/${job.conversation_id}`,'GET',undefined,'EMPLEADO');
    assert.equal(conversation.status,200);
    assert.equal(conversation.body.hasUnresolvedDelivery,true);
    const history = await request(tenant,`/api/v1/conversations/${job.conversation_id}/messages`,'GET',undefined,'EMPLEADO');
    assert.equal(history.status,200);
    const outbound = history.body.items.filter((item: { direction: string }) => item.direction === 'outbound');
    assert.equal(outbound.length,1);
    assert.equal(outbound[0].deliveryState,'unknown_delivery');
    const child = fork(join(__dirname,'fixtures/catalogWhatsappCrashWorker.ts'),[providerUrl,String(tenant.id),'once'],{
      execArgv: ['--import','tsx'],env: { ...process.env },stdio: ['ignore','ignore','ignore','ipc'],
    });
    context.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    const exited = once(child,'exit');
    const [message] = await once(child,'message',{ signal: AbortSignal.timeout(15000) });
    assert.deepEqual(message,{ processed: 0 });
    assert.deepEqual(await exited,[0,null]);
    assert.equal(providerRequests.length,before+2);
    assert.equal(graphSends.length,sendsBefore+1);
    assert.equal((await workState(tenant,id)).status,'delivery_unknown');
  });

  await t.test('a claimed answer with a lost model acknowledgement is never dispatched again after restart',async context => {
    const tenant = tenants[0];
    const id = `${source}-model-unknown`;
    const job = await seed(tenant,id,'12025550217');
    const before = providerRequests.length;
    const sendsBefore = graphSends.length;
    dropModelAck = tenant.name;
    assert.equal(await worker.processBatch(tenant.id),1);
    assert.deepEqual((await workState(tenant,id)).outcome,{ status: 'uncertain',code: 'AI_STRICT_MODEL_UNCONFIRMED' });
    const run = await runFor(tenant,job.id);
    const { rows } = await uow.run(tenant.id,db => db.query(`SELECT round.slot,round.state,reservation.status AS reservation_status,
      round.ledger_id,round.output_encrypted FROM catalog_router_rounds round JOIN ai_quota_reservations reservation
      ON reservation.tenant_id=round.tenant_id AND reservation.id=round.round_id
      WHERE round.tenant_id=$1 AND round.run_id=$2 ORDER BY round.slot`,[tenant.id,run.id]));
    const answer = rows.find(row => row.slot === 'answer');
    assert.deepEqual(answer,{ slot: 'answer',state: 'prepared',reservation_status: 'claimed',ledger_id: null,output_encrypted: null });
    assert.equal(rows.find(row => row.slot === 'router')?.state,'completed');
    const child = fork(join(__dirname,'fixtures/catalogWhatsappCrashWorker.ts'),[providerUrl,String(tenant.id),'once'],{
      execArgv: ['--import','tsx'],env: { ...process.env },stdio: ['ignore','ignore','ignore','ipc'],
    });
    context.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    const exited = once(child,'exit');
    const [message] = await once(child,'message',{ signal: AbortSignal.timeout(15000) });
    assert.deepEqual(message,{ processed: 0 });
    assert.deepEqual(await exited,[0,null]);
    assert.equal((await workState(tenant,id)).status,'delivery_unknown');
    assert.equal(providerRequests.length,before+2);
    assert.equal(graphSends.length,sendsBefore);
  });

  for (const [index,slot,kind,from] of [[0,'router','grant','12025550213'],[1,'answer','product','12025550214']] as const) {
    await t.test(`revoking ${kind} while ${slot} responds blocks further catalog delivery`,async () => {
      const tenant = tenants[index];
      const id = `${source}-revoke-${kind}`;
      const job = await seed(tenant,id,from);
      const before = providerRequests.length;
      const sendsBefore = graphSends.length;
      intervention = { name: tenant.name,slot,work: () => uow.run(tenant.id,async db => {
        if (kind === 'grant') await db.query("UPDATE agent_tool_grants SET is_enabled=false WHERE tenant_id=$1 AND agent_graph_id=$2 AND tool_name='catalog.search'",[tenant.id,tenant.graph.graphId]);
        else await db.query('UPDATE products SET ai_enabled=false WHERE company_id=$1 AND id=$2',[tenant.id,tenant.productId]);
      }) };
      assert.equal(await worker.processBatch(tenant.id),1);
      assert.equal((await workState(tenant,id)).outcome.status,'skipped');
      assert.equal(providerRequests.length,before+(slot === 'router' ? 1 : 2));
      assert.equal(graphSends.length,sendsBefore);
      assert.equal(await strictStore.getSuggestion(tenant.id,job.conversation_id),null);
      assert.equal(await worker.processBatch(tenant.id),0);
    });
  }

  await t.test('Studio accounting remains eval and runtime parents cannot cross company boundaries',async () => {
    for (const tenant of tenants) {
      const { rows: study } = await uow.run(tenant.id,db => db.query(`SELECT DISTINCT ledger.operation,run.operation AS run_operation
        FROM catalog_router_runs run JOIN catalog_router_rounds round ON round.tenant_id=run.tenant_id AND round.run_id=run.id
        JOIN ai_token_cost_ledger ledger ON ledger.tenant_id=round.tenant_id AND ledger.id=round.ledger_id
        WHERE run.tenant_id=$1 AND run.strict_whatsapp_run_id IS NULL`,[tenant.id]));
      assert.deepEqual(study,[{ operation: 'eval',run_operation: 'eval' }]);
      const { rows: [accounting] } = await uow.run(tenant.id,db => db.query(`SELECT q.current_month_tokens_used::text AS quota_tokens,
        q.current_month_cost_micro_usd::text AS quota_cost,(SELECT SUM(total_tokens)::text FROM ai_token_cost_ledger WHERE tenant_id=$1) AS ledger_tokens,
        (SELECT SUM(cost_micro_usd)::text FROM ai_token_cost_ledger WHERE tenant_id=$1) AS ledger_cost FROM tenant_ai_quotas q WHERE q.tenant_id=$1`,[tenant.id]));
      assert.equal(accounting.quota_tokens,accounting.ledger_tokens);
      assert.equal(accounting.quota_cost,accounting.ledger_cost);
    }
    const [a,b] = tenants;
    const job = await workState(a,`${source}-auto`);
    const run = await runFor(a,job.id);
    const origin = await uow.run(a.id,async db => (await db.query('SELECT * FROM catalog_router_runs WHERE tenant_id=$1 AND id=$2',[a.id,run.id])).rows[0]);
    await assert.rejects(uow.run(b.id,db => db.query(`INSERT INTO catalog_router_runs
      (tenant_id,id,graph_id,graph_version,spec_hash,input_hash,authorization_hash,max_tokens,max_cost_micro_usd,
       max_duration_seconds,created_at,deadline_at,expires_at,operation,strict_whatsapp_run_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'completion',$2)`,
    [b.id,run.id,b.graph.graphId,b.graph.version,b.graph.specHash,origin.input_hash,origin.authorization_hash,
      origin.max_tokens,origin.max_cost_micro_usd,origin.max_duration_seconds,origin.created_at,origin.deadline_at,origin.expires_at])),
    { code: '23503' });
  });
  await t.test('unavailable dispatch keeps catalog identity and allows revoking its historical binding with CAS',async () => {
    for (const [index,mode] of [[0,'paused'],[1,'legacy']] as const) {
      const tenant = tenants[index];
      const before = await request(tenant,'/api/v1/ai/whatsapp-binding','GET');
      assert.equal(before.status,200);
      assert.equal(before.body.binding.profile,'catalog-router-v1');
      await uow.run(tenant.id,db => db.query('UPDATE tenant_ai_dispatch_policies SET mode=$2 WHERE tenant_id=$1',[tenant.id,mode]));
      const state = await request(tenant,`/api/v1/agent-graphs/${tenant.graph.graphId}/execution?version=1`,'GET');
      assert.equal(state.status,200);
      assert.equal(state.body.mode,mode === 'paused' ? 'provider' : null);
      assert.equal(state.body.profile.name,'catalog-router-v1');
      assert.equal(state.body.profile.whatsappBindingAllowed,false);
      assert.ok(state.body.profile.minScenarioTimeoutMs > 0);
      assert.ok(state.body.profile.maxScenarioTimeoutMs > 0);
      assert.deepEqual((await request(tenant,'/api/v1/ai/whatsapp-binding','GET')).body,before.body);
      assert.equal((await request(tenant,'/api/v1/ai/whatsapp-binding','DELETE',{
        expectedRevision: before.body.binding.revision,
      })).status,204);
      assert.equal((await request(tenant,'/api/v1/ai/whatsapp-binding','GET')).body.binding,null);
    }
  });
  assert.deepEqual(workerErrors,[]);
  assert.deepEqual(transportErrors,[]);
  assert.deepEqual(apiErrors,[]);
});
