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
import { TokenCostLedger } from '../services/ai/gateway/TokenCostLedger';
import { OpenAiBoundedTextAdapter } from '../services/ai/gateway/adapters/OpenAiBoundedTextAdapter';
import { BoundedAgentDispatch, preflightBoundedAgentDispatch } from '../services/ai/studio/BoundedAgentDispatch';

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
      const completionTokens = input === 'overrun' ? 41 : 4;
      const usage = {
        prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens,
        prompt_tokens_details: { cached_tokens: 2 }, completion_tokens_details: { reasoning_tokens: 3 },
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
