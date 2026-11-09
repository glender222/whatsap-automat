import { z } from 'zod';
import crypto from 'node:crypto';
import {
  extensionManifestSchema,
  extensionTypeSchema,
  extensionAuthorSchema,
} from '../extensions/manifest';

/**
 * SEC-009 Forbidden Scopes
 * Extensions requesting any of these permissions are strictly rejected.
 */
export const FORBIDDEN_PERMISSION_SCOPES = [
  'database.raw_query',
  'system.process',
  'secrets.master_key',
  'filesystem.root',
  'network.raw_socket',
] as const;

export type ForbiddenPermissionScope = (typeof FORBIDDEN_PERMISSION_SCOPES)[number];

export const marketplaceListingStatusSchema = z.enum([
  'draft',
  'pending_review',
  'published',
  'deprecated',
  'rejected',
]);
export type MarketplaceListingStatus = z.infer<typeof marketplaceListingStatusSchema>;

export const extensionRatingScoreSchema = z.number().int().min(1).max(5);

export const extensionRatingSchema = z.object({
  id: z.guid(),
  extensionId: z.string().min(1),
  tenantId: z.string().min(1),
  userId: z.string().min(1),
  score: extensionRatingScoreSchema,
  review: z.string().max(1000).optional(),
  createdAt: z.string().datetime(),
});
export type ExtensionRating = z.infer<typeof extensionRatingSchema>;

export const marketplaceListingSchema = z.object({
  id: z.string().min(1),
  extensionId: z.string().min(1),
  name: z.string().regex(/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/),
  displayName: z.string().min(1).max(128),
  version: z.string().regex(/^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/),
  type: extensionTypeSchema,
  description: z.string().max(512),
  longDescription: z.string().max(10000).optional(),
  author: extensionAuthorSchema.optional(),
  license: z.string().default('MIT'),
  iconUrl: z.string().url().optional(),
  homepage: z.string().url().optional(),
  repositoryUrl: z.string().url().optional(),
  categories: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  status: marketplaceListingStatusSchema.default('published'),
  verified: z.boolean().default(false),
  tarballUrl: z.string().optional(),
  tarballSha256: z.string().regex(/^[a-fA-F0-9]{64}$/, 'Must be a 64-character SHA-256 hex string').optional(),
  tarballSizeBytes: z.number().int().nonnegative().optional(),
  manifest: extensionManifestSchema,
  rating: z.object({
    average: z.number().min(0).max(5).default(0),
    count: z.number().int().nonnegative().default(0),
  }).default({ average: 0, count: 0 }),
  downloadsCount: z.number().int().nonnegative().default(0),
  permissions: z.array(z.string()).default([]),
  publishedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type MarketplaceListing = z.infer<typeof marketplaceListingSchema>;

export const marketplaceSearchQuerySchema = z.object({
  q: z.string().optional(),
  category: z.string().optional(),
  type: extensionTypeSchema.optional(),
  verified: z.preprocess((val) => (val === 'true' ? true : val === 'false' ? false : val), z.boolean().optional()),
  limit: z.preprocess((val) => (typeof val === 'string' ? parseInt(val, 10) : val), z.number().int().min(1).max(100).default(20)),
  offset: z.preprocess((val) => (typeof val === 'string' ? parseInt(val, 10) : val), z.number().int().min(0).default(0)),
});
export type MarketplaceSearchQuery = z.infer<typeof marketplaceSearchQuerySchema>;

/**
 * Validates extension permissions against SEC-009 forbidden scopes.
 */
export function validateMarketplacePermissions(permissions: readonly string[]): {
  permitted: boolean;
  forbiddenScopes: string[];
} {
  const forbiddenScopes = permissions.filter((perm) =>
    (FORBIDDEN_PERMISSION_SCOPES as readonly string[]).includes(perm)
  );
  return {
    permitted: forbiddenScopes.length === 0,
    forbiddenScopes,
  };
}

/**
 * Validates tarball sha256 checksum in constant time.
 */
export function validateTarballChecksum(buffer: Buffer | Uint8Array, expectedSha256: string): boolean {
  if (!buffer || !expectedSha256) return false;
  const computedSha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const computedBuf = Buffer.from(computedSha256.toLowerCase(), 'utf8');
  const expectedBuf = Buffer.from(expectedSha256.toLowerCase().trim(), 'utf8');
  if (computedBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(computedBuf, expectedBuf);
}
