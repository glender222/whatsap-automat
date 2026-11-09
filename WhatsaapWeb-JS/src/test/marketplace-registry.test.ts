import './fixtures/testEnv';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import crypto from 'node:crypto';
import { MarketplaceRegistry } from '../services/marketplace/MarketplaceRegistry';
import { FORBIDDEN_PERMISSION_SCOPES } from '@whatsap-automat/contracts';
import { accessToken, jsonPost, marketplaceHttp } from './fixtures/marketplaceHttp';

const catalogManifest = {
  id: 'weather-tool',
  name: 'weather-extension',
  version: '1.0.0',
  type: 'tool',
  entrypoint: 'dist/index.js',
};

describe('PR-F9-03: Marketplace Registry & SEC-009 Security Suite', () => {
  const registry = new MarketplaceRegistry();

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

    const valid = registry.validateManifest(manifest, archiveBuffer, validSha256);
    assert.equal(valid.valid, true);
    assert.equal(valid.checksumVerified, true);

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
});

describe('Marketplace HTTP authorization', () => {
  test('validation remains public while writes require a signed tenant actor', async (t) => {
    const request = await marketplaceHttp(t);
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

  test('ratings require a signed actor and an integer score', async (t) => {
    const request = await marketplaceHttp(t);
    const reviewer = accessToken({ userId: 21, companyId: 2, rol: 'EMPLEADO' });
    const spoofedHeaders = { 'x-tenant-id': '2', 'x-user-id': '21' };
    const ratingPath = '/extensions/weather-tool/rate';
    const anonymousWrite = await request(ratingPath, jsonPost({ score: 5 }, undefined, spoofedHeaders));
    assert.equal(anonymousWrite.status, 401);
    await anonymousWrite.json();
    const unauthorizedRead = await request('/extensions/weather-tool/ratings', { headers: spoofedHeaders });
    assert.equal(unauthorizedRead.status, 401);
    await unauthorizedRead.json();
    const invalidScore = await request(ratingPath, jsonPost({ score: 2.5 }, reviewer));
    assert.equal(invalidScore.status, 400);
    await invalidScore.json();
  });
});
