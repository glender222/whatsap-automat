import crypto from 'node:crypto';
import {
  extensionManifestSchema,
  MarketplaceListing,
  marketplaceListingSchema,
  ExtensionRating,
  extensionRatingSchema,
  MarketplaceSearchQuery,
  validateMarketplacePermissions,
  validateTarballChecksum,
} from '@whatsap-automat/contracts';

import {
  RegisterExtensionOptions,
  SubmitRatingOptions,
  ExtensionValidationReport,
} from './types';

interface CatalogEntry {
  readonly publisherTenantId: number;
  listing: MarketplaceListing;
}

export class MarketplaceRegistry {
  private readonly listings = new Map<string, CatalogEntry>();
  private readonly ratings = new Map<string, ExtensionRating[]>();

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
    if (tarballBuffer && expectedSha256) {
      const validChecksum = validateTarballChecksum(tarballBuffer, expectedSha256);
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
      const err = new Error(`Marketplace manifest validation failed: ${validation.errors.join('; ')}`);
      (err as any).statusCode = 400;
      (err as any).errors = validation.errors;
      throw err;
    }

    const manifest = validation.manifest;
    const nowIso = new Date().toISOString();
    const extensionId = manifest.id || manifest.name;
    if ([extensionId, manifest.name].some((name) => name.startsWith('@whatsap-automat/'))) {
      throw Object.assign(new Error('The official namespace is reserved.'), { statusCode: 403 });
    }

    let computedSha256 = options.expectedSha256;
    const sizeBytes = options.tarballBuffer?.length;

    if (options.tarballBuffer && !computedSha256) {
      computedSha256 = crypto.createHash('sha256').update(options.tarballBuffer).digest('hex');
    }

    const entry = this.listings.get(extensionId);
    const extensionClaim = this.findEntry(extensionId);
    const nameClaim = this.findEntry(manifest.name);
    if (
      (entry && entry.publisherTenantId !== options.publisherTenantId) ||
      (entry && entry.listing.name !== manifest.name) ||
      (extensionClaim && extensionClaim !== entry) ||
      (nameClaim && nameClaim !== entry)
    ) {
      throw Object.assign(new Error('The extension ID or name is already registered.'), { statusCode: 409 });
    }

    let tarballUrl: string | undefined;
    if (options.tarballUrl !== undefined) {
      const url = new URL(options.tarballUrl);
      if (url.protocol !== 'https:' || url.username || url.password) {
        throw new Error('Extension archive URL must use HTTPS without embedded credentials.');
      }
      tarballUrl = url.href;
    }

    const existing = entry?.listing;
    const listing: MarketplaceListing = {
      id: existing?.id || `ext_${crypto.randomUUID()}`,
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
      rating: existing?.rating || { average: 0, count: 0 },
      downloadsCount: existing?.downloadsCount || 0,
      permissions: manifest.permissions || [],
      publishedAt: existing?.publishedAt || nowIso,
      updatedAt: nowIso,
    };

    const validated = marketplaceListingSchema.parse(listing);
    this.listings.set(extensionId, { publisherTenantId: options.publisherTenantId, listing: validated });
    return validated;
  }

  /**
   * Lists catalog extensions with filtering, searching, and pagination.
   */
  listExtensions(query: MarketplaceSearchQuery): { items: MarketplaceListing[]; total: number } {
    let items = Array.from(this.listings.values(), (entry) => entry.listing);

    if (query.type) {
      items = items.filter((item) => item.type === query.type);
    }

    if (query.category) {
      const cat = query.category.toLowerCase();
      items = items.filter((item) => item.categories.some((c) => c.toLowerCase() === cat));
    }

    if (query.verified !== undefined) {
      items = items.filter((item) => item.verified === query.verified);
    }

    if (query.q) {
      const q = query.q.toLowerCase();
      items = items.filter((item) =>
        item.name.toLowerCase().includes(q) ||
        item.displayName.toLowerCase().includes(q) ||
        item.description.toLowerCase().includes(q) ||
        item.tags.some((t) => t.toLowerCase().includes(q))
      );
    }

    const total = items.length;
    const offset = query.offset || 0;
    const limit = query.limit || 20;
    const paginated = items.slice(offset, offset + limit);

    return { items: paginated, total };
  }

  /**
   * Retrieves single extension listing by extensionId or ID.
   */
  getExtension(idOrExtensionId: string): MarketplaceListing | null {
    return this.findEntry(idOrExtensionId)?.listing ?? null;
  }

  private findEntry(id: string): CatalogEntry | undefined {
    const direct = this.listings.get(id);
    if (direct) return direct;
    return Array.from(this.listings.values()).find(({ listing }) => listing.id === id || listing.name === id);
  }

  /**
   * Submits a rating (1-5 stars) and review for an extension.
   */
  submitRating(options: SubmitRatingOptions): { listing: MarketplaceListing; rating: ExtensionRating } {
    const entry = this.findEntry(options.extensionId);
    if (!entry) {
      const err = new Error(`Extension ${options.extensionId} not found`);
      (err as any).statusCode = 404;
      throw err;
    }

    const { listing } = entry;
    const rating: ExtensionRating = {
      id: crypto.randomUUID(),
      extensionId: listing.extensionId,
      tenantId: String(options.tenantId),
      userId: String(options.userId),
      score: options.score,
      review: options.review,
      createdAt: new Date().toISOString(),
    };

    const validatedRating = extensionRatingSchema.parse(rating);

    const extRatings = this.ratings.get(listing.extensionId) || [];
    // Replace if user already rated
    const existingIdx = extRatings.findIndex(
      (r) => r.tenantId === validatedRating.tenantId && r.userId === validatedRating.userId
    );
    if (existingIdx >= 0) {
      extRatings[existingIdx] = validatedRating;
    } else {
      extRatings.push(validatedRating);
    }
    this.ratings.set(listing.extensionId, extRatings);

    // Recompute average
    const totalScore = extRatings.reduce((acc, r) => acc + r.score, 0);
    const average = parseFloat((totalScore / extRatings.length).toFixed(1));

    const updatedListing: MarketplaceListing = {
      ...listing,
      rating: {
        average,
        count: extRatings.length,
      },
      updatedAt: new Date().toISOString(),
    };

    entry.listing = updatedListing;
    return { listing: updatedListing, rating: validatedRating };
  }

  /**
   * Gets ratings and reviews for an extension.
   */
  getRatings(extensionId: string, tenantId: string): ExtensionRating[] {
    const listing = this.getExtension(extensionId);
    if (!listing) return [];
    return (this.ratings.get(listing.extensionId) ?? []).filter((rating) => rating.tenantId === tenantId);
  }
}
