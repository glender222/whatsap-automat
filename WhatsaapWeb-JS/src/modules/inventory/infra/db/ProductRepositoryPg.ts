import { Queryable } from '../../../../shared/UnitOfWorkPort';
import { CatalogAssignmentInput, Product, ProductImage, ProductImageInput, ProductInput, ProductListFilters, StockAdjustmentInput, StockMovement } from '../../domain/inventory.types';
import { inventoryScope, InventoryReferenceNotFound, InventoryValidationError, lockProduct, requireAssignableCatalog } from './inventoryScope';

type Row = Record<string, any>;

export class ProductRepositoryPg {
  private readonly inScope: ReturnType<typeof inventoryScope>;

  constructor(db: Queryable) {
    this.inScope = inventoryScope(db);
  }

  private query(companyId: number, sql: string, values: unknown[]) {
    return this.inScope(companyId, (db) => db.query(sql, values));
  }

  async list(companyId: number, filters: ProductListFilters | string = ''): Promise<Product[]> {
    const normalizedFilters: ProductListFilters = typeof filters === 'string' ? { q: filters } : filters;
    const search = `%${String(normalizedFilters.q || '').trim().toLowerCase()}%`;
    const values: unknown[] = [companyId, search];
    const conditions = [
      'p.company_id = $1',
      "($2 = '%%' OR LOWER(p.name) LIKE $2 OR LOWER(COALESCE(p.sku, '')) LIKE $2)",
    ];

    if (normalizedFilters.catalogId) {
      values.push(normalizedFilters.catalogId);
      conditions.push(`EXISTS (
        SELECT 1 FROM catalog_items ci_filter
        WHERE ci_filter.company_id = p.company_id
          AND ci_filter.commercial_item_id = p.id
          AND ci_filter.catalog_id = $${values.length}
      )`);
    }
    if (normalizedFilters.sectionId) {
      values.push(normalizedFilters.sectionId);
      conditions.push(`EXISTS (
        SELECT 1 FROM catalog_items ci_section
        WHERE ci_section.company_id = p.company_id
          AND ci_section.commercial_item_id = p.id
          AND ci_section.section_id = $${values.length}
      )`);
    }
    if (normalizedFilters.type) {
      values.push(normalizedFilters.type);
      conditions.push(`p.item_type = $${values.length}`);
    }
    if (normalizedFilters.status) {
      values.push(normalizedFilters.status);
      conditions.push(`p.status = $${values.length}`);
    }
    if (typeof normalizedFilters.aiEnabled === 'boolean') {
      values.push(normalizedFilters.aiEnabled);
      conditions.push(`p.ai_enabled = $${values.length}`);
    }

    const result = await this.query(companyId,
      `${this.baseProductSelect()}
       WHERE ${conditions.join(' AND ')}
       GROUP BY p.id
       ORDER BY p.status ASC, LOWER(p.name) ASC, p.id DESC`,
      values
    );
    return result.rows.map((row) => this.mapProduct(row));
  }

  async get(companyId: number, productId: number): Promise<Product | null> {
    return this.inScope(companyId, (db) => this.getUsing(db, companyId, productId));
  }

  private async getUsing(db: Queryable, companyId: number, productId: number): Promise<Product | null> {
    const result = await db.query(
      `${this.baseProductSelect()}
       WHERE p.company_id = $1 AND p.id = $2
       GROUP BY p.id
       LIMIT 1`,
      [companyId, productId]
    );
    return result.rows[0] ? this.mapProduct(result.rows[0]) : null;
  }

  async findActiveByNames(companyId: number, names: string[]): Promise<Product[]> {
    const normalized = names.map((name) => name.trim().toLowerCase()).filter(Boolean);
    if (normalized.length === 0) return [];
    const result = await this.query(companyId,
      `${this.baseProductSelect()}
       WHERE p.company_id = $1 AND p.status = 'active'
         AND (LOWER(p.name) = ANY($2::varchar[]) OR LOWER(COALESCE(p.sku, '')) = ANY($2::varchar[]))
       GROUP BY p.id
       ORDER BY LOWER(p.name) ASC`,
      [companyId, normalized]
    );
    return result.rows.map((row) => this.mapProduct(row));
  }

  async findActiveForAgent(companyId: number, scope: { catalogIds?: number[]; sectionIds?: number[] } = {}): Promise<Product[]> {
    const values: unknown[] = [companyId];
    const scopeFilters: string[] = [];
    const catalogIds = (scope.catalogIds || []).filter((id) => Number.isInteger(id) && id > 0);
    const sectionIds = (scope.sectionIds || []).filter((id) => Number.isInteger(id) && id > 0);
    if (catalogIds.length === 0 && sectionIds.length === 0) return [];
    if (catalogIds.length > 0) {
      values.push(catalogIds);
      scopeFilters.push(`ci_agent.catalog_id = ANY($${values.length}::bigint[])`);
    }
    if (sectionIds.length > 0) {
      values.push(sectionIds);
      scopeFilters.push(`ci_agent.section_id = ANY($${values.length}::bigint[])`);
    }
    const result = await this.query(companyId,
      `${this.baseProductSelect()}
       WHERE p.company_id = $1
         AND p.status = 'active'
         AND p.ai_enabled = true
         AND EXISTS (
           SELECT 1
           FROM catalog_items ci_agent
           JOIN catalogs c_agent ON c_agent.id = ci_agent.catalog_id AND c_agent.company_id = ci_agent.company_id
           LEFT JOIN catalog_sections cs_agent ON cs_agent.id = ci_agent.section_id
             AND cs_agent.company_id = ci_agent.company_id AND cs_agent.catalog_id = ci_agent.catalog_id
           WHERE ci_agent.company_id = p.company_id
             AND ci_agent.commercial_item_id = p.id
             AND c_agent.status = 'active'
             AND c_agent.ai_enabled = true
             AND (ci_agent.section_id IS NULL OR (cs_agent.status = 'active' AND cs_agent.ai_enabled = true))
             ${scopeFilters.length ? `AND ${scopeFilters.join(' AND ')}` : ''}
         )
       GROUP BY p.id
       ORDER BY p.item_type ASC, LOWER(p.name) ASC
       LIMIT 200`,
      values
    );
    return result.rows.map((row) => this.mapProduct(row));
  }

  async findActiveByIdsOrNames(companyId: number, ids: number[], names: string[]): Promise<Product[]> {
    const normalized = names.map((name) => name.trim().toLowerCase()).filter(Boolean);
    const uniqueIds = Array.from(new Set(ids.filter((id) => Number.isInteger(id) && id > 0)));
    if (uniqueIds.length === 0 && normalized.length === 0) return [];

    const result = await this.query(companyId,
      `${this.baseProductSelect()}
       WHERE p.company_id = $1
         AND p.status = 'active'
         AND (
           p.id = ANY($2::bigint[])
           OR LOWER(p.name) = ANY($3::varchar[])
           OR LOWER(COALESCE(p.sku, '')) = ANY($3::varchar[])
         )
       GROUP BY p.id
       ORDER BY LOWER(p.name) ASC`,
      [companyId, uniqueIds, normalized]
    );
    return result.rows.map((row) => this.mapProduct(row));
  }

  async create(companyId: number, input: ProductInput): Promise<Product> {
    return this.inScope(companyId, async (db) => {
      const result = await db.query(
        `INSERT INTO products (
           company_id, name, description, sku, price, currency, status,
           item_type, unit_label, ai_enabled, ai_description, ai_sales_instructions,
           requires_human_approval, availability_type, capacity, allow_backorder,
           reservation_ttl_minutes, stock_available, image_url, image_alt_text, price_mode, metadata_json
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
         RETURNING *`,
        [
          companyId,
          input.name.trim(),
          input.description || null,
          input.sku || null,
          input.price ?? null,
          input.currency || 'PEN',
          input.status || 'active',
          input.itemType || 'physical_product',
          input.unitLabel || null,
          input.aiEnabled ?? true,
          input.aiDescription || null,
          input.aiSalesInstructions || null,
          input.requiresHumanApproval ?? false,
          input.availabilityType || this.defaultAvailabilityType(input.itemType),
          input.capacity ?? null,
          input.allowBackorder ?? false,
          input.reservationTtlMinutes ?? null,
          this.initialAvailableQuantity(input),
          input.imageUrl || null,
          input.imageAltText || null,
          input.priceMode || (input.price === 0 ? 'free' : input.price === null ? 'consult' : 'fixed'),
          JSON.stringify(input.metadata || {}),
        ]
      );
      const productId = Number(result.rows[0].id);
      await this.writeAssignments(db, companyId, productId, this.normalizeAssignments(input));
      if (input.images !== undefined) {
        await this.replaceImages(db, companyId, productId, input.images, input.imageUrl, input.imageAltText);
      } else if (input.imageUrl) {
        await this.ensurePrimaryImage(db, companyId, productId, input.imageUrl, input.imageAltText ?? null);
      }
      const product = await this.getUsing(db, companyId, productId);
      if (!product) throw new InventoryReferenceNotFound('Item de catalogo no encontrado');
      this.requirePublicationImage(product);
      return product;
    });
  }

  async update(
    companyId: number, productId: number, input: Partial<ProductInput>, actorUserId: number | null = null,
  ): Promise<Product | null> {
    return this.inScope(companyId, async (db) => {
      const current = await lockProduct(db, companyId, productId);
      if (!current) return null;
      const result = await db.query(
        `UPDATE products
         SET name = COALESCE($3, name),
             description = COALESCE($4, description),
             sku = COALESCE($5, sku),
             price = COALESCE($6, price),
             currency = COALESCE($7, currency),
             status = COALESCE($8, status),
             item_type = COALESCE($9, item_type),
             unit_label = COALESCE($10, unit_label),
             ai_enabled = COALESCE($11, ai_enabled),
             ai_description = COALESCE($12, ai_description),
             ai_sales_instructions = COALESCE($13, ai_sales_instructions),
             requires_human_approval = COALESCE($14, requires_human_approval),
             availability_type = COALESCE($15, availability_type),
             capacity = COALESCE($16, capacity),
             allow_backorder = COALESCE($17, allow_backorder),
             reservation_ttl_minutes = COALESCE($18, reservation_ttl_minutes),
             stock_available = COALESCE($19, stock_available),
             price_mode = COALESCE($20, price_mode),
             metadata_json = COALESCE($21, metadata_json),
             updated_at = NOW()
         WHERE company_id = $1 AND id = $2
         RETURNING *`,
        [
          companyId,
          productId,
          input.name?.trim() || null,
          input.description ?? null,
          input.sku ?? null,
          input.price ?? null,
          input.currency || null,
          input.status || null,
          input.itemType || null,
          input.unitLabel ?? null,
          input.aiEnabled ?? null,
          input.aiDescription ?? null,
          input.aiSalesInstructions ?? null,
          input.requiresHumanApproval ?? null,
          input.availabilityType || null,
          input.capacity ?? null,
          input.allowBackorder ?? null,
          input.reservationTtlMinutes ?? null,
          input.stockAvailable ?? null,
          input.priceMode || null,
          input.metadata ? JSON.stringify(input.metadata) : null,
        ]
      );
      if (input.catalogIds !== undefined || input.catalogAssignments !== undefined) {
        await this.writeAssignments(db, companyId, productId, this.normalizeAssignments(input));
      }
      if (input.images !== undefined) {
        await this.replaceImages(db, companyId, productId, input.images, input.imageUrl, input.imageAltText);
      } else if (input.imageUrl) {
        await this.ensurePrimaryImage(db, companyId, productId, input.imageUrl, input.imageAltText ?? null);
      } else if (input.imageAltText != null) {
        await db.query(`
          UPDATE product_images SET image_alt_text = $3, updated_at = NOW()
          WHERE company_id = $1 AND product_id = $2 AND is_primary
        `, [companyId, productId, input.imageAltText]);
        await db.query(`
          UPDATE products SET image_alt_text = $3 WHERE company_id = $1 AND id = $2
        `, [companyId, productId, input.imageAltText]);
      }
      const delta = result.rows[0].stock_available - current.stock_available;
      if (delta) await this.recordAdjustment(db, result.rows[0], { delta, actorUserId });
      const product = await this.getUsing(db, companyId, productId);
      if (product && (input.status === 'active' || input.images !== undefined || input.imageUrl)) {
        this.requirePublicationImage(product);
      }
      return product;
    });
  }

  async addImage(companyId: number, productId: number, input: ProductImageInput): Promise<ProductImage | null> {
    return this.inScope(companyId, async (db) => {
      if (!await lockProduct(db, companyId, productId)) return null;
      return this.addImageUsing(db, companyId, productId, input);
    });
  }

  async updateImage(companyId: number, productId: number, imageId: number, input: Partial<ProductImageInput>): Promise<ProductImage | null> {
    return this.inScope(companyId, async (db) => {
      if (!await lockProduct(db, companyId, productId)) return null;
      return this.updateImageUsing(db, companyId, productId, imageId, input);
    });
  }

  async deleteImage(companyId: number, productId: number, imageId: number): Promise<boolean> {
    return this.inScope(companyId, async (db) => {
      const product = await lockProduct(db, companyId, productId);
      if (!product) return false;
      const removed = await db.query(
        'DELETE FROM product_images WHERE company_id = $1 AND product_id = $2 AND id = $3 RETURNING id',
        [companyId, productId, imageId],
      );
      if (!removed.rows.length) return false;
      const primary = await this.syncPrimaryImage(db, companyId, productId);
      if (product.status === 'active' && !primary) {
        throw new InventoryValidationError('La oferta activa necesita conservar una imagen principal');
      }
      return true;
    });
  }

  async adjustStock(companyId: number, productId: number, input: StockAdjustmentInput): Promise<{ product: Product; movement: StockMovement } | null> {
    return this.inScope(companyId, async (db) => {
      if (!await lockProduct(db, companyId, productId)) return null;
      const { rows: [updated] } = await db.query(`
        UPDATE products SET stock_available = stock_available + $3::integer, updated_at = NOW()
        WHERE company_id = $1 AND id = $2
          AND stock_available::bigint + $3::integer BETWEEN 0 AND 2147483647
        RETURNING *
      `, [companyId, productId, input.delta]);
      if (!updated) throw new InventoryValidationError('Disponibilidad insuficiente o fuera de rango');
      const movement = await this.recordAdjustment(db, updated, input);
      const product = (await this.getUsing(db, companyId, productId)) ?? this.mapProduct(updated);
      return { product, movement };
    });
  }

  async setCatalogAssignments(companyId: number, productId: number, assignments: CatalogAssignmentInput[] | number[]): Promise<void> {
    return this.inScope(companyId, async (db) => {
      if (!await lockProduct(db, companyId, productId)) {
        throw new InventoryReferenceNotFound('Item de catalogo no encontrado');
      }
      await this.writeAssignments(db, companyId, productId, this.normalizeAssignmentList(assignments));
    });
  }

  private async writeAssignments(
    db: Queryable, companyId: number, productId: number, assignments: CatalogAssignmentInput[],
  ): Promise<void> {
    const ordered = [...assignments].sort((first, second) => first.catalogId - second.catalogId);
    for (const { catalogId, sectionId } of ordered) {
      await requireAssignableCatalog(db, companyId, catalogId, sectionId ?? null);
    }
    await db.query(
      'DELETE FROM catalog_items WHERE company_id = $1 AND commercial_item_id = $2',
      [companyId, productId],
    );
    for (const { catalogId, sectionId } of ordered) {
      await db.query(`
        INSERT INTO catalog_items (company_id, catalog_id, commercial_item_id, section_id, sort_order)
        VALUES ($1, $2, $3, $4, 0)
      `, [companyId, catalogId, productId, sectionId ?? null]);
    }
  }

  private async recordAdjustment(db: Queryable, product: Row, input: StockAdjustmentInput): Promise<StockMovement> {
    const { rows: [movement] } = await db.query(`
      INSERT INTO stock_movements (company_id, product_id, actor_user_id, movement_type, quantity,
        stock_available_after, stock_reserved_after, notes, commercial_item_id, delta_available, delta_reserved)
      VALUES ($1, $2, $3, 'adjustment', $4, $5, $6, $7, $2, $4, 0)
      RETURNING *
    `, [product.company_id, product.id, input.actorUserId ?? null, input.delta,
      product.stock_available, product.stock_reserved, input.notes ?? null]);
    return this.mapMovement(movement);
  }

  private requirePublicationImage(product: Product): void {
    if (product.status === 'active' && !product.primaryImage?.url) {
      throw new InventoryValidationError('La oferta necesita una imagen principal antes de publicarse');
    }
  }

  private async insertImage(
    db: Queryable, companyId: number, productId: number, input: ProductImageInput, isPrimary: boolean, sortOrder: number,
  ): Promise<Row> {
    const { rows: [image] } = await db.query(`
      INSERT INTO product_images (company_id, product_id, image_url, image_alt_text, sort_order,
        is_primary, mime_type, size_bytes)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *
    `, [companyId, productId, input.imageUrl, input.imageAltText || null,
      input.sortOrder ?? sortOrder, isPrimary, input.mimeType || null, input.sizeBytes ?? null]);
    return image;
  }

  private async clearPrimaryImage(db: Queryable, companyId: number, productId: number): Promise<void> {
    await db.query(`
      UPDATE product_images SET is_primary = false, updated_at = NOW()
      WHERE company_id = $1 AND product_id = $2 AND is_primary
    `, [companyId, productId]);
  }

  private async addImageUsing(db: Queryable, companyId: number, productId: number, input: ProductImageInput): Promise<ProductImage> {
    const { rows: [existing] } = await db.query(`
      SELECT COUNT(*)::int AS count, bool_or(is_primary) AS has_primary
      FROM product_images WHERE company_id = $1 AND product_id = $2
    `, [companyId, productId]);
    if (existing.count >= 8) throw new InventoryValidationError('El item permite hasta 8 imagenes');
    if (input.isPrimary && existing.has_primary) await this.clearPrimaryImage(db, companyId, productId);
    const image = await this.insertImage(db, companyId, productId, input, input.isPrimary === true || !existing.has_primary, existing.count);
    await this.syncPrimaryImage(db, companyId, productId);
    return this.mapImage(image);
  }

  private async updateImageUsing(
    db: Queryable, companyId: number, productId: number, imageId: number, input: Partial<ProductImageInput>,
  ): Promise<ProductImage | null> {
    const { rows: [current] } = await db.query(
      'SELECT is_primary FROM product_images WHERE company_id = $1 AND product_id = $2 AND id = $3',
      [companyId, productId, imageId],
    );
    if (!current) return null;
    if (input.isPrimary === true && !current.is_primary) await this.clearPrimaryImage(db, companyId, productId);
    const { rows: [updated] } = await db.query(`
      UPDATE product_images SET image_url = COALESCE($4, image_url),
        image_alt_text = COALESCE($5, image_alt_text), sort_order = COALESCE($6, sort_order),
        is_primary = COALESCE($7, is_primary), mime_type = COALESCE($8, mime_type),
        size_bytes = COALESCE($9, size_bytes), updated_at = NOW()
      WHERE company_id = $1 AND product_id = $2 AND id = $3 RETURNING *
    `, [companyId, productId, imageId, input.imageUrl || null, input.imageAltText ?? null,
      input.sortOrder ?? null, input.isPrimary ?? null, input.mimeType ?? null, input.sizeBytes ?? null]);
    const primary = await this.syncPrimaryImage(db, companyId, productId, input.isPrimary === false ? imageId : null);
    return primary && Number(primary.id) === imageId ? this.mapImage(primary) : this.mapImage(updated);
  }

  private async replaceImages(
    db: Queryable, companyId: number, productId: number, images: ProductImageInput[],
    legacyImageUrl?: string | null, legacyAltText?: string | null,
  ): Promise<void> {
    await db.query('DELETE FROM product_images WHERE company_id = $1 AND product_id = $2', [companyId, productId]);
    const gallery = images.length ? images.slice(0, 8)
      : legacyImageUrl ? [{ imageUrl: legacyImageUrl, imageAltText: legacyAltText }] : [];
    // Older editors submit the first image as primary as well as the explicit selection.
    let primaryIndex = 0;
    gallery.forEach((image, index) => {
      if ('isPrimary' in image && image.isPrimary === true) primaryIndex = index;
    });
    for (const [index, image] of gallery.entries()) {
      await this.insertImage(db, companyId, productId, image, index === primaryIndex, index);
    }
    await this.syncPrimaryImage(db, companyId, productId);
  }

  private async ensurePrimaryImage(
    db: Queryable, companyId: number, productId: number, imageUrl: string, imageAltText: string | null,
  ): Promise<void> {
    const { rows: [existing] } = await db.query(`
      SELECT id FROM product_images WHERE company_id = $1 AND product_id = $2 AND image_url = $3
      ORDER BY is_primary DESC, sort_order, id LIMIT 1
    `, [companyId, productId, imageUrl]);
    if (existing) {
      await this.updateImageUsing(db, companyId, productId, Number(existing.id), { isPrimary: true, imageAltText });
    } else {
      await this.addImageUsing(db, companyId, productId, { imageUrl, imageAltText, isPrimary: true });
    }
  }

  private async syncPrimaryImage(db: Queryable, companyId: number, productId: number, demotedId: number | null = null) {
    const { rows: [selected] } = await db.query(`
      SELECT * FROM product_images WHERE company_id = $1 AND product_id = $2
      ORDER BY is_primary DESC, (id = $3::bigint), sort_order, id LIMIT 1
    `, [companyId, productId, demotedId]);
    let primary = selected;
    if (selected && !selected.is_primary) {
      const { rows } = await db.query(`
        UPDATE product_images SET is_primary = true, updated_at = NOW()
        WHERE company_id = $1 AND product_id = $2 AND id = $3 RETURNING *
      `, [companyId, productId, selected.id]);
      primary = rows[0];
    }
    await db.query(`
      UPDATE products SET image_url = $3, image_alt_text = $4, updated_at = NOW()
      WHERE company_id = $1 AND id = $2
    `, [companyId, productId, primary?.image_url ?? null, primary?.image_alt_text ?? null]);
    return primary;
  }

  private baseProductSelect(): string {
    return `SELECT p.*,
        COALESCE(
          (
            SELECT jsonb_agg(
              jsonb_build_object(
                'id', pi.id,
                'productId', pi.product_id,
                'url', pi.image_url,
                'altText', pi.image_alt_text,
                'sortOrder', pi.sort_order,
                'isPrimary', pi.is_primary,
                'mimeType', pi.mime_type,
                'sizeBytes', pi.size_bytes
              )
              ORDER BY pi.is_primary DESC, pi.sort_order ASC, pi.id ASC
            )
            FROM product_images pi
            WHERE pi.company_id = p.company_id
              AND pi.product_id = p.id
          ),
          '[]'::jsonb
        ) AS images_json,
        COALESCE(
          jsonb_agg(
            DISTINCT jsonb_build_object(
              'id', c.id,
              'name', c.name,
              'status', c.status,
              'aiEnabled', c.ai_enabled
            )
          ) FILTER (WHERE c.id IS NOT NULL),
          '[]'::jsonb
        ) AS catalogs_json,
        COALESCE(
          jsonb_agg(
            DISTINCT jsonb_build_object(
              'id', cs.id,
              'catalogId', c.id,
              'catalogName', c.name,
              'name', cs.name,
              'status', cs.status,
              'aiEnabled', cs.ai_enabled
            )
          ) FILTER (WHERE cs.id IS NOT NULL),
          '[]'::jsonb
        ) AS sections_json
      FROM products p
      LEFT JOIN catalog_items ci
        ON ci.company_id = p.company_id
       AND ci.commercial_item_id = p.id
      LEFT JOIN catalogs c
        ON c.id = ci.catalog_id
       AND c.company_id = p.company_id
      LEFT JOIN catalog_sections cs
        ON cs.id = ci.section_id
       AND cs.company_id = p.company_id
       AND cs.catalog_id = c.id`;
  }

  private mapProduct(row: Row): Product {
    const rawCatalogs = row.catalogs_json || [];
    const catalogs = (Array.isArray(rawCatalogs) ? rawCatalogs : []).map((catalog: Row) => ({
      id: Number(catalog.id),
      name: catalog.name,
      status: catalog.status,
      aiEnabled: catalog.aiEnabled !== false,
    }));
    const rawSections = row.sections_json || [];
    const sections = (Array.isArray(rawSections) ? rawSections : []).map((section: Row) => ({
      id: Number(section.id),
      catalogId: Number(section.catalogId),
      catalogName: section.catalogName,
      name: section.name,
      status: section.status,
      aiEnabled: section.aiEnabled !== false,
    }));
    const rawImages = row.images_json || [];
    const images = (Array.isArray(rawImages) ? rawImages : []).map((image: Row) => ({
      id: Number(image.id),
      productId: Number(image.productId),
      url: image.url,
      altText: image.altText || null,
      sortOrder: Number(image.sortOrder || 0),
      isPrimary: image.isPrimary === true,
      mimeType: image.mimeType || null,
      sizeBytes: image.sizeBytes === null || image.sizeBytes === undefined ? null : Number(image.sizeBytes),
    }));
    const imageUrl = images.find((image) => image.isPrimary)?.url || row.image_url || null;
    const imageAltText = images.find((image) => image.isPrimary)?.altText || row.image_alt_text || null;
    return {
      id: Number(row.id),
      companyId: Number(row.company_id),
      name: row.name,
      description: row.description || null,
      sku: row.sku || null,
      price: row.price === null || row.price === undefined ? null : Number(row.price),
      priceMode: row.price_mode || (row.price === null || row.price === undefined ? 'consult' : 'fixed'),
      currency: row.currency || 'PEN',
      status: row.status,
      itemType: row.item_type || 'physical_product',
      unitLabel: row.unit_label || null,
      aiEnabled: row.ai_enabled !== false,
      aiDescription: row.ai_description || null,
      aiSalesInstructions: row.ai_sales_instructions || null,
      requiresHumanApproval: Boolean(row.requires_human_approval),
      availabilityType: row.availability_type || 'stock',
      capacity: row.capacity === null || row.capacity === undefined ? null : Number(row.capacity),
      allowBackorder: Boolean(row.allow_backorder),
      reservationTtlMinutes: row.reservation_ttl_minutes === null || row.reservation_ttl_minutes === undefined ? null : Number(row.reservation_ttl_minutes),
      stockAvailable: Number(row.stock_available || 0),
      stockReserved: Number(row.stock_reserved || 0),
      catalogs,
      sections,
      primaryImage: imageUrl ? { url: imageUrl, altText: imageAltText || row.name || null } : null,
      images: images.length ? images : (imageUrl ? [{ url: imageUrl, altText: imageAltText || row.name || null, sortOrder: 0, isPrimary: true }] : []),
      imageUrl,
      imageAltText: imageAltText || null,
      aiReadiness: this.resolveAiReadiness(row, catalogs, sections),
      metadata: row.metadata_json || {},
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private normalizeAssignments(input: Partial<ProductInput>): CatalogAssignmentInput[] {
    if (Array.isArray(input.catalogAssignments)) return this.normalizeAssignmentList(input.catalogAssignments);
    return this.normalizeAssignmentList(input.catalogIds || []);
  }

  private normalizeAssignmentList(assignments: CatalogAssignmentInput[] | number[]): CatalogAssignmentInput[] {
    const byCatalog = new Map<number, CatalogAssignmentInput>();
    for (const assignment of assignments as any[]) {
      const catalogId = typeof assignment === 'number' ? assignment : Number(assignment?.catalogId);
      const sectionId = typeof assignment === 'number' ? null : assignment?.sectionId ? Number(assignment.sectionId) : null;
      if (!Number.isInteger(catalogId) || catalogId <= 0) continue;
      if (sectionId !== null && (!Number.isInteger(sectionId) || sectionId <= 0)) continue;
      byCatalog.set(catalogId, { catalogId, sectionId });
    }
    return Array.from(byCatalog.values());
  }

  private resolveAiReadiness(row: Row, catalogs: Array<{ status: string; aiEnabled: boolean }>, sections: Array<{ status: string; aiEnabled: boolean }>): Product['aiReadiness'] {
    if (row.status !== 'active') return 'inactive';
    if (row.ai_enabled === false) return 'disabled';
    if (catalogs.length === 0) return 'missing_catalog';
    if (sections.length === 0) return 'missing_section';
    const hasActiveCatalog = catalogs.some((catalog) => catalog.status === 'active' && catalog.aiEnabled !== false);
    const hasActiveSection = sections.some((section) => section.status === 'active' && section.aiEnabled !== false);
    if (!hasActiveCatalog || !hasActiveSection || !row.ai_description) return 'missing_ai_context';
    return 'ready';
  }

  private mapMovement(row: Row): StockMovement {
    return {
      id: Number(row.id),
      companyId: Number(row.company_id),
      productId: Number(row.product_id),
      commercialItemId: row.commercial_item_id ? Number(row.commercial_item_id) : null,
      orderId: row.order_id ? Number(row.order_id) : null,
      orderItemId: row.order_item_id ? Number(row.order_item_id) : null,
      actorUserId: row.actor_user_id ? Number(row.actor_user_id) : null,
      actorAgentId: row.actor_agent_id ? Number(row.actor_agent_id) : null,
      movementType: row.movement_type,
      quantity: Number(row.quantity),
      deltaAvailable: row.delta_available === null || row.delta_available === undefined ? null : Number(row.delta_available),
      deltaReserved: row.delta_reserved === null || row.delta_reserved === undefined ? null : Number(row.delta_reserved),
      stockAvailableAfter: Number(row.stock_available_after),
      stockReservedAfter: Number(row.stock_reserved_after),
      notes: row.notes || null,
      metadata: row.metadata_json || {},
      occurredAt: row.occurred_at,
    };
  }

  private defaultAvailabilityType(itemType?: string): string {
    if (itemType === 'digital_product' || itemType === 'subscription') return 'unlimited';
    if (itemType === 'service') return 'manual';
    if (itemType === 'course') return 'capacity';
    return 'stock';
  }

  private initialAvailableQuantity(input: ProductInput): number {
    if (input.stockAvailable !== undefined) return Number(input.stockAvailable);
    if (input.availabilityType === 'capacity' && input.capacity !== undefined && input.capacity !== null) return Number(input.capacity);
    return 0;
  }

  private mapImage(row: Row): ProductImage {
    return {
      id: Number(row.id),
      productId: Number(row.product_id),
      url: row.image_url,
      altText: row.image_alt_text || null,
      sortOrder: Number(row.sort_order || 0),
      isPrimary: Boolean(row.is_primary),
      mimeType: row.mime_type || null,
      sizeBytes: row.size_bytes === null || row.size_bytes === undefined ? null : Number(row.size_bytes),
    };
  }
}
