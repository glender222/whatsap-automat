import './fixtures/testEnv';
import assert from 'node:assert/strict';
import { describe, test, type TestContext } from 'node:test';
import crypto from 'node:crypto';
import { once } from 'node:events';
import express from 'express';
import jwt from 'jsonwebtoken';

import { createMarketplaceRoutes } from '../routes/marketplaceRoutes';
import { MarketplaceRegistry } from '../services/marketplace/MarketplaceRegistry';
import { FORBIDDEN_PERMISSION_SCOPES } from '@whatsap-automat/contracts';

async function marketplaceHttp(t: TestContext) {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/marketplace', createMarketplaceRoutes());
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}/api/v1/marketplace`;
  return (path: string, init?: RequestInit) => fetch(`${baseUrl}${path}`, init);
}

function accessToken(claims: Record<string, unknown>, secret = process.env.JWT_SECRET!) {
  return jwt.sign(claims, secret, { algorithm: 'HS256', expiresIn: '5m' });
}

function jsonPost(body: unknown, token?: string, headers: Record<string, string> = {}): RequestInit {
  return {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
  };
}

const catalogManifest = {
  id: 'weather-tool',
  name: 'weather-extension',
  version: '1.0.0',
  type: 'tool',
  entrypoint: 'dist/index.js',
};

describe('PR-F9-03: Marketplace Registry & SEC-009 Security Suite', () => {
  const registry = new MarketplaceRegistry();

  test('valid manifest registration succeeds with initial ratings', async () => {
    const validManifest = {
      name: 'weather-tool-pro',
      version: '1.0.0',
      type: 'tool',
      displayName: 'Weather Forecast Tool',
      description: 'Provides meteorological reports',
      entrypoint: 'dist/index.js',
      permissions: ['network:outbound', 'tool:execute'],
      license: 'MIT',
      tool: {
        name: 'getWeather',
        riskLevel: 'read',
      },
    };

    const listing = await registry.registerExtension({
      publisherTenantId: 1,
      manifest: validManifest,
      categories: ['tools', 'weather'],
      tags: ['forecast', 'utility'],
    });

    assert.ok(listing);
    assert.strictEqual(listing.extensionId, 'weather-tool-pro');
    assert.strictEqual(listing.status, 'published');
    assert.strictEqual(listing.rating.average, 0);
  });

  test('SEC-009: strictly rejects manifests demanding forbidden scopes', async () => {
    for (const forbiddenScope of FORBIDDEN_PERMISSION_SCOPES) {
      const maliciousManifest = {
        name: `exploit-${forbiddenScope.replace(/[^a-z0-9]/g, '-')}`,
        version: '1.0.0',
        type: 'tool',
        entrypoint: 'dist/index.js',
        permissions: ['tool:execute', forbiddenScope],
        tool: { name: 'exploit', riskLevel: 'read' },
      };

      await assert.rejects(
        async () => {
          await registry.registerExtension({
            publisherTenantId: 1,
            manifest: maliciousManifest,
          });
        },
        (err: any) => {
          assert.strictEqual(err.statusCode, 400);
          assert.ok(err.message.includes('SEC-009') || err.message.includes('Forbidden'));
          return true;
        }
      );
    }
  });

  test('validates tarball SHA-256 archive checksum', async () => {
    const archiveBuffer = Buffer.from('mock tarball package content 123456');
    const validSha256 = crypto.createHash('sha256').update(archiveBuffer).digest('hex');

    const manifest = {
      name: 'verified-extension',
      version: '1.0.0',
      type: 'tool',
      entrypoint: 'dist/index.js',
      permissions: ['tool:execute'],
      tool: { name: 'tool', riskLevel: 'read' },
    };

    // Valid checksum succeeds
    const reg = await registry.registerExtension({
      publisherTenantId: 1,
      manifest,
      tarballBuffer: archiveBuffer,
      expectedSha256: validSha256,
    });
    assert.strictEqual(reg.tarballSha256, validSha256);

    // Mismatched checksum is rejected
    await assert.rejects(
      async () => {
        await registry.registerExtension({
          publisherTenantId: 1,
          manifest,
          tarballBuffer: archiveBuffer,
          expectedSha256: '0000000000000000000000000000000000000000000000000000000000000000',
        });
      },
      (err: any) => {
        assert.ok(err.message.includes('CHECKSUM_MISMATCH'));
        return true;
      }
    );
  });

  test('rating submission calculates average and count accurately', async () => {
    const manifest = {
      name: 'ratable-plugin',
      version: '1.0.0',
      type: 'tool',
      entrypoint: 'dist/index.js',
      permissions: ['tool:execute'],
      tool: { name: 'tool', riskLevel: 'read' },
    };

    await registry.registerExtension({ publisherTenantId: 1, manifest });

    registry.submitRating({
      extensionId: 'ratable-plugin',
      tenantId: '1',
      userId: 'user_1',
      score: 5,
      review: 'Excellent plugin!',
    });

    registry.submitRating({
      extensionId: 'ratable-plugin',
      tenantId: '1',
      userId: 'user_2',
      score: 3,
      review: 'Average',
    });

    const listing = registry.getExtension('ratable-plugin');
    assert.ok(listing);
    assert.strictEqual(listing.rating.count, 2);
    assert.strictEqual(listing.rating.average, 4.0); // (5 + 3) / 2 = 4.0
  });

  test('catalog starts empty and search filters genuinely registered extensions', async () => {
    const catalog = new MarketplaceRegistry();
    assert.deepEqual(catalog.listExtensions({ limit: 10, offset: 0 }), { items: [], total: 0 });
    await catalog.registerExtension({
      publisherTenantId: 1,
      manifest: { name: 'weather-tool', version: '1.0.0', type: 'tool', entrypoint: 'dist/index.js' },
      categories: ['weather'],
    });

    const search = catalog.listExtensions({ q: 'weather', category: 'weather', limit: 10, offset: 0 });
    assert.deepEqual(search.items.map((item) => item.extensionId), ['weather-tool']);
    assert.equal(search.total, 1);
    assert.equal(search.items[0].verified, false);
    assert.equal(search.items[0].downloadsCount, 0);
    assert.equal(catalog.listExtensions({ verified: true, limit: 10, offset: 0 }).total, 0);
  });
});

describe('Marketplace HTTP authorization', () => {
  test('catalog and validation remain public while writes require a signed tenant actor', async (t) => {
    const request = await marketplaceHttp(t);
    const publicListing = await request('/extensions');
    assert.equal(publicListing.status, 200);
    assert.deepEqual((await publicListing.json()).data, []);
    const validation = await request('/validate', jsonPost({ manifest: catalogManifest }));
    assert.equal(validation.status, 200);
    assert.equal((await validation.json()).data.valid, true);
    const malformedArchive = await request('/validate', jsonPost({ manifest: catalogManifest, tarballBase64: '%%%bad' }));
    assert.equal(malformedArchive.status, 400);

    const spoofedHeaders = { 'x-user-id': '9', 'x-tenant-id': '2', 'x-role': 'ADMIN' };
    const requestBody = { manifest: catalogManifest, role: 'ADMIN', userId: 9, publisherTenantId: 2 };
    for (const [token, expectedStatus] of [
      [undefined, 401],
      [accessToken({ userId: 9, companyId: 2, rol: 'ADMIN' }, 'different-signing-secret'), 401],
      [accessToken({ userId: 9, rol: 'ADMIN' }), 403],
      [accessToken({ companyId: 2, rol: 'ADMIN' }), 403],
      [accessToken({ userId: 9, companyId: 2, tenantId: 3, rol: 'ADMIN' }), 403],
      [accessToken({ userId: 9, companyId: 2, rol: 'EMPLEADO' }), 403],
    ] as const) {
      const response = await request('/extensions', jsonPost(requestBody, token, spoofedHeaders));
      assert.equal(response.status, expectedStatus);
      await response.json();
    }
  });

  test('only the publishing tenant may update an extension and official names are reserved', async (t) => {
    const request = await marketplaceHttp(t);
    const owner = accessToken({ userId: 11, companyId: 2, rol: 'ADMIN' });
    const outsider = accessToken({ sub: '12', tenantId: 3, role: 'ADMIN' });
    const registered = await request('/extensions', jsonPost({ manifest: catalogManifest, verified: true }, owner, { 'x-tenant-id': '3' }));
    assert.equal(registered.status, 201);
    const { data: original } = await registered.json();
    assert.equal(original.verified, false);
    const detail = await request(`/extensions/${original.id}`);
    assert.equal(detail.status, 200);
    assert.equal((await detail.json()).data.name, catalogManifest.name);

    for (const [manifest, token, status] of [
      [{ ...catalogManifest, version: '2.0.0' }, outsider, 409],
      [{ ...catalogManifest, id: 'other-id' }, outsider, 409],
      [{ ...catalogManifest, id: catalogManifest.name, name: 'different-name' }, outsider, 409],
      [{ ...catalogManifest, name: 'renamed-extension' }, owner, 409],
      [{ ...catalogManifest, id: '@whatsap-automat/official' }, owner, 403],
    ] as const) {
      const response = await request('/extensions', jsonPost({ manifest }, token));
      assert.equal(response.status, status);
      await response.json();
    }

    const updated = await request('/extensions', jsonPost({ manifest: { ...catalogManifest, version: '1.1.0' } }, owner));
    assert.equal(updated.status, 201);
    const { data: listing } = await updated.json();
    assert.equal(listing.id, original.id);
    assert.equal(listing.version, '1.1.0');
  });

  test('rating identity comes from JWT and only aggregate scores are public', async (t) => {
    const request = await marketplaceHttp(t);
    const owner = accessToken({ userId: 11, companyId: 2, rol: 'ADMIN' });
    const reviewer = accessToken({ userId: 21, companyId: 2, rol: 'EMPLEADO' });
    const otherTenant = accessToken({ userId: 21, companyId: 3, rol: 'EMPLEADO' });
    const registered = await request('/extensions', jsonPost({ manifest: catalogManifest }, owner));
    assert.equal(registered.status, 201);
    const { data: listing } = await registered.json();

    const ratingPath = `/extensions/${listing.id}/rate`;
    const ratingsPath = `/extensions/${listing.id}/ratings`;
    const anonymousWrite = await request(ratingPath, jsonPost({ score: 5 }, undefined, { 'x-tenant-id': '2', 'x-user-id': '21' }));
    assert.equal(anonymousWrite.status, 401);
    await anonymousWrite.json();
    const unauthorizedRead = await request(ratingsPath);
    assert.equal(unauthorizedRead.status, 401);
    await unauthorizedRead.json();

    const review = await request(ratingPath, jsonPost({ score: 3, review: 'review from tenant 2', tenantId: 3, userId: 99 }, reviewer, {
      'x-tenant-id': '3',
      'x-user-id': '99',
    }));
    assert.equal(review.status, 200);
    const { data: { rating } } = await review.json();
    assert.equal(rating.tenantId, '2');
    assert.equal(rating.userId, '21');

    const replaced = await request(`/extensions/${catalogManifest.name}/rate`, jsonPost({ score: 5 }, reviewer));
    assert.equal(replaced.status, 200);
    await replaced.json();
    const tenantThreeReview = await request(ratingPath, jsonPost({ score: 3, review: 'review from tenant 3' }, otherTenant));
    assert.equal(tenantThreeReview.status, 200);
    await tenantThreeReview.json();

    const privateRead = await request(ratingsPath, { headers: { authorization: `Bearer ${otherTenant}`, 'x-tenant-id': '2' } });
    assert.equal(privateRead.status, 200);
    assert.equal(privateRead.headers.get('cache-control'), 'private, no-store');
    const { data: reviews } = await privateRead.json();
    assert.deepEqual(reviews.map((item: { tenantId: string }) => item.tenantId), ['3']);

    const publicRead = await request(`/extensions/${catalogManifest.id}`);
    assert.equal(publicRead.status, 200);
    const { data: publicDetail } = await publicRead.json();
    assert.deepEqual(publicDetail.rating, { average: 4, count: 2 });
    assert.doesNotMatch(JSON.stringify(publicDetail), /review from tenant|publisherTenantId|userId/);
  });
});
