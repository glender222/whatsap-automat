import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { api } from '../shared/axios/http.ts';
import { readSession, saveSession } from '../shared/auth/session.ts';

// The loopback fixture uses the same Socket.IO server dependency as the backend.
const requireBackend = createRequire(new URL('../../../WhatsaapWeb-JS/package.json', import.meta.url));
const { Server } = requireBackend('socket.io');
const operator = { id: '1', nombre: 'Fixture', email: 'fixture@example.test', rol: 'ADMIN', idPadre: null };
const values = new Map();
const redirects = [];
const browser = Object.assign(new EventTarget(), { location: { assign: (url) => redirects.push(url) } });
Object.defineProperties(globalThis, {
  window: { value: browser, configurable: true },
  localStorage: {
    configurable: true,
    value: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    },
  },
});

let service;
let http;
let io;
let fixture;

function deferred() {
  let release;
  const ready = new Promise((resolve) => { release = resolve; });
  return { ready, release };
}

function respond(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

before(async () => {
  http = createServer(async (req, res) => {
    if (req.url === '/api/auth/refresh') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      fixture.refreshes.push({ body: JSON.parse(raw), authorization: req.headers.authorization });
      fixture.refreshStarted.release();
      await fixture.refreshGate?.ready;
      respond(res, 200, { success: true, data: { accessToken: 'renewed-A' } });
      return;
    }
    if (req.url === '/api/auth/me') {
      fixture.checks.push(req.headers.authorization);
      fixture.checkCache.push(req.headers['cache-control']);
      fixture.checkStarted.release();
      if (fixture.checkMode === 'drop') {
        req.socket.destroy();
      } else if (fixture.checkMode === 'revoked') {
        respond(res, 401, { code: 'SESSION_REVOKED' });
      } else if (fixture.checkMode === 'expiry' && req.headers.authorization === 'Bearer access-A') {
        respond(res, 401, { code: 'ACCESS_TOKEN_EXPIRED' });
      } else {
        respond(res, 200, { success: true, data: operator });
      }
      return;
    }
    respond(res, 404, {});
  });
  io = new Server(http);
  io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    fixture.handshakes.push(token);
    const code = fixture.rejected.get(token);
    if (!code) return next();
    const error = new Error('Fixture session rejected');
    error.data = { code, status: 401 };
    return next(error);
  });
  io.on('connection', (socket) => {
    socket.on('join', (room) => {
      fixture.rooms.push(['join', room]);
      fixture.roomChanged.release();
    });
    socket.on('leave', (room) => fixture.rooms.push(['leave', room]));
  });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  api.defaults.baseURL = `http://127.0.0.1:${http.address().port}/api`;
  const { default: SocketService } = await import('../utils/socket.ts');
  service = SocketService.getInstance();
});

beforeEach(() => {
  values.clear();
  redirects.length = 0;
  fixture = {
    handshakes: [], refreshes: [], checks: [], checkCache: [], rooms: [], rejected: new Map(),
    refreshStarted: deferred(), checkStarted: deferred(), roomChanged: deferred(),
  };
  saveSession(operator, 'access-A', 'refresh-A');
});

afterEach(() => {
  fixture.refreshGate?.release();
  service.disconnect();
});

after(async () => {
  await io.close();
});

async function connect() {
  const socket = service.connect();
  await once(socket, 'connect');
  return socket;
}

function peer(socket) {
  return io.sockets.sockets.get(socket.id);
}

test('expiry shares the HTTP renewal, keeps listeners, and rejoins only the active room', { timeout: 5000 }, async () => {
  const socket = await connect();
  const received = [];
  socket.on('fixture:update', (value) => received.push(value));
  service.joinRoom('previous-room');
  await fixture.roomChanged.ready;
  fixture.roomChanged = deferred();
  fixture.checkMode = 'expiry';
  fixture.refreshGate = deferred();
  const checking = api.get('/auth/me');
  await fixture.refreshStarted.ready;

  const disconnected = once(socket, 'disconnect');
  const reconnected = once(socket, 'connect');
  const originalPeer = peer(socket);
  originalPeer.emit('auth:invalidated', { reason: 'expiry' });
  originalPeer.disconnect(true);
  await disconnected;
  service.leaveRoom('previous-room');
  service.joinRoom('active-room');
  fixture.refreshGate.release();
  await Promise.all([checking, reconnected, fixture.roomChanged.ready]);

  assert.equal(service.getSocket(), socket);
  const update = once(socket, 'fixture:update');
  peer(socket).emit('fixture:update', 'after');
  await update;
  assert.deepEqual(received, ['after']);
  assert.deepEqual(fixture.handshakes, ['access-A', 'renewed-A']);
  assert.deepEqual(fixture.refreshes, [{ body: { refreshToken: 'refresh-A' }, authorization: undefined }]);
  assert.deepEqual(fixture.rooms, [['join', 'previous-room'], ['join', 'active-room']]);
  assert.equal(readSession().accessToken, 'renewed-A');
});

test('a silent server close probes once and stops a rapid disconnect cycle', { timeout: 5000 }, async () => {
  const socket = await connect();
  const reconnected = once(socket, 'connect');
  peer(socket).disconnect(true);
  await reconnected;
  assert.deepEqual(fixture.checks, ['Bearer access-A']);
  assert.deepEqual(fixture.checkCache, ['no-cache']);
  const disconnected = once(socket, 'disconnect');
  peer(socket).disconnect(true);
  await disconnected;
  service.connect();
  await delay(100);
  assert.equal(socket.connected, false);
  assert.deepEqual(fixture.handshakes, ['access-A', 'access-A']);
  assert.deepEqual(fixture.checks, ['Bearer access-A']);
  assert.deepEqual(redirects, []);
});

test('a failed silent probe preserves the session and leaves realtime offline', { timeout: 5000 }, async () => {
  const socket = await connect();
  fixture.checkMode = 'drop';
  peer(socket).disconnect(true);
  await fixture.checkStarted.ready;
  service.connect();
  await delay(100);
  assert.equal(socket.connected, false);
  assert.deepEqual(fixture.handshakes, ['access-A']);
  assert.deepEqual(fixture.checks, ['Bearer access-A']);
  assert.equal(readSession().accessToken, 'access-A');
  assert.deepEqual(redirects, []);
});

test('a silent close followed by structured HTTP revocation clears the session once', { timeout: 5000 }, async () => {
  const socket = await connect();
  fixture.checkMode = 'revoked';
  const invalidated = deferred();
  const assign = browser.location.assign;
  browser.location.assign = (url) => { assign(url); invalidated.release(); };
  try {
    peer(socket).disconnect(true);
    await invalidated.ready;
    assert.equal(service.getSocket(), null);
    assert.equal(readSession().accessToken, null);
    assert.deepEqual(fixture.handshakes, ['access-A']);
    assert.deepEqual(fixture.checks, ['Bearer access-A']);
    assert.deepEqual(fixture.refreshes, []);
    assert.deepEqual(redirects, ['/auth/login']);
  } finally {
    browser.location.assign = assign;
  }
});

test('structured expiry on the handshake obtains one fresh access token', { timeout: 5000 }, async () => {
  fixture.rejected.set('access-A', 'ACCESS_TOKEN_EXPIRED');
  const socket = await connect();
  assert.deepEqual(fixture.handshakes, ['access-A', 'renewed-A']);
  assert.equal(fixture.refreshes.length, 1);
  assert.equal(socket.connected, true);
});

test('a revoked notice or handshake invalidates locally without renewal', { timeout: 5000 }, async (t) => {
  await t.test('notice', async () => {
    const socket = await connect();
    const disconnected = once(socket, 'disconnect');
    peer(socket).emit('auth:invalidated', { reason: 'revoked' });
    await disconnected;
    assert.equal(service.getSocket(), null);
    assert.equal(readSession().accessToken, null);
    assert.deepEqual(redirects, ['/auth/login']);
    assert.deepEqual(fixture.refreshes, []);
  });
  await t.test('handshake', async () => {
    redirects.length = 0;
    saveSession(operator, 'access-A', 'refresh-A');
    fixture.rejected.set('access-A', 'SESSION_REVOKED');
    const socket = service.connect();
    await once(socket, 'connect_error');
    assert.equal(service.getSocket(), null);
    assert.equal(readSession().accessToken, null);
    assert.deepEqual(redirects, ['/auth/login']);
    assert.deepEqual(fixture.refreshes, []);
  });
});

test('renewal begun by A cannot reconnect A or replace B after another tab changes account', { timeout: 5000 }, async () => {
  const oldSocket = await connect();
  fixture.refreshGate = deferred();
  peer(oldSocket).emit('auth:invalidated', { reason: 'expiry' });
  await fixture.refreshStarted.ready;

  localStorage.setItem('auth', JSON.stringify({
    browserSessionId: 'another-tab-B', accessToken: 'access-B', refreshToken: 'refresh-B', user: { ...operator, id: '2' },
  }));
  browser.dispatchEvent(Object.assign(new Event('storage'), { key: 'auth' }));
  assert.equal(service.getSocket(), null);
  fixture.refreshGate.release();
  const newSocket = await connect();
  service.joinRoom('current-room', newSocket);
  await fixture.roomChanged.ready;
  service.joinRoom('stale-room', oldSocket);
  service.leaveRoom('current-room', oldSocket);
  await delay(100);

  assert.notEqual(newSocket, oldSocket);
  assert.equal(oldSocket.connected, false);
  assert.deepEqual(fixture.handshakes, ['access-A', 'access-B']);
  assert.deepEqual(fixture.rooms, [['join', 'current-room']]);
  assert.equal(readSession().accessToken, 'access-B');
  assert.equal(readSession().refreshToken, 'refresh-B');
  assert.deepEqual(redirects, []);
});
