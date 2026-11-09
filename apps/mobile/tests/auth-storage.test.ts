import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { authStorage, MemoryStorageBackend, type AuthSession } from '../src/services/authStorage';

let storage: MemoryStorageBackend;
const session: AuthSession = {
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  userId: '33',
  tenantId: '8',
  apiUrl: 'https://backend.example.com',
};

beforeEach(() => {
  storage = new MemoryStorageBackend();
  authStorage.setBackendForTest(storage);
});

test('persists and clears a complete session as a single record', async () => {
  await authStorage.saveAuthSession(session);
  assert.deepEqual(await authStorage.getAuthSession(), session);
  await authStorage.clearAuthSession();
  assert.equal(await authStorage.getAuthSession(), null);
});

test('removes seeded legacy credentials without treating them as a session', async () => {
  const mockToken = 'mock_jwt_mobile_agent_token';
  await authStorage.saveAuthSession({ ...session, accessToken: mockToken });
  await storage.setItem('whatsap_automat_access_token', mockToken);

  assert.equal(await authStorage.getAuthSession(), null);
  assert.equal(await storage.getItem('whatsap_automat_access_token'), null);
});

test('recovers from a corrupt stored session', async () => {
  await storage.setItem('whatsap_automat_auth_session', '{invalid');
  assert.equal(await authStorage.getAuthSession(), null);
  assert.equal(await storage.getItem('whatsap_automat_auth_session'), null);
});
