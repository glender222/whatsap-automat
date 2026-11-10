import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { apiClient, handleUnauthorized } from '../src/services/apiClient';
import { authStorage, MemoryStorageBackend } from '../src/services/authStorage';

const originalFetch = globalThis.fetch;
const session = {
  accessToken: 'access-old', refreshToken: 'refresh-old', userId: '33', tenantId: '8',
  apiUrl: 'https://backend.example.com',
};
const nextToken = 'access-renewed';
const command = { conversationId: 8, expectedVersion: 3, key: 'send-1', text: 'Hola' };

function json(status: number, body: unknown) {
  return Response.json(body, { status });
}

function expired(legacy = false) {
  return json(401, legacy
    ? { success: false, error: 'Token invalido o expirado', details: 'jwt expired' }
    : { success: false, error: 'Access token expired', code: 'ACCESS_TOKEN_EXPIRED' });
}

function renewed() {
  return json(200, { success: true, data: { accessToken: nextToken } });
}

function user(tenantId = session.tenantId) {
  return json(200, { success: true, data: { id: Number(session.userId), companyId: Number(tenantId) } });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(async () => {
  authStorage.setBackendForTest(new MemoryStorageBackend());
  await authStorage.saveAuthSession(session);
});
afterEach(() => { globalThis.fetch = originalFetch; });

test('coalesces concurrent expirations and replays the exact authenticated mutation only once', async () => {
  const bothExpired = deferred();
  const requests: string[] = [];
  const writes: { body: BodyInit | null | undefined; key: string | null }[] = [];
  let expiredRequests = 0;
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    const headers = new Headers(init?.headers);
    const token = headers.get('Authorization');
    requests.push(path);
    if (path === '/api/auth/refresh') {
      assert.equal(token, null);
      assert.deepEqual(JSON.parse(String(init?.body)), { refreshToken: session.refreshToken });
      await bothExpired.promise;
      return renewed();
    }
    if (path === '/api/auth/me') {
      assert.equal(token, `Bearer ${nextToken}`);
      return user();
    }
    if (path.endsWith('/messages')) writes.push({ body: init?.body, key: headers.get('Idempotency-Key') });
    if (token === `Bearer ${session.accessToken}`) {
      if (++expiredRequests === 2) bothExpired.resolve();
      return expired(path.endsWith('/messages'));
    }
    assert.equal(token, `Bearer ${nextToken}`);
    if (path.endsWith('/messages')) return json(202, { accepted: true, providerMessageId: 'wamid.qa', deliveryState: 'provider_accepted' });
    return json(200, { success: true, data: [] });
  };

  assert.deepEqual(await Promise.all([apiClient.listConversations(), apiClient.sendMessage(command)]), [[], 'accepted']);
  assert.equal(requests.filter((path) => path === '/api/auth/refresh').length, 1);
  assert.equal(requests.filter((path) => path === '/api/auth/me').length, 1);
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[0], writes[1]);
  assert.equal(writes[0].key, command.key);
  assert.deepEqual(await authStorage.getAuthSession(), { ...session, accessToken: nextToken });
});

test('renews access after an explicit expiry without automatically replaying a password-bearing approval', async () => {
  const approval = { approvalId: 'appr-1', decision: 'approved' as const, expectedVersion: 3, key: 'same-key', reason: 'Motivo' };
  const paths: string[] = [];
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    paths.push(path);
    if (path === '/api/auth/refresh') {
      assert.deepEqual(JSON.parse(String(init?.body)), { refreshToken: session.refreshToken });
      return renewed();
    }
    if (path === '/api/auth/me') return user();
    assert.equal(path, '/api/v1/approvals/appr-1/decision');
    assert.equal(new Headers(init?.headers).get('Idempotency-Key'), approval.key);
    const token = new Headers(init?.headers).get('Authorization');
    const payload = JSON.parse(String(init?.body));
    if (token === `Bearer ${session.accessToken}`) {
      assert.equal(payload.password, 'initial');
      return expired();
    }
    assert.equal(token, `Bearer ${nextToken}`);
    assert.equal(payload.password, 're-entered');
    return json(200, { approvalId: approval.approvalId, status: 'approved' });
  };
  await assert.rejects(apiClient.decideApproval(approval, 'initial'), { status: 401, code: 'ACCESS_TOKEN_EXPIRED' });
  assert.deepEqual(paths, ['/api/v1/approvals/appr-1/decision', '/api/auth/refresh', '/api/auth/me']);
  assert.deepEqual(await authStorage.getAuthSession(), { ...session, accessToken: nextToken });
  assert.equal((await apiClient.decideApproval(approval, 're-entered')).status, 'approved');
  assert.equal(paths.length, 4);
});

test('sensitive approvals require explicit token expiry and HTTPS for the password', async () => {
  const approval = { approvalId: 'appr-1', decision: 'approved' as const, expectedVersion: 3, key: 'same-key', reason: 'Motivo' };
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return expired(true);
  };
  await assert.rejects(apiClient.decideApproval(approval, 'current'), { status: 401, code: undefined });
  assert.equal(requests, 1);
  await authStorage.saveAuthSession({ ...session, apiUrl: 'http://127.0.0.1:3000' });
  await assert.rejects(apiClient.decideApproval(approval, 'current'), /HTTPS/);
  assert.equal(requests, 1);
});

test('keeps the stored session on transient refresh failure and clears it on definitive revocation', async () => {
  let invalidated = 0;
  let status = 503;
  const stop = handleUnauthorized(() => {
    invalidated++;
    void authStorage.clearAuthSession();
  });
  try {
    globalThis.fetch = async (input) => String(input).endsWith('/auth/refresh') ? json(status, { success: false }) : expired();
    await assert.rejects(apiClient.listConversations(), { status: 503 });
    assert.deepEqual(await authStorage.getAuthSession(), session);
    assert.equal(invalidated, 0);

    status = 401;
    await assert.rejects(apiClient.listConversations(), { status: 401 });
    assert.equal(await authStorage.getAuthSession(), null);
    assert.equal(invalidated, 1);
  } finally {
    stop();
  }
});

for (const replace of [false, true]) {
  test(`a late refresh cannot replay after ${replace ? 'signing in to another account' : 'logout'}`, async () => {
    const started = deferred();
    const released = deferred();
    const replacement = { ...session, tenantId: '19', userId: '74', accessToken: 'other-access', refreshToken: 'other-refresh' };
    const requests: string[] = [];
    globalThis.fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      requests.push(path);
      if (path === '/api/auth/refresh') {
        started.resolve();
        await released.promise;
        return renewed();
      }
      return expired();
    };
    const pending = assert.rejects(apiClient.sendMessage(command), { status: 401 });
    await started.promise;
    await authStorage.clearAuthSession();
    if (replace) await authStorage.saveAuthSession(replacement);
    released.resolve();
    await pending;
    assert.deepEqual(requests, ['/api/v1/conversations/8/messages', '/api/auth/refresh']);
    assert.deepEqual(await authStorage.getAuthSession(), replace ? replacement : null);
  });
}

test('prevents replay when the renewed token is for a different workspace', async () => {
  let writes = 0;
  let invalidated = 0;
  const stop = handleUnauthorized(() => { invalidated++; });
  try {
    globalThis.fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/auth/refresh') return renewed();
      if (path === '/api/auth/me') return user('77');
      writes++;
      return expired();
    };
    await assert.rejects(apiClient.sendMessage(command), { status: 401 });
    assert.equal(writes, 1);
    assert.equal(invalidated, 1);
    assert.deepEqual(await authStorage.getAuthSession(), session);
  } finally {
    stop();
  }
});

test('does not start a second refresh or replay when the retried operation returns 401', async () => {
  let refreshes = 0;
  let writes = 0;
  globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === '/api/auth/refresh') {
      refreshes++;
      return renewed();
    }
    if (path === '/api/auth/me') return user();
    writes++;
    return expired();
  };
  await assert.rejects(apiClient.sendMessage(command), { status: 401 });
  assert.equal(refreshes, 1);
  assert.equal(writes, 2);
});

test('does not expose a late business conflict from a previous session to the active screen', async () => {
  const started = deferred();
  const released = deferred();
  globalThis.fetch = async () => {
    started.resolve();
    await released.promise;
    return json(409, { detail: 'Conversation changed' });
  };
  const pending = assert.rejects(apiClient.takeoverConversation(8, 3), { status: 401 });
  await started.promise;
  await authStorage.saveAuthSession({ ...session, userId: '49', accessToken: 'another-access' });
  released.resolve();
  await pending;
});
