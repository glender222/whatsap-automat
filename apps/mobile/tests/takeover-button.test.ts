import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { MobileApiClient } from '../src/services/apiClient';
import { AuthStorageService, MemoryStorageBackend } from '../src/services/authStorage';
import { ConflictError } from '@whatsap-automat/sdk';

describe('Phase F9 Mobile: TakeoverButton CAS Concurrency Logic Tests', () => {
  let originalFetch: typeof global.fetch;
  let client: MobileApiClient;

  beforeEach(() => {
    originalFetch = global.fetch;
    const storage = AuthStorageService.getInstance();
    storage.setBackendForTest(new MemoryStorageBackend());
    client = MobileApiClient.getInstance();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('1. Successful Takeover increments CAS version and assigns operator', async () => {
    global.fetch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      assert.equal(body.expectedVersion, 2);
      assert.equal(body.userId, 'agent_101');

      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          conversationId: 'conv_1',
          previousVersion: 2,
          newVersion: 3,
          epoch: 1,
          ownerType: 'human',
          ownerId: 'agent_101',
          aiPaused: true,
        }),
      } as any;
    }) as any;

    const result = (await client.takeoverConversation('conv_1', {
      expectedVersion: 2,
      userId: 'agent_101',
    })) as any;

    assert.equal(result.success, true);
    assert.equal(result.newVersion, 3);
    assert.equal(result.ownerId, 'agent_101');
    assert.equal(result.aiPaused, true);
  });

  test('2. Stale Takeover triggers RFC 7807 409 Conflict for automatic UI reconciliation', async () => {
    global.fetch = (async () => {
      return {
        ok: false,
        status: 409,
        json: async () => ({
          type: 'https://api.whatsap-automat.internal/errors/conflict',
          title: 'Resource conflict or stale version',
          status: 409,
          detail: 'Conversation conv_1 version conflict: expected version 2, but current version is 3',
          code: 'CONFLICT',
          correlationId: 'corr_cas_stale',
          metadata: {
            conversationId: 'conv_1',
            expectedVersion: 2,
            currentVersion: 3,
          },
        }),
      } as any;
    }) as any;

    let conflictCaught = false;
    let reloadInvoked = false;

    try {
      await client.takeoverConversation('conv_1', {
        expectedVersion: 2,
        userId: 'agent_101',
      });
    } catch (err: any) {
      if (err instanceof ConflictError) {
        conflictCaught = true;
        // Simulating TakeoverButton's onConflict handler triggering state reload
        assert.equal(err.metadata?.expectedVersion, 2);
        assert.equal(err.metadata?.currentVersion, 3);
        reloadInvoked = true;
      }
    }

    assert.equal(conflictCaught, true, 'ConflictError must be caught by CAS handler');
    assert.equal(reloadInvoked, true, 'Reload callback must be invoked on conflict');
  });
});
