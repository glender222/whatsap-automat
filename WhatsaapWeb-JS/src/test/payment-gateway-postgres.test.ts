import './fixtures/testEnv';
import assert from 'node:assert/strict';
import { createHmac, randomInt } from 'node:crypto';
import { once } from 'node:events';
import { test, type TestContext } from 'node:test';
import express from 'express';
import { Pool } from 'pg';
import { TenantScopedUoW } from '../db/TenantScopedUoW';
import { requireJwt } from '../middleware/jwtAuth';
import { AgentPaymentLinkService, PaymentGatewayRepositoryPg } from '../modules/ai';
import createAgentRoutes from '../routes/agentRoutes';
import createPaymentWebhookRoutes from '../routes/paymentWebhookRoutes';
import AgentService from '../services/ai/AgentService';
import { SecretVault } from '../services/security/SecretVault';

const { errorHandler } = require('../middleware/errorHandler');
const jwt = require('jsonwebtoken') as { sign(claims: Record<string, unknown>, secret: string): string };
const connectionString = process.env.PAYMENT_GATEWAY_TEST_DATABASE_URL;
const companyA = randomInt(700_000_000, 800_000_000);
const companyB = companyA + 1;
const signingSecret = 'fixture-webhook-secret-A';
const accessToken = 'fixture-access-token-A';
const masterKey = 'test-only-payment-vault-master-key-32';

function token(companyId: number, rol = 'ADMIN') {
  return jwt.sign({ companyId, userId: 6001, rol }, process.env.JWT_SECRET!);
}

async function startHttp(t: TestContext, service?: AgentService) {
  const app = express();
  app.use(express.json());
  app.use('/api/agents', requireJwt, createAgentRoutes(service));
  app.use('/api/webhooks/payments', createPaymentWebhookRoutes());
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const localFetch = globalThis.fetch;
  const outbound = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Provider requests are forbidden in this test');
  });
  async function request(method: string, path: string, auth?: string, body?: unknown, headers?: Record<string, string>) {
    const response = await localFetch(`http://127.0.0.1:${address.port}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-tenant-id': String(companyB),
        ...(auth ? { authorization: `Bearer ${auth}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }
  return {
    catalog: (method: string, path = '', auth?: string, body?: unknown) =>
      request(method, '/api/agents/payment-gateways' + path, auth, body),
    webhook: (path: string, body: unknown, headers?: Record<string, string>) =>
      request('POST', '/api/webhooks/payments' + path, undefined, body, headers),
    outbound,
  };
}

test('payment gateway authorization and input validation, plus unavailable payment webhooks', async (t) => {
  const { catalog, webhook, outbound } = await startHttp(t);
  for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
    const path = ['PATCH', 'DELETE'].includes(method) ? '/1' : '';
    assert.equal((await catalog(method, path)).status, 401);
    assert.equal((await catalog(method, path, token(companyA, 'EMPLEADO'))).status, 403);
  }
  for (const body of [
    {}, { provider: 'custom', displayName: 'Invalid' }, { provider: 'manual', displayName: ' ' },
    { provider: 'mercadopago', displayName: 'Invalid credentials', credentials: ['secret'] },
    { provider: 'mercadopago', displayName: 'Invalid default', isDefault: 'true' },
    { provider: 'mercadopago', displayName: 'Invalid status', status: 'archived' },
  ]) assert.equal((await catalog('POST', '', token(companyA), body)).status, 400);
  assert.equal((await catalog('DELETE', '/9007199254740992', token(companyA))).status, 400);
  for (const path of ['/mercadopago', '/stripe', '/paypal']) {
    const result = await webhook(path, { status: 'approved' });
    assert.equal(result.status, 501);
    assert.equal(result.body.success, false);
  }
  assert.equal(outbound.mock.callCount(), 0);
});

test('tenant catalog commits atomically and Mercado Pago never approves a voucher without checkout evidence', {
  skip: !connectionString && 'PAYMENT_GATEWAY_TEST_DATABASE_URL is required',
}, async (t) => {
  const db = new Pool({ connectionString });
  t.after(() => db.end());
  const uow = new TenantScopedUoW(db);
  const repo = new PaymentGatewayRepositoryPg(db);
  const { catalog, webhook, outbound } = await startHttp(t, new AgentService(repo));
  const a = token(companyA);
  const b = token(companyB);
  const { rows: [role] } = await db.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
  assert.deepEqual(role, { rolsuper: false, rolbypassrls: false });
  const { rows: [rls] } = await db.query(`
    SELECT count(*)::int AS count, bool_and(relrowsecurity AND relforcerowsecurity) AS enforced
    FROM pg_class WHERE relname IN ('payment_gateways','payment_vouchers','payment_webhook_events','customer_orders')
  `);
  assert.deepEqual(rls, { count: 4, enforced: true });
  for (const company of [companyA, companyB]) {
    await uow.run(company, (sql) => sql.query("INSERT INTO companies (id,name) VALUES ($1,'Payment fixture')", [company]));
  }

  const initialKey = process.env.MASTER_ENCRYPTION_KEY;
  t.after(() => {
    if (initialKey === undefined) delete process.env.MASTER_ENCRYPTION_KEY;
    else process.env.MASTER_ENCRYPTION_KEY = initialKey;
  });
  delete process.env.MASTER_ENCRYPTION_KEY;

  const manual = await catalog('POST', '', a, {
    provider: 'manual', displayName: 'Transferencia', isDefault: true,
    metadata: { manualInstructions: 'Contacta a ventas', token: accessToken },
  });
  assert.equal(manual.status, 201);
  assert.deepEqual(manual.body.data.metadata, { manualInstructions: 'Contacta a ventas' });
  assert.equal(manual.body.data.checkoutAvailability, 'unavailable');
  const manualId = manual.body.data.id;
  const paymentRequest = { orderId: 1, amount: 20, currency: 'PEN' };
  await assert.rejects(new AgentPaymentLinkService(repo).generate({
    companyId: companyA, gatewayId: manualId, request: paymentRequest,
  }), { code: 'PAYMENT_CHECKOUT_UNAVAILABLE', statusCode: 501 });

  const createMercadoPago = (auth: string) => catalog('POST', '', auth, {
    provider: 'mercadopago', displayName: 'Mercado Pago', isDefault: true,
    credentials: { access_token: accessToken },
    webhookSecret: signingSecret,
    companyId: companyB,
  });
  const missingVault = await createMercadoPago(a);
  assert.equal(missingVault.status, 503);
  assert.equal(missingVault.body.error, 'GATEWAY_SECRET_STORAGE_UNAVAILABLE');
  const afterRollback = await catalog('GET', '', a);
  assert.deepEqual(afterRollback.body.data.map((row: { id: number; isDefault: boolean }) => [row.id, row.isDefault]), [
    [manualId, true],
  ]);

  process.env.MASTER_ENCRYPTION_KEY = masterKey;
  const mercadoPago = await createMercadoPago(a);
  assert.equal(mercadoPago.status, 201);
  const gateway = mercadoPago.body.data;
  assert.equal(gateway.companyId, companyA);
  assert.equal(gateway.checkoutAvailability, 'unavailable');
  assert.equal(gateway.credentialsStored, true);
  assert.equal(gateway.webhookSecretStored, true);
  assert.deepEqual(gateway.credentials, {});
  assert.equal(gateway.webhookSecret, null);
  assert.doesNotMatch(JSON.stringify(gateway), /fixture-(access-token|webhook-secret)/);
  assert.equal((await catalog('GET', '', b)).body.data.length, 0);
  assert.equal((await catalog('PATCH', '/' + gateway.id, b, { isDefault: true })).status, 404);
  assert.equal((await catalog('DELETE', '/' + gateway.id, b)).status, 404);

  const stored = () => uow.run(companyA, async (sql) => (await sql.query(
    'SELECT credentials_json, webhook_secret FROM payment_gateways WHERE id = $1', [gateway.id],
  )).rows[0]);
  const original = await stored();
  const vault = new SecretVault({ masterKey });
  const unseal = (value: string) => JSON.parse(vault.decrypt(JSON.parse(value.slice('payment-gateway-v1:'.length))));
  assert.doesNotMatch(JSON.stringify(original), /fixture-(access-token|webhook-secret)/);
  assert.deepEqual(unseal(original.credentials_json.vault), {
    companyId: companyA, gatewayId: String(gateway.id), field: 'credentials', value: { access_token: accessToken },
  });
  assert.deepEqual(unseal(original.webhook_secret), {
    companyId: companyA, gatewayId: String(gateway.id), field: 'webhookSecret', value: signingSecret,
  });

  const other = await createMercadoPago(b);
  assert.equal(other.status, 201);
  assert.equal((await catalog('PATCH', '/' + other.body.data.id, a, { isDefault: true })).status, 404);
  const list = () => catalog('GET', '', a);
  assert.equal((await list()).body.data[0].id, gateway.id);
  assert.equal((await catalog('PATCH', '/' + gateway.id, a, { provider: 'stripe' })).status, 409);
  assert.equal((await catalog('PATCH', '/' + gateway.id, a, {
    displayName: 'Mercado Pago Perú', credentials: {}, webhookSecret: '',
  })).status, 200);
  assert.deepEqual(await stored(), original);
  assert.equal((await catalog('PATCH', '/' + gateway.id, a, { credentials: null, webhookSecret: null })).status, 200);
  assert.deepEqual(await stored(), { credentials_json: {}, webhook_secret: null });

  const races = await Promise.all([
    catalog('PATCH', '/' + manualId, a, { isDefault: true }),
    catalog('PATCH', '/' + gateway.id, a, {
      isDefault: true, credentials: { access_token: accessToken }, webhookSecret: signingSecret,
    }),
    ...Array.from({ length: 5 }, (_, index) => catalog('POST', '', a, {
      provider: 'stripe', displayName: 'Concurrent ' + index, isDefault: true,
    })),
  ]);
  assert.deepEqual(races.map((response) => response.status), [200, 200, 201, 201, 201, 201, 201]);
  assert.equal((await list()).body.data.filter((row: { isDefault: boolean }) => row.isDefault).length, 1);

  await uow.run(companyA, (sql) => sql.query(`
    INSERT INTO payment_gateways (company_id, provider, display_name, credentials_json, webhook_secret, metadata_json)
    VALUES ($1,'mercadopago','Historical configuration',$2,$3,$4)
  `, [companyA, JSON.stringify({ access_token: accessToken }), signingSecret, JSON.stringify({ token: accessToken })]));
  const historical = (await list()).body.data.find((row: { displayName: string }) => row.displayName === 'Historical configuration');
  assert.equal(historical.credentialsStored, false);
  assert.equal(historical.webhookSecretStored, false);
  assert.equal(historical.checkoutAvailability, 'unavailable');
  assert.doesNotMatch(JSON.stringify(historical), /fixture-(access-token|webhook-secret)/);

  const paymentId = '4529801234';
  const snapshot = async (company: number) => uow.run(company, async (sql) => (await sql.query(`
    SELECT (SELECT json_agg(v ORDER BY id) FROM payment_vouchers v) AS vouchers,
           (SELECT json_agg(o ORDER BY id) FROM customer_orders o) AS orders,
           (SELECT count(*)::int FROM payment_webhook_events) AS events,
           (SELECT count(*)::int FROM operational_actions) AS audit
  `)).rows[0]);
  for (const [company, id] of [[companyA, gateway.id], [companyB, other.body.data.id]]) {
    await uow.run(company, async (sql) => {
      const { rows: [order] } = await sql.query(
        "INSERT INTO customer_orders (company_id,title,status) VALUES ($1,'Fixture order','draft') RETURNING id", [company],
      );
      await sql.query(`
        INSERT INTO payment_vouchers (company_id, order_id, gateway_id, gateway_payment_id, file_url, amount, currency)
        VALUES ($1,$2,$3,$4,'fixture-only',20,'PEN')
      `, [company, order.id, id, paymentId]);
    });
  }
  const before = await Promise.all([snapshot(companyA), snapshot(companyB)]);
  const ts = String(Date.now());
  const requestId = 'b351482b-ae43-4d41-99c2-38b8e907cc14';
  // Construct the provider-shaped fixture locally. It still cannot bind any
  // payment to a server-created checkout, even when correctly signed.
  const digest = createHmac('sha256', signingSecret)
    .update(`id:${paymentId};request-id:${requestId};ts:${ts};`).digest('hex');
  const path = `/mercadopago?data.id=${paymentId}&type=payment&companyId=${companyA}`;
  const event = {
    action: 'payment.updated', type: 'payment', data: { id: paymentId }, status: 'approved',
    companyId: companyB, external_reference: String(before[1].orders[0].id), amount: 20, currency: 'PEN',
  };
  const notifications = await Promise.all([
    webhook(path, event),
    webhook(path, event, { 'x-request-id': requestId, 'x-signature': `ts=${ts},v1=invalid` }),
    ...Array.from({ length: 4 }, () => webhook(path, event, {
      'x-request-id': requestId, 'x-signature': `ts=${ts},v1=${digest}`,
    })),
  ]);
  assert.ok(notifications.every((result) => result.status === 501 &&
    result.body.error === 'PAYMENT_RECONCILIATION_UNAVAILABLE'));
  assert.deepEqual(await Promise.all([snapshot(companyA), snapshot(companyB)]), before);
  assert.equal(outbound.mock.callCount(), 0);

  assert.equal((await catalog('DELETE', '/' + gateway.id, a)).status, 200);
  assert.equal((await catalog('DELETE', '/' + gateway.id, a)).status, 404);
  assert.equal((await catalog('PATCH', '/' + gateway.id, a, { status: 'active' })).status, 404);
  assert.deepEqual(await stored(), { credentials_json: {}, webhook_secret: null });
  assert.ok(!(await list()).body.data.some((row: { id: number }) => row.id === gateway.id));
});
