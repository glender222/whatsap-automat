import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import crypto from 'node:crypto';
import {
  marketplaceListingSchema,
  marketplaceSearchQuerySchema,
  extensionRatingSchema,
  validateMarketplacePermissions,
  validateTarballChecksum,
  FORBIDDEN_PERMISSION_SCOPES,
} from '../src/marketplace';

describe('Marketplace Contracts & Schemas', () => {
  const validManifest = {
    name: '@community/weather-tool',
    version: '1.2.0',
    type: 'tool' as const,
    displayName: 'Weather Tool',
    description: 'Provides live meteorological data',
    entrypoint: 'dist/index.js',
    license: 'MIT',
    permissions: ['network:outbound', 'tool:execute'],
    tool: {
      name: 'getWeather',
      riskLevel: 'read' as const,
    },
  };

  test('validates a complete marketplace listing', () => {
    const rawListing = {
      id: 'ext_weather_123',
      extensionId: '@community/weather-tool',
      name: '@community/weather-tool',
      displayName: 'Weather Tool Pro',
      version: '1.2.0',
      type: 'tool',
      description: 'Provides live meteorological data',
      license: 'MIT',
      categories: ['tools', 'weather'],
      tags: ['forecast', 'meteorology'],
      status: 'published',
      verified: true,
      tarballUrl: 'https://cdn.example.com/weather-1.2.0.tgz',
      tarballSha256: crypto.createHash('sha256').update('weather-tgz-content').digest('hex'),
      manifest: validManifest,
      rating: { average: 4.8, count: 15 },
      downloadsCount: 350,
      permissions: ['network:outbound', 'tool:execute'],
      publishedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const parsed = marketplaceListingSchema.safeParse(rawListing);
    assert.strictEqual(parsed.success, true);
    if (parsed.success) {
      assert.strictEqual(parsed.data.name, '@community/weather-tool');
      assert.strictEqual(parsed.data.rating.average, 4.8);
      assert.strictEqual(parsed.data.verified, true);
    }
  });

  test('rejects marketplace listing with invalid semver', () => {
    const rawListing = {
      id: 'ext_invalid_semver',
      extensionId: 'invalid-semver',
      name: 'invalid-semver',
      displayName: 'Invalid Semver',
      version: 'v1.0', // invalid semver format
      type: 'tool',
      description: 'Invalid version description',
      manifest: validManifest,
      publishedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const parsed = marketplaceListingSchema.safeParse(rawListing);
    assert.strictEqual(parsed.success, false);
  });

  test('validates search query schema with string coercions', () => {
    const query = marketplaceSearchQuerySchema.parse({
      q: 'weather',
      verified: 'true',
      limit: '50',
      offset: '10',
    });

    assert.strictEqual(query.q, 'weather');
    assert.strictEqual(query.verified, true);
    assert.strictEqual(query.limit, 50);
    assert.strictEqual(query.offset, 10);
  });

  test('validates extension rating schema (1-5 range)', () => {
    const validRating = extensionRatingSchema.safeParse({
      id: crypto.randomUUID(),
      extensionId: '@community/weather-tool',
      tenantId: '1',
      userId: 'user_42',
      score: 5,
      review: 'Awesome extension!',
      createdAt: new Date().toISOString(),
    });
    assert.strictEqual(validRating.success, true);

    const invalidScore = extensionRatingSchema.safeParse({
      id: crypto.randomUUID(),
      extensionId: '@community/weather-tool',
      tenantId: '1',
      userId: 'user_42',
      score: 6, // out of range
      createdAt: new Date().toISOString(),
    });
    assert.strictEqual(invalidScore.success, false);
  });

  test('SEC-009: validateMarketplacePermissions detects forbidden scopes', () => {
    const safePerms = ['channel:inbound', 'tool:execute', 'network:outbound'];
    const safeCheck = validateMarketplacePermissions(safePerms);
    assert.strictEqual(safeCheck.permitted, true);
    assert.strictEqual(safeCheck.forbiddenScopes.length, 0);

    for (const forbidden of FORBIDDEN_PERMISSION_SCOPES) {
      const hostileCheck = validateMarketplacePermissions(['tool:execute', forbidden]);
      assert.strictEqual(hostileCheck.permitted, false);
      assert.deepStrictEqual(hostileCheck.forbiddenScopes, [forbidden]);
    }
  });

  test('validateTarballChecksum computes and checks sha256 in constant time', () => {
    const buf = Buffer.from('test archive tarball content 12345');
    const validSha = crypto.createHash('sha256').update(buf).digest('hex');
    const invalidSha = 'a'.repeat(64);

    assert.strictEqual(validateTarballChecksum(buf, validSha), true);
    assert.strictEqual(validateTarballChecksum(buf, invalidSha), false);
    assert.strictEqual(validateTarballChecksum(buf, ''), false);
  });
});
