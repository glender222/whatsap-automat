import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import express from 'express';
import jwt from 'jsonwebtoken';

test('workflow console reads tenant-scoped revisions, validates without a write and hides webhook secrets', {
  skip: process.env.WORKFLOW_CONSOLE_SMOKE !== '1' && 'Set WORKFLOW_CONSOLE_SMOKE=1 with a migrated localhost *_smoke database',
}, async (context) => {
  const { default: config } = await import('../config');
  const { default: pool } = await import('../config/database');
  const { tenantScopedUoW } = await import('../db/TenantScopedUoW');
  const { default: createRoutes } = await import('../routes/workflowRoutes');
  assert.equal(config.database.host, '127.0.0.1');
  assert.match(config.database.name, /_smoke$/);
  context.after(() => pool.end());
  const { rows: [role] } = await pool.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
  assert.deepEqual(role, { rolsuper: false, rolbypassrls: false });

  async function createTenant() {
    const { rows: [company] } = await pool.query("INSERT INTO companies (name) VALUES ('Workflow console QA') RETURNING id");
    await tenantScopedUoW.run(company.id, (client) => client.query(
      'INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)',
      [company.id, 'Workflow console QA', randomUUID()],
    ));
    return Number(company.id);
  }
  const tenant = await createTenant();
  const foreignTenant = await createTenant();
  const app = express();
  app.use(express.json());
  app.use('/api/v1/workflows', createRoutes());
  const server = app.listen(0, '127.0.0.1');
  context.after(() => new Promise<void>((resolve) => { server.close(() => resolve()); }));
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api/v1/workflows`;

  async function request(path: string, status: number, options: { tenantId?: number; role?: string; body?: unknown } = {}) {
    const token = jwt.sign({ companyId: options.tenantId ?? tenant, userId: 12, rol: options.role ?? 'ADMIN' }, config.jwt.secret);
    const response = await fetch(base + path, {
      method: options.body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const responseBody = await response.json();
    assert.equal(response.status, status, responseBody.detail || responseBody.title);
    return { headers: response.headers, body: responseBody };
  }

  const dagGraph = {
    nodes: [{ id: 'start', kind: 'trigger' }, { id: 'end', kind: 'end' }],
    edges: [{ id: 'link', source: 'start', target: 'end' }],
  };
  assert.equal((await request('/validate', 200, { body: { dagGraph } })).body.data.nodeCount, 2);
  await request('/validate', 400, { body: { dagGraph: { ...dagGraph, edges: [] } } });
  await request('/validate', 403, { role: 'EMPLEADO', body: { dagGraph } });
  assert.deepEqual((await request('', 200)).body.data, { items: [], hasMore: false });
  await request('?limit=51', 400);

  const { body: { data: created } } = await request('', 201, { body: { name: 'Workflow de QA', dagGraph } });
  const detailPath = `/${created.workflowId}`;
  const revisionPath = `${detailPath}/revisions/${created.revision.id}`;
  assert.equal((await request('', 200, { role: 'EMPLEADO' })).body.data.items[0].id, created.workflowId);
  assert.deepEqual((await request('', 200, { tenantId: foreignTenant })).body.data.items, []);
  await request(detailPath, 404, { tenantId: foreignTenant });
  await request(revisionPath, 404, { tenantId: foreignTenant });
  await request(revisionPath, 403, { role: 'EMPLEADO' });
  const revision = await request(revisionPath, 200);
  assert.equal(revision.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(revision.body.data.dagGraph.nodes[0].kind, 'trigger');

  await request(`${detailPath}/publish`, 200, { body: { revisionId: created.revision.id } });
  const { body: { data: trigger } } = await request(`${detailPath}/triggers/webhook`, 201, { body: {} });
  assert.ok(trigger.token);
  const admin = await request(detailPath, 200);
  const employee = await request(detailPath, 200, { role: 'EMPLEADO' });
  assert.equal(admin.body.data.workflow.publishedRevisionId, created.revision.id);
  assert.deepEqual(admin.body.data.webhooks.map((item: { id: string; isActive: boolean }) => ({ id: item.id, active: item.isActive })), [
    { id: trigger.id, active: true },
  ]);
  assert.ok(!JSON.stringify(admin.body).includes(trigger.token));
  assert.ok(!('webhooks' in employee.body.data));
  assert.ok(!('dagGraph' in employee.body.data.revisions[0]));
  assert.equal(employee.headers.get('Cache-Control'), 'private, no-store');
});
