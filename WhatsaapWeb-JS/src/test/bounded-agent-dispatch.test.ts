import './fixtures/testEnv';
import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import { randomInt, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { computeAgentSpecHash, type AgentGraphVersionV1 } from '@whatsap-automat/contracts';
import express from 'express';
import { Pool } from 'pg';
import { TenantScopedUoW } from '../db/TenantScopedUoW';
import { AiQuotaCapacityError, AiQuotaReservationConflictError, AiQuotaReservationStore } from '../services/ai/gateway/AiQuotaReservationStore';
import { boundedTextCapability } from '../services/ai/gateway/BoundedTextCompletion';
import { dispatchBoundedText } from '../services/ai/gateway/BoundedTextDispatcher';
import { ModelGateway } from '../services/ai/gateway/ModelGateway';
import { createTenantBoundedModelExecution } from '../services/ai/gateway/TenantBoundedModelExecution';
import { TenantAiDispatchPolicy } from '../services/ai/gateway/TenantAiDispatchPolicy';
import { QuotaManager } from '../services/ai/gateway/QuotaManager';
import { StrictModelGateway, type ModelGatewayAdmission } from '../services/ai/gateway/StrictModelGateway';
import { TokenCostLedger } from '../services/ai/gateway/TokenCostLedger';
import { OpenAiBoundedTextAdapter } from '../services/ai/gateway/adapters/OpenAiBoundedTextAdapter';
import { ByokService } from '../services/ai/gateway/byok/ByokService';
import type { ModelGatewayRequest } from '../services/ai/gateway/types';
import { BoundedAgentDispatch, preflightBoundedAgentDispatch } from '../services/ai/studio/BoundedAgentDispatch';
import { AgentExecutionEvaluator } from '../services/ai/studio/AgentExecutionEvaluator';
import { executionAttemptId } from '../services/ai/studio/AgentExecutionEvidence';
import { AgentStudioPublications, dispatchPublishedAgent } from '../services/ai/studio/AgentStudioPublications';
import { saveDraft } from '../services/ai/studio/AgentStudioDrafts';
import { createStudioProviderAccess, createStudioVerification } from '../services/ai/studio/StudioVerification';
import createAiRoutes from '../routes/ai.routes';
import createAgentStudioRoutes from '../routes/agentStudioRoutes';

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

async function startFixture(t: TestContext, beforeResponse?: (input: string) => Promise<void>) {
  const requests: Record<string, unknown>[] = [];
  let stalledBodyClosed = false;
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push(body);
      const input = body.messages[1].content;
      if (beforeResponse) await beforeResponse(input);
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
  const endpoint = 'http://127.0.0.1:' + address.port + '/v1/chat/completions';
  const adapter = new OpenAiBoundedTextAdapter((url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).has('authorization'), false);
    return fetch(endpoint, init);
  });
  return { adapter, endpoint, requests, stalledBodyClosed: () => stalledBodyClosed };
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
  const { adapter, endpoint, requests } = await startFixture(t);
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
  const verification = new AgentStudioPublications('verification');
  const provider = new AgentStudioPublications('provider');
  const publicationCommand = { tenantId: tenantA, graphId: graphA.graphId, version: 1, actorId: 1, evaluationId: command.runId };

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
  await assert.rejects(uow.run(tenantA, (db) => verification.publish(db, publicationCommand)), /matching, completed/);
  await uow.run(tenantA, (db) => db.query('UPDATE agent_eval_suites SET name = $1 WHERE id = $2', ['Stored regression suite', suiteA]));
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

  await assert.rejects(uow.run(tenantB, (db) => verification.publish(db, {
    ...publicationCommand, tenantId: tenantB, graphId: graphB.graphId,
  })), /matching, completed/);
  await assert.rejects(uow.run(tenantA, (db) => verification.publish(db, {
    ...publicationCommand, evaluationId: uncertainCommand.runId,
  })), /matching, completed/);
  await assert.rejects(uow.run(tenantA, (db) => provider.publish(db, publicationCommand)), /matching, completed/);

  const copiedId = randomUUID();
  await uow.run(tenantA, (db) => db.query(`
    INSERT INTO agent_eval_runs (
      id, tenant_id, suite_id, agent_graph_id, graph_version, status, scorecard,
      execution_spec_hash, execution_suite_hash, execution_deadline_at, completed_at, passed, pass_rate_percent
    )
    SELECT $1, tenant_id, suite_id, agent_graph_id, graph_version, status, scorecard,
      execution_spec_hash, execution_suite_hash, execution_deadline_at, completed_at, passed, pass_rate_percent
    FROM agent_eval_runs WHERE tenant_id = $2 AND id = $3
  `, [copiedId, tenantA, command.runId]));
  await assert.rejects(uow.run(tenantA, (db) => verification.publish(db, {
    ...publicationCommand, evaluationId: copiedId,
  })), /matching, completed/);

  const publish = () => uow.run(tenantA, (db) => verification.publish(db, publicationCommand));
  const [published, replay] = await Promise.all([publish(), publish()]);
  assert.equal(published?.evaluationId, command.runId);
  assert.deepEqual(published, replay);
  assert.equal(await uow.run(tenantA, (db) => provider.loadActive(db, tenantA, graphA.graphId)), null);

  const { entryNodeId, nodes, edges, policyRef, limits } = graphA;
  const draft = await uow.run(tenantA, (db) => saveDraft(db, tenantA, 1, graphA.graphId, {
    entryNodeId, nodes, edges, policyRef, limits: { ...limits, maxCostMicroUsd: limits.maxCostMicroUsd - 1 },
  }, false));
  assert.equal(draft?.version, 2);
  assert.notEqual(draft?.specHash, graphA.specHash);
  await assert.rejects(uow.run(tenantA, (db) => verification.publish(db, {
    ...publicationCommand, version: 2,
  })), /matching, completed/);

  const executionCommand = { tenantId: tenantA, graphId: graphA.graphId, input: 'Live fixture', timeoutMs: 1000, attemptId: randomUUID() };
  assert.equal(await dispatchPublishedAgent(uow, verification, dispatcher, {
    ...executionCommand, tenantId: tenantB,
  }), null);
  assert.equal(requests.length, 4);
  const activeExecution = await dispatchPublishedAgent(uow, verification, dispatcher, executionCommand);
  assert.equal(activeExecution?.publication.version, 1);
  assert.equal(activeExecution?.publication.specHash, graphA.specHash);
  assert.equal(activeExecution?.execution.status, 'completed');
  assert.equal(requests.length, 5);
  const { rows: [reservation] } = await uow.run(tenantA, (db) => db.query(
    'SELECT operation, status FROM ai_quota_reservations WHERE tenant_id = $1 AND id = $2',
    [tenantA, executionCommand.attemptId],
  ));
  assert.deepEqual(reservation, { operation: 'completion', status: 'settled' });

  const app = express();
  app.use(express.json());
  app.use('/studio', createAgentStudioRoutes(uow, createStudioVerification(uow, adapter)));
  const http = app.listen(0, '127.0.0.1');
  await once(http, 'listening');
  t.after(() => new Promise<void>((resolve) => http.close(() => resolve())));
  const address = http.address();
  assert.ok(address && typeof address === 'object');
  const jwt = require('jsonwebtoken') as { sign(claims: object, key: string): string };
  async function api(path: string, tenantId: number, payload?: object, version = 2, rol = 'ADMIN') {
    const token = jwt.sign({ tenantId, userId: 1, rol }, process.env.JWT_SECRET!);
    const response = await fetch(`http://127.0.0.1:${address.port}/studio/${graphA.graphId}${path}?version=${version}`, {
      method: payload ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-tenant-id': String(tenantB) },
      body: payload ? JSON.stringify(payload) : undefined,
    });
    assert.equal(response.headers.get('cache-control'), rol === 'ADMIN' ? 'no-store' : null);
    return { status: response.status, body: await response.json() };
  }
  const suite = { id: randomUUID(), name: 'API suite', scenarios: [
    { id: 'fixture', name: 'Fixture', mockInput: 'Input from API', expectedTextPatterns: ['^Fixture output$'] },
  ] };
  assert.equal((await api('/evaluation-suites', tenantA, suite, 2, 'EMPLEADO')).status, 403);
  assert.equal((await api('/evaluation-suites', tenantA, { ...suite, tenantId: tenantB })).status, 422);
  const created = await api('/evaluation-suites', tenantA, suite);
  assert.equal(created.status, 200);
  assert.deepEqual(await api('/evaluation-suites', tenantA, suite), created);
  assert.equal((await api('/evaluation-suites', tenantA, { ...suite, id: randomUUID(), scenarios: [
    { ...suite.scenarios[0], expectedTextPatterns: ['('] },
  ] })).status, 422);
  assert.equal((await api('/evaluation-suites', tenantA, { ...suite, name: 'Conflicting name' })).status, 409);
  assert.equal((await api('/evaluation-suites', tenantB, suite, 1)).status, 409);
  const scopeA = await api('/execution', tenantA);
  assert.equal(scopeA.status, 200);
  assert.equal(scopeA.body.active.version, 1);
  assert.ok(scopeA.body.suites.some(({ id }: { id: string }) => id === suite.id));
  const scopeB = await api('/execution', tenantB, undefined, 1);
  assert.equal(scopeB.body.active, null);
  assert.ok(scopeB.body.suites.every(({ id }: { id: string }) => id !== suite.id));

  const input = { runId: randomUUID(), suiteId: suite.id, timeoutMs: 1000 };
  assert.equal((await api('/evaluations', tenantB, input, 1)).status, 422);
  assert.equal((await api('/evaluations', tenantA, input, 2, 'EMPLEADO')).status, 403);
  assert.equal((await api('/publish', tenantA, { evaluationId: input.runId, passed: true })).status, 422);
  assert.equal((await api('/publish', tenantA, { evaluationId: input.runId })).status, 409);
  assert.equal(requests.length, 5);
  const evaluated = await api('/evaluations', tenantA, input);
  assert.equal(evaluated.status, 200);
  assert.equal(evaluated.body.passed, true);
  assert.equal(evaluated.body.version, 2);
  assert.equal(evaluated.body.specHash, draft?.specHash);
  assert.deepEqual(await api('/evaluations', tenantA, input), evaluated);
  assert.deepEqual(await api(`/evaluations/${input.runId}`, tenantA), evaluated);
  assert.equal((await api(`/evaluations/${input.runId}`, tenantA, undefined, 1)).status, 404);
  assert.equal((await api(`/evaluations/${input.runId}`, tenantB, undefined, 1)).status, 404);
  assert.equal((await api('/publish', tenantB, { evaluationId: input.runId }, 1)).status, 409);
  const publication = await api('/publish', tenantA, { evaluationId: input.runId });
  assert.equal(publication.status, 200);
  assert.equal(publication.body.mode, 'verification');
  assert.equal(publication.body.specHash, draft?.specHash);
  const execute = { attemptId: randomUUID(), timeoutMs: 1000, input: 'Published text' };
  assert.equal((await api('/execute', tenantA, execute, 1)).status, 409);
  assert.equal((await api('/execute', tenantB, execute, 1)).status, 409);
  const execution = await api('/execute', tenantA, execute);
  assert.equal(execution.status, 200);
  assert.equal(execution.body.execution.output.text, 'Fixture output');
  assert.equal(execution.body.publication.version, 2);
  assert.equal(requests.length, 7);
  assert.equal(await uow.run(tenantA, (db) => provider.loadActive(db, tenantA, graphA.graphId)), null);

  await t.test('a completed scenario is visible while the next one is in flight', async () => {
    const suiteId = await makeSuite(tenantA, graphA.graphId, [['First checkpoint', 'output$'], ['Second checkpoint', 'output$']]);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const checkpointEvaluator = new AgentExecutionEvaluator(uow, {
      dispatch: async (dispatchCommand) => {
        if (dispatchCommand.input === 'Second checkpoint') {
          entered.resolve();
          await release.promise;
        }
        return dispatcher.dispatch(dispatchCommand);
      },
    });
    const runId = randomUUID();
    const evaluation = checkpointEvaluator.evaluate({ ...command, suiteId, runId });
    try {
      await Promise.race([entered.promise, evaluation.then(() => assert.fail('The second scenario did not start'))]);
      const current = await checkpointEvaluator.read(tenantA, graphA.graphId, 1, runId);
      assert.equal(current?.status, 'running');
      assert.deepEqual(current?.scenarios.map(({ outcome }) => outcome), ['passed']);
    } finally {
      release.resolve();
      await evaluation;
    }
  });

  await t.test('cancel only stops pending scenarios and preserves the admitted result', async () => {
    const suiteId = await makeSuite(tenantA, graphA.graphId, [['Admitted', 'output$'], ['Must not dispatch', 'output$']]);
    const settled = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const runner = new AgentExecutionEvaluator(uow, {
      dispatch: async (dispatchCommand) => {
        const result = await dispatcher.dispatch(dispatchCommand);
        settled.resolve();
        await release.promise;
        return result;
      },
    });
    const runId = randomUUID();
    const path = '/evaluations/' + runId + '/cancel';
    const requestCount = requests.length;
    const evaluation = runner.evaluate({ ...command, suiteId, runId });
    try {
      await Promise.race([settled.promise, evaluation.then(() => assert.fail('The first scenario did not settle'))]);
      const cancelled = await api(path, tenantA, {}, 1);
      assert.equal(cancelled.status, 200);
      assert.equal(cancelled.body.status, 'cancelled');
      assert.equal(cancelled.body.admittedScenarioId, 'scenario-0');
      assert.deepEqual(await api(path, tenantA, {}, 1), cancelled);
      assert.equal((await api(path, tenantB, {}, 1)).status, 404);
      assert.equal((await api(path, tenantA, {}, 2)).status, 404);
      assert.equal((await api(path, tenantA, {}, 1, 'EMPLEADO')).status, 403);
      assert.equal((await api(path, tenantA, { tenantId: tenantB }, 1)).status, 422);
    } finally {
      release.resolve();
      await evaluation;
    }
    const final = await evaluation;
    assert.equal(final.status, 'cancelled');
    assert.equal(final.admittedScenarioId, null);
    assert.deepEqual(final.scenarios.map(({ outcome }) => outcome), ['passed']);
    assert.deepEqual(await api('/evaluations', tenantA, { suiteId, runId, timeoutMs: 1000 }, 1), { status: 200, body: final });
    assert.equal((await api('/publish', tenantA, { evaluationId: runId }, 1)).status, 409);
    assert.deepEqual(await api('/evaluations/' + input.runId + '/cancel', tenantA, {}, 2), evaluated);
    assert.equal(requests.length, requestCount + 1);
  });

  await t.test('a killed worker leaves a checkpoint and an unreplayed reservation after expiry', async () => {
    const next = await uow.run(tenantA, (db) => saveDraft(db, tenantA, 1, graphA.graphId, {
      entryNodeId: graphA.entryNodeId, policyRef: graphA.policyRef, nodes: graphA.nodes, edges: graphA.edges,
      limits: { ...graphA.limits, maxDurationSeconds: 15 },
    }, false));
    assert.equal(next?.version, 3);
    const suiteId = await makeSuite(tenantA, graphA.graphId, [['Before crash', 'output$'], ['stalled-body', 'output$']]);
    const runId = randomUUID();
    const workerCommand = { ...command, suiteId, runId, version: 3, timeoutMs: 5000 };
    const requestCount = requests.length;
    const worker = spawn(process.execPath, ['--import', 'tsx', 'src/test/fixtures/studioCrashWorker.ts',
      endpoint, JSON.stringify(workerCommand)], { stdio: 'ignore' });
    const stopped = once(worker, 'exit');
    try {
      const timeout = AbortSignal.timeout(10_000);
      while (requests.length < requestCount + 2) {
        assert.equal(worker.exitCode, null, 'Worker exited before the second provider request');
        await delay(10, undefined, { signal: timeout });
      }
      assert.equal(worker.kill('SIGKILL'), true);
      assert.deepEqual(await stopped, [null, 'SIGKILL']);
    } finally {
      worker.kill('SIGKILL');
      await stopped;
    }

    const recovery = createStudioVerification(uow, adapter).evaluator;
    const partial = await recovery.read(tenantA, graphA.graphId, 3, runId);
    assert.equal(partial?.status, 'running');
    assert.equal(partial.admittedScenarioId, 'scenario-1');
    assert.deepEqual(partial.scenarios.map(({ outcome }) => outcome), ['passed']);
    // Move the fixture's deadline into the past without waiting for wall time.
    await uow.run(tenantA, (db) => db.query(
      "UPDATE agent_eval_runs SET execution_deadline_at = clock_timestamp() - interval '1ms' WHERE id = $1", [runId],
    ));
    const expired = await recovery.read(tenantA, graphA.graphId, 3, runId);
    assert.deepEqual(expired, { ...partial, status: 'failed' });
    assert.equal(await recovery.read(tenantB, graphA.graphId, 3, runId), null);
    assert.deepEqual(await recovery.evaluate(workerCommand), expired);
    assert.equal((await api('/publish', tenantA, { evaluationId: runId }, 3)).status, 409);
    const { rows } = await uow.run(tenantA, (db) => db.query(
      'SELECT id, status FROM ai_quota_reservations WHERE id = ANY($1::uuid[])',
      [['scenario-0', 'scenario-1'].map((scenarioId) => executionAttemptId(runId, scenarioId))],
    ));
    const statuses = new Map(rows.map(({ id, status }) => [id, status]));
    assert.equal(statuses.get(executionAttemptId(runId, 'scenario-0')), 'settled');
    assert.equal(statuses.get(executionAttemptId(runId, 'scenario-1')), 'claimed');
    assert.equal(requests.length, requestCount + 2);
  });
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

test('tenant provider admission fences legacy work and shares the authenticated API budget with Studio', {
  skip: !databaseUrl && 'AI_QUOTA_RESERVATIONS_TEST_DATABASE_URL is required',
}, async (t) => {
  const pool = new Pool({ connectionString: databaseUrl });
  t.after(() => pool.end());
  const uow = new TenantScopedUoW(pool);
  const otherPolicy = new TenantAiDispatchPolicy(new TenantScopedUoW(pool));
  const alpha = randomInt(500_000_000, 900_000_000);
  const bravo = alpha + 1;
  for (const id of [alpha, bravo]) {
    await uow.run(id, async (db) => {
      await db.query('INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)', [id, 'Bounded provider QA', 'qa-' + randomUUID()]);
      await db.query('INSERT INTO tenant_ai_quotas (tenant_id, monthly_token_limit, monthly_cost_limit_micro_usd) VALUES ($1, 400100, 301000)', [id]);
    });
  }

  const received = Promise.withResolvers<void>();
  const respond = Promise.withResolvers<void>();
  const { endpoint, requests } = await startFixture(t, async (input) => {
    if (input === 'Alfa en curso') {
      received.resolve();
      await respond.promise;
    }
  });
  const transportHeaders: Array<{ input: string; authorization: string | null }> = [];
  const execution = createTenantBoundedModelExecution(uow, (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/chat/completions');
    const headers = new Headers(init?.headers);
    const payload = JSON.parse(String(init?.body));
    transportHeaders.push({ input: payload.messages[1].content, authorization: headers.get('authorization') });
    return fetch(endpoint, init);
  });
  const gateway = new ModelGateway(undefined, undefined, undefined, undefined, undefined, execution.admission);
  const providerAccess = createStudioProviderAccess(uow, execution);
  const byok = new ByokService(undefined, uow);

  const enteredLegacy = Promise.withResolvers<void>();
  const finishLegacy = Promise.withResolvers<void>();
  class LegacyFixtureCredential extends ByokService {
    override async resolveDecryptedCredential() {
      return { apiKey: 'fixture-legacy', baseUrl: null, defaultModel: null, isByok: true };
    }
  }
  const legacyGateway = new ModelGateway(new LegacyFixtureCredential(), new QuotaManager(uow), new TokenCostLedger(uow), async () => {
    enteredLegacy.resolve();
    await finishLegacy.promise;
    return Response.json({ choices: [{ message: { content: 'Legacy fixture' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 } });
  }, 'provider', execution.admission);
  const legacy = legacyGateway.complete({
    schemaVersion: 1, tenantId: alpha, provider: 'openai', model: 'gpt-4o-mini', timeoutMs: 5000,
    messages: [{ role: 'user', content: 'Solicitud del perfil anterior' }],
  });
  try {
    await Promise.race([enteredLegacy.promise, legacy.then(() => assert.fail('Legacy dispatch ended before the cutover'))]);
    assert.equal(await otherPolicy.mode(bravo), 'legacy');
    assert.equal(await providerAccess(bravo), null);
    await otherPolicy.transition(alpha, 'draining');
    assert.equal(await providerAccess(alpha), null);
    await assert.rejects(execution.policy.withLegacyDispatch(alpha, async () => assert.fail('Draining admitted new legacy work')),
      { code: 'AI_ADMISSION_UNAVAILABLE' });
    await assert.rejects(otherPolicy.transition(alpha, 'strict'), { code: 'AI_LEGACY_DISPATCH_IN_FLIGHT' });
    assert.equal((await uow.run(bravo, (db) => db.query('SELECT * FROM tenant_ai_legacy_dispatches WHERE tenant_id = $1', [alpha]))).rowCount, 0);
  } finally {
    finishLegacy.resolve();
    assert.equal((await legacy).text, 'Legacy fixture');
  }
  await otherPolicy.transition(alpha, 'strict');
  await otherPolicy.transition(bravo, 'draining');
  await otherPolicy.transition(bravo, 'strict');

  const graph = revision(alpha, { limits: { maxDurationSeconds: 10 } });
  const { graphId, entryNodeId, nodes, edges, policyRef, limits } = graph;
  for (const id of [alpha, bravo]) {
    await uow.run(id, (db) => saveDraft(db, id, 1, graphId, { entryNodeId, nodes, edges, policyRef, limits }, true));
  }
  const suiteId = randomUUID();
  await uow.run(alpha, (db) => db.query(
    'INSERT INTO agent_eval_suites (id, tenant_id, agent_graph_id, name, scenarios) VALUES ($1, $2, $3, $4, $5)',
    [suiteId, alpha, graphId, 'Provider QA', JSON.stringify([{
      id: 'real-case', name: 'Provider scenario', mockInput: 'Evaluación Alfa', expectedTextPatterns: ['^Fixture output$'],
    }])],
  ));
  const app = express();
  app.use(express.json());
  app.use('/api/v1/ai', createAiRoutes({ gateway, byokService: byok }));
  app.use('/api/v1/agent-graphs', createAgentStudioRoutes(uow, undefined, providerAccess));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  }));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const jwt = require('jsonwebtoken') as { sign(claims: object, key: string): string };
  const request = async (tenantId: number, path: string, data?: object, rol = 'ADMIN') => {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1${path}`, {
      method: data ? 'POST' : 'GET',
      headers: { authorization: 'Bearer ' + jwt.sign({ companyId: tenantId, userId: 1, rol }, process.env.JWT_SECRET!),
        'content-type': 'application/json' },
      body: data ? JSON.stringify(data) : undefined,
    });
    return { status: response.status, body: await response.json() };
  };
  const post = (tenantId: number, path: string, data: object, rol?: string) => request(tenantId, '/ai' + path, data, rol);
  const studio = (tenantId: number, path: string, data?: object, rol?: string) =>
    request(tenantId, `/agent-graphs/${graphId}${path}?version=1`, data, rol);
  const complete = (tenantId: number, input: string) => post(tenantId, '/completions', {
    schemaVersion: 1, tenantId: tenantId === alpha ? bravo : alpha, provider: 'openai', model, maxTokens: 40, timeoutMs: 5000,
    messages: [{ role: 'system', content: 'Fixture prompt' }, { role: 'user', content: input }],
  });
  const fixtureKey = { provider: 'openai', apiKey: 'fixture-alpha' };
  for (const path of ['/providers', '/providers/test']) {
    const denied = await post(alpha, path, fixtureKey, 'EMPLEADO');
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error, 'ADMIN_REQUIRED');
  }
  assert.equal(requests.length, 0);
  assert.equal((await studio(alpha, '/execution', undefined, 'EMPLEADO')).status, 403);
  assert.equal((await studio(alpha, '/execution')).body.availability, 'credential_required');
  assert.equal((await studio(alpha, '/evaluations', { suiteId, runId: randomUUID(), timeoutMs: 1000 })).body.code,
    'STUDIO_PROVIDER_CREDENTIAL_REQUIRED');
  assert.equal((await post(alpha, '/providers', fixtureKey)).status, 200);
  assert.equal((await studio(alpha, '/execution')).body.availability, 'ready');

  const command = { suiteId, runId: randomUUID(), timeoutMs: 1000 };
  const ordinary = complete(alpha, 'Alfa en curso');
  try {
    await Promise.race([received.promise, ordinary.then(({ status, body }) => assert.fail(`Completion ended before the provider: ${status} ${body.error}`))]);
    const response = await studio(alpha, '/evaluations', command);
    assert.equal(response.status, 200);
    const blocked = response.body;
    assert.equal(blocked.mode, 'provider');
    assert.equal(blocked.status, 'failed');
    assert.deepEqual(blocked.scenarios.map(({ outcome }) => outcome), ['blocked']);
    assert.equal(requests.length, 1);
    const missing = await complete(bravo, 'Bravo sin credencial');
    assert.equal(missing.status, 422);
    assert.equal(missing.body.error, 'POLICY_DENIED');
    assert.equal((await post(bravo, '/providers', { provider: 'openai', apiKey: 'fixture-bravo' })).status, 200);
    assert.equal((await complete(bravo, 'Bravo independiente')).status, 200);
    assert.equal(requests.length, 2);
  } finally {
    respond.resolve();
    assert.equal((await ordinary).status, 200);
  }

  const evaluation = { ...command, runId: randomUUID() };
  const { status: evaluationStatus, body: evaluated } = await studio(alpha, '/evaluations', evaluation);
  assert.equal(evaluationStatus, 200);
  assert.equal(evaluated.passed, true);
  assert.deepEqual((await studio(alpha, '/evaluations', evaluation)).body, evaluated);
  assert.equal((await studio(bravo, '/evaluations/' + evaluation.runId)).status, 404);
  assert.equal((await studio(bravo, '/publish', { evaluationId: evaluation.runId })).status, 409);
  const publication = await studio(alpha, '/publish', { evaluationId: evaluation.runId });
  assert.equal(publication.status, 200);
  assert.equal(publication.body.mode, 'provider');
  assert.deepEqual((await studio(alpha, '/execution')).body.active, publication.body);
  assert.equal((await studio(bravo, '/execution')).body.active, null);
  assert.equal(await uow.run(alpha, (db) => new AgentStudioPublications('verification').loadActive(db, alpha, graphId)), null);
  const attempt = { attemptId: randomUUID(), input: 'Ejecución publicada Alfa', timeoutMs: 1000 };
  assert.equal((await studio(alpha, '/execute', attempt)).body.execution.status, 'completed');
  assert.equal((await studio(alpha, '/execute', attempt)).body.execution.status, 'not_dispatched');
  assert.equal((await studio(bravo, '/execute', attempt)).status, 409);
  assert.deepEqual(transportHeaders, [
    { input: 'Alfa en curso', authorization: 'Bearer fixture-alpha' },
    { input: 'Bravo independiente', authorization: 'Bearer fixture-bravo' },
    { input: 'Evaluación Alfa', authorization: 'Bearer fixture-alpha' },
    { input: 'Ejecución publicada Alfa', authorization: 'Bearer fixture-alpha' },
  ]);
  const ledger = new TokenCostLedger(uow);
  const usageA = await ledger.query(alpha);
  const usageB = await ledger.query(bravo);
  assert.deepEqual(usageA.items.map(({ operation, totalTokens }) => [operation, totalTokens]),
    [['completion', 16], ['eval', 16], ['completion', 16], ['completion', 9]]);
  assert.deepEqual(usageB.items.map(({ operation, totalTokens }) => [operation, totalTokens]), [['completion', 16]]);
  const reservation = {
    id: randomUUID(), requestHash: 'a'.repeat(64), operation: 'completion' as const, provider: 'openai', model,
    maxTokens: 400040, maxCostMicroUsd: 300180,
  };
  await execution.quota.reserve(alpha, reservation);
  await otherPolicy.transition(alpha, 'paused');
  assert.equal((await studio(alpha, '/execution')).body.availability, 'paused');
  assert.deepEqual((await studio(alpha, '/evaluations/' + evaluation.runId)).body, evaluated);
  assert.equal((await studio(alpha, '/execute', { ...attempt, attemptId: randomUUID() })).body.code, 'STUDIO_PROVIDER_PAUSED');
  await assert.rejects(execution.quota.claim(alpha, reservation.id, reservation.requestHash), { code: 'AI_ADMISSION_UNAVAILABLE' });
  assert.equal(await execution.quota.release(alpha, reservation.id, reservation.requestHash), true);
  assert.equal((await complete(alpha, 'Alfa en pausa')).status, 503);
  await assert.rejects(otherPolicy.transition(alpha, 'legacy'), { code: 'AI_ADMISSION_TRANSITION' });
  assert.equal(requests.length, 4);
});

test('a killed legacy dispatcher leaves a company cutover blocked for reconciliation', {
  skip: !databaseUrl && 'AI_QUOTA_RESERVATIONS_TEST_DATABASE_URL is required',
}, async (t) => {
  const pool = new Pool({ connectionString: databaseUrl });
  t.after(() => pool.end());
  const uow = new TenantScopedUoW(pool);
  const tenantId = randomInt(500_000_000, 900_000_000);
  await uow.run(tenantId, (db) => db.query(
    'INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)', [tenantId, 'AI legacy crash QA', 'qa-' + randomUUID()],
  ));
  const child = fork('src/test/fixtures/aiLegacyAdmissionWorker.ts', [String(tenantId)], {
    execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const stopped = once(child, 'exit');
  try {
    const [event] = await Promise.race([
      once(child, 'message', { signal: AbortSignal.timeout(8000) }),
      stopped.then(() => assert.fail('Legacy worker exited before committing its permit')),
    ]);
    assert.equal(event, 'legacy-admitted');
    assert.equal(child.kill('SIGKILL'), true);
    assert.deepEqual(await stopped, [null, 'SIGKILL']);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await stopped;
  }
  const policy = new TenantAiDispatchPolicy(uow);
  await policy.transition(tenantId, 'draining');
  await assert.rejects(policy.transition(tenantId, 'strict'), { code: 'AI_LEGACY_DISPATCH_IN_FLIGHT' });
  assert.equal(await policy.mode(tenantId), 'draining');
  const permit = await uow.run(tenantId, (db) => db.query(
    'SELECT id FROM tenant_ai_legacy_dispatches WHERE tenant_id = $1', [tenantId],
  ));
  assert.equal(permit.rowCount, 1);
});
