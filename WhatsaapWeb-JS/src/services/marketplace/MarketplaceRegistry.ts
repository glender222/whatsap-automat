import crypto from 'node:crypto';
import type { Pool } from 'pg';
import {
  ExtensionManifest,
  extensionManifestSchema,
  MarketplaceListing,
  marketplaceListingSchema,
  ExtensionRating,
  extensionRatingSchema,
  MarketplaceSearchQuery,
  FORBIDDEN_PERMISSION_SCOPES,
  validateMarketplacePermissions,
  validateTarballChecksum,
} from '@whatsap-automat/contracts';

import {
  RegisterExtensionOptions,
  SubmitRatingOptions,
  ExtensionValidationReport,
} from './types';
import pool from '../../config/database';

export class MarketplaceRegistry {
  private readonly db: { query: (text: string | { text: string; values?: unknown[] }, values?: unknown[]) => Promise<any> };
  private readonly listings = new Map<string, MarketplaceListing>();
  private readonly ratings = new Map<string, ExtensionRating[]>();

  constructor(customPool?: Pool | { query: (text: string | { text: string; values?: unknown[] }, values?: unknown[]) => Promise<any> }) {
    this.db = customPool || (pool as unknown as Pool);
    this.seedOfficialExtensions();
  }

  /**
   * Pre-seeds community registry with official verified packages.
   */
  private seedOfficialExtensions(): void {
    const nowIso = new Date().toISOString();

    const officialPackages: Partial<MarketplaceListing>[] = [
      {
        id: 'ext_tiktok_channel',
        extensionId: '@whatsap-automat/channel-tiktok',
        name: '@whatsap-automat/channel-tiktok',
        displayName: 'TikTok Business Messaging Connector',
        version: '1.0.0',
        type: 'channel',
        description: 'Official TikTok Business Messaging omnichannel channel adapter for Whatsap-Automat',
        license: 'MIT',
        status: 'published',
        verified: true,
        categories: ['channels', 'social', 'messaging'],
        tags: ['tiktok', 'omnichannel', 'official'],
        tarballSha256: crypto.createHash('sha256').update('@whatsap-automat/channel-tiktok-1.0.0').digest('hex'),
        permissions: ['channel:inbound', 'channel:send', 'webhook:receive'],
        manifest: {
          name: '@whatsap-automat/channel-tiktok',
          version: '1.0.0',
          type: 'channel',
          entrypoint: 'dist/index.js',
          permissions: ['channel:inbound', 'channel:send', 'webhook:receive'],
          channel: {
            kind: 'tiktok',
            capabilities: ['text', 'image', 'video', 'interactive'],
            webhookPath: '/api/v1/webhooks/tiktok',
          },
          description: 'Official TikTok Business Messaging connector',
          license: 'MIT',
          minRuntimeVersion: '^0.4.0',
          metadata: {},
        },
        rating: { average: 5.0, count: 12 },
        downloadsCount: 1540,
        publishedAt: nowIso,
        updatedAt: nowIso,
      },
      {
        id: 'ext_line_channel',
        extensionId: '@whatsap-automat/channel-line',
        name: '@whatsap-automat/channel-line',
        displayName: 'LINE Official Account Connector',
        version: '1.0.0',
        type: 'channel',
        description: 'Official LINE Official Account omnichannel adapter with Reply & Push API dispatch',
        license: 'MIT',
        status: 'published',
        verified: true,
        categories: ['channels', 'social', 'asia'],
        tags: ['line', 'messaging', 'official'],
        tarballSha256: crypto.createHash('sha256').update('@whatsap-automat/channel-line-1.0.0').digest('hex'),
        permissions: ['channel:inbound', 'channel:send', 'webhook:receive'],
        manifest: {
          name: '@whatsap-automat/channel-line',
          version: '1.0.0',
          type: 'channel',
          entrypoint: 'dist/index.js',
          permissions: ['channel:inbound', 'channel:send', 'webhook:receive'],
          channel: {
            kind: 'line',
            capabilities: ['text', 'image', 'audio', 'video', 'document', 'interactive'],
            webhookPath: '/api/v1/webhooks/line',
          },
          description: 'Official LINE Official Account connector',
          license: 'MIT',
          minRuntimeVersion: '^0.4.0',
          metadata: {},
        },
        rating: { average: 4.9, count: 8 },
        downloadsCount: 920,
        publishedAt: nowIso,
        updatedAt: nowIso,
      },
    ];

    for (const pkg of officialPackages) {
      const parsed = marketplaceListingSchema.safeParse(pkg);
      if (parsed.success) {
        this.listings.set(parsed.data.extensionId, parsed.data);
      }
    }
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
      const secCheck = validateMarketplacePermissions(manifest.permissions);
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

    let computedSha256 = options.expectedSha256;
    let sizeBytes = options.tarballBuffer ? options.tarballBuffer.length : undefined;

    if (options.tarballBuffer && !computedSha256) {
      computedSha256 = crypto.createHash('sha256').update(options.tarballBuffer).digest('hex');
    }

    const existing = this.listings.get(extensionId);

    const listing: MarketplaceListing = {
      id: existing?.id || `ext_${crypto.randomUUID().slice(0, 8)}`,
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
      verified: options.verified !== undefined ? options.verified : (existing?.verified ?? false),
      tarballUrl: options.tarballUrl,
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
    this.listings.set(extensionId, validated);
    return validated;
  }

  /**
   * Lists catalog extensions with filtering, searching, and pagination.
   */
  listExtensions(query: MarketplaceSearchQuery): { items: MarketplaceListing[]; total: number } {
    let items = Array.from(this.listings.values());

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
    if (this.listings.has(idOrExtensionId)) {
      return this.listings.get(idOrExtensionId)!;
    }
    for (const listing of this.listings.values()) {
      if (listing.id === idOrExtensionId) {
        return listing;
      }
    }
    return null;
  }

  /**
   * Submits a rating (1-5 stars) and review for an extension.
   */
  submitRating(options: SubmitRatingOptions): { listing: MarketplaceListing; rating: ExtensionRating } {
    const listing = this.getExtension(options.extensionId);
    if (!listing) {
      const err = new Error(`Extension ${options.extensionId} not found`);
      (err as any).statusCode = 404;
      throw err;
    }

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

    this.listings.set(listing.extensionId, updatedListing);
    return { listing: updatedListing, rating: validatedRating };
  }

  /**
   * Gets ratings and reviews for an extension.
   */
  getRatings(extensionId: string): ExtensionRating[] {
    return this.ratings.get(extensionId) || [];
  }
}
