import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import crypto from 'node:crypto';

import { MarketplaceRegistry } from '../services/marketplace/MarketplaceRegistry';
import { FORBIDDEN_PERMISSION_SCOPES } from '@whatsap-automat/contracts';

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
      manifest: validManifest as any,
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
            manifest: maliciousManifest as any,
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
      manifest: manifest as any,
      tarballBuffer: archiveBuffer,
      expectedSha256: validSha256,
    });
    assert.strictEqual(reg.tarballSha256, validSha256);

    // Mismatched checksum is rejected
    await assert.rejects(
      async () => {
        await registry.registerExtension({
          manifest: manifest as any,
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

    await registry.registerExtension({ manifest: manifest as any });

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

  test('catalog search and filtering', () => {
    const searchRes = registry.listExtensions({ q: 'TikTok', limit: 10, offset: 0 });
    assert.ok(searchRes.items.length >= 1);
    assert.ok(searchRes.items.some((i) => i.extensionId.includes('tiktok')));
  });
});
