import './fixtures/testEnv';
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import express from 'express';
import { Pool } from 'pg';
import { TenantScopedUoW } from '../db/TenantScopedUoW';
import { requireJwt } from '../middleware/jwtAuth';
import { OrderRepositoryPg } from '../modules/orders';
import { PaymentCheckoutIntentService, PaymentRepositoryPg } from '../modules/payments';
import createPaymentRoutes from '../routes/paymentRoutes';

const { errorHandler } = require('../middleware/errorHandler');
const jwt = require('jsonwebtoken') as { sign(claims: Record<string, unknown>, secret: string): string };
const connectionString = process.env.PAYMENT_CHECKOUT_TEST_DATABASE_URL;

test('prepares immutable checkout intents under forced RLS and serializes voucher and inventory changes', {
  skip: !connectionString && 'PAYMENT_CHECKOUT_TEST_DATABASE_URL is required',
  timeout: 20_000,
}, async (t) => {
  const db = new Pool({ connectionString, options: '-c lock_timeout=3500 -c statement_timeout=7000' });
  t.after(() => db.end());
  const uow = new TenantScopedUoW(db);
  const orders = new OrderRepositoryPg(db);
  const vouchers = new PaymentRepositoryPg(db);
  const intents = new PaymentCheckoutIntentService(uow);
  const tenantA = randomInt(350_000_000, 450_000_000);
  const tenantB = tenantA + 1;
  const { rows: [dbRole] } = await db.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
  assert.deepEqual(dbRole, { rolsuper: false, rolbypassrls: false });
  const { rows: [table] } = await db.query(`
    SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'payment_checkout_intents'::regclass
  `);
  assert.deepEqual(table, { relrowsecurity: true, relforcerowsecurity: true });
  const ids = new Map<number, number>();
  for (const tenantId of [tenantA, tenantB]) {
    await uow.run(tenantId, async (sql) => {
      await sql.query("INSERT INTO companies (id,name) VALUES ($1,'Checkout fixture')", [tenantId]);
      await sql.query("INSERT INTO tenants (id,name,slug) VALUES ($1,'Checkout fixture',$2)", [tenantId, `checkout-${tenantId}`]);
      await sql.query("INSERT INTO workspaces (tenant_id,name,slug,is_default) VALUES ($1,'Checkout fixture','default',true)", [tenantId]);
      const { rows: [actor] } = await sql.query(`
        INSERT INTO usuarios (company_id,nombre,email,password_hash,rol) VALUES ($1,'Operator',$2,'fixture-unused','ADMIN') RETURNING id
      `, [tenantId, `checkout-${tenantId}@fixture.invalid`]);
      ids.set(tenantId, Number(actor.id));
      await sql.query("INSERT INTO memberships (tenant_id,user_id,role) VALUES ($1,$2,'owner')", [tenantId, actor.id]);
    });
  }
  const actor = (companyId: number) => ({ companyId, actorUserId: ids.get(companyId)!, sessionRole: 'ADMIN' });
  const localFetch = globalThis.fetch;
  const outbound = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Provider traffic is forbidden during checkout preparation');
  });
  const app = express();
  app.use(express.json());
  app.use('/api/payments', requireJwt, createPaymentRoutes(db));
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const pay = (path: string, company = tenantA) => localFetch(`http://127.0.0.1:${address.port}/api/payments${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${jwt.sign({ companyId: company, userId: ids.get(company), rol: 'ADMIN' }, process.env.JWT_SECRET!)}` },
  });
  assert.equal((await pay('/checkout-intents')).status, 404);

  async function gateway(companyId: number, provider = 'mercadopago') {
    const { rows: [row] } = await uow.run(companyId, (sql) => sql.query(`
      INSERT INTO payment_gateways (company_id,provider,display_name) VALUES ($1,$2,'Checkout fixture') RETURNING id
    `, [companyId, provider]));
    return Number(row.id);
  }

  async function product(companyId: number, name: string, price: string, availability = 'stock', currency = 'PEN') {
    const { rows: [row] } = await uow.run(companyId, (sql) => sql.query(`
      INSERT INTO products (company_id,name,price,currency,item_type,stock_available,availability_type)
      VALUES ($1,$2,$3,$4,'physical_product',40,$5) RETURNING id
    `, [companyId, name, price, currency, availability]));
    return Number(row.id);
  }

  let chatSequence = 0;
  async function order(companyId: number, products: Array<[number, number]>, kind: 'confirmed' | 'reserved' | 'quoted' = 'confirmed') {
    const phone = `1202555${String(++chatSequence).padStart(4, '0')}`;
    await uow.run(companyId, async (sql) => {
      const { rows: [contact] } = await sql.query(`
        INSERT INTO contacts (company_id,channel,external_contact_id) VALUES ($1,'whatsapp',$2) RETURNING id
      `, [companyId, phone]);
      await sql.query(`
        INSERT INTO conversations (company_id,channel,external_conversation_id,contact_id) VALUES ($1,'whatsapp',$2,$3)
      `, [companyId, phone, contact.id]);
    });
    const detected = await orders.createDetected({
      companyId, userId: actor(companyId).actorUserId, chatId: phone,
      items: products.map(([commercialItemId, quantity]) => ({ commercialItemId, quantity, productName: 'Fixture' })),
    });
    if (kind === 'quoted') return detected.order.id;
    const committed = await orders.updateStatus(companyId, detected.order.id, kind, actor(companyId).actorUserId, kind === 'reserved' ? 1 : undefined);
    assert.equal(committed?.status, kind);
    return detected.order.id;
  }

  const mp = await gateway(tenantA);
  const other = await gateway(tenantB);
  const manual = await gateway(tenantA, 'manual');
  const item = await product(tenantA, 'Snapshot stock', '0.10');
  const capacity = await product(tenantA, 'Snapshot capacity', '0.21', 'capacity');
  const foreignItem = await product(tenantB, 'Foreign order item', '4.00');
  const foreignOrder = await order(tenantB, [[foreignItem, 1]]);
  const originalOrder = await order(tenantA, [[item, 3], [capacity, 2]], 'reserved');
  const unconfirmedOrder = await order(tenantA, [[item, 1]], 'quoted');
  const input = (orderId: number, idempotencyKey: string, gatewayId = mp) => ({ ...actor(tenantA), orderId, gatewayId, idempotencyKey });
  async function stock(orderId: number) {
    return (await uow.run(tenantA, (sql) => sql.query(`
      SELECT movement_type, delta_available, delta_reserved FROM stock_movements
      WHERE company_id = $1 AND order_id = $2 ORDER BY id
    `, [tenantA, orderId]))).rows;
  }
  async function voucher(orderId: number) {
    return vouchers.create({
      companyId: tenantA, orderId, fileUrl: '/uploads/payment-vouchers/synthetic.pdf',
      paymentMethod: 'cash', currency: 'PEN', amount: 0.72, uploadedBy: actor(tenantA).actorUserId,
    });
  }

  await assert.rejects(intents.prepare(input(originalOrder, '')), { code: 'CHECKOUT_INPUT_INVALID' });
  await assert.rejects(intents.prepare({ ...input(originalOrder, 'operator'), sessionRole: 'EMPLEADO' }), { code: 'CHECKOUT_ADMIN_REQUIRED' });
  await assert.rejects(intents.prepare(input(foreignOrder, 'foreign-order')), { code: 'CHECKOUT_ORDER_NOT_FOUND' });
  await assert.rejects(intents.prepare(input(originalOrder, 'foreign-gateway', other)), { code: 'CHECKOUT_GATEWAY_UNAVAILABLE' });
  await assert.rejects(intents.prepare(input(originalOrder, 'manual-gateway', manual)), { code: 'CHECKOUT_GATEWAY_UNAVAILABLE' });
  await assert.rejects(intents.prepare(input(unconfirmedOrder, 'quoted')), { code: 'CHECKOUT_ORDER_NOT_READY' });

  await uow.run(tenantA, (sql) => sql.query("UPDATE products SET price=99, name='Updated catalog' WHERE company_id=$1 AND id=$2", [tenantA, item]));
  const movements = await stock(originalOrder);
  const writes = await Promise.all(Array.from({ length: 8 }, () => intents.prepare(input(originalOrder, 'same-key'))));
  const [first] = writes;
  assert.ok(writes.every(({ id, externalReference }) => id === first.id && externalReference === first.externalReference));
  assert.notEqual(first.id, first.externalReference);
  assert.match(first.externalReference, /^[0-9a-f-]{36}$/);
  assert.equal(first.amount, '0.72');
  assert.equal(first.currency, 'PEN');
  assert.equal(first.state, 'prepared');
  assert.equal(first.version, 1);
  assert.ok(first.reservationExpiresAt);
  assert.deepEqual(first.items.map(({ title, unitAmount, quantity }) => ({ title, unitAmount, quantity })), [
    { title: 'Snapshot stock', unitAmount: '0.10', quantity: 3 },
    { title: 'Snapshot capacity', unitAmount: '0.21', quantity: 2 },
  ]);
  assert.deepEqual(await stock(originalOrder), movements);
  await assert.rejects(intents.prepare(input(originalOrder, 'different-key')), { code: 'CHECKOUT_ALREADY_PREPARED' });
  assert.equal((await db.query('SELECT id FROM payment_checkout_intents')).rowCount, 0);
  assert.equal((await uow.run(tenantB, (sql) => sql.query('SELECT id FROM payment_checkout_intents WHERE id=$1', [first.id]))).rowCount, 0);
  await assert.rejects(uow.run(tenantA, (sql) => sql.query(`
    UPDATE payment_checkout_intents SET gateway_id=$1 WHERE company_id=$2 AND id=$3
  `, [other, tenantA, first.id])), { code: '23503' });

  const cash = await voucher(originalOrder);
  await assert.rejects(intents.prepare(input(originalOrder, 'same-key')), { code: 'CHECKOUT_VOUCHER_PENDING' });
  assert.equal((await pay(`/${cash.id}/validate`, tenantB)).status, 404);
  const paid = await pay(`/${cash.id}/validate`);
  assert.equal(paid.status, 200);
  assert.equal((await paid.json()).data.status, 'validated');
  const recorded = await intents.prepare(input(originalOrder, 'same-key'));
  assert.equal(recorded.state, 'voided');
  assert.equal(recorded.version, 2);
  assert.equal(recorded.voidReason, 'voucher_validated');
  await assert.rejects(intents.prepare(input(originalOrder, 'after-paid')), { code: 'CHECKOUT_PAYMENT_ALREADY_VALIDATED' });
  assert.deepEqual(await stock(originalOrder), movements);

  const casOrder = await order(tenantA, [[item, 1]]);
  const second = await intents.prepare(input(casOrder, 'manual-void'));
  const voided = await Promise.allSettled(Array.from({ length: 2 }, () =>
    intents.void({ ...actor(tenantA), intentId: second.id, expectedVersion: 1 })));
  assert.equal(voided.filter(({ status }) => status === 'fulfilled').length, 1);
  const [stale] = voided.filter((result) => result.status === 'rejected');
  assert.equal(stale.reason.code, 'CHECKOUT_VERSION_CONFLICT');
  assert.equal((await intents.prepare(input(casOrder, 'manual-void'))).voidReason, 'operator_cancelled');
  assert.notEqual((await intents.prepare(input(casOrder, 'replacement-key'))).externalReference, second.externalReference);

  const concurrentOrders = await Promise.all([order(tenantA, [[item, 1]]), order(tenantA, [[item, 1]])]);
  const sharedKey = await Promise.allSettled(concurrentOrders.map((id) => intents.prepare(input(id, 'across-orders'))));
  assert.equal(sharedKey.filter(({ status }) => status === 'fulfilled').length, 1);
  const [misused] = sharedKey.filter((result) => result.status === 'rejected');
  assert.equal(misused.reason.code, 'CHECKOUT_KEY_CONFLICT');

  const changedOrder = await order(tenantA, [[item, 1]]);
  await intents.prepare(input(changedOrder, 'order-revision'));
  await uow.run(tenantA, (sql) => sql.query(`
    UPDATE order_items SET unit_price=unit_price+1 WHERE company_id=$1 AND order_id=$2
  `, [tenantA, changedOrder]));
  await assert.rejects(intents.prepare(input(changedOrder, 'order-revision')), { code: 'CHECKOUT_SNAPSHOT_CHANGED' });
  const unsupported = await product(tenantA, 'Foreign currency', '1.00', 'unlimited', 'USD');
  await assert.rejects(intents.prepare(input(await order(tenantA, [[unsupported, 1]]), 'other-currency')), { code: 'CHECKOUT_CURRENCY_UNSUPPORTED' });
  const free = await product(tenantA, 'No payable amount', '0.00', 'unlimited');
  await assert.rejects(intents.prepare(input(await order(tenantA, [[free, 1]]), 'missing-amount')), { code: 'CHECKOUT_AMOUNT_INVALID' });
  const damaged = await order(tenantA, [[capacity, 1]]);
  await uow.run(tenantA, (sql) => sql.query('UPDATE stock_movements SET delta_reserved=0 WHERE company_id=$1 AND order_id=$2', [tenantA, damaged]));
  await assert.rejects(intents.prepare(input(damaged, 'missing-stock')), { code: 'CHECKOUT_STOCK_UNVERIFIED' });

  const expiredOrder = await order(tenantA, [[capacity, 1]], 'reserved');
  const expiring = await intents.prepare(input(expiredOrder, 'expiring'));
  await uow.run(tenantA, (sql) => sql.query(`
    UPDATE customer_orders SET reservation_expires_at=clock_timestamp()-interval '1 second'
    WHERE company_id=$1 AND id=$2
  `, [tenantA, expiredOrder]));
  await assert.rejects(intents.prepare(input(expiredOrder, 'expiring')), { code: 'CHECKOUT_RESERVATION_EXPIRED' });
  const late = await voucher(expiredOrder);
  let signalLocked!: () => void;
  let unlock!: () => void;
  const lockAcquired = new Promise<void>((resolve) => { signalLocked = resolve; });
  const release = new Promise<void>((resolve) => { unlock = resolve; });
  const held = uow.run(tenantA, async (sql) => {
    await new OrderRepositoryPg(sql).lockForCheckout(tenantA, expiredOrder);
    signalLocked();
    await release;
  });
  await lockAcquired;
  const concurrent = Promise.allSettled([
    intents.prepare(input(expiredOrder, 'late-new')),
    pay(`/${late.id}/validate`),
    orders.expireReservation(tenantA, expiredOrder),
  ]);
  await delay(40);
  unlock();
  await held;
  const [preparing, validating, expiringWorker] = await concurrent;
  assert.equal(preparing.status, 'rejected');
  assert.match(preparing.reason.code, /^CHECKOUT_(VOUCHER_PENDING|PAYMENT_ALREADY_VALIDATED)$/);
  assert.equal(validating.status, 'fulfilled');
  assert.equal(validating.value.status, 200);
  assert.equal((await validating.value.json()).data.orderReconciliationRequired, true);
  assert.equal(expiringWorker.status, 'fulfilled');
  assert.equal(expiringWorker.value?.status, 'cancelled');
  assert.equal((await stock(expiredOrder)).filter(({ delta_reserved }) => delta_reserved < 0).length, 1);
  const lateResult = await intents.prepare(input(expiredOrder, 'expiring'));
  assert.equal(lateResult.id, expiring.id);
  assert.equal(lateResult.voidReason, 'voucher_validated');
  assert.equal(lateResult.version, 2);
  await assert.rejects(intents.prepare(input(expiredOrder, 'never-duplicate')), { code: 'CHECKOUT_PAYMENT_ALREADY_VALIDATED' });
  assert.equal(outbound.mock.callCount(), 0);
});
