import './fixtures/testEnv';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { randomInt, randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Client, Connection } from '@temporalio/client';
import express from 'express';
import { Pool } from 'pg';
import { WorkflowController } from '../controllers/WorkflowController';
import { TenantScopedUoW } from '../db/TenantScopedUoW';
import createWorkflowRoutes from '../routes/workflowRoutes';
import { OutboxRelayDaemon } from '../services/outbox/OutboxRelayDaemon';
import { OutboxRepository } from '../services/outbox/OutboxRepository';
import { TemporalClientFactory } from '../services/temporal/TemporalClientFactory';
import { WorkflowDispatchService } from '../services/workflows/WorkflowDispatchService';
import { WorkflowRevisionService } from '../services/workflows/WorkflowRevisionService';
import { WorkflowTriggerService } from '../services/workflows/WorkflowTriggerService';
import { validateWorkflowRevision } from '../services/workflows/validateWorkflowRevision';
import { evaluateCondition } from '../services/temporal/workflows/evaluateCondition';

const jwt = require('jsonwebtoken') as {
  sign(payload: Record<string, unknown>, secret: string, options: { expiresIn: string }): string;
};
const databaseUrl = process.env.WORKFLOW_TEST_DATABASE_URL;
const temporalAddress = process.env.WORKFLOW_TEST_TEMPORAL_ADDRESS;
const tenantA = randomInt(500_000_000, 900_000_000);
const tenantB = tenantA + 1;
const namespace = 'default';

const firstGraph = {
  nodes: [
    { id: 'start', kind: 'trigger' },
    { id: 'check', kind: 'condition', config: { expression: 'total > 10' } },
    { id: 'wait', kind: 'delay', config: { durationMs: 500 } },
    { id: 'end-high', kind: 'end' },
    { id: 'end-low', kind: 'end' },
  ],
  edges: [
    { id: 'start-check', source: 'start', target: 'check' },
    { id: 'check-wait', source: 'check', sourceHandle: 'true', target: 'wait' },
    { id: 'check-low', source: 'check', sourceHandle: 'false', target: 'end-low' },
    { id: 'wait-high', source: 'wait', target: 'end-high' },
  ],
};

function token(tenantId: number, role: string = 'ADMIN'): string {
  return jwt.sign({ userId: 81, companyId: tenantId, rol: role }, process.env.JWT_SECRET!, { expiresIn: '5m' });
}

async function until<T>(work: () => Promise<T | undefined>, message: string): Promise<T> {
  const deadline = Date.now() + 25_000;
  do {
    const value = await work();
    if (value !== undefined) return value;
    await delay(150);
  } while (Date.now() < deadline);
  throw new Error(message);
}

test('workflow graph validation rejects dead branches, malformed conditions and cycles', () => {
  assert.doesNotThrow(() => validateWorkflowRevision(firstGraph, {}));
  assert.throws(() => validateWorkflowRevision({
    ...firstGraph,
    nodes: [...firstGraph.nodes, { id: 'unused', kind: 'end' }],
  }, {}), /reachable/);
  assert.throws(() => validateWorkflowRevision({
    ...firstGraph,
    edges: firstGraph.edges.map((edge) => edge.id === 'wait-high' ? { ...edge, target: 'start' } : edge),
  }, {}), /cycles/);
  assert.throws(() => validateWorkflowRevision({
    ...firstGraph,
    nodes: firstGraph.nodes.map((node) => node.id === 'check' ? { ...node, config: { expression: 'total > 10 || true' } } : node),
  }, {}), /supported expression/);
  assert.equal(evaluateCondition('order.total > 10.5', { order: { total: 20 } }), true);
  assert.equal(evaluateCondition('active == false', { active: false }), true);
  assert.equal(evaluateCondition('inherited', Object.create({ inherited: true })), false);
});

describe('Durable workflow HTTP, PostgreSQL and Temporal integration', {
  skip: (!databaseUrl || !temporalAddress) && 'WORKFLOW_TEST_DATABASE_URL and WORKFLOW_TEST_TEMPORAL_ADDRESS are required',
}, () => {
  let pool: Pool;
  let tenantWork: TenantScopedUoW;

  before(async () => {
    assert.match(temporalAddress!, /^(127\.0\.0\.1|localhost):\d+$/);
    pool = new Pool({ connectionString: databaseUrl });
    tenantWork = new TenantScopedUoW(pool);
    const { rows: [role] } = await pool.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
    assert.deepEqual(role, { rolsuper: false, rolbypassrls: false });
    for (const tenantId of [tenantA, tenantB]) {
      await tenantWork.run(tenantId, (client) => client.query(
        'INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)',
        [tenantId, 'Workflow test company', `workflow-test-${randomUUID()}`]
      ));
    }
  });

  after(async () => {
    if (pool) await pool.end();
  });

  test('validates identity and revision pinning, resumes dispatch, and persists the real DAG result', { timeout: 90_000 }, async (t) => {
    const outbox = new OutboxRepository(tenantWork);
    const app = express();
    app.use(express.json());
    app.use('/api/v1/workflows', createWorkflowRoutes(new WorkflowController(
      new WorkflowTriggerService(pool, tenantWork, outbox),
      new WorkflowRevisionService(pool, tenantWork)
    )));
    const server = app.listen(0, '127.0.0.1');
    t.after(() => new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())));
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const baseUrl = `http://127.0.0.1:${address.port}/api/v1/workflows`;
    const adminA = token(tenantA);
    const adminB = token(tenantB);

    async function post(url: string, data: unknown, jwtToken?: string, headers: Record<string, string> = {}) {
      const response = await fetch(`${baseUrl}${url}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(jwtToken ? { authorization: `Bearer ${jwtToken}` } : {}),
          ...headers,
        },
        body: JSON.stringify(data),
      });
      return { status: response.status, headers: response.headers, body: await response.json() };
    }

    const createInput = { name: 'Validate and branch', dagGraph: firstGraph };
    assert.equal((await post('', createInput, token(tenantA, 'EMPLEADO'), { 'x-role': 'ADMIN' })).status, 403);
    assert.equal((await post('', { ...createInput, tenantId: tenantB }, adminA)).status, 403);
    const unsupportedGraph = {
      ...firstGraph,
      nodes: firstGraph.nodes.map((node) => node.id === 'wait' ? { id: 'wait', kind: 'activity' } : node),
    };
    assert.equal((await post('', { ...createInput, dagGraph: unsupportedGraph }, adminA)).status, 400);
    const created = await post('', createInput, adminA);
    assert.equal(created.status, 201);
    const { workflowId, revision: { id: revisionOne, specHash } } = created.body.data;
    assert.match(specHash, /^[a-f0-9]{64}$/);
    assert.equal((await post(`/${workflowId}/triggers/webhook`, {}, adminA)).status, 409);
    assert.equal((await post(`/${workflowId}/publish`, { revisionId: revisionOne }, adminB)).status, 404);
    assert.equal((await post(`/${workflowId}/publish`, { revisionId: revisionOne }, adminA)).status, 200);

    const firstTrigger = await post(`/${workflowId}/triggers/webhook`, {}, adminA);
    const secondTrigger = await post(`/${workflowId}/triggers/webhook`, {}, adminA);
    assert.equal(firstTrigger.status, 201);
    assert.equal(secondTrigger.status, 201);
    assert.equal(firstTrigger.headers.get('cache-control'), 'private, no-store');
    const { endpointKey, token: webhookToken } = firstTrigger.body.data;
    assert.equal((await pool.query('SELECT id FROM workflow_triggers')).rowCount, 0);
    assert.equal((await post(`/triggers/webhook/${endpointKey}`, { total: 20 }, 'wrong-token')).status, 401);
    const querySecret = await post(`/triggers/webhook/${endpointKey}?token=${webhookToken}`, { total: 20 });
    assert.equal(querySecret.status, 401);
    assert.doesNotMatch(JSON.stringify(querySecret.body), new RegExp(webhookToken));
    assert.equal((await post('/triggers/webhook/missing-endpoint', {}, webhookToken)).status, 404);
    assert.equal((await post(`/triggers/webhook/${encodeURIComponent("a'; DROP TABLE workflow_triggers;--")}`, {}, webhookToken)).status, 400);

    const key = { 'idempotency-key': 'shared-event-id' };
    const webhookPath = `/triggers/webhook/${endpointKey}`;
    const duplicates = await Promise.all(Array.from({ length: 16 }, (_, index) => post(
      webhookPath, index % 2 ? { total: 20, order: { b: 2, a: 1 }, id: 'body-id' }
        : { id: 'body-id', order: { a: 1, b: 2 }, total: 20 }, webhookToken, key
    )));
    assert.ok(duplicates.every((entry) => entry.status === 202 && entry.body.idempotencyKey === key['idempotency-key']));
    assert.equal(duplicates.filter((entry) => !entry.body.duplicate).length, 1);
    assert.equal(new Set(duplicates.map((entry) => entry.body.runId)).size, 1);
    const runId = duplicates[0].body.runId as string;
    const differentBody = await post(webhookPath, { total: 21 }, webhookToken, key);
    assert.equal(differentBody.status, 409);
    const otherWebhook = await post(
      `/triggers/webhook/${secondTrigger.body.data.endpointKey}`, { total: 4 }, secondTrigger.body.data.token, key
    );
    assert.equal(otherWebhook.status, 202);
    assert.notEqual(otherWebhook.body.runId, runId);
    const disable = await fetch(
      `${baseUrl}/${workflowId}/triggers/${secondTrigger.body.data.id}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${adminA}` },
        body: JSON.stringify({ isActive: false }),
      }
    );
    assert.equal(disable.status, 200);
    assert.equal((await disable.json()).data.isActive, false);
    assert.equal((await post(
      `/triggers/webhook/${secondTrigger.body.data.endpointKey}`, {}, secondTrigger.body.data.token
    )).status, 403);

    const versionTwo = await post(`/${workflowId}/revisions`, {
      dagGraph: {
        ...firstGraph,
        nodes: firstGraph.nodes.map((node) => node.id === 'check' ? { ...node, config: { expression: 'total > 1000' } } : node),
      },
    }, adminA);
    assert.equal(versionTwo.status, 201);
    const revisionTwo = versionTwo.body.data.id;
    assert.equal((await post(`/${workflowId}/rollback`, { targetRevisionId: revisionTwo, reason: 'Draft is not ready' }, adminA)).status, 404);
    assert.equal((await post(`/${workflowId}/publish`, { revisionId: revisionTwo }, adminA)).status, 200);
    const newRun = await post(webhookPath, { total: 20 }, webhookToken, { 'idempotency-key': 'next-event' });
    assert.equal(newRun.status, 202);
    assert.equal(newRun.body.revisionId, revisionTwo);
    assert.equal((await post(`/${workflowId}/rollback`, { targetRevisionId: revisionOne, reason: 'Restore original behavior' }, adminA)).status, 200);
    const forbiddenRun = await fetch(`${baseUrl}/runs/${runId}`, { headers: { authorization: `Bearer ${adminB}` } });
    assert.equal(forbiddenRun.status, 404);

    const { rows: pending } = await tenantWork.run(tenantA, (client) => client.query(
      "SELECT id, payload->>'runId' AS run_id FROM processing_outbox WHERE tenant_id = $1 ORDER BY created_at, id",
      [tenantA]
    ));
    assert.equal(pending.length, 3);
    const outboxId = pending.find((row) => row.run_id === runId).id;
    const outageClient = new TemporalClientFactory();
    const dispatch = new WorkflowDispatchService(pool, tenantWork);
    const relay = new OutboxRelayDaemon({
      outboxRepo: outbox,
      batchSize: 1,
      workflowDispatch: dispatch,
      temporalClientProvider: () => outageClient.getClient({ address: '127.0.0.1:1', connectTimeoutMs: 100 }),
      baseBackoffMs: 250,
      leaseMs: 1000,
    });
    assert.equal(await relay.processBatch(tenantA), 1);
    const failedAttempt = await outbox.findById(tenantA, outboxId);
    assert.equal(failedAttempt?.status, 'delivery_unknown');
    assert.equal(failedAttempt?.retry_count, 1);
    const reclaimed = await outbox.claimWorkflowDispatch(tenantA, 1, 100);
    assert.ok(reclaimed[0]?.lease_token);

    const url = new URL(databaseUrl!);
    const worker = spawn(process.execPath, [path.resolve('dist/services/temporal/automationWorker.js')], {
      env: {
        ...process.env,
        NODE_ENV: 'test',
        WHATSAPP_PROVIDER: 'webjs',
        DB_HOST: url.hostname,
        DB_PORT: url.port || '5432',
        DB_NAME: url.pathname.slice(1),
        DB_USER: decodeURIComponent(url.username),
        DB_PASSWORD: decodeURIComponent(url.password),
        TEMPORAL_ADDRESS: temporalAddress!,
        TEMPORAL_NAMESPACE: namespace,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let workerLog = '';
    worker.stdout.on('data', (chunk) => { workerLog = (workerLog + String(chunk)).slice(-12_000); });
    worker.stderr.on('data', (chunk) => { workerLog = (workerLog + String(chunk)).slice(-12_000); });
    t.after(async () => {
      if (worker.exitCode !== null || worker.signalCode !== null) return;
      const exited = once(worker, 'exit');
      worker.kill('SIGTERM');
      const forceStop = setTimeout(() => worker.kill('SIGKILL'), 6000);
      try { await exited; } finally { clearTimeout(forceStop); }
    });

    async function completed(id: string) {
      return until(async () => {
        if (worker.exitCode !== null) throw new Error(`Compiled Temporal worker exited before completion:\n${workerLog}`);
        const response = await fetch(`${baseUrl}/runs/${id}`, { headers: { authorization: `Bearer ${adminA}` } });
        assert.equal(response.status, 200);
        const { data } = await response.json();
        if (data.status === 'failed') throw new Error(`Workflow failed: ${JSON.stringify(data.errorDetails)}\n${workerLog}`);
        return data.status === 'completed' ? data : undefined;
      }, `Workflow ${id} did not complete:\n${workerLog}`);
    }

    const completedFirst = await completed(runId);
    const completedSecond = await completed(otherWebhook.body.runId);
    const completedNew = await completed(newRun.body.runId);
    assert.equal(completedFirst.revisionId, revisionOne);
    assert.equal(completedFirst.outputPayload.check_condition, true);
    assert.equal(completedFirst.stepCount, 3);
    assert.ok(completedFirst.temporalRunId);
    assert.ok(completedFirst.completedAt);
    assert.equal(completedSecond.outputPayload.check_condition, false);
    assert.equal(completedNew.revisionId, revisionTwo);
    assert.equal(completedNew.outputPayload.check_condition, false);
    await assert.rejects(tenantWork.run(tenantA, (client) => client.query(`
      UPDATE workflow_runs SET revision_id = $1 WHERE id = $2
    `, [revisionTwo, runId])), { code: '23514' });
    await assert.rejects(tenantWork.run(tenantA, (client) => client.query(`
      UPDATE workflow_revisions SET dag_graph = '{}'::jsonb WHERE id = $1
    `, [revisionOne])), { code: '23514' });
    const staleLease = await outbox.markStatus(tenantA, reclaimed[0].id, 'dead_letter', { leaseToken: reclaimed[0].lease_token });
    assert.equal(staleLease, null);

    // A relay can lose its acknowledgement after Temporal has already completed.
    await tenantWork.run(tenantA, (client) => client.query(`
      UPDATE processing_outbox SET status = 'processing', next_retry_at = NOW(), lease_token = gen_random_uuid()
      WHERE id = $1
    `, [outboxId]));
    await until(async () => {
      const recovered = await outbox.findById(tenantA, outboxId);
      return recovered?.status === 'dispatched' ? recovered : undefined;
    }, 'Relay did not reconcile the already completed Temporal execution.');
    const connection = await Connection.connect({ address: temporalAddress });
    try {
      const temporal = new Client({ connection, namespace });
      const latest = await temporal.workflow.getHandle(completedFirst.temporalWorkflowId).describe();
      assert.equal(latest.runId, completedFirst.temporalRunId);
      const result = await temporal.workflow.getHandle(completedFirst.temporalWorkflowId, completedFirst.temporalRunId).result();
      assert.equal(result.status, 'completed');
      assert.ok(result.historyTrace.some((event: { nodeId: string; status: string }) =>
        event.nodeId === 'wait' && event.status === 'node_started_delay'
      ));
    } finally {
      await connection.close();
    }
  });

  test('concurrent ingress pins a real published revision while another transaction rolls back', async () => {
    const revisions = new WorkflowRevisionService(pool, tenantWork);
    const ingress = new WorkflowTriggerService(pool, tenantWork);
    const workflow = await revisions.createWorkflow(tenantB, { name: 'Concurrent revision snapshot', dagGraph: firstGraph });
    const first = workflow.revision.id;
    await revisions.publishRevision(tenantB, workflow.workflowId, first);
    const second = (await revisions.createRevision(tenantB, workflow.workflowId, firstGraph, {})).id;
    await revisions.publishRevision(tenantB, workflow.workflowId, second);
    const trigger = await revisions.createWebhookTrigger(tenantB, workflow.workflowId);
    const inFlight = await ingress.processInboundWebhook(trigger.endpointKey, trigger.token, {}, { id: 'pinned-before-rollback' });
    assert.equal(inFlight.revisionId, second);

    const submit = (id: string) => ingress.processInboundWebhook(trigger.endpointKey, trigger.token, {}, { id });
    await Promise.all([
      ...Array.from({ length: 20 }, (_, index) => submit(`before-${index}`)),
      revisions.rollbackRevision(tenantB, workflow.workflowId, { targetRevisionId: first, reason: 'Concurrent rollback check' }),
      ...Array.from({ length: 20 }, (_, index) => submit(`after-${index}`)),
    ]);
    const next = await submit('pinned-after-rollback');
    assert.equal(next.revisionId, first);
    const { rows } = await tenantWork.run(tenantB, (client) => client.query(`
      SELECT id, revision_id FROM workflow_runs WHERE workflow_id = $1
    `, [workflow.workflowId]));
    assert.equal(rows.length, 42);
    assert.equal(rows.find((row) => row.id === inFlight.runId)?.revision_id, second);
    assert.ok(rows.every((row) => row.revision_id === first || row.revision_id === second));
    assert.equal(await revisions.getRun(tenantA, inFlight.runId), null);
  });
});
