import './fixtures/testEnv';
import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import express from 'express';
import { Pool } from 'pg';
import { TenantScopedUoW } from '../db/TenantScopedUoW';
import { requireJwt } from '../middleware/jwtAuth';
import { OrderRepositoryPg } from '../modules/orders';
import { startOrderReservationExpiry } from '../modules/orders/application/OrderReservationExpiry';
import { PaymentRepositoryPg } from '../modules/payments/infra/db/PaymentRepositoryPg';
import createOrderRoutes from '../routes/orderRoutes';

const { errorHandler } = require('../middleware/errorHandler');
const jwt = require('jsonwebtoken') as { sign(claims: Record<string, unknown>, secret: string): string };
const connectionString = process.env.ORDERS_TEST_DATABASE_URL;
const tenantA = randomInt(500_000_000, 700_000_000);
const tenantB = tenantA + 1;
const actorA = 5101;
const actorB = 5102;

function token(companyId: number, userId: number, rol = 'EMPLEADO') {
  return jwt.sign({ companyId, userId, rol }, process.env.JWT_SECRET!);
}

async function http(t: TestContext, db?: Pool) {
  const app = express();
  app.use(express.json());
  app.use('/api/orders', requireJwt, createOrderRoutes(db));
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return async (method: string, path = '', auth?: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/orders${path}`, {
      method, headers: {
        'content-type': 'application/json',
        'x-tenant-id': String(tenantB),
        ...(auth ? { authorization: `Bearer ${auth}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
}

test('orders require authenticated operators and reject invalid detected items before writing', async (t) => {
  const request = await http(t);
  assert.equal((await request('GET')).status, 401);
  assert.equal((await request('POST', '/1/confirm', token(tenantA, actorA, 'READ_ONLY'))).status, 403);
  const user = token(tenantA, actorA);
  for (const payload of [
    { chatId: '12025550101', items: [] },
    { chatId: '12025550101', items: [{ commercialItemId: true }] },
    { chatId: '12025550101', items: [{ productName: 'Fixture', quantity: -1 }] },
    { chatId: '12025550101', items: [{ productName: 'Fixture' }], status: 'confirmed' },
  ]) {
    assert.equal((await request('POST', '/detected', user, payload)).status, 400);
  }
});

test('detected orders, reservations, transitions and audit remain atomic with PostgreSQL FORCE RLS', {
  skip: !connectionString && 'ORDERS_TEST_DATABASE_URL is required',
}, async (t) => {
  const db = new Pool({ connectionString });
  t.after(() => db.end());
  const uow = new TenantScopedUoW(db);
  const request = await http(t, db);
  const user = token(tenantA, actorA);
  const other = token(tenantB, actorB, 'ADMIN');
  const { rows: [role] } = await db.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
  assert.deepEqual(role, { rolsuper: false, rolbypassrls: false });
  const { rows: [rls] } = await db.query(`
    SELECT count(*)::int AS count, bool_and(relrowsecurity AND relforcerowsecurity) AS enforced FROM pg_class
    WHERE relname IN ('customer_orders','order_items','operational_actions','products','stock_movements')
  `);
  assert.deepEqual(rls, { count: 5, enforced: true });

  for (const [company, actor] of [[tenantA, actorA], [tenantB, actorB]] as const) {
    await uow.run(company, async (sql) => {
      await sql.query("INSERT INTO companies (id, name) VALUES ($1, 'Fixture Orders')", [company]);
      await sql.query(`
        INSERT INTO usuarios (id, company_id, nombre, email, password_hash)
        VALUES ($1,$2,'Operator',$3,'fixture-unused')
      `, [actor, company, `orders-${company}@invalid.test`]);
    });
  }

  async function chat(company: number, phone: string, externalContactId?: number) {
    return uow.run(company, async (sql) => {
      const { rows: [contact] } = await sql.query(`
        INSERT INTO contacts (company_id, channel, external_contact_id)
        VALUES ($1,'whatsapp',$2) RETURNING id
      `, [company, phone]);
      const { rows: [conversation] } = await sql.query(`
        INSERT INTO conversations (company_id, channel, external_conversation_id, contact_id)
        VALUES ($1,'whatsapp',$2,$3) RETURNING id
      `, [company, phone, externalContactId ?? contact.id]);
      const { rows: [message] } = await sql.query(`
        INSERT INTO messages (company_id, conversation_id, direction, channel)
        VALUES ($1,$2,'inbound','whatsapp') RETURNING id
      `, [company, conversation.id]);
      return { phone, contactId: contact.id, id: conversation.id, messageId: message.id };
    });
  }
  async function product(company: number, name: string, stock: number, kind = 'stock', allowBackorder = false) {
    return uow.run(company, async (sql) => {
      const { rows: [item] } = await sql.query(`
        INSERT INTO products (company_id, name, status, item_type, stock_available, availability_type, allow_backorder)
        VALUES ($1,$2,'active','custom',$3,$4,$5) RETURNING id
      `, [company, name, stock, kind, allowBackorder]);
      return Number(item.id);
    });
  }
  const first = await chat(tenantA, '12025550101');
  const second = await chat(tenantA, '12025550102');
  const mixed = await chat(tenantA, '12025550103');
  const paid = await chat(tenantA, '12025550104');
  const backorder = await chat(tenantA, '12025550105');
  const remote = await chat(tenantB, '12025550106');
  const invalidContact = await chat(tenantA, '12025550107', remote.contactId);
  const limited = await product(tenantA, 'Limited offer', 3);
  const extra = await product(tenantA, 'Available first line', 5);
  const scarce = await product(tenantA, 'Insufficient second line', 1);
  const booked = await product(tenantA, 'Capacity order', 4, 'capacity');
  const waiting = await product(tenantA, 'Backorder option', 0, 'stock', true);
  const foreign = await product(tenantB, 'Foreign offer', 9);
  const { rows: [agent] } = await uow.run(tenantB, (sql) => sql.query(
    "INSERT INTO ai_agents (company_id, name) VALUES ($1,'Foreign agent') RETURNING id", [tenantB],
  ));

  const items = (productId: number, quantity = 2) => [{ commercialItemId: productId, quantity }];
  const detected = (chatId: string, lines: ReturnType<typeof items>, additions: Record<string, unknown> = {}) =>
    request('POST', '/detected', user, { chatId, items: lines, ...additions });
  for (const result of [
    await detected(remote.phone, items(limited)),
    await detected(invalidContact.phone, items(limited)),
    await detected(first.phone, items(foreign)),
    await detected(first.phone, items(limited), { agentId: Number(agent.id) }),
    await detected(first.phone, items(limited), { sourceMessageId: second.messageId }),
  ]) {
    assert.equal(result.status, 404, JSON.stringify(result.body));
  }
  assert.equal((await detected(first.phone, items(limited), { companyId: tenantB, sourceMessageId: first.messageId })).status, 201);
  const duplicates = await Promise.all([
    detected(first.phone, [{ commercialItemId: limited, quantity: 1 }, { commercialItemId: limited, quantity: 1 }]),
    detected(`${first.phone}@c.us`, items(limited)),
  ]);
  assert.ok(duplicates.every((result) => result.status === 201));
  const orderA = duplicates[0].body.data.order;
  assert.equal(duplicates[1].body.data.order.id, orderA.id);
  assert.equal(orderA.companyId, tenantA);
  assert.equal(orderA.contactId, first.contactId);
  assert.equal(orderA.sourceMessageId, first.messageId);
  assert.equal(orderA.items.length, 1);
  assert.equal(orderA.items[0].quantity, 2);
  assert.equal(orderA.items[0].itemTypeSnapshot, 'custom');
  const b = await detected(second.phone, items(limited));
  assert.equal(b.status, 201, JSON.stringify(b.body));
  const orderB = b.body.data.order;
  assert.equal((await request('GET', `/${orderA.id}`, other)).status, 404);
  assert.equal((await request('POST', `/${orderA.id}/confirm`, other)).status, 404);
  assert.equal((await request('POST', `/${orderA.id}/confirm`, token(tenantA, actorB))).status, 403);
  const before = await request('GET', '', user);
  assert.equal(before.body.data.total, 2);
  assert.equal((await request('GET', '', other)).body.data.total, 0);

  const multi = await detected(mixed.phone, [...items(extra), ...items(scarce)]);
  assert.equal(multi.status, 201);
  const mixedOrder = multi.body.data.order;
  assert.equal(mixedOrder.status, 'unavailable');
  assert.equal((await request('POST', `/${mixedOrder.id}/confirm`, user)).body.error, 'ORDER_STOCK_UNAVAILABLE');
  const stock = async (id: number) => (await uow.run(tenantA, (sql) => sql.query(
    'SELECT stock_available, stock_reserved FROM products WHERE id = $1', [id],
  ))).rows[0];
  assert.deepEqual(await stock(extra), { stock_available: 5, stock_reserved: 0 });
  assert.deepEqual(await stock(scarce), { stock_available: 1, stock_reserved: 0 });

  const moves = (orderId: number) => uow.run(tenantA, (sql) => sql.query(`
    SELECT movement_type, delta_available, delta_reserved, actor_user_id
    FROM stock_movements WHERE order_id = $1 ORDER BY id
  `, [orderId]));
  assert.equal((await moves(mixedOrder.id)).rowCount, 0);
  assert.deepEqual(await stock(limited), { stock_available: 3, stock_reserved: 0 });

  const confirm = (id: number) => request('POST', `/${id}/confirm`, user);
  const results = await Promise.all([confirm(orderA.id), confirm(orderA.id), confirm(orderB.id)]);
  assert.equal(results[0].status, results[1].status);
  const firstWon = results[0].status === 200;
  assert.deepEqual(results.map((response) => response.status), firstWon ? [200, 200, 409] : [409, 409, 200]);
  const winner = firstWon ? orderA : orderB;
  const loser = firstWon ? orderB : orderA;
  assert.deepEqual(await stock(limited), { stock_available: 1, stock_reserved: 2 });
  assert.equal((await moves(winner.id)).rowCount, 1);
  assert.equal((await moves(loser.id)).rowCount, 0);

  const cancelled = await Promise.all([
    request('POST', `/${winner.id}/cancel`, user), request('POST', `/${winner.id}/cancel`, user),
  ]);
  assert.ok(cancelled.every((response) => response.status === 200 && response.body.data.status === 'cancelled'));
  assert.deepEqual(await stock(limited), { stock_available: 3, stock_reserved: 0 });
  assert.deepEqual((await moves(winner.id)).rows.map((entry) => entry.movement_type), ['reservation', 'release']);
  assert.equal((await confirm(loser.id)).status, 200);
  assert.equal((await request('PATCH', `/${loser.id}/status`, user, { status: 'reserved' })).status, 200);
  const complete = () => request('PATCH', `/${loser.id}/status`, user, { status: 'completed' });
  const completed = await Promise.all([complete(), complete()]);
  assert.ok(completed.every((response) => response.status === 200 && response.body.data.items[0].status === 'completed'));
  assert.equal((await request('POST', `/${loser.id}/cancel`, user)).status, 409);
  assert.deepEqual(await stock(limited), { stock_available: 1, stock_reserved: 0 });
  assert.deepEqual((await moves(loser.id)).rows, [
    { movement_type: 'reservation', delta_available: -2, delta_reserved: 2, actor_user_id: String(actorA) },
    { movement_type: 'completion', delta_available: 0, delta_reserved: -2, actor_user_id: String(actorA) },
  ]);
  const audit = await uow.run(tenantA, (sql) => sql.query(`
    SELECT action_type, count(*)::int AS count FROM operational_actions WHERE order_id = $1
      AND action_type IN ('order_confirmed','order_reserved','order_completed')
    GROUP BY action_type ORDER BY action_type
  `, [loser.id]));
  assert.deepEqual(audit.rows, [
    { action_type: 'order_completed', count: 1 }, { action_type: 'order_confirmed', count: 1 }, { action_type: 'order_reserved', count: 1 },
  ]);

  const legacy = (await detected(paid.phone, items(booked))).body.data.order;
  await uow.run(tenantA, (sql) => sql.query("UPDATE customer_orders SET status = 'confirmed' WHERE id = $1", [legacy.id]));
  assert.equal((await request('PATCH', `/${legacy.id}/status`, user, { status: 'completed' })).body.error, 'ORDER_CONFIRMATION_REQUIRED');
  await assert.rejects(uow.run(tenantA, async (sql) => {
    const order = await new OrderRepositoryPg(sql).updateStatus(tenantA, legacy.id, 'confirmed', actorA);
    assert.ok(order?.reservedAt);
    throw new Error('Rollback caller transaction');
  }), /Rollback caller transaction/);
  assert.equal((await moves(legacy.id)).rowCount, 0);
  assert.deepEqual(await stock(booked), { stock_available: 4, stock_reserved: 0 });
  assert.equal((await confirm(legacy.id)).status, 200);
  assert.equal((await confirm(legacy.id)).status, 200);
  assert.deepEqual((await moves(legacy.id)).rows.map((entry) => entry.movement_type), ['capacity_reserved']);

  const pending = (await detected(backorder.phone, items(waiting))).body.data.order;
  assert.equal(pending.status, 'pending_approval');
  assert.equal((await confirm(pending.id)).body.error, 'ORDER_STOCK_UNAVAILABLE');
  assert.deepEqual(await stock(waiting), { stock_available: 0, stock_reserved: 0 });

  const repo = new OrderRepositoryPg(db);
  const payments = new PaymentRepositoryPg(db);
  await uow.run(tenantA, (sql) => sql.query("UPDATE usuarios SET rol = 'ADMIN' WHERE id = $1", [actorA]));
  const payment = (orderId: number) => payments.create({
    companyId: tenantA, orderId, paymentMethod: 'yape', fileUrl: '/api/media/fixture', uploadedBy: actorA,
  });
  const timed = (await detected(second.phone, items(extra))).body.data.order;
  const reserve = (id: number, reservationMinutes: unknown, auth = user) =>
    request('PATCH', `/${id}/status`, auth, { status: 'reserved', reservationMinutes });
  const makeDue = (company: number, id: number) => uow.run(company, (sql) => sql.query(`
    UPDATE customer_orders SET reservation_expires_at = NOW() - INTERVAL '1 second' WHERE id = $1
  `, [id]));
  assert.equal((await reserve(timed.id, '30')).status, 400);
  assert.equal((await reserve(timed.id, 30, other)).status, 404);
  const reservation = await reserve(timed.id, 30);
  assert.equal(reservation.status, 200, JSON.stringify(reservation.body));
  assert.ok(Date.parse(reservation.body.data.reservationExpiresAt) > Date.now());
  assert.equal((await reserve(timed.id, 60)).body.data.reservationExpiresAt, reservation.body.data.reservationExpiresAt);
  const lateVoucher = await payment(timed.id);
  const paymentRows = () => payments.list(tenantA, { orderId: timed.id, limit: 5, offset: 0 });
  assert.equal((await paymentRows()).rows[0]?.voucherId, lateVoucher.id);
  assert.deepEqual(await stock(extra), { stock_available: 3, stock_reserved: 2 });
  assert.equal(await repo.expireReservation(tenantA, timed.id), null);
  assert.equal(await repo.expireReservation(tenantB, timed.id), null);
  await makeDue(tenantA, timed.id);
  assert.equal((await request('GET', `/${timed.id}`, user)).body.data.reservationReleasePending, true);
  assert.deepEqual(await repo.listDueReservations(tenantB), []);
  assert.equal((await confirm(timed.id)).body.error, 'ORDER_RESERVATION_EXPIRED');
  assert.equal((await request('PATCH', `/${timed.id}/status`, user, { status: 'completed' })).body.error, 'ORDER_RESERVATION_EXPIRED');
  const competing = await Promise.all([repo.expireReservation(tenantA, timed.id), repo.expireReservation(tenantA, timed.id)]);
  assert.equal(competing.filter(Boolean).length, 1);
  const expired = (await request('GET', `/${timed.id}`, user)).body.data;
  assert.equal(expired.status, 'cancelled');
  assert.equal(expired.reservationExpiresAt, null);
  assert.equal(expired.reservationReleasePending, false);
  assert.ok(expired.reservationExpiredAt);
  assert.deepEqual(await stock(extra), { stock_available: 5, stock_reserved: 0 });
  assert.deepEqual((await moves(timed.id)).rows, [
    { movement_type: 'reservation', delta_available: -2, delta_reserved: 2, actor_user_id: String(actorA) },
    { movement_type: 'release', delta_available: 2, delta_reserved: -2, actor_user_id: null },
  ]);
  assert.equal((await uow.run(tenantA, (sql) => sql.query(`
    SELECT id FROM operational_actions WHERE order_id = $1 AND action_type = 'order_reservation_expired' AND actor_user_id IS NULL
  `, [timed.id]))).rowCount, 1);
  assert.equal((await paymentRows()).rows[0]?.voucherStatus, 'pending');
  const lateDecision = await payments.updateStatus(tenantA, lateVoucher.id, 'validated', actorA);
  assert.equal(lateDecision?.status, 'validated');
  assert.equal(lateDecision?.orderReconciliationRequired, true);
  assert.equal((await paymentRows()).rows[0]?.orderReconciliationRequired, true);
  assert.equal((await repo.get(tenantA, timed.id))?.status, 'cancelled');
  assert.deepEqual(await stock(extra), { stock_available: 5, stock_reserved: 0 });

  const promoted = (await detected(second.phone, items(extra))).body.data.order;
  assert.equal((await reserve(promoted.id, 1)).status, 200);
  const earlyVoucher = await payment(promoted.id);
  const earlyDecision = await payments.updateStatus(tenantA, earlyVoucher.id, 'validated', actorA);
  assert.equal(earlyDecision?.status, 'validated');
  assert.equal(earlyDecision?.orderReconciliationRequired, false);
  assert.equal((await repo.get(tenantA, promoted.id))?.reservationExpiresAt, null);
  assert.equal(await repo.expireReservation(tenantA, promoted.id), null);
  assert.deepEqual(await stock(extra), { stock_available: 3, stock_reserved: 2 });

  const otherOrder = (await request('POST', '/detected', other, { chatId: remote.phone, items: items(foreign) })).body.data.order;
  assert.equal((await reserve(otherOrder.id, 1, other)).status, 200);
  await makeDue(tenantB, otherOrder.id);
  const stopExpiry = startOrderReservationExpiry(db);
  try {
    for (let i = 0; i < 50; i++) {
      if ((await repo.get(tenantB, otherOrder.id))?.reservationExpiredAt) break;
      await delay(20);
    }
    assert.ok((await repo.get(tenantB, otherOrder.id))?.reservationExpiredAt);
    assert.equal((await repo.get(tenantA, promoted.id))?.status, 'confirmed');
  } finally {
    stopExpiry();
  }
  assert.equal((await db.query('SELECT id FROM customer_orders')).rowCount, 0);
  assert.equal((await db.query('SELECT id FROM stock_movements')).rowCount, 0);
});
