import './fixtures/testEnv';
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { computeAgentSpecHash, type AgentGraphVersionV1 } from '@whatsap-automat/contracts';
import { Pool } from 'pg';
import { TenantScopedUoW } from '../db/TenantScopedUoW';
import { AiQuotaCapacityError, AiQuotaReservationConflictError, AiQuotaReservationStore } from '../services/ai/gateway/AiQuotaReservationStore';
import { boundedTextCapability } from '../services/ai/gateway/BoundedTextCompletion';
import { dispatchBoundedText } from '../services/ai/gateway/BoundedTextDispatcher';
import { ModelGateway } from '../services/ai/gateway/ModelGateway';
import { QuotaManager } from '../services/ai/gateway/QuotaManager';
import { StrictModelGateway, type ModelGatewayAdmission } from '../services/ai/gateway/StrictModelGateway';
import { TokenCostLedger } from '../services/ai/gateway/TokenCostLedger';
import { OpenAiBoundedTextAdapter } from '../services/ai/gateway/adapters/OpenAiBoundedTextAdapter';
import { ByokService } from '../services/ai/gateway/byok/ByokService';
import type { ModelGatewayRequest } from '../services/ai/gateway/types';
import { BoundedAgentDispatch, preflightBoundedAgentDispatch } from '../services/ai/studio/BoundedAgentDispatch';
import { AgentExecutionEvaluator } from '../services/ai/studio/AgentExecutionEvaluator';
import { saveDraft } from '../services/ai/studio/AgentStudioDrafts';

const databaseUrl = process.env.AI_QUOTA_RESERVATIONS_TEST_DATABASE_URL;
const model = boundedTextCapability.model;

function revision(tenantId: number, options: {
  model?: string; provider?: string; version?: number; limits?: Partial<AgentGraphVersionV1['limits']>;
} = {}): AgentGraphVersionV1 {
  const graph: AgentGraphVersionV1 = {
    schemaVersion: 1, tenantId: String(tenantId), graphId: 'bounded-qa', version: options.version ?? 1,
    status: 'draft', specHash: '', entryNodeId: 'model', policyRef: 'qa-policy',
    nodes: [
      { id: 'model', kind: 'agent', config: { provider: options.provider ?? 'openai', model: options.model ?? model, prompt: 'Fixture prompt', maxTokens: 40 } },
      { id: 'end', kind: 'end', config: {} },
    ],
    edges: [{ id: 'finish', from: 'model', to: 'end' }],
    limits: {
      maxSteps: 2, maxDelegations: 0, maxParallelNodes: 1, maxDurationSeconds: 3,
      maxModelTokens: 400_040, maxCostMicroUsd: 300_180, ...options.limits,
    },
  };
  return { ...graph, specHash: computeAgentSpecHash(graph) };
}

test('dispatch preflight binds text, tenant and revision to explicit cost, token and timeout ceilings', () => {
  const command = { tenantId: 1, graph: revision(1), input: 'Fixture 🧪', timeoutMs: 1000 };
  const result = preflightBoundedAgentDispatch(command);
  assert.ok(result.ok);
  assert.equal(result.maxTokens, 400_040);
  assert.equal(result.maxCostMicroUsd, 300_180);
  assert.deepEqual(result.request, { system: 'Fixture prompt', input: command.input, maxCompletionTokens: 40 });
  assert.deepEqual(preflightBoundedAgentDispatch(command), result);
  for (const change of [{ input: 'otro' }, { timeoutMs: 999 }, { graph: revision(1, { version: 2 }) }]) {
    const changed = preflightBoundedAgentDispatch({ ...command, ...change });
    assert.ok(changed.ok);
    assert.notEqual(changed.requestHash, result.requestHash);
  }
  const invalid = [
    [{ tenantId: 2 }, 'REVISION_SCOPE'],
    [{ graph: { ...command.graph, specHash: 'incorrect' } }, 'REVISION_PROFILE'],
    [{ graph: revision(1, { provider: 'anthropic' }) }, 'MODEL_CAPABILITY'],
    [{ graph: revision(1, { model: 'gpt-5.4-mini' }) }, 'MODEL_CAPABILITY'],
    [{ input: '\uD800' }, 'TEXT_INPUT'],
    [{ input: 'x'.repeat(4097) }, 'TEXT_INPUT'],
    [{ graph: revision(1, { limits: { maxModelTokens: 400_039 } }) }, 'DISPATCH_BUDGET'],
    [{ graph: revision(1, { limits: { maxCostMicroUsd: 300_179 } }) }, 'DISPATCH_BUDGET'],
    [{ timeoutMs: 3001 }, 'DISPATCH_BUDGET'],
  ] as const;
  for (const [change, code] of invalid) {
    assert.deepEqual(preflightBoundedAgentDispatch({ ...command, ...change }), { ok: false, code });
  }
});

test('shared dispatcher fails closed if a caller underestimates the compiled bound', async () => {
  const plan = preflightBoundedAgentDispatch({ tenantId: 1, graph: revision(1), input: 'Fixture', timeoutMs: 1000 });
  assert.ok(plan.ok);
  const unexpected = async () => assert.fail('Admission must reject before storage or provider dispatch');
  assert.deepEqual(await dispatchBoundedText({ reserve: unexpected, claim: unexpected, settle: unexpected }, {
    capabilityId: boundedTextCapability.id, complete: unexpected,
  }, { tenantId: 1, attemptId: randomUUID(), operation: 'completion', plan: { ...plan, maxTokens: 1 },
    isByok: false, started: performance.now() }), { status: 'capability_unavailable' });
});

async function startFixture(t: TestContext) {
  const requests: Record<string, unknown>[] = [];
  let stalledBodyClosed = false;
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push(body);
      const input = body.messages[1].content;
      res.setHeader('Content-Type', 'application/json');
      if (input === 'stalled-body') {
        res.once('close', () => { stalledBodyClosed = true; });
        res.write('{');
        return;
      }
      if (input === 'http-503') {
        res.statusCode = 503;
        res.end('{}');
        return;
      }
      if (input === 'oversized') {
        res.end('x'.repeat(257 * 1024));
        return;
      }
      const promptTokens = 12;
      const completionTokens = input === 'overrun' ? 41 : Math.min(4, body.max_completion_tokens);
      const usage = {
        prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens,
        prompt_tokens_details: { cached_tokens: 2 }, completion_tokens_details: { reasoning_tokens: Math.min(3, completionTokens) },
      };
      res.end(JSON.stringify({
        model, service_tier: input === 'unexpected-tier' ? 'priority' : 'default',
        usage: input === 'missing-usage' ? undefined : input === 'invalid-usage' ? { ...usage, completion_tokens: '4' }
          : input === 'inconsistent-usage' ? { ...usage, total_tokens: 17 } : usage,
        choices: [{ finish_reason: input === 'unusable' ? 'content_filter' : 'stop', message: { role: 'assistant', content: 'Fixture output' } }],
      }));
    } catch {
      res.writeHead(500).end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const adapter = new OpenAiBoundedTextAdapter((url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).has('authorization'), false);
    return fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, init);
  });
  return { adapter, requests, stalledBodyClosed: () => stalledBodyClosed };
}

test('Studio execution evaluates stored revisions and suites with durable per-company evidence', {
  skip: !databaseUrl && 'AI_QUOTA_RESERVATIONS_TEST_DATABASE_URL is required',
}, async (t) => {
  const pool = new Pool({ connectionString: databaseUrl });
  t.after(() => pool.end());
  const uow = new TenantScopedUoW(pool);
  const tenantA = randomInt(500_000_000, 900_000_000);
  const tenantB = tenantA + 1;
  const setup = async (tenantId: number) => uow.run(tenantId, async (db) => {
    await db.query('INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)',
      [tenantId, 'Studio evaluation', 'studio-eval-' + randomUUID()]);
    await db.query('INSERT INTO tenant_ai_quotas (tenant_id, monthly_token_limit, monthly_cost_limit_micro_usd) VALUES ($1, $2, $3)',
      [tenantId, 10_000_000, 10_000_000]);
    const graph = revision(tenantId, { limits: { maxModelTokens: 800_080, maxCostMicroUsd: 600_360 } });
    const { entryNodeId, nodes, edges, policyRef, limits, graphId } = graph;
    return (await saveDraft(db, tenantId, 1, graphId, { entryNodeId, nodes, edges, policyRef, limits }, true))!;
  });
  const [graphA, graphB] = await Promise.all([setup(tenantA), setup(tenantB)]);
  const makeSuite = async (tenantId: number, graphId: string, entries: Array<[string, string]>) => {
    const id = randomUUID();
    const scenarios = entries.map(([mockInput, pattern], index) => ({
      id: 'scenario-' + index, name: 'Evaluation scenario ' + index, mockInput, expectedTextPatterns: [pattern],
    }));
    await uow.run(tenantId, (db) => db.query(
      'INSERT INTO agent_eval_suites (id, tenant_id, agent_graph_id, name, scenarios) VALUES ($1, $2, $3, $4, $5)',
      [id, tenantId, graphId, 'Stored regression suite', JSON.stringify(scenarios)],
    ));
    return id;
  };
  const [suiteA, suiteB] = await Promise.all([
    makeSuite(tenantA, graphA.graphId, [['First input', '^Fixture output$'], ['Second input', 'output$']]),
    makeSuite(tenantB, graphB.graphId, [['Tenant B input', '^Different answer$']]),
  ]);
  const { adapter, requests } = await startFixture(t);
  const dispatcher = new BoundedAgentDispatch(new AiQuotaReservationStore(uow), adapter, false);
  const entered = Promise.withResolvers<void>();
  const proceed = Promise.withResolvers<void>();
  const evaluator = new AgentExecutionEvaluator(uow, {
    dispatch: async (command) => {
      entered.resolve();
      await proceed.promise;
      return dispatcher.dispatch(command);
    },
  });
  const command = { tenantId: tenantA, graphId: graphA.graphId, version: 1, suiteId: suiteA, runId: randomUUID(), timeoutMs: 1000 };

  const running = evaluator.evaluate(command);
  try {
    await Promise.race([entered.promise, running.then(() => assert.fail('The execution never dispatched'))]);
    assert.equal((await evaluator.evaluate(command)).status, 'running');
    await assert.rejects(evaluator.evaluate({ ...command, tenantId: tenantB }), /not found in this tenant/);
    await assert.rejects(evaluator.evaluate({ ...command, tenantId: tenantB, suiteId: suiteB }), /already bound/);
    assert.equal(requests.length, 0);
  } finally {
    proceed.resolve();
  }
  const completed = await running;
  assert.equal(completed.status, 'completed');
  assert.equal(completed.passed, true);
  assert.equal(completed.specHash, graphA.specHash);
  assert.match(completed.suiteHash ?? '', /^[a-f0-9]{64}$/);
  assert.deepEqual(completed.scenarios.map((scenario) => scenario.outcome), ['passed', 'passed']);
  assert.deepEqual(await evaluator.evaluate(command), completed);
  assert.equal(requests.length, 2);
  const ledgerIds = completed.scenarios.map((scenario) => scenario.ledgerId);
  const usage = await uow.run(tenantA, (db) => db.query(
    "SELECT id FROM ai_token_cost_ledger WHERE tenant_id = $1 AND operation = 'eval' AND id = ANY($2::bigint[])",
    [tenantA, ledgerIds],
  ));
  assert.equal(usage.rows.length, 2);
  assert.equal((await uow.run(tenantB, (db) => db.query('SELECT id FROM agent_eval_runs WHERE id = $1', [command.runId]))).rows.length, 0);
  const { rows: [stored] } = await uow.run(tenantA, (db) => db.query(
    'SELECT scorecard, execution_spec_hash, execution_suite_hash FROM agent_eval_runs WHERE id = $1', [command.runId],
  ));
  assert.equal(stored.execution_spec_hash, completed.specHash);
  assert.equal(stored.execution_suite_hash, completed.suiteHash);
  assert.doesNotMatch(JSON.stringify(stored.scorecard), /Fixture output|First input|Second input/);

  const expiredId = randomUUID();
  await uow.run(tenantA, (db) => db.query(`
    INSERT INTO agent_eval_runs (id, tenant_id, suite_id, agent_graph_id, graph_version, status, scorecard,
      execution_spec_hash, execution_suite_hash, execution_deadline_at)
    VALUES ($1, $2, $3, $4, 1, 'running', $5, $6, $7, clock_timestamp() - interval '1 second')
  `, [expiredId, tenantA, suiteA, graphA.graphId, JSON.stringify({ timeoutMs: command.timeoutMs }),
    completed.specHash, completed.suiteHash]));
  assert.equal((await evaluator.evaluate({ ...command, runId: expiredId })).status, 'failed');
  assert.equal(requests.length, 2);
  await uow.run(tenantA, (db) => db.query('UPDATE agent_eval_suites SET name = $1 WHERE id = $2', ['Changed suite', suiteA]));
  await assert.rejects(evaluator.evaluate(command), /already bound/);
  assert.equal(requests.length, 2);

  const rejected = await evaluator.evaluate({ ...command, tenantId: tenantB, suiteId: suiteB, runId: randomUUID() });
  assert.equal(rejected.status, 'completed');
  assert.equal(rejected.passed, false);
  assert.deepEqual(rejected.scenarios.map((scenario) => scenario.outcome), ['assertion_failed']);
  assert.equal(requests.length, 3);

  const invalidSuite = await makeSuite(tenantA, graphA.graphId, [['Valid', 'output'], ['Invalid', '(']]);
  await assert.rejects(evaluator.evaluate({ ...command, suiteId: invalidSuite, runId: randomUUID() }), /Invalid or unsupported/);
  assert.equal(requests.length, 3);
  const oversizedSuite = await makeSuite(tenantA, graphA.graphId, [['First', 'output'], ['Second', 'output'], ['Third', 'output']]);
  await assert.rejects(evaluator.evaluate({ ...command, suiteId: oversizedSuite, runId: randomUUID() }), /full suite exceeds/);
  assert.equal(requests.length, 3);
  const uncertainSuite = await makeSuite(tenantA, graphA.graphId, [['http-503', 'output'], ['Never dispatch', 'output']]);
  const uncertainCommand = { ...command, suiteId: uncertainSuite, runId: randomUUID() };
  const uncertain = await evaluator.evaluate(uncertainCommand);
  assert.equal(uncertain.status, 'failed');
  assert.equal(uncertain.passed, false);
  assert.deepEqual(uncertain.scenarios.map((scenario) => scenario.outcome), ['uncertain']);
  assert.deepEqual(await evaluator.evaluate(uncertainCommand), uncertain);
  assert.equal(requests.length, 4);
});

test('bounded dispatch via a loopback provider fixture and real quota store', {
  skip: !databaseUrl && 'AI_QUOTA_RESERVATIONS_TEST_DATABASE_URL is required',
}, async (t) => {
  const pool = new Pool({ connectionString: databaseUrl });
  t.after(() => pool.end());
  const { rows: [role] } = await pool.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
  assert.deepEqual(role, { rolsuper: false, rolbypassrls: false });
  const uow = new TenantScopedUoW(pool);
  const ledger = new TokenCostLedger(uow);
  const quota = new AiQuotaReservationStore(uow);
  const tenantId = randomInt(500_000_000, 900_000_000);
  await uow.run(tenantId, (db) => db.query(
    'INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)', [tenantId, 'Bounded dispatch test', `bounded-${randomUUID()}`]
  ));
  const { adapter, requests, stalledBodyClosed } = await startFixture(t);
  const dispatcher = new BoundedAgentDispatch(quota, adapter, false);
  const command = (input: string) => ({ tenantId, graph: revision(tenantId), input, attemptId: randomUUID(), timeoutMs: 1000 });
  const reservation = (id: string) => uow.run(tenantId, async (db) => (await db.query(
    'SELECT status, ledger_id FROM ai_quota_reservations WHERE tenant_id = $1 AND id = $2', [tenantId, id]
  )).rows[0]);

  await t.test('rejects revision and tenant quota ceilings before any network call', async () => {
    const attempt = { ...command('over-budget'), graph: revision(tenantId, { limits: { maxModelTokens: 100 } }) };
    assert.deepEqual(await dispatcher.dispatch(attempt), { status: 'preflight_rejected', code: 'DISPATCH_BUDGET', publicationEvidence: false });
    assert.equal(await reservation(attempt.attemptId), undefined);
    const tenantLimit = (limit: number) => uow.run(tenantId, (db) => db.query(
      `INSERT INTO tenant_ai_quotas (tenant_id, monthly_token_limit) VALUES ($1, $2)
       ON CONFLICT (tenant_id) DO UPDATE SET monthly_token_limit = EXCLUDED.monthly_token_limit`, [tenantId, limit]
    ));
    await tenantLimit(400_039);
    const quotaAttempt = command('over-quota');
    await assert.rejects(dispatcher.dispatch(quotaAttempt), AiQuotaCapacityError);
    assert.equal(await reservation(quotaAttempt.attemptId), undefined);
    assert.deepEqual(requests, []);
    await tenantLimit(10_000_000);
  });

  await t.test('CAS sends once and settles token accounting without publication evidence', async () => {
    const attempt = command('normal');
    const results = await Promise.all([dispatcher.dispatch(attempt), dispatcher.dispatch(attempt)]);
    const completed = results.find((result) => result.status === 'completed');
    assert.ok(completed);
    assert.equal(completed.publicationEvidence, false);
    assert.equal(completed.costMicroUsd, 26);
    assert.deepEqual(completed.usage, { promptTokens: 12, completionTokens: 4, cachedTokens: 2 });
    assert.deepEqual(completed.output, { text: 'Fixture output', finishReason: 'stop' });
    assert.ok(results.some((result) => result.status === 'not_dispatched' && result.reason === 'claim_unavailable'));
    await assert.rejects(dispatcher.dispatch({ ...attempt, input: 'changed' }), AiQuotaReservationConflictError);
    assert.deepEqual(requests, [{
      model, messages: [{ role: 'system', content: 'Fixture prompt' }, { role: 'user', content: 'normal' }],
      n: 1, stream: false, store: false, modalities: ['text'], service_tier: 'default',
      reasoning_effort: 'none', max_completion_tokens: 40,
    }]);
    const { items } = await ledger.query(tenantId);
    assert.equal(items.length, 1);
    assert.equal(items[0].operation, 'eval');
    assert.equal(items[0].totalTokens, 16);
    assert.equal((await reservation(attempt.attemptId)).status, 'settled');
  });

  await t.test('missing or unverified provider usage holds quota and never retries', async () => {
    const initialCalls = requests.length;
    const inputs = ['missing-usage', 'invalid-usage', 'inconsistent-usage', 'unexpected-tier', 'http-503', 'oversized'];
    for (const input of inputs) {
      const attempt = command(input);
      assert.deepEqual(await dispatcher.dispatch(attempt), { status: 'uncertain', reason: 'provider_outcome', publicationEvidence: false });
      assert.deepEqual(await reservation(attempt.attemptId), { status: 'claimed', ledger_id: null });
      assert.equal((await dispatcher.dispatch(attempt)).status, 'not_dispatched');
    }
    assert.equal(requests.length, initialCalls + inputs.length);
    assert.equal((await ledger.query(tenantId)).items.length, 1);
  });

  await t.test('deadline includes body consumption and aborts its HTTP stream', async () => {
    const attempt = { ...command('stalled-body'), timeoutMs: 350 };
    const initialCalls = requests.length;
    const result = await dispatcher.dispatch(attempt);
    assert.deepEqual(result, { status: 'uncertain', reason: 'provider_outcome', publicationEvidence: false });
    for (let i = 0; i < 20 && !stalledBodyClosed(); i++) await delay(20);
    assert.equal(stalledBodyClosed(), true);
    assert.deepEqual(await reservation(attempt.attemptId), { status: 'claimed', ledger_id: null });
    assert.equal((await dispatcher.dispatch(attempt)).status, 'not_dispatched');
    assert.equal(requests.length, initialCalls + 1);
  });

  await t.test('known usage settles even if the output is unusable or exceeds a component cap', async () => {
    for (const [input, expectedStatus] of [['overrun', 'budget_exhausted'], ['unusable', 'output_unusable']]) {
      const attempt = command(input);
      const result = await dispatcher.dispatch(attempt);
      assert.equal(result.status, expectedStatus);
      assert.equal(result.publicationEvidence, false);
      assert.ok(!('output' in result));
      assert.equal((await reservation(attempt.attemptId)).status, 'settled');
    }
    const { items } = await ledger.query(tenantId);
    assert.deepEqual(items.map((entry) => entry.status), ['failed', 'budget_exhausted', 'success']);
    assert.deepEqual(items.map((entry) => entry.totalTokens), [16, 53, 16]);
  });
});

test('injected strict ModelGateway admission shares quota with eval and preserves legacy tenants', {
  skip: !databaseUrl && 'AI_QUOTA_RESERVATIONS_TEST_DATABASE_URL is required',
}, async (t) => {
  const pool = new Pool({ connectionString: databaseUrl });
  t.after(() => pool.end());
  const uow = new TenantScopedUoW(pool);
  const quota = new AiQuotaReservationStore(uow);
  const ledger = new TokenCostLedger(uow);
  const { adapter, requests } = await startFixture(t);
  const modes = new Map<number, 'legacy' | 'draining' | 'strict'>();
  const transportScopes: { tenantId: number; explicitKey: boolean }[] = [];
  const strict = new StrictModelGateway(quota, async ({ tenantId, probeApiKey }) => {
    transportScopes.push({ tenantId, explicitKey: probeApiKey !== undefined });
    return { adapter, isByok: true };
  });
  const admission: ModelGatewayAdmission = {
    modeForTenant: async (tenantId) => {
      const mode = modes.get(tenantId);
      if (!mode) throw new Error('synthetic policy lookup failure');
      return mode;
    },
    strict,
  };

  class FixtureByok extends ByokService {
    override async resolveDecryptedCredential() {
      return { apiKey: 'legacy-local-fixture-key', baseUrl: null, defaultModel: null, isByok: true };
    }
  }

  const legacyCalls: string[] = [];
  const byok = new FixtureByok();
  const gateway = new ModelGateway(byok, new QuotaManager(uow), ledger, async (url) => {
    legacyCalls.push(String(url));
    if (String(url).endsWith('/embeddings')) {
      return Response.json({ data: [{ index: 0, embedding: [0, 1] }], usage: { prompt_tokens: 2 } });
    }
    return Response.json({ choices: [{ message: { content: 'Legacy fixture' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 } });
  }, 'provider', admission);

  async function tenant(mode?: 'legacy' | 'draining' | 'strict', tokens = 10_000_000) {
    const tenantId = randomInt(500_000_000, 900_000_000);
    await uow.run(tenantId, async (db) => {
      await db.query('INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)', [tenantId, 'Gateway admission test', `admission-${randomUUID()}`]);
      await db.query('INSERT INTO tenant_ai_quotas (tenant_id, monthly_token_limit) VALUES ($1, $2)', [tenantId, tokens]);
    });
    if (mode) modes.set(tenantId, mode);
    return tenantId;
  }

  function completion(tenantId: number, input = 'normal'): ModelGatewayRequest {
    return {
      schemaVersion: 1, tenantId, provider: 'openai', model, maxTokens: 40, timeoutMs: 1000,
      messages: [{ role: 'system', content: 'Fixture prompt' }, { role: 'user', content: input }],
    };
  }

  await t.test('rejects unsupported complete, embed and connection profiles before transport resolution', async () => {
    const tenantId = await tenant('strict');
    for (const override of [{ model: 'gpt-5.4-mini' }, { maxTokens: undefined }, { temperature: 0.5 }, { workspaceId: 1 }]) {
      await assert.rejects(gateway.complete({ ...completion(tenantId), ...override }), { code: 'POLICY_DENIED' });
    }
    await assert.rejects(gateway.embed({ tenantId, input: ['text'] }), { code: 'POLICY_DENIED' });
    const synthetic = new ModelGateway(byok, new QuotaManager(uow), ledger, undefined, 'synthetic', admission);
    await assert.rejects(synthetic.embed({ tenantId, input: ['text'] }), { code: 'POLICY_DENIED' });
    assert.equal((await gateway.testConnection(tenantId, { provider: 'openai', baseUrl: 'https://example.invalid' })).ok, false);
    assert.equal((await gateway.testConnection(tenantId, { provider: 'anthropic' })).ok, false);
    assert.deepEqual(transportScopes, []);
    assert.deepEqual(requests, []);
    assert.deepEqual(legacyCalls, []);
  });

  await t.test('accounts strict completion and connection probe using the same ledger and limits', async () => {
    const tenantId = await tenant('strict');
    const result = await gateway.complete(completion(tenantId));
    assert.equal(result.text, 'Fixture output');
    assert.equal(result.costMicroUsd, 26);
    assert.deepEqual(result.usage, { promptTokens: 12, completionTokens: 4, totalTokens: 16 });
    assert.equal((await gateway.testConnection(tenantId, { provider: 'openai', apiKey: 'probe-fixture-only' })).ok, true);
    assert.equal(requests.at(-1)?.max_completion_tokens, 1);
    assert.deepEqual(transportScopes.slice(-2), [{ tenantId, explicitKey: false }, { tenantId, explicitKey: true }]);
    const { items } = await ledger.query(tenantId);
    assert.deepEqual(items.map((entry) => [entry.operation, entry.totalTokens, entry.costMicroUsd]),
      [['completion', 13, 13], ['completion', 16, 26]]);
    const noQuota = await tenant('strict', 400_000);
    const sent = requests.length;
    assert.equal((await gateway.testConnection(noQuota, { provider: 'openai' })).ok, false);
    assert.equal(requests.length, sent);
  });

  await t.test('ordinary and eval holds contend while a smaller ordinary attempt still fits after uncertainty', async () => {
    const tenantId = await tenant('strict', 800_060);
    const evaluation = new BoundedAgentDispatch(quota, adapter, true);
    const evalAttempt = { tenantId, graph: revision(tenantId), input: 'normal', attemptId: randomUUID(), timeoutMs: 1000 };
    const initialCalls = requests.length;
    await assert.rejects(gateway.complete(completion(tenantId, 'missing-usage')), { code: 'MODEL_OUTCOME_UNCONFIRMED' });
    await assert.rejects(evaluation.dispatch(evalAttempt), AiQuotaCapacityError);
    const smaller = await gateway.complete({ ...completion(tenantId), maxTokens: 1 });
    assert.equal(smaller.usage.completionTokens, 1);
    assert.equal(requests.length, initialCalls + 2);
    const rows = await uow.run(tenantId, (db) => db.query(
      'SELECT operation, status, max_tokens FROM ai_quota_reservations WHERE tenant_id = $1 ORDER BY created_at', [tenantId]
    ));
    assert.deepEqual(rows.rows, [
      { operation: 'completion', status: 'claimed', max_tokens: 400_040 },
      { operation: 'completion', status: 'settled', max_tokens: 400_001 },
    ]);

    const reverse = await tenant('strict', 800_060);
    const reverseEval = { ...evalAttempt, tenantId: reverse, graph: revision(reverse), input: 'missing-usage' };
    assert.equal((await evaluation.dispatch(reverseEval)).status, 'uncertain');
    await assert.rejects(gateway.complete(completion(reverse)), AiQuotaCapacityError);
    assert.equal(requests.length, initialCalls + 3);
  });

  await t.test('legacy operations remain available and draining or policy failure cannot fall back', async () => {
    const legacy = await tenant('legacy');
    const legacyRequest = { ...completion(legacy), model: 'gpt-4o-mini', messages: [{ role: 'user' as const, content: 'normal' }] };
    assert.equal((await gateway.complete(legacyRequest)).text, 'Legacy fixture');
    assert.deepEqual((await gateway.embed({ tenantId: legacy, input: ['normal'] })).embeddings, [[0, 1]]);
    assert.equal((await gateway.testConnection(legacy, { provider: 'openai' })).ok, true);
    assert.equal(legacyCalls.length, 3);

    const initialCalls = requests.length;
    for (const id of [await tenant('draining'), await tenant()]) {
      await assert.rejects(gateway.complete(completion(id)), { code: 'AI_ADMISSION_UNAVAILABLE' });
      await assert.rejects(gateway.embed({ tenantId: id, input: ['text'] }), { code: 'AI_ADMISSION_UNAVAILABLE' });
      assert.equal((await gateway.testConnection(id, { provider: 'openai' })).ok, false);
    }
    assert.equal(requests.length, initialCalls);
    assert.equal(legacyCalls.length, 3);
  });
});
