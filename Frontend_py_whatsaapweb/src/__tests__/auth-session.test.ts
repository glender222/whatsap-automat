import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { api } from '../shared/axios/http';
import { readSession, saveSession } from '../shared/auth/session';
import { logoutSession } from '../factures/auth/services/authService';
import { currentApprovalSession, decideApproval } from '../factures/dashboard/approvals/approvalApi';

function response(config: InternalAxiosRequestConfig, status: number, data = {}) {
  return { config, status, statusText: String(status), data, headers: {} };
}

function expired(config: InternalAxiosRequestConfig) {
  return new AxiosError('Expired session', undefined, config, undefined, response(config, 401, {
    code: 'ACCESS_TOKEN_EXPIRED',
  }));
}

function session(access: string, refresh: string) {
  localStorage.setItem('accessToken', access);
  localStorage.setItem('refreshToken', refresh);
}

function useAuthFixture(t: TestContext) {
  const values = new Map<string, string>();
  const stored = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });
  const adapter = api.defaults.adapter;
  t.after(() => {
    api.defaults.adapter = adapter;
    if (stored) Object.defineProperty(globalThis, 'localStorage', stored);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });
}

test('an expired mutation from a previous account never renews or replays as the current account', async (t) => {
  useAuthFixture(t);
  const sent: Array<[string | undefined, unknown]> = [];
  session('owner-A', 'refresh-A');
  api.defaults.adapter = async (config) => {
    sent.push([config.url, config.headers.get('Authorization')]);
    if (config.url === '/auth/refresh') {
      return response(config, 200, { success: true, data: { accessToken: 'new-owner-B' } });
    }
    if (sent.length === 1) {
      session('owner-B', 'refresh-B');
      throw expired(config);
    }
    return response(config, 200);
  };
  await assert.rejects(api.post('/orders/7/cancel', {}), AxiosError);
  assert.deepEqual(sent, [['/orders/7/cancel', 'Bearer owner-A']]);
  assert.equal(readSession().accessToken, 'owner-B');
});

test('concurrent requests share one renewal and retry with the refreshed token', async (t) => {
  useAuthFixture(t);
  session('expired-access', 'active-refresh');
  let renewals = 0;
  let retried = 0;
  api.defaults.adapter = async (config) => {
    if (config.url === '/auth/refresh') {
      renewals++;
      assert.equal(config.headers.get('Authorization'), undefined);
      return response(config, 200, { success: true, data: { accessToken: 'fresh-access' } });
    }
    if (config.headers.get('Authorization') === 'Bearer expired-access') throw expired(config);
    assert.equal(config.headers.get('Authorization'), 'Bearer fresh-access');
    retried++;
    return response(config, 200);
  };
  await Promise.all([api.get('/orders'), api.get('/tags')]);
  assert.equal(renewals, 1);
  assert.equal(retried, 2);
});

test('renewal completed after an account switch cannot overwrite the new session', async (t) => {
  useAuthFixture(t);
  session('old-owner', 'old-refresh');
  let mutations = 0;
  api.defaults.adapter = async (config) => {
    if (config.url === '/auth/refresh') {
      session('new-owner', 'new-refresh');
      return response(config, 200, { success: true, data: { accessToken: 'late-owner' } });
    }
    mutations++;
    throw expired(config);
  };
  await assert.rejects(api.post('/orders/7/cancel', {}), { code: 'ERR_CANCELED' });
  assert.equal(mutations, 1);
  assert.equal(readSession().accessToken, 'new-owner');
  assert.equal(readSession().refreshToken, 'new-refresh');
});

test('a late successful response from a previous account is discarded', async (t) => {
  useAuthFixture(t);
  session('owner-A', 'refresh-A');
  api.defaults.adapter = async (config) => {
    session('owner-B', 'refresh-B');
    return response(config, 200, { private: 'old account' });
  };
  await assert.rejects(api.get('/orders'), { code: 'ERR_CANCELED' });
});

test('a downstream provider 401 does not replay a mutation', async (t) => {
  useAuthFixture(t);
  session('active-owner', 'active-refresh');
  const sent: Array<string | undefined> = [];
  api.defaults.adapter = async (config) => {
    sent.push(config.url);
    throw new AxiosError('Provider unauthorized', undefined, config, undefined, response(config, 401, {
      error: 'META_API_ERROR',
    }));
  };
  await assert.rejects(api.post('/chats/7/messages', {}), AxiosError);
  assert.deepEqual(sent, ['/chats/7/messages']);
});

test('a protected download recognizes an expired JWT returned as a JSON blob', async (t) => {
  useAuthFixture(t);
  session('expired-access', 'active-refresh');
  const file = new Blob(['report'], { type: 'text/csv' });
  api.defaults.adapter = async (config) => {
    if (config.url === '/auth/refresh') {
      return response(config, 200, { success: true, data: { accessToken: 'fresh-access' } });
    }
    assert.equal(config.responseType, 'blob');
    if (config.headers.get('Authorization') === 'Bearer expired-access') {
      const body = new Blob(['{"code":"ACCESS_TOKEN_EXPIRED"}'], { type: 'application/json' });
      throw new AxiosError('Expired session', undefined, config, undefined, response(config, 401, body));
    }
    assert.equal(config.headers.get('Authorization'), 'Bearer fresh-access');
    return response(config, 200, file);
  };
  assert.equal((await api.get('/reports/operations/export', { responseType: 'blob' })).data, file);
});

test('an expired approval password request renews the session without replaying the password', async (t) => {
  useAuthFixture(t);
  session('expired-access', 'active-refresh');
  const calls: Array<string | undefined> = [];
  api.defaults.adapter = async (config) => {
    calls.push(config.url);
    if (config.url === '/auth/refresh') {
      assert.ok(!String(config.data).includes('local-password-fixture'));
      return response(config, 200, { success: true, data: { accessToken: 'fresh-access' } });
    }
    assert.equal(JSON.parse(config.data).password, 'local-password-fixture');
    throw expired(config);
  };
  await assert.rejects(decideApproval({ approvalId: 'test', decision: 'approved', expectedVersion: 1,
    reason: 'Reviewed fixture', key: 'approval-attempt' }, currentApprovalSession()!, 'local-password-fixture'), AxiosError);
  assert.deepEqual(calls, ['/v1/approvals/test/decision', '/auth/refresh']);
  assert.equal(readSession().accessToken, 'fresh-access');
});


test('renewing a legacy session migrates credentials to one record without changing its generation', async (t) => {
  useAuthFixture(t);
  session('expired-access', 'active-refresh');
  const generation = readSession().generation;
  api.defaults.adapter = async (config) => {
    if (config.url === '/auth/refresh') {
      return response(config, 200, { success: true, data: { accessToken: 'fresh-access', refreshToken: 'fresh-refresh' } });
    }
    if (config.headers.get('Authorization') === 'Bearer expired-access') throw expired(config);
    return response(config, 200);
  };
  await api.get('/auth/me');
  assert.equal(readSession().generation, generation);
  assert.equal(readSession().accessToken, 'fresh-access');
  assert.equal(readSession().refreshToken, 'fresh-refresh');
  assert.equal(localStorage.getItem('accessToken'), null);
  assert.equal(localStorage.getItem('refreshToken'), null);
  assert.doesNotMatch(localStorage.getItem('auth')!, /expired-access|active-refresh/);
});

test('a structured revoked response clears only the generation that made the request', async (t) => {
  useAuthFixture(t);
  const operator = { id: '1', nombre: 'Fixture', email: 'fixture@example.test', rol: 'ADMIN' as const, idPadre: null };
  saveSession(operator, 'owner-A', 'refresh-A');
  api.defaults.adapter = async (config) => {
    if (config.headers.get('Authorization') === 'Bearer owner-A') {
      saveSession({ ...operator, id: '2' }, 'owner-B', 'refresh-B');
    }
    throw new AxiosError('Revoked', undefined, config, undefined, response(config, 401, { code: 'SESSION_REVOKED' }));
  };
  await assert.rejects(api.get('/auth/me'), AxiosError);
  assert.equal(readSession().accessToken, 'owner-B');
  assert.equal(readSession().refreshToken, 'refresh-B');
  await assert.rejects(api.get('/auth/me'), AxiosError);
  assert.equal(readSession().accessToken, null);
  assert.equal(localStorage.getItem('auth'), null);
});


test('a pending logout for A cannot clear the replacement session B', async (t) => {
  useAuthFixture(t);
  const operator = { id: '1', nombre: 'Fixture', email: 'fixture@example.test', rol: 'ADMIN' as const, idPadre: null };
  const accountA = saveSession(operator, 'owner-A', 'refresh-A');
  api.defaults.adapter = async (config) => {
    assert.equal(config.url, '/auth/logout');
    assert.equal(config.headers.get('Authorization'), 'Bearer owner-A');
    assert.deepEqual(JSON.parse(config.data), { refreshToken: 'refresh-A' });
    saveSession({ ...operator, id: '2' }, 'owner-B', 'refresh-B');
    return response(config, 200, { success: true });
  };
  assert.equal(await logoutSession(accountA.generation), false);
  assert.equal(readSession().accessToken, 'owner-B');
  assert.equal(readSession().refreshToken, 'refresh-B');
});
