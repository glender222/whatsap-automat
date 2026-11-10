import assert from 'node:assert/strict';
import { createHmac, randomInt, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { io } from 'socket.io-client';
import config from '../config/index';
import pool from '../config/database';
import { withTenantTransaction } from '../db/TenantScopedUoW';
import { MetaAccountStore } from '../services/whatsapp/meta/MetaAccountStore';

const base = process.env.PRODUCT_SMOKE_URL;

test('dos empresas con el mismo contacto y wamid conservan sus mensajes y conexiones separados', {
  skip: !base && 'Run against a local product smoke server and dedicated database',
  timeout: 30_000,
}, async (t) => {
  const url = new URL(base!);
  assert.equal(url.protocol, 'http:');
  assert.equal(url.hostname, '127.0.0.1');
  assert.match(config.database.name, /_smoke$/);
  assert.equal(config.whatsapp.provider, 'meta-cloud');
  t.after(() => pool.end());

  async function request(path: string, expected: number, options: { token?: string; body?: object } = {}) {
    const response = await fetch(`${url.origin}${path}`, {
      method: options.body ? 'POST' : 'GET',
      headers: {
        ...(options.token && { Authorization: `Bearer ${options.token}` }),
        ...(options.body && { 'Content-Type': 'application/json' }),
      },
      body: options.body && JSON.stringify(options.body),
    });
    const envelope = await response.json();
    assert.equal(response.status, expected, `${path}: ${envelope.error ?? response.statusText}`);
    return envelope.data ?? envelope;
  }

  const prefix = randomInt(200_000_000_000_000, 300_000_000_000_000);
  const companies = await Promise.all(['Alfa', 'Bravo'].map(async (name, index) => {
    const auth = await request('/api/auth/register', 200, {
      body: { nombre: name, email: `${randomUUID()}@example.invalid`, password: randomUUID() },
    });
    const phoneNumberId = String(prefix + index);
    // Fixtures are preassigned to avoid provisioning a real line or using Graph credentials.
    await new MetaAccountStore().upsertConnection(auth.user.companyId, { phoneNumberId, status: 'configured' });
    return { id: Number(auth.user.companyId), token: String(auth.accessToken), phoneNumberId, text: `Mensaje ${name}` };
  }));
  const [alpha, bravo] = companies;
  assert.notEqual(alpha.id, bravo.id);

  const station = { nombre: 'Operador', email: `${randomUUID()}@example.invalid`, password: randomUUID() };
  await request('/api/auth/create-station', 200, { token: alpha.token, body: station });
  const employee = await request('/api/auth/login', 200, {
    body: { email: station.email, password: station.password },
  });
  for (const path of ['/logout', '/api/auth/logout-whatsapp', '/api/whatsapp/logout']) {
    await request(path, 403, { token: employee.accessToken, body: {} });
  }

  const sockets = companies.map(({ token }) => io(url.origin, {
    auth: { token }, transports: ['websocket'], reconnection: false, timeout: 5000, autoConnect: false,
  }));
  t.after(() => { sockets.forEach((socket) => socket.disconnect()); });
  const events = companies.map(() => [] as string[]);
  await Promise.all(sockets.map((socket, index) => new Promise<void>((resolve, reject) => {
    socket.on('message', ({ body }) => events[index].push(body));
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
    socket.connect();
  })));

  const chatId = '51987654321';
  const sharedMessage = `wamid.${randomUUID()}`;
  async function receive(phoneNumberId: string, body: string, expected: number, id = sharedMessage) {
    const payload = JSON.stringify({ entry: [{ changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: phoneNumberId },
      messages: [{ id, from: chatId, type: 'text', text: { body } }],
    } }] }] });
    const signature = createHmac('sha256', config.meta.appSecret).update(payload).digest('hex');
    const response = await fetch(`${url.origin}/api/webhooks/meta/whatsapp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': `sha256=${signature}` },
      body: payload,
    });
    const outcome = await response.json();
    assert.equal(response.status, expected, outcome.error);
    return outcome;
  }

  for (const company of companies) {
    assert.equal((await receive(company.phoneNumberId, company.text, 200)).results[0].duplicate, false);
    assert.equal((await receive(company.phoneNumberId, company.text, 200)).results[0].duplicate, true);
    const stored = await withTenantTransaction(company.id, (db) => db.query(
      'SELECT company_id, body FROM messages WHERE provider_message_id = $1',
      [sharedMessage],
    ));
    assert.deepEqual(stored.rows, [{ company_id: company.id, body: company.text }]);
  }

  const history = `/api/chats/${chatId}/messages`;
  const chatLists = await Promise.all(companies.map(({ token }) => request('/api/chats', 200, { token })));
  assert.deepEqual(chatLists.map((items) => items.map(({ id }: { id: string }) => id)), [[chatId], [chatId]]);
  assert.notEqual(chatLists[0][0].conversationId, chatLists[1][0].conversationId);
  for (const [index, company] of companies.entries()) {
    const ownHistory = await request(history, 200, { token: company.token });
    assert.deepEqual(ownHistory.map(({ body }: { body: string }) => body), [company.text]);
    const otherId = chatLists[1 - index][0].conversationId;
    await request(`/api/v1/conversations/${otherId}/messages`, 404, { token: company.token });
    const room = await sockets[index].timeout(2000).emitWithAck('join_conversation', chatId);
    assert.equal(room.room, `conversation:${company.id}:${chatId}`);
    assert.equal(room.success, true);
  }
  // Acknowledgements are received after the already queued message events on each connection.
  assert.deepEqual(events, [[alpha.text], [bravo.text]]);

  await request('/logout', 200, { token: alpha.token, body: {} });
  await request('/api/auth/me', 200, { token: alpha.token });
  const afterAlpha = await receive(alpha.phoneNumberId, 'Línea desvinculada', 404, `wamid.${randomUUID()}`);
  assert.equal(afterAlpha.error, 'META_WEBHOOK_TENANT_NOT_FOUND');
  assert.equal((await request('/api/whatsapp/status', 200, { token: bravo.token })).accountStatus, 'configured');

  const secondText = 'Bravo continúa conectado';
  assert.equal((await receive(bravo.phoneNumberId, secondText, 200, `wamid.${randomUUID()}`)).results[0].duplicate, false);
  await Promise.all(sockets.map((socket) => socket.timeout(2000).emitWithAck('join_conversation', chatId)));
  assert.deepEqual(events, [[alpha.text], [bravo.text, secondText]]);

  await request('/api/auth/logout-whatsapp', 200, { token: bravo.token, body: {} });
  await request('/api/auth/me', 200, { token: bravo.token });
  const afterBravo = await receive(bravo.phoneNumberId, 'Línea desvinculada', 404, `wamid.${randomUUID()}`);
  assert.equal(afterBravo.error, 'META_WEBHOOK_TENANT_NOT_FOUND');
});
