import './fixtures/testEnv';
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { test, type TestContext } from 'node:test';
import { computeAgentSpecHash } from '@whatsap-automat/contracts';
import express from 'express';
import { Pool } from 'pg';
import { TenantScopedUoW } from '../db/TenantScopedUoW';
import createAgentStudioRoutes, { createAgentSimulationRoutes } from '../routes/agentStudioRoutes';

const jwt = require('jsonwebtoken') as { sign(claims: Record<string, unknown>, key: string): string };
const connectionString = process.env.AGENT_STUDIO_TEST_DATABASE_URL;
const tenantA = randomInt(500_000_000, 800_000_000);
const tenantB = tenantA + 1;
const graphId = `studio-${randomUUID()}`;
const spec = {
  entryNodeId: 'router',
  nodes: [
    { id: 'router', kind: 'router', config: { z: 'first', aa: { z: true, b: false } } },
    { id: 'end', kind: 'end', config: {} },
  ],
  edges: [{ id: 'decision', from: 'router', to: 'end' }],
  policyRef: 'sandbox',
  limits: {
    maxSteps: 10, maxDelegations: 0, maxParallelNodes: 1,
    maxDurationSeconds: 10, maxModelTokens: 100, maxCostMicroUsd: 100,
  },
};

function token(tenantId: number, userId: number, rol = 'ADMIN', secret = process.env.JWT_SECRET!) {
  return jwt.sign({ tenantId, userId, rol }, secret);
}

async function startHttp(t: TestContext, uow?: TenantScopedUoW) {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/agent-graphs', createAgentStudioRoutes(uow));
  app.use('/api/v1/agent-runs', createAgentSimulationRoutes(uow));
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const localFetch = globalThis.fetch;
  return async (path: string, accessToken?: string, body?: unknown, resource = 'agent-graphs') => {
    const response = await localFetch(`http://127.0.0.1:${address.port}/api/v1/${resource}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'content-type': 'application/json',
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
        'x-tenant-id': String(tenantB),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
}

test('Agent Studio requires a signed tenant administrator and rejects client ownership fields', async (t) => {
  const request = await startHttp(t);
  const payload = { ...spec, graphId };
  assert.equal((await request('/', undefined, payload)).status, 401);
  assert.equal((await request('/', token(tenantA, 20, 'ADMIN', 'forged-test-key'), payload)).status, 401);
  assert.equal((await request('/', token(tenantA, 20, 'USER'), { ...payload, role: 'ADMIN' })).status, 403);
  assert.equal((await request('/', token(tenantA, 0), payload)).status, 403);
  assert.equal((await request('/', token(tenantA, 20), { ...payload, tenantId: tenantB, status: 'published' })).status, 422);
});

test('Agent Studio revisions are durable, immutable, tenant scoped and ineligible for publication', {
  skip: !connectionString && 'AGENT_STUDIO_TEST_DATABASE_URL is required',
}, async (t) => {
  const db = new Pool({ connectionString });
  t.after(() => db.end());
  const uow = new TenantScopedUoW(db);
  const request = await startHttp(t, uow);
  const { rows: [runtime] } = await db.query(`
    SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user
  `);
  assert.deepEqual(runtime, { rolsuper: false, rolbypassrls: false });
  const { rows: [rls] } = await db.query(`
    SELECT count(*)::int AS tables, bool_and(relrowsecurity AND relforcerowsecurity) AS enforced
    FROM pg_class WHERE oid IN ('agent_studio_graphs'::regclass, 'agent_studio_revisions'::regclass)
  `);
  assert.deepEqual(rls, { tables: 2, enforced: true });
  for (const tenantId of [tenantA, tenantB]) {
    await uow.run(tenantId, (client) => client.query(
      'INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)',
      [tenantId, 'Studio test tenant', `${graphId}-${tenantId}`],
    ));
  }

  const adminA = token(tenantA, 20);
  const adminB = token(tenantB, 21);
  const path = `/${graphId}`;
  const creation = await Promise.all([
    request('/', adminA, { ...spec, graphId }),
    request('/', adminA, { ...spec, graphId }),
  ]);
  assert.deepEqual(creation.map((response) => response.status).sort(), [201, 409]);
  const first = creation.find((response) => response.status === 201)!.body;
  assert.equal(first.tenantId, String(tenantA));
  assert.equal(first.version, 1);
  assert.equal(first.status, 'draft');
  assert.equal(first.specHash, computeAgentSpecHash(first));
  assert.deepEqual(await request(path, adminA), { status: 200, body: first });
  assert.equal((await request(path, adminB)).status, 404);
  assert.equal((await request(`${path}/validate`, adminB, {})).status, 404);
  assert.equal((await request(`${path}/publish`, adminB, {})).status, 404);
  assert.equal((await request(`${path}/revisions`, adminB, spec)).status, 404);

  const malformed = {
    ...spec,
    nodes: [...spec.nodes, { id: 'orphan', kind: 'end', config: {} }],
    edges: [
      ...spec.edges,
      { id: 'cycle', from: 'end', to: 'router' },
      { id: 'dangling', from: 'router', to: 'missing' },
    ],
  };
  const revisions = await Promise.all([
    request(`${path}/revisions`, adminA, malformed),
    request(`${path}/revisions`, adminA, { ...spec, policyRef: 'review' }),
  ]);
  assert.deepEqual(revisions.map((response) => response.status), [201, 201]);
  assert.deepEqual(revisions.map((response) => response.body.version).sort(), [2, 3]);
  const { version, specHash } = revisions[0].body;
  const validation = await request(`${path}/validate?version=${version}`, adminA, { valid: true });
  assert.equal(validation.status, 200);
  assert.equal(validation.body.valid, false);
  assert.equal(validation.body.version, version);
  assert.equal(validation.body.specHash, specHash);
  assert.equal(validation.body.scope, 'structural');
  assert.equal(validation.body.publicationEvidence, false);
  assert.deepEqual(validation.body.issues.map((issue: { code: string }) => issue.code).sort(), [
    'END_HAS_OUTBOUND', 'GRAPH_CYCLE', 'UNKNOWN_EDGE_ENDPOINT', 'UNREACHABLE_NODE',
  ]);
  const old = await request(`${path}?version=1`, adminA);
  assert.deepEqual(old.body, first);
  assert.equal((await request(`${path}/validate?version=1`, adminA, {})).body.valid, true);
  assert.equal((await request(`${path}/validate?version=9`, adminA, {})).status, 404);

  const publish = await request(`${path}/publish?version=1`, adminA, {
    scorecard: { passRatePercent: 100, securityToolLeaks: [] }, publicationEvidence: true,
  });
  assert.equal(publish.status, 501);
  assert.equal(publish.body.code, 'PUBLICATION_UNAVAILABLE');
  assert.equal(publish.body.specHash, first.specHash);
  assert.equal((await request(path, adminA)).body.status, 'draft');

  const sameId = await request('/', adminB, { ...spec, graphId, policyRef: 'other-tenant' });
  assert.equal(sameId.status, 201);
  assert.equal(sameId.body.version, 1);
  assert.equal((await request(path, adminB)).body.policyRef, 'other-tenant');
  assert.equal((await request('/?limit=1', adminB)).body.items.length, 1);
  assert.equal((await request(`/?after=${graphId}`, adminB)).body.items.length, 0);
  assert.equal((await db.query('SELECT * FROM agent_studio_graphs')).rowCount, 0);
  assert.equal((await db.query('SELECT * FROM agent_studio_revisions')).rowCount, 0);

  const actorAudit = await uow.run(tenantA, (client) => client.query(
    'SELECT created_by FROM agent_studio_revisions WHERE graph_id = $1 ORDER BY version', [graphId],
  ));
  assert.deepEqual(actorAudit.rows, [{ created_by: '20' }, { created_by: '20' }, { created_by: '20' }]);
  await assert.rejects(uow.run(tenantA, (client) => client.query(
    'UPDATE agent_studio_revisions SET spec_hash = $1 WHERE graph_id = $2', ['f'.repeat(64), graphId],
  )), { code: '55000' });
  await assert.rejects(uow.run(tenantA, (client) => client.query(
    'DELETE FROM agent_studio_revisions WHERE graph_id = $1', [graphId],
  )), { code: '55000' });
  assert.deepEqual((await request(`${path}?version=1`, adminA)).body, first);
});

test('both Studio fixture routes reject unsigned, unauthorized or ambiguous selectors', async (t) => {
  const request = await startHttp(t);
  const path = `/${graphId}/simulate`;
  const payload = { mockInput: 'Prueba de fixture' };
  for (const [endpoint, resource] of [[path, 'agent-graphs'], ['/simulate', 'agent-runs']]) {
    assert.equal((await request(endpoint, undefined, payload, resource)).status, 401);
    assert.equal((await request(endpoint, token(tenantA, 20, 'USER'), payload, resource)).status, 403);
    assert.equal((await request(endpoint, token(tenantA, 20), { ...payload, tenantId: tenantB }, resource)).status, 422);
  }
  const admin = token(tenantA, 20);
  assert.equal((await request('/simulate', admin, payload, 'agent-runs')).status, 422);
  assert.equal((await request(path, admin, { ...payload, graphId: 'other-graph' })).status, 422);
  assert.equal((await request(path + '?version=1', admin, { ...payload, graphVersion: 2 })).status, 422);
  assert.equal((await request(path + '?version=1&version=1', admin, payload)).status, 422);
  assert.equal((await request(path, admin, { ...payload, graphVersion: 2_147_483_648 })).status, 422);
  assert.equal((await request(path, admin, { mockInput: 'a'.repeat(2049) })).status, 422);
  assert.equal((await request(path, admin, { ...payload, assertions: Array(17).fill({ id: 'budget', type: 'max_steps' }) })).status, 422);
});

test('Studio simulation reads the selected immutable tenant revision and emits fixture outputs only', {
  skip: !connectionString && 'AGENT_STUDIO_TEST_DATABASE_URL is required',
}, async (t) => {
  const db = new Pool({ connectionString });
  t.after(() => db.end());
  const uow = new TenantScopedUoW(db);
  const request = await startHttp(t, uow);
  const outbound = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Fixture simulation must not use a provider');
  });

  const a = tenantA + 10;
  const b = tenantB + 10;
  const admins = [token(a, 20), token(b, 21)];
  const id = `fixture-${randomUUID()}`;
  for (const tenantId of [a, b]) {
    await uow.run(tenantId, (client) => client.query(
      'INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)', [tenantId, 'Simulation fixture', `${id}-${tenantId}`],
    ));
  }
  const firstSpec = {
    ...spec, entryNodeId: 'compose',
    nodes: [
      { id: 'compose', kind: 'agent', config: { systemPrompt: 'SECRET_NOT_FOR_TRACE' } },
      { id: 'charge', kind: 'tool', config: { toolName: 'payments.charge' } },
      { id: 'review', kind: 'approval', config: { private: 'SECRET_NOT_FOR_TRACE' } },
      { id: 'finish', kind: 'end', config: {} },
    ],
    edges: [
      { id: 'first', from: 'compose', to: 'charge', condition: 'false' },
      { id: 'alternative', from: 'compose', to: 'finish', condition: 'true' },
      { id: 'needs-approval', from: 'charge', to: 'review' },
      { id: 'complete', from: 'review', to: 'finish' },
    ],
  };
  const created = await request('/', admins[0], { ...firstSpec, graphId: id });
  assert.equal(created.status, 201);
  const path = `/${id}/simulate`;
  const mockInput = 'Stock disponible';
  assert.equal((await request(path, admins[1], { mockInput })).status, 404);

  const second = await request(`/${id}/revisions`, admins[0], spec);
  assert.equal(second.status, 201);
  const other = await request('/', admins[1], { ...spec, graphId: id, policyRef: 'other-tenant-fixture' });
  assert.equal(other.status, 201);

  const counts = async (tenantId: number) => uow.run(tenantId, async (client) => (await client.query(`
    SELECT (SELECT count(*)::int FROM agent_studio_revisions) AS revisions,
           (SELECT count(*)::int FROM agent_eval_runs) AS evaluations,
           (SELECT count(*)::int FROM agent_eval_suites) AS suites,
           (SELECT count(*)::int FROM messages) AS messages
  `)).rows[0]);
  const before = await Promise.all([counts(a), counts(b)]);
  const assertions = [
    { id: 'text', type: 'expected_text_matched', target: 'stock\\s+disponible$' },
    { id: 'approval', type: 'approval_triggered', target: 'review' },
    { id: 'tool', type: 'expected_tool_called', target: 'payments.charge' },
  ];
  const fixture = await request(path + '?version=1', admins[0], { graphId: id, graphVersion: 1, mockInput, assertions });
  assert.equal(fixture.status, 200);
  assert.equal(fixture.body.mode, 'fixture');
  assert.equal(fixture.body.publicationEvidence, false);
  assert.equal(fixture.body.graphId, id);
  assert.equal(fixture.body.graphVersion, 1);
  assert.equal(fixture.body.specHash, created.body.specHash);
  assert.equal(fixture.body.finalState, 'completed');
  assert.equal(fixture.body.totalSteps, 4);
  assert.deepEqual(fixture.body.executedNodes.map((node: { nodeId: string }) => node.nodeId), [
    'compose', 'charge', 'review', 'finish',
  ]);
  assert.deepEqual(fixture.body.approvalsTriggered.map((approval: { nodeId: string }) => approval.nodeId), ['review']);
  assert.match(fixture.body.simulatedMessages[0].text, /Stock disponible/);
  assert.ok(fixture.body.assertionsResults.every((assertion: { passed: boolean }) => assertion.passed));
  assert.doesNotMatch(JSON.stringify(fixture.body), /SECRET_NOT_FOR_TRACE/);

  const alias = await request('/simulate', admins[0], { graphId: id, graphVersion: 1, mockInput, assertions }, 'agent-runs');
  assert.equal(alias.status, 200);
  assert.equal(alias.body.specHash, fixture.body.specHash);
  assert.deepEqual(alias.body.simulatedMessages, fixture.body.simulatedMessages);
  const latest = await request(path, admins[0], { mockInput });
  assert.equal(latest.body.specHash, second.body.specHash);
  assert.equal(latest.body.graphVersion, 2);
  assert.equal(latest.body.totalSteps, 2);
  const isolated = await request(path, admins[1], { mockInput });
  assert.equal(isolated.body.specHash, other.body.specHash);
  assert.equal(isolated.body.graphVersion, 1);
  assert.deepEqual(isolated.body.simulatedMessages, []);
  assert.equal((await request(path, admins[1], { mockInput, graphVersion: 2 })).status, 404);

  const rejectedRegex = await request(path, admins[0], { mockInput, graphVersion: 1, assertions: [
    { id: 'unsupported', type: 'expected_text_matched', target: '(x)\\1' },
  ] });
  assert.equal(rejectedRegex.status, 422);
  assert.match(rejectedRegex.body.detail, /unsupported simulation text pattern/);
  const sensitiveTool = await request(path, admins[0], { mockInput, graphVersion: 1, assertions: [
    { id: 'effect', type: 'forbidden_tool_not_called', target: 'payments.charge' },
  ] });
  assert.equal(sensitiveTool.status, 200);
  assert.equal(sensitiveTool.body.finalState, 'failed');
  assert.equal(sensitiveTool.body.assertionsResults[0].passed, false);
  assert.equal((await request(`/${id}/publish?version=1`, admins[0], fixture.body)).status, 501);
  assert.deepEqual(await Promise.all([counts(a), counts(b)]), before);
  assert.equal(outbound.mock.callCount(), 0);
});
