import './fixtures/testEnv';
import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { once } from 'node:events';
import { test, type TestContext } from 'node:test';
import express from 'express';
import { Pool } from 'pg';
import { TenantScopedUoW } from '../db/TenantScopedUoW';
import { requireJwt } from '../middleware/jwtAuth';
import createCatalogRoutes from '../routes/catalogRoutes';
import createProductRoutes from '../routes/productRoutes';

const { errorHandler } = require('../middleware/errorHandler');
const jwt = require('jsonwebtoken') as { sign(claims: Record<string, unknown>, secret: string): string };
const connectionString = process.env.CATALOG_INVENTORY_TEST_DATABASE_URL;
const tenantA = randomInt(500_000_000, 700_000_000);
const tenantB = tenantA + 1;
const adminId = 4101;
const operatorId = 4102;
const otherAdminId = 4103;
const url = (name: string) => `/uploads/commercial-items/${name}.png`;

function accessToken(companyId: number, userId: number, rol = 'ADMIN') {
  return jwt.sign({ companyId, userId, rol }, process.env.JWT_SECRET!);
}

async function http(t: TestContext, db?: Pool) {
  const app = express();
  app.use(express.json());
  app.use('/api/catalogs', requireJwt, createCatalogRoutes(db));
  app.use('/api/commercial-items', requireJwt, createProductRoutes(db));
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())));
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return async (method: string, path: string, token?: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/api${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-tenant-id': String(tenantB),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
}

test('catalog and inventory legacy HTTP entry points enforce authentication and admin catalog edits', async (t) => {
  const request = await http(t);
  assert.equal((await request('GET', '/catalogs')).status, 401);
  assert.equal((await request('GET', '/commercial-items')).status, 401);
  const employee = accessToken(tenantA, operatorId, 'EMPLEADO');
  assert.equal((await request('POST', '/catalogs', employee, { name: 'Forbidden' })).status, 403);
  assert.equal((await request('PATCH', '/commercial-items/1/status', employee, { status: 'active' })).status, 403);
});

test('catalog, assignments, images and inventory stay tenant-scoped and atomic in PostgreSQL', {
  skip: !connectionString && 'CATALOG_INVENTORY_TEST_DATABASE_URL is required',
}, async (t) => {
  const db = new Pool({ connectionString });
  t.after(() => db.end());
  const uow = new TenantScopedUoW(db);
  const request = await http(t, db);
  const admin = accessToken(tenantA, adminId);
  const operator = accessToken(tenantA, operatorId, 'EMPLEADO');
  const other = accessToken(tenantB, otherAdminId);
  const { rows: [role] } = await db.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
  assert.deepEqual(role, { rolsuper: false, rolbypassrls: false });
  const { rows: [rls] } = await db.query(`
    SELECT count(*)::int AS count, bool_and(relrowsecurity AND relforcerowsecurity) AS enforced
    FROM pg_class WHERE relname = ANY($1::text[])
  `, [['catalogs', 'catalog_sections', 'products', 'catalog_items', 'product_images', 'stock_movements']]);
  assert.deepEqual(rls, { count: 6, enforced: true });
  for (const [companyId, userIds] of [[tenantA, [adminId, operatorId]], [tenantB, [otherAdminId]]] as const) {
    await uow.run(companyId, async (sql) => {
      await sql.query("INSERT INTO companies (id, name) VALUES ($1, 'Fixture Inventory')", [companyId]);
      for (const userId of userIds) {
        await sql.query(`
          INSERT INTO usuarios (id, company_id, nombre, email, password_hash)
          VALUES ($1, $2, 'Fixture Operator', $3, 'fixture-unused-hash')
        `, [userId, companyId, `inventory-${companyId}-${userId}@invalid.test`]);
      }
    });
  }

  async function create(path: string, auth: string, body: unknown) {
    const result = await request('POST', path, auth, body);
    assert.equal(result.status, 201, JSON.stringify(result.body));
    return result.body.data;
  }

  const first = await create('/catalogs', admin, { name: 'Main catalogue' });
  const second = await create('/catalogs', admin, { name: 'Secondary catalogue' });
  const remote = await create('/catalogs', other, { name: 'Foreign catalogue' });
  const section = await create(`/catalogs/${first.id}/sections`, admin, { name: 'Main section' });
  const wrongSection = await create(`/catalogs/${second.id}/sections`, admin, { name: 'Wrong section' });
  const foreignSection = await create(`/catalogs/${remote.id}/sections`, other, { name: 'Foreign section' });
  const catalogEdit = await request('PATCH', `/catalogs/${first.id}`, admin, { name: 'Updated catalogue' });
  assert.equal(catalogEdit.body.data.name, 'Updated catalogue');
  const sectionEdit = await request('PATCH', `/catalogs/sections/${section.id}`, admin, { name: 'Updated section' });
  assert.equal(sectionEdit.body.data.name, 'Updated section');
  const visibleCatalogs = await request('GET', '/catalogs', operator);
  assert.deepEqual(visibleCatalogs.body.data.map((item: { id: number }) => item.id).sort(), [first.id, second.id].sort());
  const sectionList = await request('GET', `/catalogs/${first.id}/sections`, operator);
  assert.deepEqual(sectionList.body.data.map((item: { id: number }) => item.id), [section.id]);
  assert.equal((await request('GET', `/catalogs/${remote.id}/sections`, admin)).status, 404);
  assert.equal((await request('PATCH', `/catalogs/${remote.id}`, admin, { name: 'Forbidden' })).status, 404);
  assert.equal((await request('PATCH', `/catalogs/sections/${foreignSection.id}`, admin, { name: 'Forbidden' })).status, 404);

  const rejectedCreate = await request('POST', '/commercial-items', admin, {
    name: 'Unpublished attempt', status: 'active', catalogAssignments: [{ catalogId: first.id, sectionId: section.id }],
  });
  assert.equal(rejectedCreate.status, 400);
  assert.deepEqual((await request('GET', '/commercial-items?q=Unpublished', admin)).body.data, []);

  const localDraft = await create('/commercial-items', operator, { name: 'Employee draft', status: 'active', aiEnabled: true });
  assert.equal(localDraft.status, 'draft');
  assert.equal(localDraft.aiEnabled, false);
  const foreignItem = await create('/commercial-items', other, {
    name: 'Foreign item', status: 'draft', images: [{ imageUrl: url('foreign') }],
  });
  const local = await create('/commercial-items', admin, {
    name: 'Primary item', status: 'active', aiEnabled: true, stockAvailable: 5,
    catalogAssignments: [{ catalogId: first.id, sectionId: section.id }],
    images: [{ imageUrl: url('one'), isPrimary: true }, { imageUrl: url('two'), isPrimary: true }],
  });
  const base = `/commercial-items/${local.id}`;
  assert.equal(local.primaryImage.url, url('two'));
  assert.deepEqual(local.sections.map((entry: { id: number }) => entry.id), [section.id]);
  const localEdit = await request('PATCH', base, operator, { name: 'Employee edit', status: 'archived', aiEnabled: false });
  assert.equal(localEdit.body.data.name, 'Employee edit');
  assert.equal(localEdit.body.data.status, 'active');
  assert.equal(localEdit.body.data.aiEnabled, true);
  assert.equal((await request('GET', base, other)).status, 404);
  assert.equal((await request('POST', `${base}/stock-adjustments`, other, { delta: 1 })).status, 404);

  const itemCollection = `/catalogs/${first.id}/items`;
  assert.equal((await request('POST', itemCollection, admin, { commercialItemId: foreignItem.id })).status, 404);
  assert.equal((await request('POST', itemCollection, admin, { commercialItemId: local.id, sectionId: wrongSection.id })).status, 404);
  assert.equal((await request('POST', itemCollection, admin, { commercialItemId: local.id, sectionId: 0 })).status, 400);
  const linked = await create(itemCollection, admin, { commercialItemId: localDraft.id, sectionId: section.id });
  assert.equal(linked.added, true);
  assert.equal((await request('DELETE', `${itemCollection}/${localDraft.id}`, admin)).body.data.removed, true);

  for (const bad of [
    { catalogId: remote.id, sectionId: foreignSection.id }, { catalogId: second.id, sectionId: section.id },
  ]) {
    const result = await request('PATCH', base, admin, {
      name: 'Roll back name', stockAvailable: 9,
      catalogAssignments: [{ catalogId: first.id, sectionId: section.id }, bad],
      images: [{ imageUrl: url('must-not-persist') }],
    });
    assert.equal(result.status, 404, JSON.stringify(result.body));
  }
  const emptyGallery = await request('PATCH', base, admin, {
    name: 'Roll back gallery change', stockAvailable: 8, catalogAssignments: [], images: [],
  });
  assert.equal(emptyGallery.status, 400);
  const afterRollback = (await request('GET', base, admin)).body.data;
  assert.equal(afterRollback.name, 'Employee edit');
  assert.equal(afterRollback.stockAvailable, 5);
  assert.equal(afterRollback.primaryImage.url, url('two'));
  assert.deepEqual(afterRollback.catalogs.map((item: { id: number }) => item.id), [first.id]);
  const beforeStock = await uow.run(tenantA, (sql) => sql.query('SELECT id FROM stock_movements WHERE product_id = $1', [local.id]));
  assert.equal(beforeStock.rowCount, 0);

  const badImage = foreignItem.images[0].id;
  assert.equal((await request('PATCH', `${base}/images/${badImage}`, admin, { isPrimary: true })).status, 404);
  assert.equal((await request('DELETE', `${base}/images/${badImage}`, admin)).status, 404);
  assert.equal((await request('GET', base, admin)).body.data.primaryImage.url, url('two'));
  const single = await create('/commercial-items', admin, { name: 'One image item', imageUrl: url('only-image') });
  const singleImage = `/commercial-items/${single.id}/images/${single.images[0].id}`;
  assert.equal((await request('DELETE', singleImage, operator)).status, 400);
  assert.equal((await request('GET', `/commercial-items/${single.id}`, admin)).body.data.primaryImage.url, url('only-image'));
  assert.equal((await request('PATCH', `/commercial-items/${single.id}/status`, admin, { status: 'inactive' })).status, 200);
  assert.equal((await request('DELETE', singleImage, operator)).status, 200);
  assert.equal((await request('GET', `/commercial-items/${single.id}`, admin)).body.data.primaryImage, null);
  const switches = await Promise.all(local.images.map((image: { id: number }) =>
    request('PATCH', `${base}/images/${image.id}`, operator, { isPrimary: true })));
  assert.deepEqual(switches.map((result) => result.status), [200, 200]);
  let gallery = (await request('GET', base, admin)).body.data;
  assert.equal(gallery.images.filter((image: { isPrimary: boolean }) => image.isPrimary).length, 1);
  const former = gallery.images.find((image: { isPrimary: boolean }) => image.isPrimary);
  assert.equal(gallery.imageUrl, former.url);
  const demoted = await request('PATCH', `${base}/images/${former.id}`, operator, { isPrimary: false });
  assert.equal(demoted.body.data.isPrimary, false);
  gallery = (await request('GET', base, admin)).body.data;
  assert.notEqual(gallery.primaryImage.url, former.url);

  const additions = await Promise.all(Array.from({ length: 8 }, (_, index) =>
    request('POST', `${base}/images`, operator, { imageUrl: url(`additional-${index}`), isPrimary: true })));
  assert.deepEqual(additions.map((result) => result.status).sort(), [201, 201, 201, 201, 201, 201, 400, 400]);
  gallery = (await request('GET', base, admin)).body.data;
  assert.equal(gallery.images.length, 8);
  assert.equal(gallery.images.filter((image: { isPrimary: boolean }) => image.isPrimary).length, 1);
  assert.equal(gallery.imageUrl, gallery.images.find((image: { isPrimary: boolean }) => image.isPrimary).url);

  const stock = await Promise.all(Array.from({ length: 8 }, () =>
    request('POST', `${base}/stock-adjustments`, operator, { delta: -1 })));
  assert.deepEqual(stock.map((result) => result.status).sort(), [200, 200, 200, 200, 200, 400, 400, 400]);
  const availability = await request('GET', `${base}/availability`, operator);
  assert.equal(availability.body.data.availableQuantity, 0);
  const absolute = await request('PATCH', `${base}/availability`, operator, { availableQuantity: 2 });
  assert.equal(absolute.status, 200);
  assert.equal(absolute.body.data.stockAvailable, 2);
  const movements = await uow.run(tenantA, (sql) => sql.query(`
    SELECT delta_available, stock_available_after, actor_user_id FROM stock_movements
    WHERE company_id = $1 AND product_id = $2 ORDER BY id
  `, [tenantA, local.id]));
  assert.deepEqual(movements.rows.map((movement) => movement.stock_available_after), [4, 3, 2, 1, 0, 2]);
  assert.deepEqual(movements.rows.map((movement) => movement.delta_available), [-1, -1, -1, -1, -1, 2]);
  assert.ok(movements.rows.every((movement) => movement.actor_user_id === String(operatorId)));
  assert.equal((await db.query('SELECT id FROM products')).rowCount, 0);
  assert.equal((await db.query('SELECT id FROM stock_movements')).rowCount, 0);
});
