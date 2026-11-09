import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { io, Socket } from 'socket.io-client';
import config from '../config/index';
import pool from '../config/database';
import { MetaAccountStore } from '../services/whatsapp/meta/MetaAccountStore';

const base = process.env.PRODUCT_SMOKE_URL;

async function api(path: string, status: number, token?: string, data?: object) {
  const response = await fetch(`${base}${path}`, {
    method: data ? 'POST' : 'GET',
    headers: {
      ...(token && { Authorization: `Bearer ${token}` }),
      ...(data && { 'Content-Type': 'application/json' }),
    },
    body: data && JSON.stringify(data),
  });
  const body = await response.json();
  assert.equal(response.status, status, `${path}: ${body.error || body.detail || response.statusText}`);
  return body.data;
}

function connect(token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = io(base, { auth: { token }, transports: ['websocket'], reconnection: false, timeout: 5000 });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', (error) => {
      socket.disconnect();
      reject(error);
    });
  });
}

test('real API isolates two companies through auth, signed ingress, inbox, sockets and CAS', {
  skip: !base && 'Run against a dedicated local smoke database and set PRODUCT_SMOKE_URL',
  timeout: 20000,
}, async (t) => {
  assert.equal(new URL(base!).hostname, '127.0.0.1');
  assert.match(config.database.name, /_smoke$/);
  assert.equal(config.whatsapp.provider, 'meta-cloud');
  t.after(() => pool.end());

  const accounts = ['Alfa', 'Bravo'].map((nombre) => ({
    nombre, email: `${randomUUID()}@example.invalid`, password: randomUUID(),
  }));
  const [owner, other] = await Promise.all(accounts.map((account) => api('/api/auth/register', 200, undefined, account)));
  assert.notEqual(owner.user.companyId, other.user.companyId);
  const [first, second] = await Promise.all([1, 2].map(() => api('/api/auth/login', 200, undefined, accounts[0])));
  assert.notEqual(first.refreshToken, second.refreshToken);
  const renewal = await api('/api/auth/refresh', 200, undefined, { refreshToken: first.refreshToken });
  assert.equal((await api('/api/auth/me', 200, renewal.accessToken)).companyId, owner.user.companyId);
  await api('/api/auth/logout', 200, first.accessToken, { refreshToken: first.refreshToken });
  await api('/api/auth/refresh', 401, undefined, { refreshToken: first.refreshToken });

  const ownerSocket = await connect(owner.accessToken);
  t.after(() => { ownerSocket.disconnect(); });
  const otherSocket = await connect(other.accessToken);
  t.after(() => { otherSocket.disconnect(); });
  const ownerMessages: unknown[] = [];
  const otherMessages: unknown[] = [];
  ownerSocket.on('message', (message) => ownerMessages.push(message));
  otherSocket.on('message', (message) => otherMessages.push(message));

  const phoneNumberId = randomUUID();
  await new MetaAccountStore().upsertConnection(owner.user.companyId, { phoneNumberId, status: 'configured' });
  const chatId = '51987654321';
  const messageId = `wamid.${randomUUID()}`;
  const payload = JSON.stringify({ entry: [{ changes: [{ field: 'messages', value: {
    metadata: { phone_number_id: phoneNumberId },
    messages: [{ id: messageId, from: chatId, type: 'text', text: { body: 'Mensaje de prueba' } }],
  } }] }] });
  const signature = createHmac('sha256', config.meta.appSecret).update(payload).digest('hex');
  async function webhook(sig: string, status: number) {
    const response = await fetch(`${base}/api/webhooks/meta/whatsapp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': `sha256=${sig}` },
      body: payload,
    });
    const data = await response.json();
    assert.equal(response.status, status, data.error || data.message);
    return data;
  }

  await webhook('0'.repeat(64), 403);
  assert.equal((await webhook(signature, 200)).results[0].duplicate, false);
  assert.equal((await webhook(signature, 200)).results[0].duplicate, true);

  const chats = await api('/api/chats', 200, owner.accessToken);
  assert.equal(chats.length, 1);
  assert.equal(chats[0].id, chatId);
  const messages = await api(`/api/chats/${chatId}/messages`, 200, owner.accessToken);
  assert.deepEqual(messages.map((message: { id: string }) => message.id), [messageId]);
  assert.deepEqual(await api('/api/chats', 200, other.accessToken), []);
  await api(`/api/chats/${chatId}/messages`, 404, other.accessToken);
  const room = await ownerSocket.timeout(2000).emitWithAck('join_conversation', chatId);
  assert.equal(room.success, true);
  const deniedRoom = await otherSocket.timeout(2000).emitWithAck('join_conversation', chatId);
  assert.equal(deniedRoom.success, false);
  assert.equal(deniedRoom.status, 404);
  const takeover = `/api/conversations/${chats[0].conversationId}/takeover`;
  const command = { expectedVersion: chats[0].stateVersion, reason: 'Validación de producto' };
  await api(takeover, 404, other.accessToken, command);
  const updated = await api(takeover, 200, owner.accessToken, command);
  assert.equal(updated.aiPaused, true);
  await api(takeover, 409, owner.accessToken, command);

  for (let attempt = 0; attempt < 20 && ownerMessages.length === 0; attempt++) await delay(25);
  assert.equal(ownerMessages.length, 1);
  assert.deepEqual(otherMessages, []);
});
