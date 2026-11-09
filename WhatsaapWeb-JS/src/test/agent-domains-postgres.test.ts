import './fixtures/testEnv';
import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import express from 'express';
import jwt from 'jsonwebtoken';

const databaseUrl = process.env.AGENT_DOMAINS_TEST_DATABASE_URL;

test('agent domains, configurations and activity operate under forced tenant RLS', {
  skip: !databaseUrl && 'AGENT_DOMAINS_TEST_DATABASE_URL is required',
}, async (t) => {
  const database = new URL(databaseUrl!);
  process.env.DB_HOST = database.hostname;
  process.env.DB_PORT = database.port || '5432';
  process.env.DB_NAME = database.pathname.slice(1);
  process.env.DB_USER = decodeURIComponent(database.username);
  process.env.DB_PASSWORD = decodeURIComponent(database.password);
  const { default: db } = await import('../config/database');
  const { default: config } = await import('../config/index');
  const { TenantScopedUoW } = await import('../db/TenantScopedUoW');
  const { AiSessionRepositoryPg } = await import('../modules/ai/infra/db/AiSessionRepositoryPg');
  const { default: createAgentRoutes } = await import('../routes/agentRoutes');
  const { requireJwt } = await import('../middleware/jwtAuth');
  const { errorHandler } = require('../middleware/errorHandler');
  t.after(() => db.end());
  const uploadDir = await mkdtemp(join(tmpdir(), 'agent-domain-fixture-'));
  const previousUploadDir = config.whatsapp.uploadDir;
  config.whatsapp.uploadDir = uploadDir;
  t.after(async () => { config.whatsapp.uploadDir = previousUploadDir; await rm(uploadDir, { recursive: true, force: true }); });
  const uow = new TenantScopedUoW(db);
  const { rows: [role] } = await db.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
  assert.deepEqual(role, { rolsuper: false, rolbypassrls: false });
  const a = randomInt(270_000_000, 300_000_000);
  const b = a + 1;
  for (const tenant of [a, b]) {
    await uow.run(tenant, async (sql) => {
      await sql.query("INSERT INTO companies (id,name) VALUES ($1, 'Agent domains fixture')", [tenant]);
      await sql.query(`INSERT INTO usuarios (id, company_id, nombre, email, password_hash)
        VALUES ($1, $2, 'Fixture administrator', $3, 'unused')`, [tenant + 2, tenant, `agent-${tenant}@example.invalid`]);
    });
  }
  await assert.rejects(db.query(`INSERT INTO company_ai_domains (company_id, domain_key, status)
    VALUES ($1, 'gestion_web', 'active')`, [a]), { code: '42501' });

  const app = express();
  app.use(express.json());
  app.use('/api/agents', requireJwt, createAgentRoutes());
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api/agents`;
  const token = (tenant: number, role: string) => jwt.sign({ companyId: tenant, userId: tenant + 2, rol: role }, config.jwt.secret);
  async function request(path: string, status: number, tenant = a, method = 'GET', body?: unknown, role = 'ADMIN') {
    const result = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token(tenant, role)}`,
      'X-Tenant-Id': String(tenant === a ? b : a), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
    const json = await result.json();
    assert.equal(result.status, status, `${method} ${path}: ${JSON.stringify(json)}`);
    return json.data;
  }
  assert.equal((await fetch(base + '/domains')).status, 401);
  const domains = await Promise.all([
    request('/domains', 200, a, 'GET', undefined, 'EMPLEADO'), request('/domains', 200), request('/domains', 200, b),
  ]);
  for (const list of domains) assert.deepEqual(list.filter((item: any) => item.createdAt).map((item: any) => item.domainKey),
    ['gestion_web', 'inventory_stock']);
  const domainPath = '/domains/gestion_web';
  await request(`${domainPath}/activate`, 200, a, 'POST', {});
  await request('/domains/payments/activate', 409, a, 'POST', {});
  await request('', 403, a, 'POST', { name: 'Employee forbidden' }, 'EMPLEADO');
  const [agent, second] = await Promise.all([
    request('', 200, a, 'POST', { name: 'Own agent' }), request('', 200, a, 'POST', { name: 'Second agent' }),
  ]);
  assert.equal([agent, second].filter(({ isDefault }) => isDefault).length, 1);
  const foreign = await request('', 200, b, 'POST', { name: 'Other tenant agent', domainKey: 'gestion_web' });
  await request('', 409, a, 'POST', { name: 'Must roll back', domainKey: 'payments' });
  assert.equal((await request('', 200)).length, 2);
  await request(`/${foreign.id}`, 404);
  await request(`/${foreign.id}`, 404, a, 'DELETE');
  await request(`/${foreign.id}/profile`, 404, a, 'PUT', { language: 'en' });
  await request(`${domainPath}/agent`, 404, a, 'PUT', { agentId: foreign.id });
  await request(`${domainPath}/agent`, 403, a, 'PUT', { agentId: agent.id }, 'EMPLEADO');
  assert.equal((await request(`${domainPath}/agent`, 200, a, 'PUT', { agentId: agent.id })).assignedAgent.id, agent.id);
  assert.equal((await request('/domains', 200, b))[0].assignedAgent.id, foreign.id);
  assert.equal((await request(`/${agent.id}/profile`, 200, a, 'PUT', { language: 'es', tone: 'Claro' })).profile.tone, 'Claro');
  assert.equal((await request(`/${agent.id}/rules`, 200, a, 'PUT', { blockedTopics: ['riesgo'] })).rules.blockedTopics[0], 'riesgo');
  await request(`${domainPath}/deploy`, 409, a, 'POST', { agentId: agent.id,
    patch: { name: 'Must roll back', mode: 'disabled', profile: { tone: 'Must roll back' } } });
  const unchanged = await request(`/${agent.id}`, 200);
  assert.equal(unchanged.name, 'Own agent');
  assert.equal(unchanged.profile.tone, 'Claro');
  assert.equal(unchanged.status, 'draft');
  const deployed = await request(`${domainPath}/deploy`, 200, a, 'POST', {
    agentId: agent.id, patch: { name: 'Active agent', profile: { tone: 'Profesional' } },
  });
  assert.equal(deployed.assignedAgent.status, 'active');
  assert.equal(deployed.assignedAgent.profile.tone, 'Profesional');
  await request('/company-mode', 200, a, 'PUT', { mode: 'mixed' });
  assert.equal((await request('/company-mode', 200)).mode, 'mixed');
  assert.equal((await request('/company-mode', 200, b)).mode, 'normal');

  const chatId = '12025550120';
  const conversationId = await uow.run(a, async (sql) => Number((await sql.query(`
    INSERT INTO conversations (company_id, channel, external_conversation_id) VALUES ($1, 'whatsapp', $2) RETURNING id
  `, [a, chatId])).rows[0].id));
  const sessions = new AiSessionRepositoryPg(db);
  const scope = { companyId: a, conversationId, agentId: agent.id, domainKey: 'gestion_web', chatId };
  const session = await sessions.resolveOrCreateSession(scope);
  const turn = await sessions.createTurn({ ...scope, sessionId: session.id, mode: 'suggest' });
  await sessions.createEvent({ ...scope, sessionId: session.id, turnId: turn.id, kind: 'tool', title: 'Fixture tool' });
  assert.equal((await request(`${domainPath}/sessions`, 200))[0].id, session.id);
  assert.deepEqual(await request(`${domainPath}/sessions`, 200, b), []);
  assert.equal((await request(`${domainPath}/activity`, 200))[0].commands[0].title, 'Fixture tool');
  assert.deepEqual(await request(`${domainPath}/operations`, 200, b), []);
  assert.equal((await request(`${domainPath}/metrics`, 200)).commands, 1);
  assert.equal((await request(`${domainPath}/metrics`, 200, b)).commands, 0);
  await request(`/${second.id}`, 200, a, 'DELETE');
  await request(`/${second.id}`, 404);
});
