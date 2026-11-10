import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import express from 'express';
import { Server } from 'socket.io';
import { io as socketClient } from 'socket.io-client';
import config from '../config/index';
import { WhatsappWebAdapter } from '../core/infrastructure/channels/whatsapp/adapters/WhatsappWebAdapter';
import { requireJwt } from '../middleware/jwtAuth';
import { createWhatsAppRoutes } from '../routes/whatsappRoutes';
import WhatsAppService from '../services/whatsappService';
import { SocketHandler } from '../sockets/socketHandler';
import { createTenantAToken, createTenantBToken } from './fixtures/authFixtures';

test('el canal Web.js comparte eventos y operaciones solo con su empresa', { timeout: 8000 }, async (t) => {
  const ownerId = config.defaultCompanyId;
  const outsiderId = ownerId + 1;
  const calls: string[] = [];
  let events: { emit: (name: string, payload: unknown) => void } | undefined;
  const webClient = {
    initialize: () => calls.push('initialize'),
    logout: () => calls.push('logout'),
    getQR: () => 'qr-fixture',
    getStatus: () => ({ isConnected: true, hasQR: true }),
    getChats: () => [{ id: 'chat-fixture' }],
    getMyInfo: () => ({ id: 'device-fixture' }),
    setSocketIO: (scope: typeof events) => { events = scope; },
  };
  const service: WhatsAppService = Object.assign(Object.create(WhatsAppService.prototype), {
    provider: 'webjs', whatsappClient: webClient,
  });

  const app = express();
  app.use('/api/whatsapp', requireJwt, createWhatsAppRoutes(service));
  app.use(require('../middleware/errorHandler').errorHandler);
  const server = createServer(app);
  const io = new Server(server);
  service.setSocketIO(io);
  const closeSessions = new SocketHandler(service).handleConnection(io);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    closeSessions();
    await io.close();
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const owner = createTenantAToken(ownerId);
  const employee = createTenantAToken(ownerId, 'EMPLEADO', { userId: 103 });
  const outsider = createTenantBToken(outsiderId);

  const request = async (token: string, path: string, method = 'GET') => {
    const response = await fetch(`${url}/api/whatsapp/${path}`, {
      method, headers: { Authorization: `Bearer ${token}` },
    });
    return { status: response.status, body: await response.json() };
  };
  assert.deepEqual(await request(owner, 'qr'), { status: 200, body: { provider: 'webjs', qr: 'qr-fixture' } });
  assert.equal((await request(employee, 'qr')).status, 403);
  assert.equal((await request(outsider, 'qr')).status, 403);
  assert.equal((await request(outsider, 'status')).body.isConnected, false);
  assert.equal((await request(outsider, 'me')).status, 403);
  assert.equal((await request(outsider, 'chats')).status, 403);
  assert.deepEqual((await request(employee, 'chats')).body.data, [{ id: 'chat-fixture' }]);
  for (const path of ['init', 'logout']) {
    assert.equal((await request(employee, path, 'POST')).status, 403);
    assert.equal((await request(outsider, path, 'POST')).status, 403);
    assert.equal((await request(owner, path, 'POST')).status, 200);
  }
  assert.deepEqual(calls, ['initialize', 'logout']);

  const clients = [owner, employee, outsider].map((token) => socketClient(url, {
    auth: { token }, transports: ['websocket'], reconnection: false, forceNew: true, timeout: 2000,
  }));
  t.after(() => clients.forEach((client) => client.disconnect()));
  await Promise.all(clients.map((client) => once(client, 'connect')));
  const observed = clients.map(() => [] as unknown[]);
  clients.forEach((client, index) => {
    for (const name of ['qr', 'chats-updated', 'test:barrier']) {
      client.on(name, (payload) => observed[index].push(payload));
    }
  });
  events!.emit('qr', 'qr-fixture');
  events!.emit('chats-updated', 'chats-fixture');
  const barriers = clients.map((client) => once(client, 'test:barrier'));
  io.emit('test:barrier', 'done');
  await Promise.all(barriers);
  assert.deepEqual(observed, [['qr-fixture', 'chats-fixture', 'done'], ['chats-fixture', 'done'], ['done']]);
  const empty = once(clients[2], 'chats-updated');
  clients[2].emit('request-chats');
  assert.deepEqual(await empty, [[]]);
});

test('el envío persistente conserva la empresa del pedido de envío', async () => {
  const calls: unknown[][] = [];
  const provider = {
    sendMessage: (...args: unknown[]) => {
      calls.push(args);
      return { id: { _serialized: 'provider-fixture' } };
    },
  };
  const adapter = new WhatsappWebAdapter(provider, 1);
  const result = await adapter.sendMessage({
    companyId: 42, channel: 'whatsapp', externalConversationId: 'chat-fixture',
    externalContactId: 'contact-fixture', clientRequestId: 'send-fixture', body: 'Mensaje', messageType: 'text',
  });
  assert.deepEqual(calls, [['chat-fixture', 'Mensaje', null, { companyId: 42 }]]);
  assert.equal(result.providerMessageId, 'provider-fixture');
});
