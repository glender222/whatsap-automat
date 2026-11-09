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

test('a queued clear or sign-in takes precedence over an in-progress secure write', async () => {
  let start!: () => void;
  let unblock!: () => void;
  const writing = new Promise<void>((done) => { start = done; });
  const released = new Promise<void>((done) => { unblock = done; });
  const setItem = storage.setItem.bind(storage);
  storage.setItem = async (key, value) => {
    if (JSON.parse(value).accessToken === 'late-token') {
      start();
      await released;
    }
    await setItem(key, value);
  };
  await authStorage.saveAuthSession(session);
  const before = await authStorage.getSnapshot();
  assert.ok(before);
  const rotating = authStorage.rotateAccessToken(before, 'late-token');
  await writing;
  const clearing = authStorage.clearAuthSession();
  const replacement = { ...session, userId: '77', accessToken: 'replacement-token' };
  const saving = authStorage.saveAuthSession(replacement);
  unblock();
  assert.equal(await rotating, null);
  assert.equal((await clearing)?.accessToken, 'late-token');
  await saving;
  assert.deepEqual(await authStorage.getAuthSession(), replacement);
});

test('logout blocks further use of the session even if the secure storage deletion fails', async () => {
  await authStorage.saveAuthSession(session);
  storage.deleteItem = async () => { throw new Error('Secure store is unavailable'); };
  await assert.rejects(authStorage.clearAuthSession(), /Secure store is unavailable/);
  assert.equal(await authStorage.getSnapshot(), null);
  assert.ok(await storage.getItem('whatsap_automat_auth_session'));
});
