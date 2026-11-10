import './fixtures/testEnv';
import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import express from 'express';
import jwt from 'jsonwebtoken';

const databaseUrl = process.env.AGENT_DOMAINS_TEST_DATABASE_URL;

test('agent domains, configurations and activity operate under forced tenant RLS', {
  skip: !databaseUrl && 'AGENT_DOMAINS_TEST_DATABASE_URL is required',
  timeout: 90_000,
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

  await t.test('knowledge downloads use tenant and agent storage and ignore user-controlled paths', async () => {
    const knowledge = (agentId: number) => `/${agentId}/knowledge`;
    async function upload(agentId: number, tenant: number, value: string, expected: number, role = 'ADMIN', title?: string) {
      const form = new FormData();
      form.append('file', new Blob([value], { type: 'text/plain' }), 'política.txt');
      if (title) form.append('title', title);
      const response = await fetch(base + knowledge(agentId) + '/upload', { method: 'POST',
        headers: { Authorization: `Bearer ${token(tenant, role)}` }, body: form });
      const json = await response.json();
      assert.equal(response.status, expected, JSON.stringify(json));
      return json.data;
    }
    const download = (agentId: number, sourceId: number, tenant = a) => fetch(base + knowledge(agentId) + `/${sourceId}/file`, {
      headers: { Authorization: `Bearer ${token(tenant, 'EMPLEADO')}` },
    });
    const original = 'Tenant A content';
    const confidential = 'Tenant B content';
    const sourceA = await upload(agent.id, a, original, 200);
    const sourceB = await upload(foreign.id, b, confidential, 200);
    assert.equal(sourceA.content, original);
    assert.equal(sourceA.metadata.file.originalName, 'política.txt');
    assert.equal(sourceA.metadata.file.storagePath, undefined);
    assert.equal(sourceA.metadata.file.storedName, undefined);
    assert.equal(sourceA.url, `/api/agents${knowledge(agent.id)}/${sourceA.id}/file`);
    const aDir = join(uploadDir, 'agent-knowledge', String(a), String(agent.id));
    const bDir = join(uploadDir, 'agent-knowledge', String(b), String(foreign.id));
    const [aName] = await readdir(aDir);
    const [bName] = await readdir(bDir);
    const aFile = join(aDir, aName);
    const bFile = join(bDir, bName);
    const own = await download(agent.id, sourceA.id);
    assert.equal(own.status, 200);
    assert.equal(own.headers.get('cache-control'), 'private, no-store');
    assert.equal(await own.text(), original);
    assert.equal((await download(foreign.id, sourceB.id)).status, 404);
    assert.equal((await download(agent.id, sourceB.id)).status, 404);
    await upload(foreign.id, a, 'foreign upload', 404);
    await upload(agent.id, a, 'employee upload', 403, 'EMPLEADO');
    await upload(agent.id, a, 'failed DB write', 500, 'ADMIN', 'x'.repeat(3000));
    assert.deepEqual(await readdir(aDir), [aName]);
    assert.deepEqual(await readdir(bDir), [bName]);

    const forgedMetadata = { file: { originalName: 'forged.txt', storedName: bName, storagePath: bFile } };
    const forged = await request(knowledge(agent.id), 200, a, 'POST', { title: 'Forged link', metadata: forgedMetadata });
    assert.equal(forged.metadata.file, undefined);
    assert.equal((await download(agent.id, forged.id)).status, 404);
    const updated = await request(`${knowledge(agent.id)}/${sourceA.id}`, 200, a, 'PUT', { metadata: forgedMetadata });
    assert.equal(updated.metadata.file.originalName, 'política.txt');
    assert.equal(await (await download(agent.id, sourceA.id)).text(), original);

    const rawFileMetadata = (sourceId: number, metadata: unknown) => uow.run(a, (db) => db.query(`
      UPDATE agent_knowledge_sources SET metadata_json = $3::jsonb WHERE id = $1 AND agent_id = $2
    `, [sourceId, agent.id, JSON.stringify(metadata)]));
    await rawFileMetadata(forged.id, { file: { storedName: '../../' + bName, storagePath: bFile } });
    assert.equal((await download(agent.id, forged.id)).status, 404);
    const alias = 'b'.repeat(32);
    await symlink(bFile, join(aDir, alias));
    await rawFileMetadata(forged.id, { file: { storedName: alias } });
    assert.equal((await download(agent.id, forged.id)).status, 404);
    assert.equal(await readFile(bFile, 'utf8'), confidential);
    await rm(join(aDir, alias));

    const backup = aDir + '-backup';
    await rename(aDir, backup);
    await symlink(bDir, aDir);
    try {
      await rawFileMetadata(forged.id, { file: { storedName: bName } });
      assert.equal((await download(agent.id, forged.id)).status, 404);
      await upload(agent.id, a, 'symlinked directory', 500);
      assert.deepEqual(await readdir(bDir), [bName]);
      assert.equal(await readFile(bFile, 'utf8'), confidential);
    } finally {
      await rm(aDir);
      await rename(backup, aDir);
    }

    const legacyName = 'c'.repeat(32);
    const legacyPath = join(uploadDir, 'agent-knowledge', legacyName);
    await writeFile(legacyPath, 'Unscoped historical file');
    await rawFileMetadata(forged.id, { file: { storedName: legacyName, storagePath: legacyPath } });
    assert.equal((await download(agent.id, forged.id)).status, 404);
    assert.equal(await readFile(legacyPath, 'utf8'), 'Unscoped historical file');
    assert.equal(await readFile(aFile, 'utf8'), original);
    assert.equal(await (await download(agent.id, sourceA.id)).text(), original);
  });
});
