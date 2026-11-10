import './fixtures/testEnv';
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { test } from 'node:test';
import express from 'express';
import { Pool } from 'pg';
import { TenantScopedUoW } from '../db/TenantScopedUoW';
import { requireJwt } from '../middleware/jwtAuth';
import { DashboardRepositoryPg } from '../modules/dashboard/infra/db/DashboardRepositoryPg';
import { OrderRepositoryPg } from '../modules/orders';
import createPaymentRoutes from '../routes/paymentRoutes';
import { createTestJwt } from './fixtures/authFixtures';
import type { Queryable } from '../shared/UnitOfWorkPort';
import {
  PaymentCheckoutDispatchService, PaymentCheckoutIntentService, PaymentCheckoutReconciliationService, PaymentRepositoryPg,
} from '../modules/payments';
import { MercadoPagoOrdersAdapter } from '../modules/payments/infra/mercadopago/MercadoPagoOrdersAdapter';

const connectionString = process.env.PAYMENT_CHECKOUT_TEST_DATABASE_URL;
const sellerId = '1234567890';
const paymentId = 'PAY01J49MMW3SSBK5PSV3DFR32957';
const providerId = (sequence: number) => 'ORD' + String(sequence).padStart(26, '0');

function credited(amount: string) {
  return {
    status: 'processed', status_detail: 'accredited', total_paid_amount: amount,
    transactions: { payments: [{ id: paymentId, status: 'processed', status_detail: 'accredited', amount, paid_amount: amount }] },
  };
}

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return { promise, resolve };
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

test('reconciles only verified checkout observations and settles once under tenant RLS', {
  skip: !connectionString && 'PAYMENT_CHECKOUT_TEST_DATABASE_URL is required',
  timeout: 25_000,
}, async (t) => {
  const db = new Pool({ connectionString, options: '-c lock_timeout=3500 -c statement_timeout=7000' });
  t.after(() => db.end());
  const uow = new TenantScopedUoW(db);
  const orders = new OrderRepositoryPg(db);
  const intents = new PaymentCheckoutIntentService(uow);
  const vouchers = new PaymentRepositoryPg(db);
  const companyId = randomInt(490_000_000, 520_000_000);
  const actorIds = new Map<number, number>();
  for (const tenant of [companyId, companyId + 1]) {
    await uow.run(tenant, async (sql) => {
      await sql.query("INSERT INTO companies (id,name) VALUES ($1,'Reconciliation fixture')", [tenant]);
      await sql.query("INSERT INTO tenants (id,name,slug) VALUES ($1,'Reconciliation fixture',$2)", [tenant, `checkout-reconcile-${tenant}`]);
      await sql.query("INSERT INTO workspaces (tenant_id,name,slug,is_default) VALUES ($1,'Fixture','default',true)", [tenant]);
      const { rows: [actor] } = await sql.query(`
        INSERT INTO usuarios (company_id,nombre,email,password_hash,rol)
        VALUES ($1,'Operator',$2,'fixture-unused','ADMIN') RETURNING id
      `, [tenant, `checkout-reconcile-${tenant}@fixture.invalid`]);
      actorIds.set(tenant, Number(actor.id));
      await sql.query("INSERT INTO memberships (tenant_id,user_id,role) VALUES ($1,$2,'owner')", [tenant, actor.id]);
    });
  }
  const actor = { companyId, actorUserId: actorIds.get(companyId)!, sessionRole: 'ADMIN' };
  const { gatewayId, productId } = await uow.run(companyId, async (sql) => {
    const { rows: [gateway] } = await sql.query(`
      INSERT INTO payment_gateways (company_id,provider,display_name) VALUES ($1,'mercadopago','Fixture') RETURNING id
    `, [companyId]);
    const { rows: [product] } = await sql.query(`
      INSERT INTO products (company_id,name,price,currency,item_type,stock_available,availability_type)
      VALUES ($1,'Fixture','0.20','PEN','physical_product',40,'stock') RETURNING id
    `, [companyId]);
    return { gatewayId: Number(gateway.id), productId: Number(product.id) };
  });

  const provider = new Map<string, Record<string, unknown>>();
  const requests: string[] = [];
  const reads = new Map<string, (res: ServerResponse, remote: Record<string, unknown>) => void>();
  let loseAcknowledgment = false;
  let allowSearch = false;
  let createdId: string;
  let sequence = randomInt(100_000_000, 999_999_999);
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.headers.authorization, 'Bearer fixture-access-token');
      requests.push(`${req.method} ${req.url}`);
      if (req.method === 'POST' && req.url === '/v1/orders') {
        const body = await readJson(req);
        createdId = providerId(++sequence);
        const remote = {
          id: createdId, type: 'online', processing_mode: 'manual', total_amount: body.total_amount,
          total_paid_amount: '0.00', country_code: 'PER', currency: 'PEN', user_id: sellerId,
          external_reference: body.external_reference, created_date: new Date().toISOString(),
          expiration_time: body.expiration_time, status: 'created', status_detail: 'created',
          checkout_url: `https://www.mercadopago.com.pe/checkout/v1/redirect?order_id=${createdId}`,
        };
        provider.set(createdId, remote);
        if (loseAcknowledgment) return sendJson(res, 502, { code: 'fixture' });
        return sendJson(res, 201, remote);
      }
      const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'GET' && requestUrl.pathname === '/v1/orders') {
        const reference = requestUrl.searchParams.get('external_reference');
        assert.equal(requestUrl.searchParams.get('page'), '1');
        assert.equal(requestUrl.searchParams.get('page_size'), '2');
        const data = allowSearch ? [...provider.values()].filter((row) => row.external_reference === reference) : [];
        return sendJson(res, 200, { data, paging: { total: data.length, total_pages: data.length, offset: 0, limit: 2 } });
      }
      const id = requestUrl.pathname.split('/').at(-1) ?? '';
      const remote = provider.get(id);
      if (req.method !== 'GET' || !remote) return sendJson(res, 404, { code: 'not_found' });
      const read = reads.get(id);
      if (read) return read(res, remote);
      sendJson(res, 200, remote);
    } catch {
      sendJson(res, 500, { code: 'fixture_error' });
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const adapter = new MercadoPagoOrdersAdapter(
    (url, init) => fetch(`http://127.0.0.1:${address.port}${url.pathname}${url.search}`, init),
    async (scope) => scope.companyId === companyId && scope.gatewayId === String(gatewayId)
      ? { ...scope, sellerId, accessToken: 'fixture-access-token' } : null,
  );
  const app = express();
  app.use('/api/payments', requireJwt, createPaymentRoutes(db));
  app.use(require('../middleware/errorHandler').errorHandler);
  const http = app.listen(0, '127.0.0.1');
  await once(http, 'listening');
  t.after(() => new Promise<void>((resolve) => http.close(() => resolve())));
  const appAddress = http.address();
  assert.ok(appAddress && typeof appAddress !== 'string');
  const api = (path: string, token?: string) => fetch(`http://127.0.0.1:${appAddress.port}/api/payments${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  const token = (tenantId: number, userId: number, rol = 'ADMIN') =>
    createTestJwt({ companyId: tenantId, userId, rol }, process.env.JWT_SECRET);
  const adminToken = token(companyId, actor.actorUserId);
  const ledgerPath = '/mercadopago-reconciliations';

  const dispatcher = new PaymentCheckoutDispatchService(adapter, uow);
  const reconciliation = new PaymentCheckoutReconciliationService(adapter, uow);
  let chatSequence = 0;

  async function prepare(kind: 'confirmed' | 'reserved' = 'confirmed') {
    const phone = `1202555${String(++chatSequence).padStart(4, '0')}`;
    await uow.run(companyId, async (sql) => {
      await sql.query("INSERT INTO conversations (company_id,channel,external_conversation_id) VALUES ($1,'whatsapp',$2)", [companyId, phone]);
    });
    const { order } = await orders.createDetected({
      companyId, userId: actor.actorUserId, chatId: phone,
      items: [{ commercialItemId: productId, quantity: 2, productName: 'Fixture' }],
    });
    const ready = await orders.updateStatus(companyId, order.id, kind, actor.actorUserId, kind === 'reserved' ? 1 : undefined);
    assert.equal(ready?.status, kind);
    const intent = await intents.prepare({ ...actor, orderId: order.id, gatewayId, idempotencyKey: randomUUID() });
    const dispatch = await dispatcher.dispatch({ ...actor, intentId: intent.id, expectedVersion: intent.version });
    assert.equal(dispatch.state, loseAcknowledgment ? 'uncertain' : 'created');
    return { id: intent.id, orderId: order.id, providerId: createdId };
  }

  async function observe(intentId: string, candidate?: string) {
    const result = await reconciliation.reconcile({ ...actor, intentId, providerOrderId: candidate });
    assert.equal(result.kind, 'observed');
    return result.reconciliation;
  }
  function remoteStatus(id: string, body: Record<string, unknown>) {
    Object.assign(provider.get(id)!, body);
  }
  async function settlementActions(orderId: number) {
    const { rows } = await uow.run(companyId, (sql) => sql.query(`
      SELECT metadata_json FROM operational_actions WHERE company_id=$1 AND order_id=$2 AND action_type='payment_validated'
        AND metadata_json->>'source'='mercadopago_orders'
    `, [companyId, orderId]));
    return rows.map((row) => row.metadata_json);
  }
  const createVoucher = (orderId: number) => vouchers.create({
    companyId, orderId, paymentMethod: 'cash', fileUrl: '/fixture', amount: 0.40,
  });

  await t.test('a verified full payment confirms a live reservation once and blocks a second manual payment', async () => {
    const checkout = await prepare('reserved');
    const reservation = await orders.get(companyId, checkout.orderId);
    assert.ok(reservation?.reservationExpiresAt);
    assert.equal((await observe(checkout.id)).state, 'unpaid');
    remoteStatus(checkout.providerId, credited('0.20'));
    assert.equal((await observe(checkout.id)).state, 'partial');
    assert.equal((await orders.get(companyId, checkout.orderId))?.status, 'reserved');
    remoteStatus(checkout.providerId, credited('0.40'));

    const started = latch();
    const allowOldResponse = latch();
    reads.set(checkout.providerId, (res, remote) => {
      reads.delete(checkout.providerId);
      started.resolve();
      void allowOldResponse.promise.then(() => sendJson(res, 200, { ...remote, ...credited('0.20') }));
    });
    const oldRead = reconciliation.reconcile({ ...actor, intentId: checkout.id });
    await started.promise;
    const settled = await observe(checkout.id);
    allowOldResponse.resolve();
    assert.deepEqual(await oldRead, { kind: 'retry', reason: 'observation_superseded' });
    assert.equal(settled.state, 'settled');
    assert.ok(settled.settledAt);
    const confirmed = await orders.get(companyId, checkout.orderId);
    assert.equal(confirmed?.status, 'confirmed');
    assert.equal(confirmed?.reservationExpiresAt, null);
    assert.deepEqual(await settlementActions(checkout.orderId), [{
      source: 'mercadopago_orders', intentId: checkout.id, providerOrderId: checkout.providerId, amount: '0.40', currency: 'PEN',
    }]);
    assert.equal((await observe(checkout.id)).settledAt?.getTime(), settled.settledAt.getTime());
    const manualList = await api(`?orderId=${checkout.orderId}`, adminToken);
    assert.equal(manualList.status, 200);
    assert.deepEqual((await manualList.json()).data.rows, []);
    const pendingCount = await api('/pending/count', adminToken);
    assert.equal(pendingCount.status, 200);
    assert.equal((await pendingCount.json()).data.count, 0);
    assert.equal((await new DashboardRepositoryPg(db).getActionCards(companyId)).pendingPaymentsCount, 0);
    assert.equal((await settlementActions(checkout.orderId)).length, 1);
    await assert.rejects(createVoucher(checkout.orderId), { statusCode: 409, code: 'ORDER_PAYMENT_ALREADY_SETTLED' });
    await assert.rejects(uow.run(companyId, (sql) => sql.query(`
      INSERT INTO payment_vouchers (company_id, order_id, file_url, payment_method, status)
      VALUES ($1,$2,'/fixture','cash','validated')
    `, [companyId, checkout.orderId])), { code: 'PWA01' });

    remoteStatus(checkout.providerId, { status: 'refunded', status_detail: 'refunded', total_paid_amount: '0.00',
      transactions: { refunds: [{ id: 'refund-fixture' }] } });
    const review = await observe(checkout.id);
    assert.equal(review.reviewCode, 'settled_payment_changed');
    assert.equal(review.settledAt?.getTime(), settled.settledAt.getTime());
    assert.equal((await orders.get(companyId, checkout.orderId))?.status, 'confirmed');
    remoteStatus(checkout.providerId, credited('0.40'));
    assert.equal((await observe(checkout.id)).state, 'review_required');
    assert.equal((await settlementActions(checkout.orderId)).length, 1);
  });

  await t.test('a missing POST acknowledgment requires a bound GET and RLS prevents cross-company access', async () => {
    loseAcknowledgment = true;
    const checkout = await prepare();
    loseAcknowledgment = false;
    const count = requests.length;
    assert.deepEqual(await reconciliation.reconcile({ ...actor, intentId: checkout.id }),
      { kind: 'retry', reason: 'provider_order_unresolved' });
    assert.equal(requests.length, count + 1);
    assert.match(requests[count], /^GET \/v1\/orders\?/);
    await assert.rejects(reconciliation.reconcile({
      companyId: companyId + 1, actorUserId: actorIds.get(companyId + 1)!, sessionRole: 'ADMIN',
      intentId: checkout.id, providerOrderId: checkout.providerId,
    }), { code: 'CHECKOUT_INTENT_NOT_FOUND' });
    assert.equal(requests.length, count + 1);

    const correctReference = provider.get(checkout.providerId)!.external_reference;
    remoteStatus(checkout.providerId, { external_reference: randomUUID(), ...credited('0.40') });
    assert.deepEqual(await reconciliation.reconcile({ ...actor, intentId: checkout.id, providerOrderId: checkout.providerId }),
      { kind: 'retry', reason: 'provider_unavailable' });
    assert.equal((await settlementActions(checkout.orderId)).length, 0);
    remoteStatus(checkout.providerId, { external_reference: correctReference });
    allowSearch = true;
    assert.equal((await observe(checkout.id)).state, 'settled');
    allowSearch = false;
    assert.match(requests.at(-2)!, /^GET \/v1\/orders\?/);
    assert.equal(requests.at(-1), `GET /v1/orders/${checkout.providerId}`);
    await assert.rejects(reconciliation.reconcile({ ...actor, intentId: checkout.id, providerOrderId: providerId(900) }),
      { code: 'CHECKOUT_PROVIDER_ORDER_CONFLICT' });
    assert.equal(requests.slice(count).filter((request) => request.startsWith('POST')).length, 0);
    const query = 'SELECT intent_id FROM payment_checkout_reconciliations WHERE intent_id = $1';
    assert.equal((await db.query(query, [checkout.id])).rowCount, 0);
    assert.equal((await uow.run(companyId + 1, (sql) => sql.query(query, [checkout.id]))).rowCount, 0);
    assert.equal((await uow.run(companyId, (sql) => sql.query(query, [checkout.id]))).rowCount, 1);
  });

  await t.test('a failed settlement transaction rolls back the confirmation and permits a safe retry', async () => {
    const checkout = await prepare('reserved');
    remoteStatus(checkout.providerId, credited('0.40'));
    const failing = new PaymentCheckoutReconciliationService(adapter, {
      run: <T>(tenantId: number, work: (client: Queryable) => Promise<T>) =>
        uow.run(tenantId, (client) => work({
          query: (text, values) => {
            if (text.includes('Pago Mercado Pago conciliado')) throw new Error('fixture settlement audit failure');
            return client.query(text, values);
          },
        })),
    });
    await assert.rejects(failing.reconcile({ ...actor, intentId: checkout.id }), /fixture settlement audit failure/);
    assert.equal((await orders.get(companyId, checkout.orderId))?.status, 'reserved');
    assert.equal((await settlementActions(checkout.orderId)).length, 0);
    assert.equal((await observe(checkout.id)).state, 'settled');
    assert.equal((await settlementActions(checkout.orderId)).length, 1);
  });

  await t.test('voucher validation racing the GET and an expired reservation leave review evidence without settlement', async () => {
    const manual = await prepare();
    const voucher = await createVoucher(manual.orderId);
    const started = latch();
    const allowResponse = latch();
    reads.set(manual.providerId, (res, remote) => {
      reads.delete(manual.providerId);
      started.resolve();
      void allowResponse.promise.then(() => sendJson(res, 200, { ...remote, ...credited('0.40') }));
    });
    const processing = observe(manual.id);
    await started.promise;
    const validated = await vouchers.updateStatus(companyId, voucher.id, 'validated', actor.actorUserId);
    assert.equal(validated?.status, 'validated');
    allowResponse.resolve();
    assert.equal((await processing).reviewCode, 'voucher_validated');
    assert.equal((await settlementActions(manual.orderId)).length, 0);

    const expired = await prepare('reserved');
    await uow.run(companyId, (sql) => sql.query(`
      UPDATE customer_orders SET reservation_expires_at=clock_timestamp()-interval '1 minute' WHERE company_id=$1 AND id=$2
    `, [companyId, expired.orderId]));
    await orders.expireReservation(companyId, expired.orderId);
    remoteStatus(expired.providerId, credited('0.40'));
    assert.equal((await observe(expired.id)).reviewCode, 'checkout_expired');
    assert.equal((await orders.get(companyId, expired.orderId))?.status, 'cancelled');
    assert.equal((await settlementActions(expired.orderId)).length, 0);
  });

  await t.test('serves a scoped, read-only ledger with order filter, cursor and sanitized rows', async () => {
    const first = await api(`${ledgerPath}?limit=1`, adminToken);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('cache-control'), 'no-store');
    const page = (await first.json()).data;
    assert.equal(page.rows.length, 1);
    assert.equal(page.nextBeforeOrderId, page.rows[0].orderId);
    assert.deepEqual(Object.keys(page.rows[0]).sort(), [
      'amountPaid', 'currency', 'expectedAmount', 'observedAt', 'orderId', 'providerOrderId', 'reviewCode', 'settledAt', 'state',
    ]);
    const next = await api(`${ledgerPath}?limit=1&beforeOrderId=${page.nextBeforeOrderId}`, adminToken);
    assert.equal(next.status, 200);
    const second = (await next.json()).data.rows[0];
    assert.ok(BigInt(second.orderId) < BigInt(page.rows[0].orderId));
    const orderPath = `${ledgerPath}?orderId=${second.orderId}`;
    const exact = await api(orderPath, adminToken);
    assert.equal(exact.status, 200);
    assert.deepEqual((await exact.json()).data, { rows: [second], nextBeforeOrderId: null });

    const otherToken = token(companyId + 1, actorIds.get(companyId + 1)!);
    const inaccessible = await api(orderPath, otherToken);
    assert.equal(inaccessible.status, 200);
    assert.deepEqual((await inaccessible.json()).data, { rows: [], nextBeforeOrderId: null });
    assert.equal((await api(orderPath)).status, 401);
    assert.equal((await api(orderPath, token(companyId, actor.actorUserId, 'EMPLEADO'))).status, 403);
    assert.equal((await api(orderPath, token(companyId, actorIds.get(companyId + 1)!))).status, 403);
    for (const invalidQuery of ['orderId=0', 'orderId=1e3', 'beforeOrderId=9223372036854775808', 'limit=101', 'limit=1&limit=2']) {
      assert.equal((await api(`${ledgerPath}?${invalidQuery}`, adminToken)).status, 400);
    }
  });
});
