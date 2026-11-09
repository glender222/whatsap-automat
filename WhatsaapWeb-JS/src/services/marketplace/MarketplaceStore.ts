import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { ExtensionRating, MarketplaceListing, MarketplaceSearchQuery } from '@whatsap-automat/contracts';
import { TenantScopedUoW } from '../../db/TenantScopedUoW';
import { Queryable } from '../../shared/UnitOfWorkPort';
import { MarketplaceError, MarketplacePublication, SubmitRatingOptions } from './types';

interface ListingRow {
  listing: MarketplaceListing;
  rating_count: string;
  score_total: string;
  updated_at: Date;
}

interface PublicationRow {
  listing: MarketplaceListing;
  withdrawn_at: Date | null;
}

function publicationDto(row: PublicationRow): MarketplacePublication {
  const { id, extensionId, displayName, version, type, publishedAt } = row.listing;
  return {
    id, extensionId, displayName, version, type, publishedAt,
    state: row.withdrawn_at ? 'withdrawn' : 'published',
    withdrawnAt: row.withdrawn_at?.toISOString() ?? null,
  };
}

interface RatingRow {
  id: string;
  tenant_id: number;
  user_id: string;
  score: number;
  review: string | null;
  created_at: Date;
}

function publicListing(row: ListingRow): MarketplaceListing {
  const count = Number(row.rating_count);
  return {
    ...row.listing,
    rating: { count, average: count ? Number((Number(row.score_total) / count).toFixed(1)) : 0 },
    updatedAt: row.updated_at.toISOString(),
  };
}

function reviewDto(row: RatingRow, extensionId: string): ExtensionRating {
  return {
    id: row.id,
    extensionId,
    tenantId: String(row.tenant_id),
    userId: row.user_id,
    score: row.score,
    review: row.review ?? undefined,
    createdAt: row.created_at.toISOString(),
  };
}

const listingProjection = `extension.listing, totals.rating_count, totals.score_total,
  GREATEST(extension.updated_at, totals.updated_at) AS updated_at`;

export class MarketplaceStore {
  private readonly tenantWork: TenantScopedUoW;

  constructor(private readonly db: Pool) {
    this.tenantWork = new TenantScopedUoW(db);
  }

  async checkStorage(): Promise<void> {
    await this.db.query(`
      SELECT 1 FROM marketplace_extensions AS extension
      JOIN marketplace_rating_totals AS totals ON totals.listing_id = extension.id
      LIMIT 1
    `);
  }

  async publish(publisherTenantId: number, listing: MarketplaceListing): Promise<MarketplaceListing> {
    const conflict = new MarketplaceError(409, 'The extension ID or name is already registered.');
    try {
      return await this.tenantWork.run(publisherTenantId, async (client) => {
        const inserted = await client.query(`
          INSERT INTO marketplace_extensions (id, extension_id, name, publisher_tenant_id, listing, published_at)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT DO NOTHING RETURNING id
        `, [listing.id, listing.extensionId, listing.name, publisherTenantId, listing, listing.publishedAt]);

        let listingId = inserted.rows[0]?.id as string | undefined;
        if (listingId) {
          await this.pinDigest(client, listingId, listing.version, listing.tarballSha256);
        } else {
          const { rows: [current] }: { rows: { id: string; listing: MarketplaceListing }[] } = await client.query(`
            SELECT id, listing FROM marketplace_extensions
            WHERE extension_id = $1 AND name = $2 AND publisher_tenant_id = $3
              AND withdrawn_at IS NULL
            FOR UPDATE
          `, [listing.extensionId, listing.name, publisherTenantId]);
          if (!current) throw conflict;
          listingId = current.id;
          const previousArtifact = current.listing.version === listing.version ? current.listing : undefined;
          const digest = await this.pinDigest(client, listingId, listing.version,
            listing.tarballSha256 ?? previousArtifact?.tarballSha256);
          const updated = {
            ...listing,
            id: listingId,
            publishedAt: current.listing.publishedAt,
            tarballSha256: digest,
            tarballUrl: listing.tarballUrl ?? previousArtifact?.tarballUrl,
            tarballSizeBytes: listing.tarballSizeBytes ?? previousArtifact?.tarballSizeBytes,
          };
          await client.query(`
            UPDATE marketplace_extensions SET listing = $2::jsonb, updated_at = clock_timestamp()
            WHERE id = $1 AND publisher_tenant_id = $3
          `, [listingId, updated, publisherTenantId]);
        }

        const published = await this.getExtension(listingId, client);
        if (!published) throw new Error('The published marketplace listing could not be read.');
        return published;
      });
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw conflict;
      throw error;
    }
  }

  private async pinDigest(client: Queryable, listingId: string, version: string, requested?: string): Promise<string | undefined> {
    const sha256 = requested?.toLowerCase();
    if (sha256) {
      await client.query(`
        INSERT INTO marketplace_version_digests (listing_id, version, sha256)
        VALUES ($1, $2, $3) ON CONFLICT DO NOTHING
      `, [listingId, version, sha256]);
    }

    const { rows: [pin] }: { rows: { sha256: string }[] } = await client.query(`
      SELECT sha256 FROM marketplace_version_digests WHERE listing_id = $1 AND version = $2
    `, [listingId, version]);
    if (pin && sha256 && pin.sha256 !== sha256) {
      throw new MarketplaceError(409, 'The extension version already has a different SHA-256 checksum.');
    }
    return pin?.sha256;
  }

  async listPublications(publisherTenantId: number, limit: number, offset: number) {
    return this.tenantWork.run(publisherTenantId, async (client) => {
      const { rows }: { rows: PublicationRow[] } = await client.query(`
        SELECT listing, withdrawn_at
        FROM marketplace_extensions
        WHERE publisher_tenant_id = $1 AND (withdrawn_at IS NOT NULL OR listing->>'status' = 'published')
        ORDER BY published_at DESC, id LIMIT $2 OFFSET $3
      `, [publisherTenantId, limit + 1, offset]);
      return { items: rows.slice(0, limit).map(publicationDto), hasMore: rows.length > limit };
    });
  }

  async withdrawPublication(publisherTenantId: number, actorId: number, alias: string): Promise<MarketplacePublication | null> {
    return this.tenantWork.run(publisherTenantId, async (client) => {
      const { rows: [current] }: { rows: PublicationRow[] } = await client.query(`
        SELECT extension.listing, extension.withdrawn_at
        FROM marketplace_extension_aliases AS aliases
        JOIN marketplace_extensions AS extension ON extension.id = aliases.listing_id
        WHERE aliases.alias = $1 AND extension.publisher_tenant_id = $2
          AND (extension.withdrawn_at IS NOT NULL OR extension.listing->>'status' = 'published')
        FOR UPDATE OF extension
      `, [alias, publisherTenantId]);
      if (!current) return null;
      if (current.withdrawn_at) return publicationDto(current);
      const { rows: [updated] }: { rows: PublicationRow[] } = await client.query(`
        UPDATE marketplace_extensions
        SET listing = jsonb_set(listing, '{status}', '"deprecated"'),
            withdrawn_at = clock_timestamp(), withdrawn_by = $3, updated_at = clock_timestamp()
        WHERE id = $1 AND publisher_tenant_id = $2
        RETURNING listing, withdrawn_at
      `, [current.listing.id, publisherTenantId, actorId]);
      return publicationDto(updated);
    });
  }

  async listExtensions(query: MarketplaceSearchQuery): Promise<{ items: MarketplaceListing[]; total: number }> {
    const { rows } = await this.db.query<ListingRow & { total: string }>(`
      WITH matching AS (
        SELECT extension.id, extension.published_at
        FROM marketplace_extensions AS extension
        WHERE extension.listing->>'status' = 'published'
          AND ($1::text IS NULL OR extension.listing->>'type' = $1)
          AND ($2::text IS NULL OR EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(extension.listing->'categories') AS categories(category)
            WHERE lower(category) = lower($2)
          ))
          AND ($3::boolean IS NULL OR (extension.listing->>'verified')::boolean = $3)
          AND ($4::text IS NULL OR EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(
              jsonb_build_array(extension.name, extension.listing->>'displayName', extension.listing->>'description')
                || (extension.listing->'tags')
            ) AS terms(term)
            WHERE strpos(lower(term), lower($4)) > 0
          ))
      ), page AS (
        SELECT id FROM matching ORDER BY published_at, id LIMIT $5 OFFSET $6
      )
      SELECT counts.total, ${listingProjection}
      FROM (SELECT count(*) AS total FROM matching) AS counts
      LEFT JOIN page ON true
      LEFT JOIN marketplace_extensions AS extension ON extension.id = page.id
      LEFT JOIN marketplace_rating_totals AS totals ON totals.listing_id = page.id
      ORDER BY extension.published_at, extension.id
    `, [query.type ?? null, query.category ?? null, query.verified ?? null, query.q ?? null, query.limit, query.offset]);

    return { items: rows.filter((row) => row.listing).map(publicListing), total: Number(rows[0].total) };
  }

  async getExtension(alias: string, client: Queryable = this.db): Promise<MarketplaceListing | null> {
    const { rows } = await client.query(`
      SELECT ${listingProjection}
      FROM marketplace_extension_aliases AS aliases
      JOIN marketplace_extensions AS extension ON extension.id = aliases.listing_id
      JOIN marketplace_rating_totals AS totals ON totals.listing_id = extension.id
      WHERE aliases.alias = $1 AND extension.listing->>'status' = 'published'
    `, [alias]);
    return rows[0] ? publicListing(rows[0]) : null;
  }

  async submitRating(options: SubmitRatingOptions): Promise<{ listing: MarketplaceListing; rating: ExtensionRating }> {
    return this.tenantWork.run(options.tenantId, async (client) => {
      const { rows } = await client.query(`
        INSERT INTO marketplace_ratings (id, listing_id, tenant_id, user_id, score, review)
        SELECT $1, extension.id, $3, $4, $5, $6
        FROM marketplace_extension_aliases AS aliases
        JOIN marketplace_extensions AS extension ON extension.id = aliases.listing_id
        WHERE aliases.alias = $2 AND extension.listing->>'status' = 'published'
        ON CONFLICT (listing_id, tenant_id, user_id)
        DO UPDATE SET score = EXCLUDED.score, review = EXCLUDED.review
        RETURNING id, listing_id, tenant_id, user_id, score, review, created_at
      `, [randomUUID(), options.extensionId, options.tenantId, options.userId, options.score, options.review ?? null]);
      const review = rows[0];
      if (!review) throw new MarketplaceError(404, 'Marketplace extension not found.');

      const listing = await this.getExtension(review.listing_id, client);
      if (!listing) throw new MarketplaceError(404, 'Marketplace extension not found.');
      return { listing, rating: reviewDto(review, listing.extensionId) };
    });
  }

  async getRatings(alias: string, tenantId: string): Promise<ExtensionRating[]> {
    return this.tenantWork.run(tenantId, async (client) => {
      const { rows } = await client.query(`
        SELECT review.id, review.tenant_id, review.user_id, review.score, review.review,
               review.created_at, extension.extension_id
        FROM marketplace_extension_aliases AS aliases
        JOIN marketplace_extensions AS extension ON extension.id = aliases.listing_id
        JOIN marketplace_ratings AS review ON review.listing_id = extension.id
        WHERE aliases.alias = $1 AND review.tenant_id = $2 AND extension.listing->>'status' = 'published'
        ORDER BY review.created_at, review.id
      `, [alias, tenantId]);
      return rows.map((row) => reviewDto(row, row.extension_id));
    });
  }
}
