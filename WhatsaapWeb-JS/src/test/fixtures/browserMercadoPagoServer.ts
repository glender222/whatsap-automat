import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';

async function main() {
  const backend = new URL(process.env.PRODUCT_SMOKE_URL ?? '');
  const provider = new URL(process.env.PRODUCT_MERCADOPAGO_FIXTURE_URL ?? '');
  for (const endpoint of [backend, provider]) {
    assert.equal(endpoint.protocol, 'http:');
    assert.equal(endpoint.hostname, '127.0.0.1');
    assert.ok(Number(endpoint.port) > 1024);
  }
  assert.equal(process.env.HOST, '127.0.0.1');
  assert.equal(process.env.PORT, backend.port);
  assert.equal(process.env.DB_HOST, '127.0.0.1');
  assert.match(process.env.DB_NAME ?? '', /_smoke$/);
  assert.equal(process.env.META_WA_ACCESS_TOKEN, 'synthetic-local-token');
  assert.equal(process.env.MERCADOPAGO_RECONCILIATION_ENABLED, 'true');
  const { default: pool } = await import('../../config/database');
  const { rows: [role] } = await pool.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user');
  assert.deepEqual(role, { rolsuper: false, rolbypassrls: false });

  type Remote = { token: string; body: Record<string, unknown>; unavailable?: boolean; searchable?: boolean; reads: number };
  const orders = new Map<string, Remote>();
  const server = createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url ?? '/', provider);
    if (req.method === 'GET' && url.pathname === '/health') return send(200, { backend: backend.origin });
    try {
      const fixtureId = url.pathname.match(/^\/fixtures\/orders\/(ORDTST[0-9A-F]{26})$/)?.[1];
      if (fixtureId && req.method === 'GET') {
        const remote = orders.get(fixtureId);
        return send(remote ? 200 : 404, remote ? { reads: remote.reads, status: remote.body.status } : {});
      }
      if (fixtureId && req.method === 'POST') {
        const chunks = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString()) as Partial<Remote>;
        const previous = orders.get(fixtureId);
        assert.ok(previous || (body.token?.startsWith('fixture-mp-') && body.body?.id === fixtureId));
        orders.set(fixtureId, { ...previous, ...body, body: { ...previous?.body, ...body.body }, reads: previous?.reads ?? 0 } as Remote);
        return send(200, { saved: true });
      }
      if (req.method !== 'GET') return send(405, {});
      const authorized = [...orders.values()].filter((order) => req.headers.authorization === `Bearer ${order.token}`);
      if (url.pathname === '/v1/orders') {
        const data = authorized.filter((order) => order.searchable && order.body.external_reference === url.searchParams.get('external_reference'));
        return send(200, { data: data.map((order) => order.body), paging: { total: data.length, total_pages: data.length, offset: 0, limit: 2 } });
      }
      const remote = orders.get(url.pathname.slice('/v1/orders/'.length));
      if (!url.pathname.startsWith('/v1/orders/') || !remote || !authorized.includes(remote)) return send(404, {});
      remote.reads += 1;
      send(remote.unavailable ? 503 : 200, remote.unavailable ? { code: 'fixture_unavailable' } : remote.body);
    } catch { send(400, { code: 'fixture_invalid' }); }
  }).listen(Number(provider.port), provider.hostname);
  await once(server, 'listening');
  server.unref();

  const network = globalThis.fetch;
  globalThis.fetch = (input, options) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.origin === 'https://api.mercadopago.com') {
      assert.equal(options?.method, 'GET');
      assert.equal(options?.redirect, 'error');
      assert.match(new Headers(options?.headers).get('authorization') ?? '', /^Bearer fixture-mp-/);
      return network(provider.origin + url.pathname + url.search, options);
    }
    assert.equal(url.hostname, '127.0.0.1', 'Browser reconciliation fixture rejects external network calls');
    return network(input, options);
  };
  const { App } = require('../../../dist/app') as typeof import('../../app');
  await new App().start();
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Mercado Pago browser server failed');
  process.exitCode = 1;
});
