import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { MobileApiClient } from '../src/services/apiClient';
import { AuthStorageService, MemoryStorageBackend } from '../src/services/authStorage';
import { ConflictError } from '@whatsap-automat/sdk';

describe('Phase F9 Mobile: MobileApiClient Tests', () => {
  let originalFetch: typeof global.fetch;
  let storage: AuthStorageService;
  let client: MobileApiClient;

  beforeEach(() => {
    originalFetch = global.fetch;
    const memoryBackend = new MemoryStorageBackend();
    storage = AuthStorageService.getInstance();
    storage.setBackendForTest(memoryBackend);
    client = MobileApiClient.getInstance();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('1. Injects Authorization Bearer and X-Tenant-Id headers on requests', async () => {
    await storage.saveAuthSession({
      accessToken: 'test_bearer_token',
      tenantId: '99',
      userId: '1',
      apiUrl: 'http://api.mock.internal/v1',
    });

    let capturedUrl = '';
    let capturedHeaders: any = null;

    global.fetch = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedHeaders = init?.headers;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          items: [{ id: 'conv_1', tenantId: '99', channel: 'whatsapp-cloud', stateVersion: 1 }],
          nextCursor: null,
          hasMore: false,
        }),
      } as any;
    }) as any;

    const res = await client.listConversations();
    assert.equal(capturedUrl, 'http://api.mock.internal/v1/conversations');
    assert.equal(capturedHeaders['Authorization'], 'Bearer test_bearer_token');
    assert.equal(capturedHeaders['X-Tenant-Id'], '99');
    assert.equal(res.items.length, 1);
  });

  test('2. Injects Idempotency-Key on sending conversation messages', async () => {
    await storage.saveAuthSession({
      accessToken: 'token_1',
      tenantId: '1',
      userId: '1',
      apiUrl: 'http://api.mock.internal/v1',
    });

    let capturedHeaders: any = null;
    let capturedBody: any = null;

    global.fetch = (async (url: string, init?: RequestInit) => {
      capturedHeaders = init?.headers;
      capturedBody = JSON.parse(init?.body as string);
      return {
        ok: true,
        status: 202,
        json: async () => ({
          providerMessageId: 'prov_123',
          accepted: true,
          rawStatus: 'dispatched',
          deliveryState: 'dispatched',
        }),
      } as any;
    }) as any;

    const res = await client.sendMessage('conv_42', {
      text: 'Hello from mobile agent',
      expectedConversationVersion: 3,
      idempotencyKey: 'idemp_key_custom_99',
    });

    assert.equal(capturedHeaders['Idempotency-Key'], 'idemp_key_custom_99');
    assert.equal(capturedBody.expectedConversationVersion, 3);
    assert.equal(capturedBody.message.text, 'Hello from mobile agent');
    assert.equal(res.accepted, true);
  });

  test('3. Parses RFC 7807 409 Conflict ProblemDetails into typed ConflictError', async () => {
    await storage.saveAuthSession({
      accessToken: 'token_1',
      tenantId: '1',
      userId: '1',
      apiUrl: 'http://api.mock.internal/v1',
    });

    global.fetch = (async () => {
      return {
        ok: false,
        status: 409,
        statusText: 'Conflict',
        headers: new Headers({ 'content-type': 'application/problem+json' }),
        json: async () => ({
          type: 'https://api.whatsap-automat.internal/errors/conflict',
          title: 'Resource conflict or stale version',
          status: 409,
          detail: 'Conversation 101 version conflict: expected version 1, but current version is 2',
          instance: '/conversations/101/takeover',
          code: 'CONFLICT',
          correlationId: 'corr_test_409',
          metadata: {
            conversationId: '101',
            expectedVersion: 1,
            currentVersion: 2,
            ownerType: 'human',
          },
        }),
      } as any;
    }) as any;

    await assert.rejects(
      async () => {
        await client.takeoverConversation('101', {
          expectedVersion: 1,
          userId: '1',
        });
      },
      (err: any) => {
        assert(err instanceof ConflictError, 'Error must be instance of ConflictError');
        assert.equal(err.status, 409);
        assert.equal(err.code, 'CONFLICT');
        assert.equal(err.metadata?.expectedVersion, 1);
        assert.equal(err.metadata?.currentVersion, 2);
        return true;
      }
    );
  });
});
