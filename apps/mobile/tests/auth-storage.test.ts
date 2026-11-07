import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { AuthStorageService, MemoryStorageBackend, AuthSession } from '../src/services/authStorage';

describe('Phase F9 Mobile: AuthStorageService Tests', () => {
  let memoryStorage: MemoryStorageBackend;
  let service: AuthStorageService;

  beforeEach(() => {
    memoryStorage = new MemoryStorageBackend();
    service = AuthStorageService.getInstance();
    service.setBackendForTest(memoryStorage);
  });

  test('1. Saves and retrieves auth session with JWT, tenantId, and userId', async () => {
    const session: AuthSession = {
      accessToken: 'jwt_mobile_token_123',
      refreshToken: 'refresh_token_456',
      tenantId: '1',
      userId: '42',
      apiUrl: 'http://localhost:3000/api/v1',
    };

    await service.saveAuthSession(session);

    const retrieved = await service.getAuthSession();
    assert.deepEqual(retrieved, session);

    const token = await service.getAccessToken();
    assert.equal(token, 'jwt_mobile_token_123');

    const tenantId = await service.getTenantId();
    assert.equal(tenantId, '1');

    const userId = await service.getUserId();
    assert.equal(userId, '42');

    const isAuthed = await service.isAuthenticated();
    assert.equal(isAuthed, true);
  });

  test('2. Clears auth session on logout', async () => {
    await service.saveAuthSession({
      accessToken: 'jwt_to_be_cleared',
      tenantId: '1',
      userId: '42',
    });

    assert.equal(await service.isAuthenticated(), true);

    await service.clearAuthSession();

    assert.equal(await service.getAccessToken(), null);
    assert.equal(await service.getAuthSession(), null);
    assert.equal(await service.isAuthenticated(), false);
  });

  test('3. Returns default API URL when none is explicitly configured', async () => {
    const url = await service.getApiUrl();
    assert.equal(url, 'http://localhost:3000/api/v1');
  });
});
