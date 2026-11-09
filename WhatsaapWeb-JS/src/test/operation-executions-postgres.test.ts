import './fixtures/testEnv';
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { test, type TestContext } from 'node:test';
import express from 'express';
import { Pool } from 'pg';
import { TenantScopedUoW } from '../db/TenantScopedUoW';
import createOperationExecutionRoutes from '../routes/operationExecutionRoutes';
import { OutboxRepository } from '../services/outbox/OutboxRepository';
import { OperationExecutionService } from '../services/workflows/OperationExecutionService';
import { WORKFLOW_WEBHOOK_EVENT } from '../services/workflows/WorkflowTriggerService';

const jwt = require('jsonwebtoken') as { sign(claims: Record<string, unknown>, secret: string): string };
const connectionString = process.env.OPERATION_EXECUTIONS_TEST_DATABASE_URL;
const tenantA = randomInt(500_000_000, 700_000_000);
const tenantB = tenantA + 1;
const nonce = randomUUID();
const id = (key: string) => `${nonce}-${key}`;
const secret = 'fixture-never-expose-secret';

function token(tenantId: number, rol = 'ADMIN', userId = 42, secret = process.env.JWT_SECRET!) {
  return jwt.sign({ companyId: tenantId, userId, rol }, secret);
}

async function http(t: TestContext, service?: OperationExecutionService) {
  const app = express();
  app.use('/api/v1/operations', createOperationExecutionRoutes(service));
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return async (query = '', accessToken?: string, headers: Record<string, string> = {}) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/operations/executions${query}`, {
      headers: { ...(accessToken && { authorization: `Bearer ${accessToken}` }), ...headers },
    });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
}

test('operations executions requires a signed administrator and rejects unbounded or malformed queries', async (t) => {
  const request = await http(t);
  assert.equal((await request()).status, 401);
  assert.equal((await request('', token(tenantA, 'ADMIN', 42, 'forged-key'))).status, 401);
  assert.equal((await request('', token(tenantA, 'EMPLEADO'))).status, 403);
  assert.equal((await request('', token(tenantA, 'ADMIN', 0))).status, 403);
  const malformedTimestamp = Buffer.from(JSON.stringify(['2026-02-31T00:00:00.000000Z', 'run'])).toString('base64url');
  for (const query of [
    '?limit=101', '?limit=0', '?limit=1&limit=2', '?workflowId=%25', '?status=dispatched',
    '?status=queued&status=running', '?cursor=invalid', `?cursor=${malformedTimestamp}`, '?tenantId=123',
  ]) {
    const result = await request(query, token(tenantA));
    assert.equal(result.status, 422, query);
    assert.equal(result.body.code, 'VALIDATION_ERROR');
  }
});

test('operations executions pages real workflow and outbox evidence without exposing secrets or another tenant', {
  skip: !connectionString && 'OPERATION_EXECUTIONS_TEST_DATABASE_URL is required',
}, async (t) => {
  const db = new Pool({ connectionString });
  t.after(() => db.end());
  const uow = new TenantScopedUoW(db);
  const outbox = new OutboxRepository(uow);
  const { rows: [role] } = await db.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
  assert.deepEqual(role, { rolsuper: false, rolbypassrls: false });
  const { rows: [rls] } = await db.query(`
    SELECT count(*)::int AS tables, bool_and(relrowsecurity AND relforcerowsecurity) AS enforced
    FROM pg_class WHERE oid IN ('workflow_runs'::regclass, 'processing_outbox'::regclass)
  `);
  assert.deepEqual(rls, { tables: 2, enforced: true });

  for (const tenantId of [tenantA, tenantB]) {
    await uow.run(tenantId, (sql) => sql.query(
      "INSERT INTO tenants (id, name, slug) VALUES ($1, 'Fixture Operations', $2)", [tenantId, `operations-${tenantId}`],
    ));
  }
  const workflows = [id('main'), id('secondary'), id('other-tenant')];
  for (const [tenant, workflow] of [[tenantA, workflows[0]], [tenantA, workflows[1]], [tenantB, workflows[2]]] as const) {
    await uow.run(tenant, async (sql) => {
      await sql.query("INSERT INTO workflow_definitions (id, tenant_id, name) VALUES ($1, $2, 'Fixture')", [workflow, tenant]);
      await sql.query(`
        INSERT INTO workflow_revisions (id, tenant_id, workflow_id, revision_number, spec_hash)
        VALUES ($1, $2, $3, 1, 'fixture')
      `, [`${workflow}-rev`, tenant, workflow]);
    });
  }

  async function run(
    tenant: number, workflow: string, key: string, status: string, fraction: string, failureCode?: string,
  ) {
    await uow.run(tenant, (sql) => sql.query(`
      INSERT INTO workflow_runs (
        id, tenant_id, workflow_id, revision_id, temporal_workflow_id, temporal_run_id, correlation_id,
        trigger_type, trigger_payload, status, current_step, step_count, started_at, completed_at, error_details, state_snapshot
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,'webhook',$8,$9::varchar,$10,1,$11,
        CASE WHEN $9::varchar IN ('completed', 'failed') THEN '2026-11-08T01:00:00Z'::timestamptz END,$12,$13)
    `, [id(key), tenant, workflow, `${workflow}-rev`, id(`temporal-${key}`), secret, secret,
      JSON.stringify({ token: secret }), status, secret, `2026-11-08T00:00:00.${fraction}Z`,
      JSON.stringify({ code: failureCode ?? secret, message: secret }), JSON.stringify({ token: secret })]));
  }
  async function event(tenant: number, key: string, runKey: string, eventType = WORKFLOW_WEBHOOK_EVENT, correlationId = secret) {
    return outbox.enqueue(tenant, {
      eventType, correlationId, idempotencyKey: id(key),
      payload: { runId: id(runKey), secret },
    });
  }

  await run(tenantA, workflows[0], 'z-old-queued', 'queued', '000100');
  await run(tenantA, workflows[0], 'a-new-queued', 'queued', '000200');
  await run(tenantA, workflows[0], 'z-running', 'running', '000100');
  await run(tenantA, workflows[0], 'completed', 'completed', '000010');
  await run(tenantA, workflows[1], 'failed', 'failed', '000005', 'LOOP_LIMIT_EXCEEDED');
  await run(tenantA, workflows[1], 'generic-failed', 'failed', '000002');
  await run(tenantA, workflows[1], 'dead-letter', 'queued', '000001');
  await run(tenantB, workflows[2], 'other-run', 'waiting_timer', '000300');
  const retry = await event(tenantA, 'retry', 'a-new-queued');
  await outbox.markStatus(tenantA, retry.id, 'delivery_unknown', {
    error: secret, nextRetryAt: new Date('2026-11-08T01:05:00Z'), incrementRetry: true,
  });
  await outbox.markStatus(tenantA, retry.id, 'delivery_unknown', {
    error: secret, nextRetryAt: new Date('2026-11-08T01:06:00Z'), incrementRetry: true,
  });
  await event(tenantA, 'bad-type', 'a-new-queued', 'unrelated.event');
  await event(tenantA, 'bad-correlation', 'a-new-queued', WORKFLOW_WEBHOOK_EVENT, 'unrelated');
  await event(tenantB, 'foreign-spoof', 'a-new-queued');
  await event(tenantA, 'ambiguous-1', 'z-old-queued');
  await event(tenantA, 'ambiguous-2', 'z-old-queued');
  const processing = await event(tenantA, 'lease', 'z-running');
  await uow.run(tenantA, (sql) => sql.query(`
    UPDATE processing_outbox SET status = 'processing', lease_token = gen_random_uuid(),
      next_retry_at = '2026-11-08T01:10:00Z' WHERE id = $1
  `, [processing.id]));
  const dispatched = await event(tenantA, 'dispatched', 'completed');
  await outbox.markStatus(tenantA, dispatched.id, 'dispatched');
  const deadLetter = await event(tenantA, 'failed-dispatch', 'dead-letter');
  await outbox.markStatus(tenantA, deadLetter.id, 'dead_letter', { error: secret, incrementRetry: true });
  assert.equal((await db.query('SELECT id FROM workflow_runs')).rowCount, 0);
  assert.equal((await db.query('SELECT id FROM processing_outbox')).rowCount, 0);

  const request = await http(t, new OperationExecutionService(uow));
  const access = token(tenantA);
  const page = await request('?limit=1', access, { 'x-tenant-id': String(tenantB) });
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal(page.body.items[0].id, id('a-new-queued'));
  assert.equal(page.body.items[0].recordedAt, '2026-11-08T00:00:00.000200Z');
  assert.equal(page.body.items[0].status, 'queued');
  assert.equal(page.body.items[0].completedAt, null);
  assert.deepEqual(page.body.pageSummary, { retryCount: 2, deliveryUnknownCount: 1 });
  assert.equal(page.body.items[0].dispatchEvidence, 'recorded');
  assert.equal(page.body.items[0].dispatch.status, 'delivery_unknown');
  assert.equal(page.body.items[0].dispatch.nextRetryAt, '2026-11-08T01:06:00.000Z');
  assert.equal(page.body.items[0].dispatch.leaseExpiresAt, null);

  const next = await request(`?limit=1&cursor=${page.body.nextCursor}`, access);
  assert.equal(next.body.items[0].id, id('z-running'));
  assert.equal(next.body.items[0].dispatch.status, 'processing');
  assert.equal(next.body.items[0].dispatch.nextRetryAt, null);
  assert.equal(next.body.items[0].dispatch.leaseExpiresAt, '2026-11-08T01:10:00.000Z');
  const afterTie = await request(`?limit=1&cursor=${next.body.nextCursor}`, access);
  assert.equal(afterTie.body.items[0].id, id('z-old-queued'));
  assert.equal(afterTie.body.items[0].dispatchEvidence, 'ambiguous');
  assert.equal(afterTie.body.items[0].dispatch, null);

  const filtered = await request(`?workflowId=${workflows[0]}&status=completed`, access);
  assert.equal(filtered.body.items.length, 1);
  assert.equal(filtered.body.items[0].id, id('completed'));
  assert.equal(filtered.body.items[0].completedAt, '2026-11-08T01:00:00.000Z');
  assert.equal(filtered.body.items[0].dispatch.status, 'dispatched');
  const failed = await request('?status=failed', access);
  assert.equal(failed.body.items[0].failureCode, 'LOOP_LIMIT_EXCEEDED');
  assert.equal(failed.body.items[0].dispatchEvidence, 'missing');
  assert.equal(failed.body.items[0].dispatch, null);
  assert.equal(failed.body.items[1].failureCode, 'WORKFLOW_FAILED');
  assert.equal(failed.body.items[2].failureCode, 'TEMPORAL_DISPATCH_UNCONFIRMED');
  assert.equal(failed.body.items[2].dispatch.status, 'dead_letter');
  assert.deepEqual(failed.body.pageSummary, { retryCount: 1, deliveryUnknownCount: 0 });
  assert.equal((await request(`?workflowId=${workflows[2]}`, access)).body.items.length, 0);
  const other = await request('', token(tenantB), { 'x-tenant-id': String(tenantA) });
  assert.deepEqual(other.body.items.map((item: { id: string }) => item.id), [id('other-run')]);
  assert.equal(other.body.items[0].status, 'waiting_timer');
  for (const body of [page.body, next.body, afterTie.body, filtered.body, failed.body, other.body]) {
    assert.ok(!JSON.stringify(body).includes(secret));
    assert.ok(!JSON.stringify(body).includes('startedAt'));
  }
});
