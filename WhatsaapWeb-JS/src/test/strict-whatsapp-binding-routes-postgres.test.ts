import './fixtures/testEnv';
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { test, type TestContext } from 'node:test';
import type { AgentGraphVersionV1 } from '@whatsap-automat/contracts';
import express from 'express';
import { Pool } from 'pg';
import { TenantScopedUoW } from '../db/TenantScopedUoW';
import createStrictWhatsappBindingRoutes, { createStrictWhatsappSuggestionRoutes } from '../routes/strictWhatsappBindingRoutes';
import { saveDraft } from '../services/ai/studio/AgentStudioDrafts';
import { boundedTextCapability, boundedTextBudget } from '../services/ai/gateway/BoundedTextCompletion';

const jwt = require('jsonwebtoken') as { sign(claims: Record<string, unknown>, key: string): string };
const connectionString = process.env.STRICT_AGENT_RUNTIME_TEST_DATABASE_URL;
const tenantA = randomInt(600_000_000, 800_000_000);
const tenantB = tenantA + 1;
const graphId = `binding-${randomUUID()}`;
const linearSpec = {
  entryNodeId: 'model',
  nodes: [
    { id: 'model', kind: 'agent' as const, config: {
      provider: boundedTextCapability.provider, model: boundedTextCapability.model, prompt: 'Private binding fixture prompt', maxTokens: 40,
    } },
    { id: 'end', kind: 'end' as const, config: {} },
  ],
  edges: [{ id: 'finish', from: 'model', to: 'end' }],
  policyRef: 'fixture',
  limits: {
    maxSteps: 2, maxDelegations: 0, maxParallelNodes: 1,
    maxDurationSeconds: 10, maxModelTokens: boundedTextBudget(40, 10000)!.maxTokens,
    maxCostMicroUsd: boundedTextBudget(40, 10000)!.maxCostMicroUsd,
  },
};

function token(tenantId: number, userId = 20, rol = 'ADMIN', key = process.env.JWT_SECRET!) {
  return jwt.sign({ tenantId, userId, rol }, key);
}

async function startHttp(t: TestContext, uow?: TenantScopedUoW) {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/ai/whatsapp-binding', createStrictWhatsappBindingRoutes(uow));
  app.use('/api/v1/ai/whatsapp-suggestions', createStrictWhatsappSuggestionRoutes(uow));
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return async (method: 'GET' | 'PUT' | 'DELETE', accessToken?: string, body?: unknown, query = '', resource = 'whatsapp-binding') => {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/ai/${resource}${query}`, {
      method, headers: {
        'content-type': 'application/json', 'x-tenant-id': String(tenantB),
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: response.status, body: response.status === 204 ? null : await response.json(),
      cacheControl: response.headers.get('cache-control'),
    };
  };
}

test('WhatsApp binding HTTP access requires a signed tenant administrator and explicit input', async (t) => {
  const request = await startHttp(t);
  const body = { graphId, version: 1, specHash: 'a'.repeat(64), mode: 'suggest', expectedRevision: null };
  for (const method of ['GET', 'PUT', 'DELETE'] as const) {
    const payload = method === 'PUT' ? body : method === 'DELETE' ? { expectedRevision: null } : undefined;
    assert.equal((await request(method, undefined, payload)).status, 401);
    assert.equal((await request(method, token(tenantA, 20, 'ADMIN', 'forged-fixture-key'), payload)).status, 401);
    assert.equal((await request(method, token(tenantA, 20, 'EMPLEADO'), payload)).status, 403);
    assert.equal((await request(method, token(tenantA, 0), payload)).status, 403);
    assert.equal((await request(method, token(2_147_483_648), payload)).status, 403);
    assert.equal((await request(method, jwt.sign({ userId: 20, rol: 'ADMIN' }, process.env.JWT_SECRET!), payload)).status, 403);
    assert.equal((await request(method, token(tenantA), payload, `?tenantId=${tenantB}`)).status, 422);
  }
  for (const invalid of [
    {}, [], { ...body, graphId: '../graph' }, { ...body, graphId: 'g'.repeat(129) },
    { ...body, version: undefined }, { ...body, version: '1' }, { ...body, version: 0 },
    { ...body, version: 1.5 }, { ...body, version: 2_147_483_648 },
    { ...body, specHash: undefined }, { ...body, specHash: 'A'.repeat(64) },
    { ...body, mode: 'disabled' }, { ...body, mode: undefined },
    { ...body, expectedRevision: undefined }, { ...body, expectedRevision: 'latest' },
    { ...body, expectedRevision: 1 },
    ...['tenantId', 'companyId', 'actorId', 'userId', 'role', 'enabled', 'executionMode'].map((key) => ({ ...body, [key]: tenantB })),
  ]) {
    assert.equal((await request('PUT', token(tenantA), invalid)).status, 422);
  }
  for (const invalid of [undefined, {}, [], { expectedRevision: 'latest' }, { expectedRevision: 1 },
    { expectedRevision: null, tenantId: tenantB }]) {
    assert.equal((await request('DELETE', token(tenantA), invalid)).status, 422);
  }
});

test('WhatsApp suggestion reads require an administrator or employee and one bounded conversation ID', async (t) => {
  const request = await startHttp(t);
  const read = (accessToken?: string, query = '?conversationId=1') =>
    request('GET', accessToken, undefined, query, 'whatsapp-suggestions');
  assert.equal((await read()).status, 401);
  assert.equal((await read(token(tenantA, 20, 'ADMIN', 'forged-fixture-key'))).status, 401);
  assert.equal((await read(token(tenantA, 20, 'USER'))).status, 403);
  assert.equal((await read(token(tenantA, 0))).status, 403);
  assert.equal((await read(token(2_147_483_648))).status, 403);
  for (const role of ['ADMIN', 'EMPLEADO']) {
    for (const query of ['', '?conversationId=0', '?conversationId=-1', '?conversationId=1.5',
      '?conversationId=1&conversationId=2', '?conversationId=9223372036854775808',
      '?conversationId=1&tenantId=2', '?conversationId=1&actorId=2']) {
      assert.equal((await read(token(tenantA, 20, role), query)).status, 422);
    }
  }
});

test('WhatsApp binding pins an exact provider publication under PostgreSQL FORCE RLS', {
  skip: !connectionString && 'STRICT_AGENT_RUNTIME_TEST_DATABASE_URL is required',
  timeout: 30_000,
}, async (t) => {
  const connection = new URL(connectionString!);
  assert.equal(connection.hostname, '127.0.0.1');
  assert.match(connection.pathname, /_smoke$/);
  const pool = new Pool({ connectionString });
  t.after(() => pool.end());
  const uow = new TenantScopedUoW(pool);
  const request = await startHttp(t, uow);
  const adminA = token(tenantA);
  const adminB = token(tenantB, 21);
  const { rows: [role] } = await pool.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
  assert.deepEqual(role, { rolsuper: false, rolbypassrls: false });
  const { rows: [rls] } = await pool.query(`
    SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'strict_whatsapp_bindings'::regclass
  `);
  assert.deepEqual(rls, { relrowsecurity: true, relforcerowsecurity: true });
  for (const tenantId of [tenantA, tenantB]) {
    await uow.run(tenantId, async (db) => {
      await db.query('INSERT INTO companies (id, name) VALUES ($1, $2)', [tenantId, 'Binding fixture']);
      await db.query('INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)', [tenantId, 'Binding fixture', randomUUID()]);
    });
  }
  for (const role of ['ADMIN', 'EMPLEADO']) {
    const suggestion = await request('GET', token(tenantA, 20, role), undefined, '?conversationId=1', 'whatsapp-suggestions');
    assert.equal(suggestion.status, 200);
    assert.equal(suggestion.cacheControl, 'no-store');
    assert.deepEqual(suggestion.body, { suggestion: null });
  }

  async function revision(tenantId: number, id: string,
    spec: Pick<AgentGraphVersionV1, 'entryNodeId' | 'nodes' | 'edges' | 'policyRef' | 'limits'> = linearSpec, create = true) {
    const result = await uow.run(tenantId, (db) => saveDraft(db, tenantId, 20, id, spec, create));
    assert.ok(result);
    return result;
  }

  // Seed immutable publication records as trusted fixtures; no model execution or external provider is involved.
  async function publish(graph: AgentGraphVersionV1, mode: 'provider' | 'verification' = 'provider') {
    const tenantId = Number(graph.tenantId);
    const suiteId = randomUUID();
    const evaluationId = randomUUID();
    await uow.run(tenantId, async (db) => {
      await db.query(`INSERT INTO agent_eval_suites (id, tenant_id, agent_graph_id, name)
        VALUES ($1, $2, $3, 'Binding fixture')`, [suiteId, tenantId, graph.graphId]);
      await db.query(`INSERT INTO agent_eval_runs (id, tenant_id, suite_id, agent_graph_id, graph_version,
        execution_mode, passed, pass_rate_percent) VALUES ($1, $2, $3, $4, $5, $6, true, 100)`,
      [evaluationId, tenantId, suiteId, graph.graphId, graph.version, mode]);
      await db.query(`INSERT INTO agent_studio_publications
        (tenant_id, graph_id, version, execution_mode, evaluation_id, spec_hash, suite_hash, published_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 20)`,
      [tenantId, graph.graphId, graph.version, mode, evaluationId, graph.specHash, 'a'.repeat(64)]);
    });
  }

  const input = (graph: AgentGraphVersionV1, mode = 'suggest', expectedRevision: string | null = null) => ({
    graphId: graph.graphId, version: graph.version, specHash: graph.specHash, mode, expectedRevision,
  });
  assert.equal((await request('GET', adminA)).body.binding, null);
  assert.equal((await request('DELETE', adminA, { expectedRevision: null })).status, 204);
  const first = await revision(tenantA, graphId);
  assert.equal((await request('PUT', adminA, input(first))).status, 409, 'A draft is not a publication');
  await publish(first, 'verification');
  assert.equal((await request('PUT', adminA, input(first))).status, 409, 'A verification publication is not a provider publication');
  await publish(first);
  assert.equal((await request('PUT', adminB, input(first))).status, 409, 'A publication in another tenant cannot be bound');
  const bound = await request('PUT', adminA, input(first));
  assert.equal(bound.status, 200);
  assert.equal(bound.cacheControl, 'no-store');
  assert.deepEqual(bound.body.binding, {
    graphId, version: 1, specHash: first.specHash, mode: 'suggest',
    revision: bound.body.binding.revision, boundBy: 20, boundAt: bound.body.binding.boundAt,
  });
  assert.match(bound.body.binding.revision, /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/);
  assert.ok(Number.isFinite(Date.parse(bound.body.binding.boundAt)));
  assert.equal(JSON.stringify(bound.body).includes('Private binding fixture prompt'), false);
  assert.deepEqual((await request('GET', adminA)).body, bound.body);
  assert.equal((await request('GET', adminB)).body.binding, null);
  assert.equal((await request('DELETE', adminB, { expectedRevision: null })).status, 204);
  assert.deepEqual((await request('GET', adminA)).body, bound.body);

  const second = await revision(tenantA, graphId, { ...linearSpec, policyRef: 'fixture-v2' }, false);
  await publish(second);
  assert.deepEqual((await request('GET', adminA)).body, bound.body, 'Publishing v2 must not move a pinned v1 binding');
  assert.equal((await request('PUT', adminA, { ...input(second, 'suggest', bound.body.binding.revision), specHash: first.specHash })).status, 409);
  assert.deepEqual((await request('GET', adminA)).body, bound.body, 'A failed rebind must preserve the current pin');
  const stale = await request('PUT', adminA, input(second, 'auto'));
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'BINDING_CONFLICT');
  const changed = await request('PUT', adminA, input(second, 'auto', bound.body.binding.revision));
  assert.equal(changed.status, 200);
  assert.equal(changed.body.binding.version, 2);
  assert.equal(changed.body.binding.mode, 'auto');
  assert.notEqual(changed.body.binding.revision, bound.body.binding.revision);
  const restored = await request('PUT', adminA, input(first, 'suggest', changed.body.binding.revision));
  assert.equal(restored.status, 200, 'The exact published v1 remains explicitly selectable');

  const other = await revision(tenantB, graphId, { ...linearSpec, policyRef: 'other-company' });
  await publish(other);
  assert.equal((await request('PUT', adminB, input(other, 'auto'))).status, 200);
  assert.equal((await request('GET', adminB)).body.binding.boundBy, 21);
  assert.equal((await request('GET', adminA)).body.binding.specHash, first.specHash);
  assert.equal((await request('PUT', adminA, input(other, 'suggest', restored.body.binding.revision))).status, 409);

  const incompatible = await revision(tenantA, `${graphId}-incompatible`, {
    ...linearSpec, nodes: [{ ...linearSpec.nodes[0], config: { ...linearSpec.nodes[0].config, tools: ['catalog.search'] } }, linearSpec.nodes[1]],
  });
  await publish(incompatible);
  assert.equal((await request('PUT', adminA, input(incompatible, 'suggest', restored.body.binding.revision))).status, 409);
  assert.equal((await request('GET', adminA)).body.binding.specHash, first.specHash);

  assert.equal((await pool.query('SELECT tenant_id FROM strict_whatsapp_bindings')).rowCount, 0);
  assert.equal((await uow.run(tenantB, (db) => db.query(
    'SELECT tenant_id FROM strict_whatsapp_bindings WHERE tenant_id = $1', [tenantA],
  ))).rowCount, 0);
  assert.equal((await uow.run(tenantB, (db) => db.query(
    'DELETE FROM strict_whatsapp_bindings WHERE tenant_id = $1', [tenantA],
  ))).rowCount, 0);
  await assert.rejects(uow.run(tenantB, (db) => db.query(
    'UPDATE strict_whatsapp_bindings SET tenant_id = $1 WHERE tenant_id = $2', [tenantA, tenantB],
  )), { code: '42501' });
  const race = await Promise.all(['auto', 'suggest'].map((mode) =>
    request('PUT', adminA, input(first, mode, restored.body.binding.revision))));
  assert.deepEqual(race.map(({ status }) => status).sort(), [200, 409]);
  assert.equal(race.find(({ status }) => status === 409)!.body.code, 'BINDING_CONFLICT');
  const winner = race.find(({ status }) => status === 200)!.body.binding;
  assert.deepEqual((await request('GET', adminA)).body.binding, winner);
  const staleDelete = await request('DELETE', adminA, { expectedRevision: restored.body.binding.revision });
  assert.equal(staleDelete.status, 409);
  assert.equal(staleDelete.body.code, 'BINDING_CONFLICT');
  assert.equal((await request('DELETE', adminA, { expectedRevision: winner.revision })).status, 204);
  assert.equal((await request('DELETE', adminA, { expectedRevision: winner.revision })).status, 409);
  assert.equal((await request('DELETE', adminA, { expectedRevision: null })).status, 204);
  assert.equal((await request('GET', adminA)).body.binding, null);
  assert.equal((await request('GET', adminB)).body.binding.mode, 'auto');
});
