import './fixtures/testEnv';
import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { TenantScopedUoW } from '../db/TenantScopedUoW';

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
