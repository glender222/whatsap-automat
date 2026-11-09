import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { api } from '../shared/axios/http';

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
  assert.equal(localStorage.getItem('accessToken'), 'owner-B');
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
  assert.equal(localStorage.getItem('accessToken'), 'new-owner');
  assert.equal(localStorage.getItem('refreshToken'), 'new-refresh');
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
