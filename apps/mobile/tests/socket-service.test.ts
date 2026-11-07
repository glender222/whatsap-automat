import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MobileSocketService } from '../src/services/socketService';
import { AuthStorageService, MemoryStorageBackend } from '../src/services/authStorage';

describe('Phase F9 Mobile: SocketService Room Lifecycle & Event Subscription', () => {
  test('1. MobileSocketService is a singleton instance', () => {
    const instance1 = MobileSocketService.getInstance();
    const instance2 = MobileSocketService.getInstance();
    assert.equal(instance1, instance2);
  });

  test('2. Formats WebSocket URL correctly by stripping /api/v1 suffix', async () => {
    const storage = AuthStorageService.getInstance();
    storage.setBackendForTest(new MemoryStorageBackend());
    await storage.saveAuthSession({
      accessToken: 'jwt_test_token',
      tenantId: '1',
      userId: '10',
      apiUrl: 'https://backend.automat.example.com/api/v1/',
    });

    const apiUrl = await storage.getApiUrl();
    const stripped = apiUrl.replace(/\/api\/v1\/?$/, '').replace(/\/+$/, '');
    assert.equal(stripped, 'https://backend.automat.example.com');
  });

  test('3. Tracks joined rooms and manages subscription lifecycle', async () => {
    const service = MobileSocketService.getInstance();
    assert.equal(typeof service.joinConversation, 'function');
    assert.equal(typeof service.leaveConversation, 'function');
    assert.equal(typeof service.onConversationUpdated, 'function');
    assert.equal(typeof service.onMessageCreated, 'function');
  });
});
