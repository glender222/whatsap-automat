import './fixtures/testEnv';
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import { test } from 'node:test';
import { Pool } from 'pg';
import { TenantScopedUoW } from '../db/TenantScopedUoW';
import { OrderRepositoryPg } from '../modules/orders';
import { PaymentCheckoutDispatchService, PaymentCheckoutIntentService, PaymentRepositoryPg } from '../modules/payments';
import { PaymentCheckoutDispatchRepositoryPg } from '../modules/payments/infra/db/PaymentCheckoutDispatchRepositoryPg';
import { MercadoPagoOrdersAdapter } from '../modules/payments/infra/mercadopago/MercadoPagoOrdersAdapter';

const connectionString = process.env.PAYMENT_CHECKOUT_DISPATCH_TEST_DATABASE_URL;
const fixtureToken = 'synthetic-payment-dispatch-credential';
const sellerId = '182736';

test('Mercado Pago dispatch survives contention, cancellation, and an acknowledgement loss', {
  skip: !connectionString && 'PAYMENT_CHECKOUT_DISPATCH_TEST_DATABASE_URL is required',
  timeout: 20_000,
}, async (t) => {
  const db = new Pool({ connectionString, options: '-c lock_timeout=3500 -c statement_timeout=7000' });
  t.after(() => db.end());
  const uow = new TenantScopedUoW(db);
  const intents = new PaymentCheckoutIntentService(uow);
  const orders = new OrderRepositoryPg(db);
  const tenant = randomInt(451_000_000, 549_000_000);
  const actors = await Promise.all([tenant, tenant + 1].map((companyId) => uow.run(companyId, async (sql) => {
    await sql.query("INSERT INTO companies (id,name) VALUES ($1,'Dispatch fixture')", [companyId]);
    await sql.query("INSERT INTO tenants (id,name,slug) VALUES ($1,'Dispatch fixture',$2)", [companyId, `dispatch-${companyId}`]);
    await sql.query("INSERT INTO workspaces (tenant_id,name,slug,is_default) VALUES ($1,'Dispatch fixture','default',true)", [companyId]);
    const { rows: [user] } = await sql.query(`
      INSERT INTO usuarios (company_id,nombre,email,password_hash,rol) VALUES ($1,'Dispatcher',$2,'fixture-unused','ADMIN') RETURNING id
    `, [companyId, `dispatch-${companyId}@fixture.invalid`]);
    await sql.query("INSERT INTO memberships (tenant_id,user_id,role) VALUES ($1,$2,'owner')", [companyId, user.id]);
    return { companyId, actorUserId: Number(user.id), sessionRole: 'ADMIN' };
  })));
  const [actor, outsider] = actors;
  const { rows: [security] } = await db.query(`
    SELECT r.rolsuper, r.rolbypassrls, c.relrowsecurity, c.relforcerowsecurity
    FROM pg_roles r CROSS JOIN pg_class c
    WHERE r.rolname = current_user AND c.oid = 'payment_checkout_dispatches'::regclass
  `);
  assert.deepEqual(security, { rolsuper: false, rolbypassrls: false, relrowsecurity: true, relforcerowsecurity: true });

  const { gateway, product } = await uow.run(tenant, async (sql) => {
    const { rows: [gateway] } = await sql.query(`
      INSERT INTO payment_gateways (company_id,provider,display_name) VALUES ($1,'mercadopago','Dispatch fixture') RETURNING id
    `, [tenant]);
    const { rows: [product] } = await sql.query(`
      INSERT INTO products (company_id,name,price,currency,item_type,stock_available,availability_type)
      VALUES ($1,'Dispatch fixture',4.25,'PEN','physical_product',40,'stock') RETURNING id
    `, [tenant]);
    return { gateway: Number(gateway.id), product: Number(product.id) };
  });

  let sequence = 0;
  async function createOrder(status: 'confirmed' | 'reserved' = 'confirmed') {
    const chatId = `1202556${String(++sequence).padStart(4, '0')}`;
    await uow.run(tenant, (sql) => sql.query(`
      INSERT INTO conversations (company_id,channel,external_conversation_id)
      VALUES ($1,'whatsapp',$2)
    `, [tenant, chatId]));
    const { order } = await orders.createDetected({
      companyId: tenant, userId: actor.actorUserId, chatId,
      items: [{ commercialItemId: product, quantity: 2, productName: 'Dispatch fixture' }],
    });
    assert.equal((await orders.updateStatus(tenant, order.id, status, actor.actorUserId, 1))?.status, status);
    return order.id;
  }

  const prepare = (orderId: number) => intents.prepare({ ...actor, orderId, gatewayId: gateway, idempotencyKey: randomUUID() });
  const request = (intent: { id: string; version: number }) => ({ ...actor, intentId: intent.id, expectedVersion: intent.version });
  const stored = (intentId: string, companyId = tenant) =>
    uow.run(companyId, (sql) => new PaymentCheckoutDispatchRepositoryPg(sql).get(companyId, intentId));
  const firstOrder = await createOrder('reserved');
  const first = await prepare(firstOrder);
  const requests: string[] = [];
  let firstResponse: (() => void) | undefined;
  let mode: 'hold' | 'drop' | 'create' = 'hold';
  const remoteId = (index: number) => `ORDTST${String(tenant * 100 + index).padStart(26, '0')}`;
  const server = createServer(async (req, res) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/v1/orders');
    assert.equal(req.headers.authorization, `Bearer ${fixtureToken}`);
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const intentId = String(req.headers['x-idempotency-key']);
    requests.push(intentId);
    const send = (res: ServerResponse) => {
      const id = remoteId(requests.indexOf(intentId) + 1);
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id, type: 'online', processing_mode: 'manual', country_code: 'PER', currency: 'PEN', user_id: sellerId,
        external_reference: body.external_reference, total_amount: body.total_amount, total_paid_amount: '0.00',
        status: 'created', status_detail: 'created', created_date: new Date().toISOString(), expiration_time: body.expiration_time,
        checkout_url: `https://www.mercadopago.com.pe/checkout/v1/redirect?order_id=${id}`,
      }));
    };
    if (mode === 'hold') {
      firstResponse = () => send(res);
      server.emit('fixture:post');
    } else if (mode === 'drop') {
      res.destroy();
    } else {
      send(res);
    }
  });
  server.listen(0, '127.0.0.1');
  t.after(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const adapter = new MercadoPagoOrdersAdapter((url, init) => {
    assert.equal(url.href, 'https://api.mercadopago.com/v1/orders');
    return fetch(`http://127.0.0.1:${address.port}${url.pathname}`, init);
  }, async (scope) => ({ ...scope, sellerId, accessToken: fixtureToken }));
  const dispatches = new PaymentCheckoutDispatchService(adapter, uow);

  await assert.rejects(dispatches.dispatch({ ...request(first), ...outsider }), { code: 'CHECKOUT_INTENT_NOT_FOUND' });
  await assert.rejects(dispatches.dispatch({ ...request(first), sessionRole: 'EMPLEADO' }), { code: 'CHECKOUT_ADMIN_REQUIRED' });
  await assert.rejects(dispatches.dispatch({ ...request(first), expectedVersion: first.version + 1 }), { code: 'CHECKOUT_VERSION_CONFLICT' });

  const posted = once(server, 'fixture:post');
  const sending = dispatches.dispatch(request(first));
  void sending.catch(() => undefined);
  await Promise.race([posted, sending.then(() => { throw new Error('Dispatch finished before the provider accepted the request'); })]);
  const claim = await stored(first.id);
  assert.equal(claim?.state, 'claimed');
  assert.equal(claim.version, 1);
  assert.ok(claim.validUntil <= Date.parse(first.reservationExpiresAt!));
  assert.equal(await stored(first.id, outsider.companyId), null);
  assert.equal((await uow.run(outsider.companyId, (sql) => sql.query(
    'SELECT intent_id FROM payment_checkout_dispatches WHERE intent_id = $1', [first.id],
  ))).rowCount, 0);
  assert.equal((await db.query('SELECT intent_id FROM payment_checkout_dispatches')).rowCount, 0);
  assert.deepEqual(await dispatches.dispatch(request(first)), claim);
  assert.equal((await intents.void(request(first))).state, 'voided');
  firstResponse!();
  const completed = await sending;
  assert.equal(completed.state, 'created');
  assert.equal(completed.providerOrderId, remoteId(1));
  assert.equal(completed.version, 2);
  assert.ok(!Object.hasOwn(completed, 'checkoutUrl'));
  assert.deepEqual(await dispatches.dispatch(request(first)), completed);

  const second = await prepare(firstOrder);
  await assert.rejects(dispatches.dispatch(request(second)), { code: 'CHECKOUT_ORDER_ALREADY_DISPATCHED' });
  assert.deepEqual(requests, [first.id]);

  const dropped = await prepare(await createOrder());
  mode = 'drop';
  const uncertain = await dispatches.dispatch(request(dropped));
  assert.equal(uncertain.state, 'uncertain');
  assert.equal(uncertain.outcomeCode, 'transport');
  assert.deepEqual(await new PaymentCheckoutDispatchService(adapter, uow).dispatch(request(dropped)), uncertain);

  const crashed = await prepare(await createOrder());
  mode = 'create';
  let transactions = 0;
  const interrupted = new PaymentCheckoutDispatchService(adapter, {
    run: async (companyId, work) => {
      if (++transactions === 2) throw new Error('fixture: lost PostgreSQL connection after POST');
      return uow.run(companyId, work);
    },
  });
  await assert.rejects(interrupted.dispatch(request(crashed)), /after POST/);
  const recovered = await dispatches.dispatch(request(crashed));
  assert.equal(recovered.state, 'claimed');
  assert.equal(recovered.providerOrderId, null);
  assert.equal(recovered.version, 1);
  const attached = await uow.run(tenant, async (sql) => {
    const repository = new PaymentCheckoutDispatchRepositoryPg(sql);
    assert.equal(await repository.attachVerifiedOrder(tenant, crashed.id, 2, remoteId(3)), null);
    return repository.attachVerifiedOrder(tenant, crashed.id, recovered.version, remoteId(3));
  });
  assert.equal(attached?.providerOrderId, remoteId(3));
  assert.equal(attached?.outcomeCode, 'acknowledgement_lost');
  assert.deepEqual(await dispatches.dispatch(request(crashed)), attached);

  const pendingOrder = await createOrder();
  const pending = await prepare(pendingOrder);
  await new PaymentRepositoryPg(db).create({
    companyId: tenant, orderId: pendingOrder, fileUrl: '/fixture.pdf',
    paymentMethod: 'cash', amount: 8.5, uploadedBy: actor.actorUserId,
  });
  await assert.rejects(dispatches.dispatch(request(pending)), { code: 'CHECKOUT_VOUCHER_PENDING' });

  const shortOrder = await createOrder('reserved');
  await uow.run(tenant, (sql) => sql.query(`
    UPDATE customer_orders SET reservation_expires_at = clock_timestamp() + INTERVAL '12 seconds'
    WHERE company_id = $1 AND id = $2
  `, [tenant, shortOrder]));
  const short = await prepare(shortOrder);
  await assert.rejects(dispatches.dispatch(request(short)), { code: 'CHECKOUT_DISPATCH_WINDOW_UNAVAILABLE' });

  const changed = await prepare(await createOrder());
  await uow.run(tenant, (sql) => sql.query('UPDATE payment_gateways SET updated_at = clock_timestamp() WHERE id = $1', [gateway]));
  await assert.rejects(dispatches.dispatch(request(changed)), { code: 'CHECKOUT_SNAPSHOT_CHANGED' });
  for (const intent of [pending, short, changed]) assert.equal(await stored(intent.id), null);
  assert.deepEqual(requests, [first.id, dropped.id, crashed.id]);
});
