import './fixtures/testEnv';
import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import express from 'express';
import { Pool } from 'pg';
import { createConversationCore } from '../core/infrastructure/integration/conversationCore';
import { TenantScopedUoW } from '../db/TenantScopedUoW';
import { requireJwt } from '../middleware/jwtAuth';
import createConversationRoutes from '../routes/conversationRoutes';

const connectionString = process.env.ATTACHMENT_RLS_TEST_DATABASE_URL;

test('raw attachment reads and writes inherit the tenant of the parent message', {
  skip: !connectionString && 'ATTACHMENT_RLS_TEST_DATABASE_URL is required',
}, async (t) => {
  const db = new Pool({ connectionString });
  t.after(() => db.end());
  const uow = new TenantScopedUoW(db);
  const { rows: [role] } = await db.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
  assert.deepEqual(role, { rolsuper: false, rolbypassrls: false });
  const { rows: [rls] } = await db.query(`
    SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'message_attachments'::regclass
  `);
  assert.deepEqual(rls, { relrowsecurity: true, relforcerowsecurity: true });

  const tenantA = randomInt(420_000_000, 450_000_000);
  const tenantB = tenantA + 1;
  const seed = (tenantId: number) => uow.run(tenantId, async (client) => {
    await client.query("INSERT INTO companies (id, name) VALUES ($1, 'Attachment RLS fixture')", [tenantId]);
    const { rows: [message] } = await client.query(`
      INSERT INTO messages (company_id, channel, direction) VALUES ($1, 'whatsapp', 'inbound') RETURNING id
    `, [tenantId]);
    const { rows: [attachment] } = await client.query(`
      INSERT INTO message_attachments (message_id, filename) VALUES ($1, 'fixture.pdf') RETURNING id
    `, [message.id]);
    return { messageId: message.id, id: attachment.id };
  });
  const first = await seed(tenantA);
  const second = await seed(tenantB);
  assert.deepEqual((await db.query('SELECT id FROM message_attachments')).rows, []);
  await assert.rejects(db.query('INSERT INTO message_attachments (message_id) VALUES ($1)', [first.messageId]),
    { code: '42501' });

  await uow.run(tenantA, async (client) => {
    assert.deepEqual((await client.query('SELECT id FROM message_attachments')).rows, [{ id: first.id }]);
    assert.equal((await client.query('UPDATE message_attachments SET filename = $2 WHERE id = $1',
      [second.id, 'cannot-change.pdf'])).rowCount, 0);
    assert.equal((await client.query('DELETE FROM message_attachments WHERE id = $1', [second.id])).rowCount, 0);
    assert.equal((await client.query('UPDATE message_attachments SET filename = $2 WHERE id = $1',
      [first.id, 'owner-change.pdf'])).rowCount, 1);
  });
  await assert.rejects(uow.run(tenantA, (client) => client.query(
    'INSERT INTO message_attachments (message_id) VALUES ($1)', [second.messageId])), { code: '42501' });
  await assert.rejects(uow.run(tenantA, (client) => client.query(
    'UPDATE message_attachments SET message_id = $2 WHERE id = $1', [first.id, second.messageId])), { code: '42501' });
  assert.deepEqual(await uow.run(tenantB, async (client) => (await client.query(
    'SELECT id, filename FROM message_attachments')).rows), [{ id: second.id, filename: 'fixture.pdf' }]);
  assert.deepEqual(await uow.run(tenantA, async (client) => (await client.query(
    'SELECT id, filename FROM message_attachments')).rows), [{ id: first.id, filename: 'owner-change.pdf' }]);
});

test('Web.js saves inbound attachments once and the legacy timeline reads them only within the tenant', {
  skip: !connectionString && 'ATTACHMENT_RLS_TEST_DATABASE_URL is required',
}, async (t) => {
  const db = new Pool({ connectionString });
  t.after(() => db.end());
  const uow = new TenantScopedUoW(db);
  const tenantA = randomInt(450_000_000, 480_000_000);
  const tenantB = tenantA + 1;
  for (const tenant of [tenantA, tenantB]) {
    await uow.run(tenant, (client) => client.query(
      "INSERT INTO companies (id, name) VALUES ($1, 'Legacy attachment fixture')", [tenant]));
  }

  const emitted: Array<{ room: string; event: string }> = [];
  const core = createConversationCore({}, { to: (room: string) => ({ emit: (event: string) => emitted.push({ room, event }) }) },
    tenantA, uow);
  const chatId = '12025550111@c.us';
  const msg = {
    id: { _serialized: `false_${chatId}_${tenantA}` },
    from: chatId, body: 'Fixture legacy attachment', type: 'document', hasMedia: true,
    _data: { filename: 'legacy.pdf', mimetype: 'application/pdf' },
  };
  const chat = { id: { _serialized: chatId, user: '12025550111' }, name: 'Fixture contact' };
  const dto = core.adapter.normalizeInbound(msg, chat);
  const results = await Promise.all([
    core.conversationService.ingestInbound(dto), core.conversationService.ingestInbound(dto),
  ]);
  assert.deepEqual(results.map(({ isDuplicate }) => isDuplicate).sort(), [false, true]);
  const [first] = results;
  assert.equal(results[1].message.id, first.message.id);
  assert.deepEqual(emitted, [{ room: `tenant:${tenantA}`, event: 'message' }, { room: `tenant:${tenantA}`, event: 'chats-updated' }]);
  const attachments = await uow.run(tenantA, async (client) => (await client.query(
    'SELECT filename, mime_type FROM message_attachments WHERE message_id = $1', [first.message.id])).rows);
  assert.deepEqual(attachments, [{ filename: 'legacy.pdf', mime_type: 'application/pdf' }]);

  const invalid = { ...dto, providerMessageId: `invalid-${tenantA}`, attachments: [{ ...dto.attachments![0], filename: 'a'.repeat(256) }] };
  await assert.rejects(core.conversationService.ingestInbound(invalid), { code: '22001' });
  assert.deepEqual(await uow.run(tenantA, async (client) => (await client.query(
    'SELECT id FROM messages WHERE provider_message_id = $1', [invalid.providerMessageId])).rows), []);
  assert.equal(emitted.length, 2);

  const app = express();
  app.use('/api/conversations', requireJwt, createConversationRoutes(undefined, uow));
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const timeline = `http://127.0.0.1:${address.port}/api/conversations/${first.conversation.id}/timeline`;
  const jwt = require('jsonwebtoken') as { sign(claims: Record<string, unknown>, secret: string): string };
  const request = (companyId: number) => fetch(timeline, { headers: {
    authorization: `Bearer ${jwt.sign({ companyId, userId: 1, rol: 'EMPLEADO' }, process.env.JWT_SECRET!)}`,
  } });
  assert.equal((await fetch(timeline)).status, 401);
  assert.equal((await request(tenantB)).status, 404);
  const ownTimeline = await request(tenantA);
  const body = await ownTimeline.json();
  assert.equal(ownTimeline.status, 200, JSON.stringify(body));
  assert.equal(body.data.events.length, 1);
  assert.equal(body.data.events[0].data.has_attachments, true);
});
