import './fixtures/testEnv';
import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { test, type TestContext } from 'node:test';
import { channelConnectionV1Schema } from '@whatsap-automat/contracts';
import express from 'express';
import { Pool } from 'pg';
import { TenantScopedUoW } from '../db/TenantScopedUoW';
import createChannelConnectionRoutes from '../routes/channelConnectionRoutes';
import { ChannelConnections } from '../services/channels/ChannelConnections';
import MetaAccountStore from '../services/whatsapp/meta/MetaAccountStore';

const jwt = require('jsonwebtoken') as { sign(claims: Record<string, unknown>, key: string): string };
const connectionString = process.env.CHANNEL_CONNECTIONS_TEST_DATABASE_URL;
const tenantA = randomInt(500_000_000, 700_000_000);
const tenantB = tenantA + 1;

function token(tenantId: number, role = 'ADMIN', secret = process.env.JWT_SECRET!) {
  return jwt.sign({ companyId: tenantId, userId: 12, rol: role }, secret);
}

async function address(t: TestContext, server: Server) {
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  await once(server, 'listening');
  const bound = server.address();
  assert.ok(bound && typeof bound !== 'string');
  return `http://127.0.0.1:${bound.port}`;
}

async function channelHttp(t: TestContext, service?: ChannelConnections) {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/channel-connections', createChannelConnectionRoutes(service));
  const url = await address(t, app.listen(0, '127.0.0.1'));
  return async (path: string, auth?: string, payload?: unknown) => {
    const response = await fetch(`${url}/api/v1/channel-connections${path}`, {
      method: payload === undefined ? 'GET' : 'POST',
      headers: {
        ...(auth ? { authorization: `Bearer ${auth}` } : {}),
        'content-type': 'application/json',
        'x-tenant-id': String(tenantB),
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
}

test('channel HTTP requires signed tenancy and administrators for validation', async (t) => {
  const request = await channelHttp(t);
  assert.equal((await request('/')).status, 401);
  assert.equal((await request('/', token(tenantA, 'ADMIN', 'forged-test-key'))).status, 401);
  assert.equal((await request('/some-id/validate', token(tenantA, 'USER'), { role: 'ADMIN' })).status, 403);
  assert.equal((await request('/?limit=0', token(tenantA))).status, 422);
  assert.equal((await request('/%00/validate', token(tenantA), {})).status, 422);
});

test('canonical connections use tenant-scoped encrypted credentials and real read-only Graph diagnostics', {
  skip: !connectionString && 'CHANNEL_CONNECTIONS_TEST_DATABASE_URL is required',
}, async (t) => {
  const pool = new Pool({ connectionString });
  t.after(() => pool.end());
  const uow = new TenantScopedUoW(pool);
  const accounts = new MetaAccountStore(pool);
  const { rows: [role] } = await pool.query(`
    SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user
  `);
  assert.deepEqual(role, { rolsuper: false, rolbypassrls: false });
  const { rows: [rls] } = await pool.query(`
    SELECT count(*)::int AS tables, bool_and(relrowsecurity AND relforcerowsecurity) AS enforced
    FROM pg_class WHERE oid IN ('channel_connections'::regclass, 'whatsapp_business_accounts'::regclass)
  `);
  assert.deepEqual(rls, { tables: 2, enforced: true });
  for (const id of [tenantA, tenantB]) {
    await uow.run(id, async (db) => {
      await db.query('INSERT INTO companies (id, name) VALUES ($1, $2)', [id, 'Channel test company']);
      await db.query('INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)', [id, 'Channel test tenant', `channel-test-${id}`]);
    });
  }

  const phone = `120${tenantA}`;
  const connectionId = `wa-meta-${tenantA}-${phone}`;
  const secret = 'fixture-meta-token-is-private';
  const credentialInput = { phoneNumberId: phone, graphVersion: 'v25.0', accessToken: secret };
  const account = await accounts.upsertConnection(tenantA, {
    ...credentialInput,
    webhookVerifyToken: 'fixture-meta-webhook-secret',
    metadata: { privateProviderMetadata: 'fixture-meta-metadata-secret' },
  });
  assert.ok(typeof account.access_token_encrypted === 'string' && account.access_token_encrypted.startsWith('v1:'));
  assert.notEqual(account.access_token_encrypted, secret);
  await uow.run(tenantA, async (db) => {
    await db.query(`
      INSERT INTO channel_connections (id, tenant_id, channel, account_id, credentials_encrypted)
      VALUES ('01-unsupported', $1, 'telegram', 'bot-fixture', '{"token":"fixture-unsupported-secret"}'),
        ('02-unconfigured', $1, 'whatsapp-cloud', '199000000001', '{"token":"fixture-alternate-secret"}')
    `, [tenantA]);
  });
  assert.equal((await pool.query('SELECT id FROM channel_connections')).rowCount, 0);
  assert.equal((await pool.query('SELECT id FROM whatsapp_business_accounts')).rowCount, 0);

  const calls: { url?: string; method?: string; authorization?: string }[] = [];
  let reply = (_req: IncomingMessage, res: ServerResponse) => res.end(JSON.stringify({ id: phone }));
  const graph = await address(t, createServer((req, res) => {
    calls.push({ url: req.url, method: req.method, authorization: req.headers.authorization });
    res.setHeader('Content-Type', 'application/json');
    reply(req, res);
  }).listen(0, '127.0.0.1'));
  const fetchGraph: typeof fetch = (input, init) => {
    const target = new URL(String(input));
    assert.equal(target.origin, 'https://graph.facebook.com');
    return fetch(`${graph}${target.pathname}${target.search}`, init);
  };
  const request = await channelHttp(t, new ChannelConnections(uow, accounts, fetchGraph));
  const admin = token(tenantA);
  const otherAdmin = token(tenantB);
  const validate = `/${connectionId}/validate`;
  const list = await request('/', token(tenantA, 'USER'));
  assert.equal(list.status, 200);
  channelConnectionV1Schema.array().parse(list.body);
  assert.equal(list.headers.get('cache-control'), 'no-store');
  assert.deepEqual(list.body.map((connection: { id: string }) => connection.id), ['01-unsupported', '02-unconfigured', connectionId]);
  assert.deepEqual(list.body[2].health, {
    configured: true, authorized: false, lastErrorCode: 'VALIDATION_REQUIRED', lastCheckedAt: null,
  });
  for (const marker of [
    secret, 'fixture-meta-webhook-secret', 'fixture-meta-metadata-secret', 'fixture-unsupported-secret',
    'fixture-alternate-secret', String(account.access_token_encrypted),
  ]) {
    assert.ok(!JSON.stringify(list.body).includes(marker));
  }
  const detail = await request(`/${connectionId}`, token(tenantA, 'USER'));
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.body, list.body[2]);
  assert.deepEqual((await request('/', otherAdmin)).body, []);
  assert.equal((await request(`/${connectionId}`, otherAdmin)).status, 404);
  assert.equal((await request(validate, otherAdmin, { tenantId: tenantA })).status, 404);
  assert.equal((await request('/01-unsupported/validate', admin, {})).body.lastErrorCode, 'CHANNEL_UNSUPPORTED');
  assert.equal((await request('/02-unconfigured/validate', admin, {})).body.lastErrorCode, 'META_ACCOUNT_NOT_CONNECTED');
  const page = await request('/?limit=1', admin);
  assert.equal(page.headers.get('x-next-cursor'), '01-unsupported');
  assert.equal((await request('/?limit=1&after=01-unsupported', admin)).body[0].id, '02-unconfigured');
  assert.equal(calls.length, 0);

  const checked = await request(validate, admin, {
    accessToken: 'ignored-client-token', phoneNumberId: '123', graphUrl: 'http://untrusted.invalid',
  });
  assert.equal(checked.status, 200);
  assert.equal(checked.body.configured, true);
  assert.equal(checked.body.authorized, true);
  assert.equal(checked.body.lastErrorCode, null);
  assert.match(checked.body.lastCheckedAt, /^\d{4}-/);
  assert.deepEqual(calls, [{ url: `/v25.0/${phone}?fields=id`, method: 'GET', authorization: `Bearer ${secret}` }]);
  assert.deepEqual((await request('/', admin)).body[2].health, checked.body);

  reply = (_req, res) => {
    res.statusCode = 401;
    return res.end(JSON.stringify({ error: { code: 190, message: `provider echoed ${secret}` } }));
  };
  const unauthorized = await request(validate, admin, {});
  assert.equal(unauthorized.body.authorized, false);
  assert.equal(unauthorized.body.lastErrorCode, 'META_AUTH_ERROR');
  assert.ok(!JSON.stringify(unauthorized.body).includes(secret));
  assert.deepEqual((await request('/', admin)).body[2].health, unauthorized.body);
  assert.equal((await request('/', admin)).body[2].status, 'needs_reauthorization');

  reply = (_req, res) => res.end(JSON.stringify({ id: 'unexpected-id' }));
  assert.equal((await request(validate, admin, {})).body.lastErrorCode, 'META_ACCOUNT_MISMATCH');
  reply = (_req, res) => {
    res.writeHead(302, { Location: `${graph}/must-not-follow` });
    return res.end();
  };
  assert.equal((await request(validate, admin, {})).body.lastErrorCode, 'META_PROVIDER_UNAVAILABLE');
  assert.ok(calls.every((call) => call.url === `/v25.0/${phone}?fields=id`));

  const started = new Promise<ServerResponse>((resolve) => {
    reply = (_req, res) => {
      resolve(res);
      return res;
    };
  });
  const pending = request(validate, admin, {});
  const blocked = await started;
  await accounts.upsertConnection(tenantA, { ...credentialInput, accessToken: 'rotated-fixture-token' });
  blocked.end(JSON.stringify({ id: phone }));
  assert.equal((await pending).body.lastErrorCode, 'CHECK_SUPERSEDED');
  assert.equal((await request('/', admin)).body[2].health.lastErrorCode, 'VALIDATION_REQUIRED');

  await accounts.disconnect(tenantA);
  const callCount = calls.length;
  assert.equal((await request(validate, admin, {})).body.lastErrorCode, 'CONNECTION_INACTIVE');
  assert.equal(calls.length, callCount);
  assert.equal((await request('/', admin)).body[2].status, 'inactive');
});
