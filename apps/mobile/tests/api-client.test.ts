import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { apiClient, handleUnauthorized, MobileApiError, normalizeServerUrl } from '../src/services/apiClient';
import { authStorage, MemoryStorageBackend } from '../src/services/authStorage';

const originalFetch = globalThis.fetch;
const session = {
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  userId: '33',
  tenantId: '8',
  apiUrl: 'https://backend.example.com',
};

beforeEach(() => authStorage.setBackendForTest(new MemoryStorageBackend()));
afterEach(() => { globalThis.fetch = originalFetch; });

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('uses HTTPS except private development servers and strips the documented API suffix', () => {
  assert.equal(normalizeServerUrl(' HTTPS://EXAMPLE.COM:8443/api/v1/ '), 'https://example.com:8443');
  assert.equal(normalizeServerUrl('http://10.0.2.2:3000', true), 'http://10.0.2.2:3000');
  assert.throws(() => normalizeServerUrl('http://10.0.2.2:3000'), /HTTPS/);
  assert.throws(() => normalizeServerUrl('http://evil.example.com', true), /HTTPS/);
  assert.throws(() => normalizeServerUrl('https://user:pass@example.com'));
  assert.throws(() => normalizeServerUrl('https://example.com?next=https://elsewhere.example.com'));
});

test('signs in against the actual auth endpoint and uses only the returned account and tenant', async () => {
  globalThis.fetch = async (input, init) => {
    assert.equal(input, `${session.apiUrl}/api/auth/login`);
    assert.equal(init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(init?.body)), { email: 'operator@example.com', password: ' password ' });
    assert.equal(new Headers(init?.headers).has('Authorization'), false);
    return json(200, {
      success: true,
      data: { accessToken: session.accessToken, refreshToken: session.refreshToken, user: { id: 33, companyId: 8 } },
    });
  };

  assert.deepEqual(await apiClient.signIn(session.apiUrl, 'operator@example.com ', ' password '), session);
  assert.equal(await authStorage.getAuthSession(), null);
});

test('rejects a successful login response that omits tenant identity', async () => {
  globalThis.fetch = async () => json(200, { success: true, data: { accessToken: session.accessToken, user: { id: 33 } } });
  await assert.rejects(apiClient.signIn(session.apiUrl, 'operator@example.com', 'password'), { status: 502 });
});

test('loads the real chats response envelope and authenticates with the server-issued token', async () => {
  await authStorage.saveAuthSession(session);
  const chat = { id: '505', name: 'Ana', stateVersion: 2, assignedUserId: '33', conversationId: '8' };
  globalThis.fetch = async (input, init) => {
    assert.equal(input, `${session.apiUrl}/api/chats?limit=50&offset=50`);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('Authorization'), 'Bearer access-token');
    assert.equal(headers.has('X-Tenant-Id'), false);
    return json(200, { success: true, data: [chat] });
  };

  assert.deepEqual(await apiClient.listConversations(50), [chat]);
});

test('reads the actual session status response without inventing an active window', async () => {
  await authStorage.saveAuthSession(session);
  const status = {
    success: true,
    hasActiveSession: false,
    conversationId: '8',
    stateVersion: 4,
    assignedUserId: '33',
    aiPaused: true,
  };
  globalThis.fetch = async (input) => {
    assert.equal(input, `${session.apiUrl}/api/chats/123%40c.us/session/status`);
    return json(200, status);
  };

  assert.deepEqual(await apiClient.getChatSessionStatus('123@c.us'), status);
});

test('sends text to the actual chat endpoint without retrying a transport failure', async () => {
  await authStorage.saveAuthSession(session);
  let attempts = 0;
  globalThis.fetch = async (input, init) => {
    attempts++;
    assert.equal(input, `${session.apiUrl}/api/chats/123%40c.us/messages`);
    assert.deepEqual(JSON.parse(String(init?.body)), { message: 'Hola' });
    throw new TypeError('network failed after dispatch');
  };

  await assert.rejects(apiClient.sendMessage('123@c.us', 'Hola'), TypeError);
  assert.equal(attempts, 1);
});

test('sends CAS version to the real takeover endpoint and reads the version returned by the server', async () => {
  await authStorage.saveAuthSession(session);
  const result = { conversationId: '8', newVersion: 4, ownerId: '33', aiPaused: true };
  globalThis.fetch = async (input, init) => {
    assert.equal(input, `${session.apiUrl}/api/conversations/8/takeover`);
    assert.deepEqual(JSON.parse(String(init?.body)), { expectedVersion: 3 });
    return json(200, { success: true, data: result });
  };

  assert.deepEqual(await apiClient.takeoverConversation(8, 3), result);
});

test('reports CAS conflicts and notifies the active session only on 401', async () => {
  await authStorage.saveAuthSession(session);
  const invalidatedTokens: string[] = [];
  const stop = handleUnauthorized((token) => invalidatedTokens.push(token));
  try {
    const metadata = { currentVersion: 4, ownerType: 'human', ownerId: '71' };
    globalThis.fetch = async () => json(409, { status: 409, detail: 'Versión vencida', metadata });
    await assert.rejects(apiClient.takeoverConversation('8', 3), (error: unknown) =>
      error instanceof MobileApiError && error.status === 409 && error.message === 'Versión vencida'
      && error.metadata?.currentVersion === 4 && error.metadata?.ownerId === '71');
    assert.deepEqual(invalidatedTokens, []);

    globalThis.fetch = async () => json(401, { success: false, message: 'Sesión vencida' });
    await assert.rejects(apiClient.listConversations(), { status: 401 });
    assert.deepEqual(invalidatedTokens, [session.accessToken]);
  } finally {
    stop();
  }
});
