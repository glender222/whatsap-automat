import './fixtures/testEnv';
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { Pool } from 'pg';
import { TenantScopedUoW } from '../db/TenantScopedUoW';
import { MarketplaceRegistry } from '../services/marketplace/MarketplaceRegistry';
import { accessToken, jsonPost, marketplaceHttp } from './fixtures/marketplaceHttp';

const connectionString = process.env.MARKETPLACE_TEST_DATABASE_URL;
const runId = `marketplace-test-${randomUUID()}`;
const tenantA = randomInt(500_000_000, 900_000_000);
const tenantB = tenantA + 1;

function manifest(id: string, name = id) {
  return { id, name, version: '1.0.0', type: 'tool', entrypoint: 'dist/index.js' };
}

describe('Marketplace PostgreSQL with FORCE RLS', { skip: !connectionString && 'MARKETPLACE_TEST_DATABASE_URL is required' }, () => {
  let db: Pool;
  let tenantWork: TenantScopedUoW;

  before(async () => {
    db = new Pool({ connectionString });
    tenantWork = new TenantScopedUoW(db);
    const { rows: [runtime] } = await db.query(`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user
    `);
    assert.equal(runtime.rolsuper, false, 'Test must use a non-superuser database role.');
    assert.equal(runtime.rolbypassrls, false, 'Test must use a NOBYPASSRLS database role.');
    const { rows: [tables] } = await db.query(`
      SELECT count(*)::int AS count, bool_and(relrowsecurity AND relforcerowsecurity) AS enforced
      FROM pg_class
      WHERE oid IN (
        'marketplace_extensions'::regclass, 'marketplace_extension_aliases'::regclass,
        'marketplace_ratings'::regclass, 'marketplace_rating_totals'::regclass
      )
    `);
    assert.deepEqual(tables, { count: 4, enforced: true });

    for (const tenantId of [tenantA, tenantB]) {
      await tenantWork.run(tenantId, (client) => client.query(`
        INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)
      `, [tenantId, 'Marketplace test tenant', `${runId}-${tenantId}`]));
    }
  });

  after(async () => {
    if (db) await db.end();
  });

  test('health reports unavailable when the storage schema is missing', async (t) => {
    const noCatalog = new Pool({ connectionString, options: '-c search_path=pg_catalog' });
    t.after(() => noCatalog.end());
    const request = await marketplaceHttp(t, new MarketplaceRegistry(noCatalog));
    const health = await request('/health');
    assert.equal(health.status, 503);
    assert.deepEqual(await health.json(), { status: 'unavailable', service: 'marketplace-registry' });
  });

  test('reserves overlapping aliases atomically across tenants', async (t) => {
    const request = await marketplaceHttp(t, new MarketplaceRegistry(db));
    const health = await request('/health');
    assert.equal(health.status, 200);
    assert.equal((await health.json()).status, 'ok');
    const adminA = accessToken({ userId: 31, companyId: tenantA, rol: 'ADMIN' });
    const adminB = accessToken({ sub: '32', tenantId: tenantB, role: 'ADMIN' });
    const firstAlias = `${runId}-first`;
    const secondAlias = `${runId}-second`;
    const candidates = [manifest(firstAlias, secondAlias), manifest(secondAlias, firstAlias)];

    const attempted = await Promise.all([
      request('/extensions', jsonPost({ manifest: candidates[0], verified: true }, adminA, { 'x-tenant-id': String(tenantB) })),
      request('/extensions', jsonPost({ manifest: candidates[1] }, adminB)),
    ]);
    const result = await Promise.all(attempted.map((response) => response.json()));
    assert.deepEqual(attempted.map((response) => response.status).sort(), [201, 409]);
    const winner = attempted.findIndex((response) => response.status === 201);
    const published = result[winner].data;
    assert.equal(published.verified, false);
    assert.deepEqual(published.rating, { average: 0, count: 0 });

    for (const alias of [published.id, firstAlias, secondAlias]) {
      const response = await request(`/extensions/${alias}`);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).data.id, published.id);
    }
    const page = await request(`/extensions?q=${runId}&offset=1&limit=1`);
    const pageData = await page.json();
    assert.deepEqual(pageData.data, []);
    assert.equal(pageData.pagination.total, 1);

    const owningToken = winner === 0 ? adminA : adminB;
    const otherToken = winner === 0 ? adminB : adminA;
    const update = { ...candidates[winner], version: '1.1.0' };
    const stolen = await request('/extensions', jsonPost({ manifest: update }, otherToken));
    assert.equal(stolen.status, 409);
    await stolen.json();
    const renamed = await request('/extensions', jsonPost({ manifest: { ...update, name: `${runId}-renamed` } }, owningToken));
    assert.equal(renamed.status, 409);
    await renamed.json();
    const official = await request('/extensions', jsonPost({ manifest: manifest('@whatsap-automat/official') }, owningToken));
    assert.equal(official.status, 403);
    await official.json();
    const edited = await request('/extensions', jsonPost({ manifest: update }, owningToken));
    assert.equal(edited.status, 201);
    const listing = (await edited.json()).data;
    assert.equal(listing.version, '1.1.0');
    assert.equal(listing.id, published.id);
    assert.equal(listing.publishedAt, published.publishedAt);

    const otherTenant = winner === 0 ? tenantB : tenantA;
    const foreignWrite = await tenantWork.run(otherTenant, (client) => client.query(`
      UPDATE marketplace_extensions SET updated_at = clock_timestamp() WHERE id = $1
    `, [published.id]));
    assert.equal(foreignWrite.rowCount, 0);
  });

  test('owner withdrawal is durable and idempotent, with private access and reserved identity', async (t) => {
    const request = await marketplaceHttp(t, new MarketplaceRegistry(db));
    const admin = accessToken({ userId: 51, companyId: tenantA, rol: 'ADMIN' });
    const otherAdmin = accessToken({ userId: 52, companyId: tenantB, rol: 'ADMIN' });
    const operator = accessToken({ userId: 53, companyId: tenantA, rol: 'EMPLEADO' });
    const extensionId = `${runId}-withdrawn`;
    const extensionName = `${extensionId}-name`;
    const published = await request('/extensions', jsonPost({ manifest: manifest(extensionId, extensionName) }, admin));
    assert.equal(published.status, 201);
    const listing = (await published.json()).data;

    const path = `/extensions/${encodeURIComponent(listing.id)}`;
    const withdraw = path + '/withdraw';
    assert.equal((await request('/publications')).status, 401);
    assert.equal((await request('/publications', { headers: { authorization: `Bearer ${operator}` } })).status, 403);
    assert.equal((await request(withdraw, jsonPost({}))).status, 401);
    assert.equal((await request(withdraw, jsonPost({}, operator))).status, 403);
    assert.equal((await request(withdraw, jsonPost({}, otherAdmin, { 'x-tenant-id': String(tenantA) }))).status, 404);
    assert.equal((await request(path + '/rate', jsonPost({ score: 4, review: 'Preserve this review' }, otherAdmin))).status, 200);

    const responses = await Promise.all([
      request(withdraw, jsonPost({ tenantId: tenantB, userId: 999 }, admin)),
      request(`/extensions/${extensionId}/withdraw`, jsonPost({}, admin)),
    ]);
    assert.deepEqual(responses.map((response) => response.status), [200, 200]);
    const [first, second] = await Promise.all(responses.map((response) => response.json()));
    assert.deepEqual(first, second);
    assert.equal(first.data.state, 'withdrawn');
    assert.ok(Date.parse(first.data.withdrawnAt));
    assert.equal(responses[0].headers.get('cache-control'), 'private, no-store');

    const anotherInstance = await marketplaceHttp(t, new MarketplaceRegistry(db));
    const repeat = await anotherInstance(withdraw, jsonPost({}, admin));
    assert.equal(repeat.status, 200);
    assert.deepEqual(await repeat.json(), first);
    for (const alias of [listing.id, extensionId, extensionName]) {
      assert.equal((await anotherInstance(`/extensions/${encodeURIComponent(alias)}`)).status, 404);
    }
    const publicSearch = await anotherInstance(`/extensions?q=${extensionId}`);
    assert.equal((await publicSearch.json()).pagination.total, 0);
    assert.equal((await anotherInstance(path + '/rate', jsonPost({ score: 5 }, otherAdmin))).status, 404);

    const ownership = async (auth: string) => anotherInstance('/publications?limit=100', { headers: { authorization: `Bearer ${auth}` } });
    const owner = await ownership(admin);
    assert.equal(owner.status, 200);
    assert.equal(owner.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual((await owner.json()).data.find((item: { id: string }) => item.id === listing.id), first.data);
    assert.ok(!(await (await ownership(otherAdmin)).json()).data.some((item: { id: string }) => item.id === listing.id));

    for (const auth of [admin, otherAdmin]) {
      const republish = await request('/extensions', jsonPost({
        manifest: { ...manifest(extensionId, extensionName), version: '1.1.0' },
      }, auth));
      assert.equal(republish.status, 409);
    }
    const aliasCollision = await request('/extensions', jsonPost({ manifest: manifest(extensionName) }, otherAdmin));
    assert.equal(aliasCollision.status, 409);
    const { rows: [record] } = await tenantWork.run(tenantA, (client) => client.query(`
      SELECT withdrawn_by, listing->>'status' AS status
      FROM marketplace_extensions WHERE id = $1
    `, [listing.id]));
    assert.deepEqual(record, { withdrawn_by: '51', status: 'deprecated' });
    const { rows: [review] } = await tenantWork.run(tenantB, (client) => client.query(`
      SELECT score, review FROM marketplace_ratings WHERE listing_id = $1
    `, [listing.id]));
    assert.deepEqual(review, { score: 4, review: 'Preserve this review' });
  });

  test('persists rating upserts across API instances and exposes only public aggregates', async (t) => {
    const firstPool = new Pool({ connectionString });
    let firstPoolClosed = false;
    t.after(async () => {
      if (!firstPoolClosed) await firstPool.end();
    });
    const request = await marketplaceHttp(t, new MarketplaceRegistry(firstPool));
    const admin = accessToken({ userId: 31, companyId: tenantA, rol: 'ADMIN' });
    const extensionId = `${runId}-rated`;
    const archive = Buffer.from('extension archive fixture');
    const created = await request('/extensions', jsonPost({
      manifest: manifest(extensionId),
      tarballBase64: archive.toString('base64'),
      tarballUrl: 'https://example.test/extension.tar.gz',
      categories: ['Testing'],
      tags: ['Persistence'],
    }, admin));
    assert.equal(created.status, 201);
    const { data: listing } = await created.json();

    const ratingPath = `/extensions/${listing.id}/rate`;
    const ratingsPath = `/extensions/${listing.id}/ratings`;
    const reviewerA = accessToken({ userId: 41, companyId: tenantA, rol: 'EMPLEADO' });
    const reviewerB = accessToken({ userId: 41, companyId: tenantB, rol: 'EMPLEADO' });
    const anotherB = accessToken({ userId: 42, companyId: tenantB, rol: 'EMPLEADO' });
    const attempts = await Promise.all([
      request(ratingPath, jsonPost({ score: 5, review: 'private tenant A', tenantId: tenantB, userId: 99 }, reviewerA, {
        'x-tenant-id': String(tenantB),
        'x-user-id': '99',
      })),
      request(ratingPath, jsonPost({ score: 5, review: 'private tenant A' }, reviewerA)),
      request(ratingPath, jsonPost({ score: 3, review: 'private tenant B' }, reviewerB)),
      request(ratingPath, jsonPost({ score: 4 }, anotherB)),
    ]);
    for (const response of attempts) assert.equal(response.status, 200);
    const ratingResults = await Promise.all(attempts.map((response) => response.json()));
    assert.equal(ratingResults[0].data.rating.id, ratingResults[1].data.rating.id);
    assert.equal(ratingResults[0].data.rating.userId, '41');
    assert.equal(ratingResults[0].data.rating.tenantId, String(tenantA));
    const initialPublic = await request(`/extensions/${extensionId}`);
    assert.deepEqual((await initialPublic.json()).data.rating, { average: 4, count: 3 });

    const edited = await request(ratingPath, jsonPost({ score: 1 }, reviewerA));
    assert.equal(edited.status, 200);
    assert.deepEqual((await edited.json()).data.listing.rating, { average: 2.7, count: 3 });
    await firstPool.end();
    firstPoolClosed = true;

    const reopened = await marketplaceHttp(t, new MarketplaceRegistry(db));
    const catalog = await reopened('/extensions?q=Persistence&category=testing&verified=false&type=tool');
    assert.equal(catalog.status, 200);
    assert.ok((await catalog.json()).data.some((item: { id: string }) => item.id === listing.id));
    const privateRead = await reopened(ratingsPath, {
      headers: { authorization: `Bearer ${reviewerB}`, 'x-tenant-id': String(tenantA) },
    });
    assert.equal(privateRead.headers.get('cache-control'), 'private, no-store');
    const { data: reviews } = await privateRead.json();
    assert.deepEqual(reviews.map((review: { tenantId: string }) => review.tenantId), [String(tenantB), String(tenantB)]);
    const anonymous = await reopened(`/extensions/${extensionId}`);
    const publicListing = (await anonymous.json()).data;
    assert.deepEqual(publicListing.rating, { average: 2.7, count: 3 });
    assert.doesNotMatch(JSON.stringify(publicListing), /private tenant|publisherTenantId|userId/);

    const unscoped = await db.query('SELECT id FROM marketplace_ratings WHERE listing_id = $1', [listing.id]);
    assert.equal(unscoped.rowCount, 0);
    const scoped = await tenantWork.run(tenantA, (client) => client.query(`
      SELECT tenant_id, score FROM marketplace_ratings WHERE listing_id = $1
    `, [listing.id]));
    assert.deepEqual(scoped.rows, [{ tenant_id: tenantA, score: 1 }]);
    await assert.rejects(tenantWork.run(tenantA, (client) => client.query(`
      INSERT INTO marketplace_ratings (id, listing_id, tenant_id, user_id, score) VALUES ($1, $2, $3, 99, 5)
    `, [randomUUID(), listing.id, tenantB])), { code: '42501' });
    const forgedTotals = await db.query(`
      UPDATE marketplace_rating_totals SET score_total = 15 WHERE listing_id = $1
    `, [listing.id]);
    assert.equal(forgedTotals.rowCount, 0);
  });
});
