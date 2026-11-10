import './fixtures/testEnv';
import assert from 'node:assert/strict';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test, type TestContext } from 'node:test';
import express, { type Router } from 'express';
import { Pool } from 'pg';
import { TenantScopedUoW } from '../db/TenantScopedUoW';
import { PaymentGatewayRepositoryPg } from '../modules/ai/infra/db/PaymentGatewayRepositoryPg';
import { OrderRepositoryPg } from '../modules/orders';
import { PaymentCheckoutDispatchService, PaymentCheckoutIntentService } from '../modules/payments';
import createPaymentCheckoutReconciliationRuntime from '../routes/paymentCheckoutReconciliationRuntime';
import createPaymentCheckoutReconciliationRoutes from '../routes/paymentCheckoutReconciliationRoutes';
import { PaymentCheckoutIntentError } from '../modules/payments/application/PaymentCheckoutIntentService';

const jwt = require('jsonwebtoken') as { sign(claims: Record<string, unknown>, secret: string): string };
const intentId = 'f803e202-8596-4b12-9b4a-c33ff98c6176';
const providerOrderId = 'ORDTST01KS5AJ6HTK2HRQ3XJ3C2JCKP9';
const path = '/api/payments/checkout-intents/' + intentId + '/reconcile';
const databaseUrl = process.env.PAYMENT_CHECKOUT_TEST_DATABASE_URL;

function token(claims: Record<string, unknown> = {}) {
  return jwt.sign({ companyId: 12, userId: 35, rol: 'ADMIN', ...claims }, process.env.JWT_SECRET!);
}

async function start(t: TestContext, router: Router) {
  const app = express();
  app.use(express.json());
  app.use('/api/payments/checkout-intents', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return async (auth: string | undefined, body: unknown = {}, url = path) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${url}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-tenant-id': '999',
        ...(auth ? { authorization: 'Bearer ' + auth } : {}),
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, cache: response.headers.get('cache-control'), body: await response.json() };
  };
}

test('the reconciliation endpoint stays unavailable by default and requires authentication', async (t) => {
  const oldGate = process.env.MERCADOPAGO_RECONCILIATION_ENABLED;
  delete process.env.MERCADOPAGO_RECONCILIATION_ENABLED;
  t.after(() => {
    if (oldGate !== undefined) process.env.MERCADOPAGO_RECONCILIATION_ENABLED = oldGate;
  });
  const request = await start(t, createPaymentCheckoutReconciliationRuntime());
  assert.equal((await request(undefined)).status, 401);
  assert.equal((await request(token({ rol: 'EMPLEADO' }))).status, 403);
  assert.equal((await request(token({ companyId: 12, tenantId: 99 }))).status, 403);
  const disabled = await request(token());
  assert.equal(disabled.status, 501);
  assert.equal(disabled.body.error, 'PAYMENT_RECONCILIATION_UNAVAILABLE');
  assert.equal(disabled.cache, 'private, no-store');
});

test('the reconciliation endpoint admits only the authenticated scope and returns a bounded receipt', async (t) => {
  const receipt = {
    state: 'settled',
    amountPaid: '10.50',
    providerStatus: 'processed',
    providerStatusDetail: 'accredited',
    observedAt: '2026-11-10T12:00:00.000Z',
    settledAt: '2026-11-10T12:00:00.000Z',
    reviewCode: null,
  };
  const reconcile = t.mock.fn<NonNullable<Parameters<typeof createPaymentCheckoutReconciliationRoutes>[0]>['reconcile']>(async () => ({
    kind: 'observed' as const,
    reconciliation: {
      ...receipt, observedAt: new Date(receipt.observedAt), settledAt: new Date(receipt.settledAt),
      state: 'settled', raw: { access_token: 'test-only-unexpected-secret' },
    },
  }));
  const request = await start(t, createPaymentCheckoutReconciliationRoutes({ reconcile }));
  for (const body of [
    { providerOrderId: 123 }, { providerOrderId: 'x'.repeat(33) }, { companyId: 99 },
    { accessToken: 'ignored-value' }, { amount: 10.50 }, [],
  ]) assert.equal((await request(token(), body)).status, 422);
  assert.equal((await request(token(), {}, path.replace(intentId, 'bad'))).status, 422);
  assert.equal(reconcile.mock.callCount(), 0);

  const result = await request(token(), { providerOrderId });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { success: true, data: receipt });
  assert.deepEqual(reconcile.mock.calls[0].arguments, [{
    companyId: 12, actorUserId: 35, sessionRole: 'ADMIN', intentId, providerOrderId,
  }]);
});

test('the reconciliation endpoint maps provider retry, concurrent update and tenant-scoped absence', async (t) => {
  const request = await start(t, createPaymentCheckoutReconciliationRoutes({
    async reconcile(input) {
      if (input.companyId === 12) return { kind: 'retry', reason: 'provider_unavailable' };
      if (input.companyId === 13) return { kind: 'retry', reason: 'observation_superseded' };
      throw new PaymentCheckoutIntentError(404, 'CHECKOUT_INTENT_NOT_FOUND', 'Intención de cobro no encontrada.');
    },
  }));
  const unavailable = await request(token());
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.body.error, 'CHECKOUT_PROVIDER_UNAVAILABLE');
  const conflict = await request(token({ companyId: 13 }));
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error, 'CHECKOUT_OBSERVATION_SUPERSEDED');
  const absent = await request(token({ companyId: 99 }));
  assert.equal(absent.status, 404);
  assert.equal(absent.body.error, 'CHECKOUT_INTENT_NOT_FOUND');
});

test('operator reconciliation uses persisted dispatch, scoped encrypted credentials and a verified provider GET', {
  skip: !databaseUrl && 'PAYMENT_CHECKOUT_TEST_DATABASE_URL is required',
  timeout: 15_000,
}, async (t) => {
  const initial = { key: process.env.MASTER_ENCRYPTION_KEY, gate: process.env.MERCADOPAGO_RECONCILIATION_ENABLED };
  process.env.MASTER_ENCRYPTION_KEY = 'fixture-orders-vault-master-key-32-characters';
  process.env.MERCADOPAGO_RECONCILIATION_ENABLED = 'true';
  t.after(() => {
    if (initial.key === undefined) delete process.env.MASTER_ENCRYPTION_KEY;
    else process.env.MASTER_ENCRYPTION_KEY = initial.key;
    if (initial.gate === undefined) delete process.env.MERCADOPAGO_RECONCILIATION_ENABLED;
    else process.env.MERCADOPAGO_RECONCILIATION_ENABLED = initial.gate;
  });
  const db = new Pool({ connectionString: databaseUrl });
  t.after(() => db.end());
  const uow = new TenantScopedUoW(db);
  const companyId = randomInt(350_000_000, 420_000_000);
  const createCompany = (company: number) => uow.run(company, async (sql) => {
    await sql.query("INSERT INTO companies (id, name) VALUES ($1, 'Runtime checkout fixture')", [company]);
    await sql.query("INSERT INTO tenants (id, name, slug) VALUES ($1, 'Fixture', $2)", [company, 'runtime-fixture-' + company]);
    await sql.query("INSERT INTO workspaces (tenant_id, name, slug, is_default) VALUES ($1, 'Fixture', 'default', true)", [company]);
    const { rows: [actor] } = await sql.query(
      "INSERT INTO usuarios (company_id,nombre,email,password_hash,rol) VALUES ($1,'Fixture',$2,'unused','ADMIN') RETURNING id",
      [company, `fixture-runtime-${company}@example.invalid`],
    );
    await sql.query("INSERT INTO memberships (tenant_id,user_id,role) VALUES ($1,$2,'owner')", [company, actor.id]);
    return Number(actor.id);
  });
  const actorUserId = await createCompany(companyId);
  const otherUser = await createCompany(companyId + 1);
  const actor = { companyId, actorUserId, sessionRole: 'ADMIN' };
  const sellerId = '1234567890';
  const accessToken = 'fixture-runtime-orders-token';
  const gateways = new PaymentGatewayRepositoryPg(db);
  const gateway = await gateways.create(companyId, {
    provider: 'mercadopago', displayName: 'Runtime fixture', credentials: { access_token: accessToken, seller_id: sellerId },
  });
  const phone = '12025550118';
  const productId = await uow.run(companyId, async (sql) => {
    await sql.query("INSERT INTO conversations (company_id, channel, external_conversation_id) VALUES ($1,'whatsapp',$2)", [companyId, phone]);
    const { rows: [product] } = await sql.query(`
      INSERT INTO products (company_id,name,price,currency,item_type,stock_available,availability_type)
      VALUES ($1,'Fixture','5.25','PEN','physical_product',40,'stock') RETURNING id
    `, [companyId]);
    return Number(product.id);
  });
  const orders = new OrderRepositoryPg(db);
  const { order } = await orders.createDetected({
    companyId, userId: actorUserId, chatId: phone,
    items: [{ commercialItemId: productId, quantity: 2, productName: 'Fixture' }],
  });
  await orders.updateStatus(companyId, order.id, 'confirmed', actorUserId);
  const intents = new PaymentCheckoutIntentService(uow);
  const intent = await intents.prepare({ ...actor, orderId: order.id, gatewayId: gateway.id, idempotencyKey: randomUUID() });
  const remoteOrderId = 'ORDTST' + randomBytes(13).toString('hex').toUpperCase();
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + 120_000).toISOString();
  const dispatcher = new PaymentCheckoutDispatchService({
    async create() { return { kind: 'created', orderId: remoteOrderId, expiresAt, checkoutUrl: 'unused-internal-fixture' }; },
  }, uow);
  const dispatch = await dispatcher.dispatch({ ...actor, intentId: intent.id, expectedVersion: intent.version });
  assert.equal(dispatch.state, 'created');

  let providerReads = 0;
  const provider = createServer((req, res) => {
    providerReads += 1;
    const authorized = req.method === 'GET' && req.url === '/v1/orders/' + remoteOrderId &&
      req.headers.authorization === 'Bearer ' + accessToken;
    res.writeHead(authorized ? 200 : 403, { 'content-type': 'application/json' });
    res.end(JSON.stringify(authorized ? {
      id: remoteOrderId, external_reference: intent.externalReference, total_amount: '10.50', total_paid_amount: '10.50',
      type: 'online', processing_mode: 'manual', country_code: 'PER', currency: 'PEN', user_id: sellerId,
      created_date: createdAt.toISOString(), expiration_time: 'PT120S', status: 'processed', status_detail: 'accredited',
      transactions: { payments: [{
        id: 'PAY01J49MMW3SSBK5PSV3DFR32957', status: 'processed', status_detail: 'accredited',
        amount: '10.50', paid_amount: '10.50',
      }] },
    } : { error: 'fixture_unauthorized' }));
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  t.after(() => new Promise<void>((resolve) => provider.close(() => resolve())));
  const providerAddress = provider.address();
  assert.ok(providerAddress && typeof providerAddress !== 'string');
  const request = await start(t, createPaymentCheckoutReconciliationRuntime(db, (target, init) => {
    const url = new URL(String(target));
    assert.equal(url.origin, 'https://api.mercadopago.com');
    assert.equal(init?.method, 'GET');
    assert.equal(init?.redirect, 'error');
    return fetch(`http://127.0.0.1:${providerAddress.port}${url.pathname}${url.search}`, init);
  }));
  const url = path.replace(intentId, intent.id);
  const admin = token({ companyId, userId: actorUserId });
  const foreign = token({ companyId: companyId + 1, userId: otherUser });
  assert.equal((await request(foreign, {}, url)).status, 404);
  assert.equal(providerReads, 0);
  const first = await request(admin, {}, url);
  assert.equal(first.status, 200);
  assert.equal(first.body.data.state, 'settled');
  assert.equal(first.body.data.amountPaid, '10.50');
  assert.equal(typeof first.body.data.settledAt, 'string');
  const second = await request(admin, {}, url);
  assert.equal(second.body.data.settledAt, first.body.data.settledAt);
  assert.equal(providerReads, 2);
  await gateways.update(companyId, gateway.id, { credentials: { access_token: 'fixture-rotated', seller_id: sellerId } });
  assert.equal((await request(admin, {}, url)).status, 503);
  assert.equal(providerReads, 2);
});
