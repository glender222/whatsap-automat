import crypto from 'node:crypto';
import { Pool } from 'pg';
import {
  extensionManifestSchema,
  MarketplaceListing,
  marketplaceListingSchema,
  ExtensionRating,
  extensionRatingScoreSchema,
  MarketplaceSearchQuery,
  validateMarketplacePermissions,
  validateTarballChecksum,
} from '@whatsap-automat/contracts';
import defaultPool from '../../config/database';
import { MarketplaceStore } from './MarketplaceStore';

import {
  MarketplaceError,
  RegisterExtensionOptions,
  SubmitRatingOptions,
  ExtensionValidationReport,
} from './types';

export class MarketplaceRegistry {
  private readonly store: MarketplaceStore;

  constructor(pool: Pool = defaultPool) {
    this.store = new MarketplaceStore(pool);
  }

  checkStorage(): Promise<void> {
    return this.store.checkStorage();
  }

  /**
   * Validates manifest structure and checks SEC-009 forbidden scopes.
   */
  validateManifest(manifestInput: unknown, tarballBuffer?: Buffer, expectedSha256?: string): ExtensionValidationReport {
    const errors: string[] = [];
    const warnings: string[] = [];

    const parseResult = extensionManifestSchema.safeParse(manifestInput);
    if (!parseResult.success) {
      for (const issue of parseResult.error.issues) {
        errors.push(`[${issue.path.join('.') || 'root'}]: ${issue.message}`);
      }
      return { valid: false, errors, warnings };
    }

    const manifest = parseResult.data;

    // SEC-009 Forbidden Scope Checks
    if (Array.isArray(manifest.permissions)) {
      const secCheck = validateMarketplacePermissions(
        manifest.permissions.map((permission) => permission.trim().toLowerCase())
      );
      if (!secCheck.permitted) {
        for (const scope of secCheck.forbiddenScopes) {
          errors.push(`[SEC-009]: Forbidden permission scope "${scope}" cannot be requested by extensions.`);
        }
      }
    }

    // Checksum verification if tarball provided
    let checksumVerified = false;
    if (tarballBuffer && expectedSha256 !== undefined) {
      const validChecksum = typeof expectedSha256 === 'string' && validateTarballChecksum(tarballBuffer, expectedSha256);
      if (!validChecksum) {
        errors.push(`[CHECKSUM_MISMATCH]: Calculated tarball SHA-256 does not match provided checksum.`);
      } else {
        checksumVerified = true;
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      manifest: errors.length === 0 ? manifest : undefined,
      checksumVerified,
    };
  }

  /**
   * Registers a community extension into the marketplace catalog.
   */
  async registerExtension(options: RegisterExtensionOptions): Promise<MarketplaceListing> {
    const validation = this.validateManifest(options.manifest, options.tarballBuffer, options.expectedSha256);
    if (!validation.valid || !validation.manifest) {
      throw new MarketplaceError(400, `Marketplace manifest validation failed: ${validation.errors.join('; ')}`, validation.errors);
    }

    const manifest = validation.manifest;
    const nowIso = new Date().toISOString();
    const extensionId = manifest.id || manifest.name;
    if ([extensionId, manifest.name].some((name) => name.startsWith('@whatsap-automat/'))) {
      throw new MarketplaceError(403, 'The official namespace is reserved.');
    }

    let computedSha256 = options.expectedSha256;
    const sizeBytes = options.tarballBuffer?.length;

    if (options.tarballBuffer && !computedSha256) {
      computedSha256 = crypto.createHash('sha256').update(options.tarballBuffer).digest('hex');
    }

    let tarballUrl: string | undefined;
    if (options.tarballUrl !== undefined) {
      let url: URL;
      try {
        url = new URL(options.tarballUrl);
      } catch {
        throw new MarketplaceError(400, 'Extension archive URL is invalid.');
      }
      if (url.protocol !== 'https:' || url.username || url.password) {
        throw new MarketplaceError(400, 'Extension archive URL must use HTTPS without embedded credentials.');
      }
      tarballUrl = url.href;
    }

    const listing: MarketplaceListing = {
      id: `ext_${crypto.randomUUID()}`,
      extensionId,
      name: manifest.name,
      displayName: options.displayName || manifest.displayName || manifest.name,
      version: manifest.version,
      type: manifest.type,
      description: manifest.description || '',
      longDescription: options.longDescription,
      author: manifest.author,
      license: manifest.license,
      categories: options.categories || (manifest.metadata?.categories as string[]) || [],
      tags: options.tags || [],
      status: 'published',
      verified: false,
      tarballUrl,
      tarballSha256: computedSha256,
      tarballSizeBytes: sizeBytes,
      manifest,
      rating: { average: 0, count: 0 },
      downloadsCount: 0,
      permissions: manifest.permissions || [],
      publishedAt: nowIso,
      updatedAt: nowIso,
    };

    const validated = marketplaceListingSchema.safeParse(listing);
    if (!validated.success) {
      const errors = validated.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
      throw new MarketplaceError(400, 'Invalid marketplace listing metadata.', errors);
    }
    return this.store.publish(options.publisherTenantId, validated.data);
  }

  listPublications(publisherTenantId: number, limit: number, offset: number) {
    return this.store.listPublications(publisherTenantId, limit, offset);
  }

  withdrawPublication(publisherTenantId: number, actorId: number, alias: string) {
    return this.store.withdrawPublication(publisherTenantId, actorId, alias);
  }

  /**
   * Lists catalog extensions with filtering, searching, and pagination.
   */
  listExtensions(query: MarketplaceSearchQuery): Promise<{ items: MarketplaceListing[]; total: number }> {
    return this.store.listExtensions(query);
  }

  /**
   * Retrieves single extension listing by extensionId or ID.
   */
  getExtension(idOrExtensionId: string): Promise<MarketplaceListing | null> {
    return this.store.getExtension(idOrExtensionId);
  }

  /**
   * Submits a rating (1-5 stars) and review for an extension.
   */
  async submitRating(options: SubmitRatingOptions): Promise<{ listing: MarketplaceListing; rating: ExtensionRating }> {
    if (!extensionRatingScoreSchema.safeParse(options.score).success) {
      throw new MarketplaceError(400, 'Score must be an integer from 1 to 5.');
    }
    if (options.review !== undefined && (typeof options.review !== 'string' || options.review.length > 1000)) {
      throw new MarketplaceError(400, 'Review must contain at most 1000 characters.');
    }
    return this.store.submitRating(options);
  }

  /**
   * Gets ratings and reviews for an extension.
   */
  getRatings(extensionId: string, tenantId: string): Promise<ExtensionRating[]> {
    return this.store.getRatings(extensionId, tenantId);
  }
}
