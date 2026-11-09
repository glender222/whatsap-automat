import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { apiClient, handleUnauthorized, MobileApiError, normalizeServerUrl } from '../src/services/apiClient';
import { authStorage, MemoryStorageBackend } from '../src/services/authStorage';
import { canDecideMobileApproval } from '../src/services/approvalPolicy';

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

const approval = {
  id: 'approval-fixture', policyVersion: 7, risk: 'write', status: 'pending' as const,
  expiresAt: '2026-11-20T10:00:00Z', createdAt: '2026-11-20T09:00:00Z',
};

test('reads canonical workspace capability and tenant-scoped approval list and detail with the signed session', async () => {
  await authStorage.saveAuthSession(session);
  globalThis.fetch = async (url, init) => {
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer access-token');
    assert.equal(new Headers(init?.headers).has('X-Tenant-Id'), false);
    switch (url) {
      case `${session.apiUrl}/api/v1/workspaces/current`: return json(200, { capabilities: ['approvals.review'] });
      case `${session.apiUrl}/api/v1/approvals?status=pending&limit=50&offset=50`: return json(200, [approval]);
      case `${session.apiUrl}/api/v1/approvals/${approval.id}`: return json(200, approval);
      default: throw new Error(`Unexpected route ${url}`);
    }
  };
  assert.deepEqual(await apiClient.getCurrentWorkspace(), { capabilities: ['approvals.review'] });
  assert.deepEqual(await apiClient.listApprovals(50), [approval]);
  assert.deepEqual(await apiClient.getApproval(approval.id), approval);
});

test('writes only the canonical decision and version, reuses the given key and preserves 409 and 410', async () => {
  await authStorage.saveAuthSession(session);
  const command = { approvalId: approval.id, decision: 'approved' as const, expectedVersion: approval.policyVersion, key: 'approval-key' };
  let attempts = 0;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, `${session.apiUrl}/api/v1/approvals/${approval.id}/decision`);
    assert.equal(init?.method, 'POST');
    assert.equal(new Headers(init?.headers).get('Idempotency-Key'), command.key);
    assert.deepEqual(JSON.parse(String(init?.body)), { decision: 'approved', expectedVersion: 7 });
    attempts++;
    if (attempts === 1) throw new TypeError('Fixture dropped connection');
    if (attempts === 3) return json(409, { detail: 'Approval changed' });
    if (attempts === 4) return json(410, { detail: 'Approval expired' });
    return json(200, { approvalId: approval.id, status: 'approved' });
  };
  await assert.rejects(apiClient.decideApproval(command), TypeError);
  assert.equal(attempts, 1);
  assert.equal((await apiClient.decideApproval(command)).status, 'approved');
  await assert.rejects(apiClient.decideApproval(command), { status: 409 });
  await assert.rejects(apiClient.decideApproval(command), { status: 410 });
});

test('fails closed for high, financial, destructive or unknown risks and for stale or invalid details', () => {
  const now = Date.parse('2026-11-20T09:30:00Z');
  for (const risk of ['low', 'medium', 'read', 'write', 'send']) {
    assert.equal(canDecideMobileApproval({ ...approval, risk }, now), true);
  }
  for (const risk of ['high', 'financial', 'destructive', 'unexpected-risk']) {
    assert.equal(canDecideMobileApproval({ ...approval, risk }, now), false);
  }
  assert.equal(canDecideMobileApproval({ ...approval, status: 'rejected' }, now), false);
  assert.equal(canDecideMobileApproval({ ...approval, policyVersion: 0 }, now), false);
  assert.equal(canDecideMobileApproval({ ...approval, expiresAt: 'invalid' }, now), false);
  assert.equal(canDecideMobileApproval(approval, Date.parse(approval.expiresAt)), false);
});

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

test('sends canonical text with a stable request key and never retries a transport failure automatically', async () => {
  await authStorage.saveAuthSession(session);
  let attempts = 0;
  const command = { conversationId: '8', expectedVersion: 3, key: 'mobile-request-1', text: 'Hola' };
  globalThis.fetch = async (input, init) => {
    attempts++;
    assert.equal(input, `${session.apiUrl}/api/v1/conversations/8/messages`);
    assert.equal(init?.method, 'POST');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('Authorization'), 'Bearer access-token');
    assert.equal(headers.get('Idempotency-Key'), command.key);
    assert.deepEqual(JSON.parse(String(init?.body)), {
      expectedConversationVersion: 3, message: { kind: 'text', text: 'Hola' },
    });
    if (attempts === 1) throw new TypeError('network failed after dispatch');
    return json(202, { accepted: true, providerMessageId: 'wamid.qa', deliveryState: 'provider_accepted' });
  };

  await assert.rejects(apiClient.sendMessage(command), TypeError);
  assert.equal(attempts, 1);
  assert.equal(await apiClient.sendMessage(command), 'accepted');
  assert.equal(attempts, 2);
});

test('distinguishes an acknowledged rejection, unresolved delivery and a canonical conflict', async () => {
  await authStorage.saveAuthSession(session);
  const command = { conversationId: 8, expectedVersion: 3, key: 'mobile-request-1', text: 'Hola' };
  globalThis.fetch = async () => json(202, { accepted: false, deliveryState: 'failed', providerMessageId: null });
  assert.equal(await apiClient.sendMessage(command), 'failed');
  globalThis.fetch = async () => json(202, { accepted: false, deliveryState: 'unknown_delivery', providerMessageId: null });
  assert.equal(await apiClient.sendMessage(command), 'unknown_delivery');
  globalThis.fetch = async () => json(202, { accepted: true, deliveryState: 'provider_accepted', providerMessageId: null });
  assert.equal(await apiClient.sendMessage(command), 'unknown_delivery');
  globalThis.fetch = async () => json(409, {
    detail: 'Conversation version changed.', metadata: { reasonCode: 'CONVERSATION_VERSION_CHANGED', currentVersion: 4 },
  });
  await assert.rejects(apiClient.sendMessage(command), (error: unknown) =>
    error instanceof MobileApiError && error.status === 409 &&
      error.metadata?.reasonCode === 'CONVERSATION_VERSION_CHANGED' && error.metadata.currentVersion === 4);
});

test('maps canonical history and cursor for reconciliation of an exact outbound request', async () => {
  await authStorage.saveAuthSession(session);
  globalThis.fetch = async (input) => {
    assert.equal(input, `${session.apiUrl}/api/v1/conversations/8/messages?limit=50&cursor=qa%2Fcursor`);
    return json(200, { items: [{
      id: '10', body: 'Hola', direction: 'outbound', deliveryState: 'unknown_delivery',
      clientRequestId: 'mobile-request-1', causedBy: { type: 'human' }, attachments: [], createdAt: '2026-08-01T10:00:00Z',
    }], nextCursor: 'older' });
  };
  assert.deepEqual(await apiClient.listConversationMessages(8, 'qa/cursor'), {
    messages: [{
      id: '10', body: 'Hola', fromMe: true, timestamp: Date.parse('2026-08-01T10:00:00Z'),
      type: 'text', status: 'unknown_delivery', clientRequestId: 'mobile-request-1',
    }],
    nextCursor: 'older',
  });
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    assert.equal(url.pathname, '/api/v1/conversations/8/messages');
    assert.equal(url.searchParams.get('limit'), '1');
    assert.equal(url.searchParams.get('clientRequestId'), 'mobile-request:1');
    return json(200, { items: [], nextCursor: null });
  };
  assert.deepEqual(await apiClient.listConversationMessages(8, undefined, 'mobile-request:1'), {
    messages: [], nextCursor: null,
  });
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
