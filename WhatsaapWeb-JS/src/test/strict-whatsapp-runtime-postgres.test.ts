import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import type { Pool } from 'pg';

const databaseUrl = process.env.STRICT_AGENT_RUNTIME_TEST_DATABASE_URL;

test('strict WhatsApp executes pinned publications, recovers confirmed output and fences automatic sends', {
  skip: !databaseUrl && 'STRICT_AGENT_RUNTIME_TEST_DATABASE_URL must select a local _smoke database',
  timeout: 60_000,
}, async (t) => {
  const connection = new URL(databaseUrl!);
  assert.equal(connection.hostname, '127.0.0.1');
  assert.match(connection.pathname, /_smoke$/);
  const targets = new Map<string, number>();
  const requests: Array<{ company: string; kind: 'router' | 'tool' | 'final' | 'bounded' | 'strict'; prompt: string }> = [];
  const graphCredentials = new Map<string, string>();
  const graphSends: Array<{ phoneId: string; to: string; text: string; id: string }> = [];
  const fixtureErrors: unknown[] = [];
  let beforeStrictReply: (() => Promise<void>) | undefined;
  let dropStrictReply = false;
  const server = createServer(async (req, res) => {
    try {
      if (req.url?.startsWith('/v25.0/')) {
        const phoneId = req.url.split('/')[2].split('?')[0];
        assert.ok(graphCredentials.has(phoneId));
        assert.equal(req.headers.authorization, `Bearer ${graphCredentials.get(phoneId)}`);
        res.setHeader('Content-Type', 'application/json');
        if (req.method === 'GET') {
          assert.equal(req.url, `/v25.0/${phoneId}?fields=id`);
          res.end(JSON.stringify({ id: phoneId }));
          return;
        }
        assert.equal(req.method, 'POST');
        assert.equal(req.url, `/v25.0/${phoneId}/messages`);
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        assert.equal(body.type, 'text');
        assert.equal(body.messaging_product, 'whatsapp');
        const id = `wamid.strict-auto-${randomUUID()}`;
        graphSends.push({ phoneId, to: body.to, text: body.text.body, id });
        res.end(JSON.stringify({ messages: [{ id }] }));
        return;
      }
      assert.equal(req.method, 'POST');
      assert.equal(req.url, '/v1/chat/completions');
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const allText = body.messages.map((message: { content: string }) => message.content).join('\n');
      const company = allText.includes('Fixture Alfa') ? 'Alfa' : 'Bravo';
      const isBounded = body.messages[0].content === 'Bounded fixture probe';
      const isStrict = body.messages[0].content.startsWith('Published Fixture Alfa');
      const kind = isBounded ? 'bounded' : isStrict ? 'strict' : body.messages[0].content.includes('Eres el agente ROUTER') ? 'router'
        : body.messages.some((message: { role: string }) => message.role === 'tool') ? 'final' : 'tool';
      requests.push({ company, kind, prompt: body.messages[0].content });
      if (isStrict) {
        assert.equal(req.headers.authorization, 'Bearer fixture-alpha-provider');
        const hook = beforeStrictReply;
        beforeStrictReply = undefined;
        await hook?.();
        if (dropStrictReply) {
          dropStrictReply = false;
          req.socket.destroy();
          return;
        }
      }
      const content = kind === 'bounded' ? 'Ready'
        : kind === 'strict' ? `Respuesta publicada ${body.messages[0].content.endsWith('v2') ? 'v2' : 'v1'} Fixture Alfa`
          : JSON.stringify(kind === 'router'
          ? { route: 'customer_service', targetAgentId: targets.get(company), confidence: 1, reason: 'fixture', handoffReason: null }
          : kind === 'tool'
            ? { type: 'tool_request', toolCalls: [{ id: 'catalog-read', name: 'catalog.search', input: { q: 'fixture', limit: 1 } }] }
            : { type: 'final', reply: `Sugerencia Fixture ${company}`, action: 'suggest', confidence: 1, reason: 'fixture' });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        model: body.model, service_tier: 'default',
        usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16,
          prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 } },
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }],
      }));
    } catch (error) { fixtureErrors.push(error); res.writeHead(500).end(); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const providerUrl = `http://127.0.0.1:${address.port}`;

  // Configure before importing application modules. Every credential is synthetic;
  // the production provider implementation can reach only this loopback fixture.
  Object.assign(process.env, {
    NODE_ENV: 'test', DOTENV_CONFIG_PATH: '/dev/null', WHATSAPP_PROVIDER: 'meta-cloud', AI_PROVIDER: 'opencode',
    DB_HOST: connection.hostname, DB_PORT: connection.port || '5432', DB_NAME: connection.pathname.slice(1),
    DB_USER: decodeURIComponent(connection.username), DB_PASSWORD: decodeURIComponent(connection.password),
    JWT_SECRET: 'strict-runtime-fixture-jwt-secret-0000000000',
    META_TOKEN_ENCRYPTION_KEY: 'strict-runtime-fixture-cipher-0000000000000',
    META_APP_SECRET: 'strict-runtime-fixture-signature', META_WA_ACCESS_TOKEN: 'strict-runtime-fixture-meta-token',
    META_WA_PHONE_NUMBER_ID: '177000000000001', META_WABA_ID: '177000000000002',
    META_WEBHOOK_VERIFY_TOKEN: 'strict-runtime-fixture-verify', OPENAI_API_KEY: '',
    OPENCODE_API_URL: providerUrl, OPENCODE_API_KEY: '', OPENCODE_MODEL: 'fixture-local',
    OPENCODE_CHAT_PATH: '/v1/chat/completions',
  });
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === 'https://api.openai.com') {
      assert.equal(url.pathname, '/v1/chat/completions');
      assert.equal(init?.redirect, 'error');
      return nativeFetch(`${providerUrl}${url.pathname}`, init);
    }
    if (url.origin === 'https://graph.facebook.com') {
      return nativeFetch(`${providerUrl}${url.pathname}${url.search}`, init);
    }
    assert.equal(url.origin, providerUrl, 'The application must not contact an external provider');
    return nativeFetch(input, init);
  };
  t.after(() => { globalThis.fetch = nativeFetch; });
  const pool = require('../config/database') as Pool;
  t.after(() => pool.end());
  const { TenantScopedUoW } = await import('../db/TenantScopedUoW');
  const { AgentRepositoryPg } = await import('../modules/ai/infra/db/AgentRepositoryPg');
  const { IaPauseOverrideRepositoryPg } = await import('../modules/ai/infra/db/IaPauseOverrideRepositoryPg');
  const { MetaInboxStore } = await import('../services/whatsapp/meta/MetaInboxStore');
  const { MetaInboundWorkRepository } = await import('../services/whatsapp/meta/MetaInboundWorkRepository');
  const { MetaInboundWorker } = await import('../services/whatsapp/meta/MetaInboundWorker');
  const { default: WhatsAppService } = await import('../services/whatsappService');
  const { createTenantBoundedModelExecution } = await import('../services/ai/gateway/TenantBoundedModelExecution');
  const { ByokService } = await import('../services/ai/gateway/byok/ByokService');
  const { boundedTextCapability, boundedTextBudget } = await import('../services/ai/gateway/BoundedTextCompletion');
  const { saveDraft } = await import('../services/ai/studio/AgentStudioDrafts');
  const { createStudioProviderExecution } = await import('../services/ai/studio/StudioVerification');
  const { StrictWhatsappRuntimeStore } = await import('../services/ai/runtime/StrictWhatsappRuntimeStore');
  const uow = new TenantScopedUoW(pool);
  const { rows: [role] } = await pool.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
  assert.deepEqual(role, { rolsuper: false, rolbypassrls: false });
  const repo = new AgentRepositoryPg(pool);
  const pauses = new IaPauseOverrideRepositoryPg(pool);
  const alpha = randomInt(500_000_000, 600_000_000);
  const bravo = alpha + 1;
  for (const [companyId, name] of [[alpha, 'Alfa'], [bravo, 'Bravo']] as const) {
    await uow.run(companyId, async (db) => {
      await db.query('INSERT INTO companies (id, name) VALUES ($1, $2)', [companyId, `Fixture ${name}`]);
      await db.query('INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)', [companyId, `Fixture ${name}`, randomUUID()]);
      await db.query(`INSERT INTO tenant_ai_quotas (tenant_id, monthly_token_limit, monthly_cost_limit_micro_usd)
        VALUES ($1, 3000000, 3000000)`, [companyId]);
    });
    await repo.setAutomatorMode(companyId, 'mixed');
    await repo.create(companyId, null, { name: `Fixture router ${name}`, purpose: 'router', mode: 'suggest', status: 'active',
      provider: 'opencode', model: 'fixture-local' });
    const agent = await repo.create(companyId, null, { name: `Fixture agent ${name}`, purpose: 'customer_service',
      mode: 'suggest', status: 'active', provider: 'opencode', model: 'fixture-local',
      moduleAccess: { catalog: true }, toolAccess: { catalogSearch: true }, catalogScope: { catalogIds: [], sectionIds: [] },
      profile: { businessDescription: `Fixture ${name}` } });
    targets.set(name, agent.id);
  }
  const bounded = createTenantBoundedModelExecution(uow);
  const strictStore = new StrictWhatsappRuntimeStore(uow);
  const runtime = new WhatsAppService();
  const repository = new MetaInboundWorkRepository(pool, uow);
  const worker = new MetaInboundWorker({
    repository,
    execute: (work, authority) => runtime.processMetaInbound(work, authority),
    afterCompleted: (work, outcome) => runtime.publishMetaInboundOutcome(work, outcome),
    onError: () => assert.fail('Inbound worker failed before returning an outcome'),
  });
  t.after(() => worker.stop());

  async function seed(companyId: number, name: string, id: string, from = '12025550123') {
    const store = new MetaInboxStore({ db: pool, companyId });
    const persisted = await store.persistInboundMessage({
      message: { id, from, timestamp: String(Math.floor(Date.now() / 1000)),
        type: 'text', text: { body: `Consulta Fixture ${name}` } },
      metadata: { phone_number_id: String(177000000000000 + companyId) }, contact: null, value: {},
    });
    assert.equal(persisted.duplicate, false);
    return workState(companyId, id);
  }
  async function workState(companyId: number, id: string) {
    return uow.run(companyId, async (db) => (await db.query(`
      SELECT id, payload->>'messageId' AS message_id, payload->>'conversationId' AS conversation_id,
        status, payload->'outcome' AS outcome FROM processing_outbox
      WHERE tenant_id = $1 AND correlation_id = $2 AND event_type = 'whatsapp.inbound.received'
    `, [companyId, id])).rows[0]);
  }
  async function inbound(companyId: number, name: string, id: string, from?: string) {
    await seed(companyId, name, id, from);
    assert.equal(await worker.processBatch(companyId), 1);
    return workState(companyId, id);
  }
  const shared = `wamid.strict-fixture-${randomUUID()}`;
  assert.equal((await inbound(alpha, 'Alfa', `${shared}-before`)).outcome.status, 'completed');
  assert.equal((await inbound(bravo, 'Bravo', `${shared}-before`)).outcome.status, 'completed');
  assert.deepEqual(requests.map(({ company, kind }) => `${company}:${kind}`),
    ['Alfa:router', 'Alfa:tool', 'Alfa:final', 'Bravo:router', 'Bravo:tool', 'Bravo:final']);
  await new ByokService(undefined, uow).saveCredential(alpha, 'openai', 'fixture-alpha-provider');
  await bounded.policy.transition(alpha, 'draining');
  await bounded.policy.transition(alpha, 'strict');
  assert.equal((await bounded.admission.strict.complete(alpha, {
    schemaVersion: 1, tenantId: alpha, provider: 'openai', model: boundedTextCapability.model, maxTokens: 40, timeoutMs: 1000,
    messages: [{ role: 'system', content: 'Bounded fixture probe' }, { role: 'user', content: 'Fixture Alfa' }],
  })).text, 'Ready');
  const beforeStrict = requests.length;
  const alphaAfter = await inbound(alpha, 'Alfa', shared);
  assert.equal(requests.length, beforeStrict, 'strict WhatsApp must not fall back to the legacy provider');
  assert.equal(alphaAfter.status, 'completed');
  assert.deepEqual(alphaAfter.outcome, { status: 'skipped', code: 'AI_ADMISSION_UNAVAILABLE' });
  assert.equal((await inbound(bravo, 'Bravo', shared)).outcome.status, 'completed');
  assert.deepEqual(requests.slice(beforeStrict).map(({ company, kind }) => `${company}:${kind}`),
    ['Bravo:router', 'Bravo:tool', 'Bravo:final']);
  assert.equal(await worker.processBatch(alpha), 0, 'the skipped strict work is terminal, not resumable');
  const isolation = await uow.run(bravo, (db) => db.query('SELECT id FROM messages WHERE company_id = $1', [alpha]));
  assert.equal(isolation.rowCount, 0);
  const ledger = await uow.run(alpha, (db) => db.query(
    'SELECT operation FROM ai_token_cost_ledger WHERE tenant_id = $1', [alpha],
  ));
  assert.deepEqual(ledger.rows, [{ operation: 'completion' }]);
  const graphId = `strict-runtime-${randomUUID()}`;
  const studio = createStudioProviderExecution(uow, bounded);
  async function publish(version: number) {
    const budget = boundedTextBudget(40, 10000)!;
    const graph = await uow.run(alpha, (db) => saveDraft(db, alpha, 1, graphId, {
      entryNodeId: 'model', policyRef: 'strict-fixture',
      nodes: [
        { id: 'model', kind: 'agent', config: { provider: 'openai', model: boundedTextCapability.model,
          prompt: `Published Fixture Alfa v${version}`, maxTokens: 40 } },
        { id: 'end', kind: 'end', config: {} },
      ],
      edges: [{ id: 'finish', from: 'model', to: 'end' }],
      limits: { maxSteps: 2, maxDelegations: 0, maxParallelNodes: 1, maxDurationSeconds: 10,
        maxModelTokens: budget.maxTokens, maxCostMicroUsd: budget.maxCostMicroUsd },
    }, version === 1));
    assert.ok(graph);
    const suiteId = randomUUID();
    const runId = randomUUID();
    await uow.run(alpha, (db) => db.query(`
      INSERT INTO agent_eval_suites (id, tenant_id, agent_graph_id, name, scenarios) VALUES ($1,$2,$3,$4,$5)
    `, [suiteId, alpha, graphId, 'Production provider publication fixture', JSON.stringify([
      { id: 'case', name: 'Case', mockInput: 'Consulta Fixture Alfa',
        expectedTextPatterns: [`^Respuesta publicada v${version} Fixture Alfa$`] },
    ])]));
    const evaluation = await studio.evaluator.evaluate({ tenantId: alpha, graphId, version, suiteId, runId, timeoutMs: 10000 });
    assert.equal(evaluation.passed, true);
    assert.equal(evaluation.mode, 'provider');
    const publication = await uow.run(alpha, (db) => studio.publications.publish(db, {
      tenantId: alpha, actorId: 1, graphId, version, evaluationId: runId,
    }));
    assert.equal(publication?.specHash, graph.specHash);
    return graph;
  }
  const first = await publish(1);
  const bind = async (mode: 'suggest' | 'auto') => strictStore.bind(alpha, {
    actorId: 1, graphId, version: first.version, specHash: first.specHash, mode,
  }, (await strictStore.getBinding(alpha))?.revision ?? null);
  await bind('suggest');
  await publish(2);
  assert.equal((await strictStore.getBinding(alpha))?.version, 1);
  const runFor = (jobId: string) => uow.run(alpha, async (db) => (await db.query(`
    SELECT id, attempt_id, graph_version, state, ledger_id, output_encrypted FROM strict_whatsapp_runs
    WHERE tenant_id = $1 AND job_id = $2
  `, [alpha, jobId])).rows[0]);

  await t.test('a published pin produces a reloadable encrypted suggestion without sending to Graph', async () => {
    const before = requests.length;
    const job = await inbound(alpha, 'Alfa', `${shared}-suggest`);
    assert.equal(job.status, 'completed');
    assert.deepEqual(job.outcome, { status: 'completed', code: 'AI_STRICT_SUGGESTION_READY' });
    assert.deepEqual(requests.slice(before).map(({ kind, prompt }) => ({ kind, prompt })),
      [{ kind: 'strict', prompt: 'Published Fixture Alfa v1' }]);
    assert.equal(graphSends.length, 0);
    const suggestion = await strictStore.getSuggestion(alpha, job.conversation_id);
    assert.ok(suggestion);
    assert.equal(suggestion.reply, 'Respuesta publicada v1 Fixture Alfa');
    assert.equal(suggestion.version, 1);
    assert.equal(suggestion.specHash, first.specHash);
    assert.equal(suggestion.inboundMessageId, job.message_id);
    assert.equal(await strictStore.getSuggestion(bravo, job.conversation_id), null);
    const run = await runFor(job.id);
    assert.equal(run.state, 'ready');
    assert.match(run.output_encrypted, /^v1:/);
    assert.equal(run.output_encrypted.includes(suggestion.reply), false);
    const { rows: [storage] } = await uow.run(alpha, (db) => db.query(`
      SELECT row_to_json(ledger)::text AS ledger, work.payload::text AS outbox
      FROM ai_token_cost_ledger ledger JOIN processing_outbox work ON work.tenant_id = ledger.tenant_id
      WHERE ledger.tenant_id = $1 AND ledger.id = $2 AND work.id = $3
    `, [alpha, run.ledger_id, job.id]));
    assert.equal(storage.ledger.includes(suggestion.reply), false);
    assert.equal(storage.outbox.includes(suggestion.reply), false);
    assert.equal(await worker.processBatch(alpha), 0);
    assert.equal(requests.length, before + 1);
    assert.equal((await inbound(bravo, 'Bravo', `${shared}-after-suggestion`)).outcome.status, 'completed');
    assert.deepEqual(requests.slice(-3).map(({ company, kind }) => `${company}:${kind}`),
      ['Bravo:router', 'Bravo:tool', 'Bravo:final']);
  });

  await t.test('a crash after model settlement resumes the same pinned run and attempt without another model request', async () => {
    const id = `${shared}-recover`;
    const job = await seed(alpha, 'Alfa', id, '12025550124');
    const claim = await repository.claim(alpha, 30000);
    assert.ok(claim);
    assert.equal(claim.jobId, job.id);
    const work = await repository.load(claim);
    assert.equal(await repository.enterRuntime(claim, 30000), true);
    const before = requests.length;
    const outcome = await runtime.processMetaInbound(work, {
      signal: new AbortController().signal, isCurrent: (db) => repository.isCurrent(claim, db),
    });
    assert.deepEqual(outcome, { status: 'completed', code: 'AI_STRICT_SUGGESTION_READY' });
    const checkpoint = await runFor(job.id);
    assert.equal(checkpoint.state, 'ready');
    assert.equal(await strictStore.getSuggestion(alpha, job.conversation_id), null, 'No suggestion leaks before outbox completion');
    await uow.run(alpha, (db) => db.query(`UPDATE processing_outbox SET next_retry_at = clock_timestamp() - interval '1 second'
      WHERE tenant_id = $1 AND id = $2`, [alpha, job.id]));
    assert.equal(await worker.processBatch(alpha), 1);
    assert.equal((await workState(alpha, id)).outcome.code, 'AI_STRICT_SUGGESTION_READY');
    const recovered = await runFor(job.id);
    assert.equal(recovered.id, checkpoint.id);
    assert.equal(recovered.attempt_id, checkpoint.attempt_id);
    assert.equal(recovered.ledger_id, checkpoint.ledger_id);
    assert.equal((await strictStore.getSuggestion(alpha, job.conversation_id))?.reply, 'Respuesta publicada v1 Fixture Alfa');
    assert.equal(requests.length, before + 1);
    assert.equal(graphSends.length, 0);
  });

  await bind('auto');
  await repo.setAutomatorMode(alpha, 'automator');
  const phoneId = String(177000000000000 + alpha);
  graphCredentials.set(phoneId, 'fixture-alpha-graph-token');
  await runtime.saveCompanyConnection(alpha, { phoneNumberId: phoneId, accessToken: 'fixture-alpha-graph-token', graphVersion: 'v25.0' });
  await t.test('automatic mode uses the canonical tenant Graph send exactly once', async () => {
    const before = requests.length;
    const job = await inbound(alpha, 'Alfa', `${shared}-auto`, '12025550125');
    assert.equal(job.status, 'completed');
    assert.equal(job.outcome.status, 'completed');
    assert.equal(requests.length, before + 1);
    assert.equal(graphSends.length, 1);
    assert.deepEqual({ ...graphSends[0], id: undefined }, {
      phoneId, to: '12025550125', text: 'Respuesta publicada v1 Fixture Alfa', id: undefined,
    });
    const run = await runFor(job.id);
    assert.equal(run.state, 'completed');
    assert.equal(run.output_encrypted, null);
    const { rows: [sent] } = await uow.run(alpha, (db) => db.query(`
      SELECT claim.state, claim.actor_type, claim.inbound_message_id::text, message.body
      FROM conversation_send_claims claim JOIN messages message ON message.company_id = claim.tenant_id AND message.id = claim.message_id
      WHERE claim.tenant_id = $1 AND claim.inbound_message_id = $2
    `, [alpha, job.message_id]));
    assert.equal(sent.actor_type, 'ai_agent');
    assert.equal(sent.state, 'provider_accepted');
    assert.equal(sent.body, 'Respuesta publicada v1 Fixture Alfa');
    assert.equal(await worker.processBatch(alpha), 0);
    assert.equal(graphSends.length, 1);
  });

  for (const [intervention, sender] of [['pause', '12025550126'], ['human', '12025550127'],
    ['pause and resume', '12025550131']] as const) {
    await t.test(`${intervention} during the provider request prevents automatic delivery`, async () => {
      const id = `${shared}-${sender}`;
      const job = await seed(alpha, 'Alfa', id, sender);
      const before = requests.length;
      const sendsBefore = graphSends.length;
      beforeStrictReply = async () => {
        if (intervention === 'human') {
          await uow.run(alpha, (db) => db.query(`UPDATE conversations SET owner_type = 'human',
            owner_id = 'fixture-operator', ownership_epoch = ownership_epoch + 1
            WHERE company_id = $1 AND id = $2`, [alpha, job.conversation_id]));
          return;
        }
        const conversationId = Number(job.conversation_id);
        await pauses.pause({ companyId: alpha, conversationId });
        if (intervention === 'pause and resume') await pauses.resume(alpha, conversationId);
      };
      assert.equal(await worker.processBatch(alpha), 1);
      const result = await workState(alpha, id);
      assert.equal(result.status, 'completed');
      assert.equal(result.outcome.status, 'skipped');
      assert.equal(requests.length, before + 1);
      assert.equal(graphSends.length, sendsBefore);
      assert.equal(await strictStore.getSuggestion(alpha, job.conversation_id), null);
      assert.equal(await worker.processBatch(alpha), 0);
    });
  }

  await t.test('an unconfirmed provider response is terminal and never falls back or repeats the POST', async () => {
    const id = `${shared}-unknown`;
    const before = requests.length;
    const sendsBefore = graphSends.length;
    dropStrictReply = true;
    const job = await inbound(alpha, 'Alfa', id, '12025550128');
    assert.equal(job.status, 'delivery_unknown');
    assert.deepEqual(job.outcome, { status: 'uncertain', code: 'AI_STRICT_MODEL_UNCONFIRMED' });
    const run = await runFor(job.id);
    assert.equal(run.state, 'prepared');
    assert.equal(run.ledger_id, null);
    assert.equal(run.output_encrypted, null);
    assert.equal(requests.length, before + 1);
    assert.equal(await worker.processBatch(alpha), 0);
    assert.equal(requests.length, before + 1);
    assert.equal(graphSends.length, sendsBefore);
  });

  const { rows: [accounting] } = await uow.run(alpha, (db) => db.query(`
    SELECT q.current_month_tokens_used::text AS quota_tokens, q.current_month_cost_micro_usd::text AS quota_cost,
      (SELECT SUM(total_tokens)::text FROM ai_token_cost_ledger WHERE tenant_id = $1) AS ledger_tokens,
      (SELECT SUM(cost_micro_usd)::text FROM ai_token_cost_ledger WHERE tenant_id = $1) AS ledger_cost,
      (SELECT count(*)::int FROM ai_token_cost_ledger WHERE tenant_id = $1 AND operation = 'eval') AS evaluations,
      (SELECT count(*)::int FROM ai_token_cost_ledger WHERE tenant_id = $1 AND operation = 'completion') AS completions
    FROM tenant_ai_quotas q WHERE q.tenant_id = $1
  `, [alpha]));
  assert.equal(accounting.quota_tokens, accounting.ledger_tokens);
  assert.equal(accounting.quota_cost, accounting.ledger_cost);
  assert.equal(accounting.evaluations, 2);
  assert.equal(accounting.completions, 7);
  await t.test('a recovered older checkpoint cannot overtake a later active or completed turn', async () => {
    const from = '12025550129';
    const earlierId = `${shared}-earlier-recovery`;
    const laterId = `${shared}-later-active`;
    await repo.setAutomatorMode(alpha, 'mixed');
    const earlier = await seed(alpha, 'Alfa', earlierId, from);
    const earlierClaim = await repository.claim(alpha, 30000);
    assert.ok(earlierClaim);
    assert.equal(earlierClaim.jobId, earlier.id);
    const earlierWork = await repository.load(earlierClaim);
    assert.equal(await repository.enterRuntime(earlierClaim, 30000), true);
    assert.deepEqual(await runtime.processMetaInbound(earlierWork, {
      signal: new AbortController().signal, isCurrent: (db) => repository.isCurrent(earlierClaim, db),
    }), { status: 'completed', code: 'AI_STRICT_SUGGESTION_READY' });
    assert.equal((await runFor(earlier.id)).state, 'ready');
    // Model output is confirmed, but its worker outcome was lost. This is also
    // the recoverable state after a previously unknown request settles late.
    await uow.run(alpha, (db) => db.query(`UPDATE processing_outbox
      SET status = 'delivery_unknown', lease_token = NULL, next_retry_at = NULL
      WHERE tenant_id = $1 AND id = $2`, [alpha, earlier.id]));
    await repo.setAutomatorMode(alpha, 'automator');
    const later = await seed(alpha, 'Alfa', laterId, from);
    const laterClaim = await repository.claim(alpha, 30000);
    assert.ok(laterClaim);
    assert.equal(laterClaim.jobId, later.id);
    const laterWork = await repository.load(laterClaim);
    assert.equal(await repository.enterRuntime(laterClaim, 30000), true);
    assert.equal(await repository.isCurrent(laterClaim), true);
    await repository.recoverExpired(alpha);
    assert.equal((await workState(alpha, earlierId)).status, 'pending');
    assert.equal(await repository.claim(alpha, 30000), null,
      'An older recovered turn must not be claimed while a later turn in its conversation has a current lease');

    const beforeLater = requests.length;
    const sendsBeforeLater = graphSends.length;
    const laterOutcome = await runtime.processMetaInbound(laterWork, {
      signal: new AbortController().signal, isCurrent: (db) => repository.isCurrent(laterClaim, db),
    });
    assert.equal(laterOutcome.status, 'completed');
    assert.equal(await repository.finish(laterClaim, laterOutcome), true);
    await runtime.publishMetaInboundOutcome(laterWork, laterOutcome);
    assert.equal(requests.length, beforeLater + 1);
    assert.equal(graphSends.length, sendsBeforeLater + 1);
    assert.equal(await worker.processBatch(alpha), 1);
    assert.equal((await workState(alpha, earlierId)).outcome.status, 'skipped');
    assert.equal(await strictStore.getSuggestion(alpha, earlier.conversation_id), null);
    assert.equal(requests.length, beforeLater + 1, 'The recovered older turn must not dispatch another model request');
    assert.equal(graphSends.length, sendsBeforeLater + 1, 'The recovered older output must not be delivered after the later turn');
  });
  await t.test('an expired processing lease cannot block an older pending turn with a uniqueness error', async () => {
    const from = '12025550130';
    const earlier = await seed(alpha, 'Alfa', `${shared}-earlier-pending`, from);
    const earlierClaim = await repository.claim(alpha, 30000);
    assert.ok(earlierClaim);
    assert.equal(earlierClaim.jobId, earlier.id);
    await uow.run(alpha, (db) => db.query(`UPDATE processing_outbox
      SET status = 'delivery_unknown', lease_token = NULL, next_retry_at = NULL
      WHERE tenant_id = $1 AND id = $2`, [alpha, earlier.id]));
    const later = await seed(alpha, 'Alfa', `${shared}-later-expired-processing`, from);
    const laterClaim = await repository.claim(alpha, 30000);
    assert.ok(laterClaim);
    assert.equal(laterClaim.jobId, later.id);
    // The later worker crashed before enterRuntime. An older turn has meanwhile
    // become pending again; neither job needs a provider call to expose this race.
    await uow.run(alpha, async (db) => {
      await db.query(`UPDATE processing_outbox SET next_retry_at = clock_timestamp() - interval '1 second'
        WHERE tenant_id = $1 AND id = $2`, [alpha, later.id]);
      await db.query(`UPDATE processing_outbox SET status = 'pending'
        WHERE tenant_id = $1 AND id = $2`, [alpha, earlier.id]);
    });
    const before = requests.length;
    const sendsBefore = graphSends.length;
    await repository.recoverExpired(alpha);
    const progressed = new Set<string>();
    for (let index = 0; index < 2; index += 1) {
      const claim = await repository.claim(alpha, 30000);
      assert.ok(claim, 'Recovery must make one pending turn claimable without a uniqueness violation');
      assert.ok([earlier.id, later.id].includes(claim.jobId));
      progressed.add(claim.jobId);
      await repository.load(claim);
      assert.equal(await repository.enterRuntime(claim, 30000), true);
      assert.equal(await repository.finish(claim, { status: 'skipped', code: 'FIXTURE_NO_PROVIDER' }), true);
    }
    assert.equal(progressed.size, 2);
    assert.equal(await repository.enterRuntime(laterClaim, 30000), false, 'The expired lease cannot regain execution authority');
    assert.equal(requests.length, before);
    assert.equal(graphSends.length, sendsBefore);
  });
  assert.equal(requests.slice(beforeStrict).filter(({ company, kind }) => company === 'Alfa' && kind !== 'strict').length, 0);
  assert.equal((await uow.run(bravo, (db) => db.query('SELECT id FROM strict_whatsapp_runs WHERE tenant_id = $1', [alpha]))).rowCount, 0);
  assert.deepEqual(fixtureErrors, []);
  t.diagnostic('Provider and Graph transports stayed on loopback. Studio evaluations, strict completion and retries share durable quota accounting.');
});
