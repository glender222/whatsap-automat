import './fixtures/testEnv';
import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import express from 'express';
import { Pool } from 'pg';
import { TenantScopedUoW } from '../db/TenantScopedUoW';
import { requireJwt } from '../middleware/jwtAuth';
import createPaymentRoutes from '../routes/paymentRoutes';

const { errorHandler } = require('../middleware/errorHandler');
const jwt = require('jsonwebtoken') as { sign(claims: Record<string, unknown>, secret: string): string };
const connectionString = process.env.PAYMENT_CHECKOUT_TEST_DATABASE_URL;

test('payment collection filters before counting and paginating with PostgreSQL FORCE RLS', {
  skip: !connectionString && 'PAYMENT_CHECKOUT_TEST_DATABASE_URL is required',
  timeout: 20_000,
}, async (t) => {
  const db = new Pool({ connectionString });
  t.after(() => db.end());
  const uow = new TenantScopedUoW(db);
  const company = randomInt(450_000_000, 500_000_000);
  const otherCompany = company + 1;
  const { rows: [role] } = await db.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
  assert.deepEqual(role, { rolsuper: false, rolbypassrls: false });
  const { rows: [rls] } = await db.query(`
    SELECT count(*)::int AS count, bool_and(relrowsecurity AND relforcerowsecurity) AS enforced
    FROM pg_class WHERE relname IN ('customer_orders', 'order_items', 'payment_vouchers')
  `);
  assert.deepEqual(rls, { count: 3, enforced: true });
  for (const tenant of [company, otherCompany]) {
    await uow.run(tenant, (sql) => sql.query("INSERT INTO companies (id, name) VALUES ($1, 'Payment list fixture')", [tenant]));
  }

  async function orders(tenant: number, count: number, date: string, status?: 'pending' | 'validated' | 'rejected') {
    return uow.run(tenant, async (sql) => {
      const { rows } = await sql.query(`
        INSERT INTO customer_orders (company_id, title, status, order_type, occurred_at)
        SELECT $1, 'Payment list fixture', 'draft', 'commercial', $2::timestamptz + n * interval '1 second'
        FROM generate_series(1, $3::int) AS n RETURNING id
      `, [tenant, date, count]);
      const ids = rows.map((row) => Number(row.id));
      await sql.query(`
        INSERT INTO order_items (company_id, order_id, product_name, quantity, unit_price)
        SELECT $1, id, 'Payment fixture item', 1, 10 FROM unnest($2::bigint[]) AS id
      `, [tenant, ids]);
      if (status) await sql.query(`
        INSERT INTO payment_vouchers (company_id, order_id, file_url, status, uploaded_at)
        SELECT $1, id, '/uploads/payment-vouchers/fixture.png', $3, $4::timestamptz
        FROM unnest($2::bigint[]) AS id
      `, [tenant, ids, status, date]);
      return ids;
    });
  }
  const oldCollectible = await orders(company, 3, '2025-01-01T00:00:00Z');
  await orders(company, 100, '2026-01-01T00:00:00Z', 'validated');
  const pending = await orders(company, 1, '2026-02-01T00:00:00Z', 'pending');
  const rejected = await orders(company, 1, '2026-03-01T00:00:00Z', 'rejected');
  const foreignCollectible = await orders(otherCompany, 1, '2026-04-01T00:00:00Z');
  await uow.run(company, (sql) => sql.query(`
    INSERT INTO payment_vouchers (company_id, file_url, status, uploaded_at)
    VALUES ($1, '/uploads/payment-vouchers/orphan.png', 'pending', '2026-04-01T00:00:00Z')
  `, [company]));

  const app = express();
  app.use('/api/payments', requireJwt, createPaymentRoutes(db));
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  async function request(query: string, tenant = company, role = 'ADMIN') {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/payments?${query}`, {
      headers: {
        authorization: 'Bearer ' + jwt.sign({ companyId: tenant, userId: 1, rol: role }, process.env.JWT_SECRET!),
        'x-tenant-id': String(otherCompany),
      },
    });
    return { status: response.status, body: await response.json() };
  }
  async function list(query: string, tenant = company) {
    const result = await request(query, tenant);
    assert.equal(result.status, 200);
    assert.equal(result.body.success, true);
    return result.body.data;
  }

  const all = await list('limit=100');
  assert.equal(all.total, 106);
  assert.equal(all.rows.length, 100);
  assert.equal(all.rows.some((row: { processStatus: string }) => row.processStatus === 'collect_payment'), false);

  const first = await list('processStatus=collect_payment&limit=2&offset=0');
  assert.equal(first.total, 3, 'the total must count collectible orders, not every payment row');
  assert.equal(first.limit, 2);
  assert.equal(first.offset, 0);
  assert.deepEqual(first.rows.map((row: { orderId: number }) => row.orderId), oldCollectible.slice(1).reverse());
  assert.ok(first.rows.every((row: { processStatus: string }) => row.processStatus === 'collect_payment'));
  const last = await list('processStatus=collect_payment&limit=2&offset=2');
  assert.equal(last.total, 3);
  assert.equal(last.offset, 2);
  assert.deepEqual(last.rows.map((row: { orderId: number }) => row.orderId), oldCollectible.slice(0, 1));
  const afterLast = await list('processStatus=collect_payment&limit=2&offset=4');
  assert.equal(afterLast.total, 3);
  assert.deepEqual(afterLast.rows, []);
  const foreign = await list('processStatus=collect_payment&limit=100', otherCompany);
  assert.equal(foreign.total, 1);
  assert.deepEqual(foreign.rows.map((row: { orderId: number }) => row.orderId), foreignCollectible);
  assert.deepEqual((await list(`processStatus=collect_payment&orderId=${foreignCollectible[0]}`)).rows, []);

  // Keep the existing voucher-status contract, including orders awaiting their first voucher.
  const legacyPending = await list('status=pending&limit=100');
  assert.equal(legacyPending.total, 5);
  assert.equal(legacyPending.rows.filter((row: { processStatus: string }) => row.processStatus === 'collect_payment').length, 3);
  assert.ok(legacyPending.rows.some((row: { orderId: number }) => row.orderId === pending[0]));
  assert.ok(legacyPending.rows.some((row: { rowType: string }) => row.rowType === 'voucher'));
  const validated = await list('status=validated&limit=2&offset=98');
  assert.equal(validated.total, 100);
  assert.equal(validated.rows.length, 2);
  assert.ok(validated.rows.every((row: { processStatus: string }) => row.processStatus === 'validated'));
  const refused = await list('status=rejected');
  assert.equal(refused.total, 1);
  assert.deepEqual(refused.rows.map((row: { orderId: number }) => row.orderId), rejected);
  const combined = await list('processStatus=collect_payment&status=validated');
  assert.equal(combined.total, 0);
  assert.deepEqual(combined.rows, []);
  assert.equal((await request('processStatus=unknown')).status, 400);
  assert.equal((await request('processStatus=collect_payment', company, 'EMPLEADO')).status, 403);
});
