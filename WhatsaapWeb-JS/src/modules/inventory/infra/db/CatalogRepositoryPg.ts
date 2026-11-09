import { Queryable } from '../../../../shared/UnitOfWorkPort';
import { Catalog, CatalogInput, CatalogSection, CatalogSectionInput } from '../../domain/inventory.types';
import { inventoryScope, InventoryReferenceNotFound, lockCatalog, lockProduct, requireAssignableCatalog } from './inventoryScope';

type Row = Record<string, any>;

export class CatalogRepositoryPg {
  private readonly inScope: ReturnType<typeof inventoryScope>;

  constructor(db: Queryable) {
    this.inScope = inventoryScope(db);
  }

  private query(companyId: number, sql: string, values: unknown[]) {
    return this.inScope(companyId, (db) => db.query(sql, values));
  }

  async list(companyId: number): Promise<Catalog[]> {
    return this.inScope(companyId, async (db) => {
      const result = await db.query(
        `SELECT c.*,
            COUNT(ci.commercial_item_id)::int AS item_count
         FROM catalogs c
         LEFT JOIN catalog_items ci
           ON ci.company_id = c.company_id
          AND ci.catalog_id = c.id
         WHERE c.company_id = $1
           AND c.status <> 'archived'
         GROUP BY c.id
         ORDER BY c.sort_order ASC, LOWER(c.name) ASC, c.id ASC`,
        [companyId]
      );
      const catalogs = result.rows.map((row) => this.mapCatalog(row));
      const sections = await this.listSectionsForCompany(db, companyId);
      return catalogs.map((catalog) => ({
        ...catalog,
        sections: sections.filter((section) => section.catalogId === catalog.id),
      }));
    });
  }

  async create(companyId: number, input: CatalogInput): Promise<Catalog> {
    const result = await this.query(companyId,
      `INSERT INTO catalogs (
         company_id, name, description, status, ai_enabled, ai_instructions, sales_policy, sort_order, metadata_json
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *, 0::int AS item_count`,
      [
        companyId,
        input.name.trim(),
        input.description || null,
        input.status || 'active',
        input.aiEnabled ?? true,
        input.aiInstructions || '',
        input.salesPolicy || '',
        input.sortOrder ?? 0,
        JSON.stringify(input.metadata || {}),
      ]
    );
    return this.mapCatalog(result.rows[0]);
  }

  async update(companyId: number, catalogId: number, input: Partial<CatalogInput>): Promise<Catalog | null> {
    const result = await this.query(companyId,
      `UPDATE catalogs
       SET name = COALESCE($3, name),
           description = COALESCE($4, description),
           status = COALESCE($5, status),
           ai_enabled = COALESCE($6, ai_enabled),
           ai_instructions = COALESCE($7, ai_instructions),
           sales_policy = COALESCE($8, sales_policy),
           sort_order = COALESCE($9, sort_order),
           metadata_json = COALESCE($10, metadata_json),
           updated_at = NOW()
       WHERE company_id = $1 AND id = $2
       RETURNING *,
         (
           SELECT COUNT(*)::int
           FROM catalog_items ci
           WHERE ci.company_id = catalogs.company_id
             AND ci.catalog_id = catalogs.id
         ) AS item_count`,
      [
        companyId,
        catalogId,
        input.name?.trim() || null,
        input.description ?? null,
        input.status || null,
        input.aiEnabled ?? null,
        input.aiInstructions ?? null,
        input.salesPolicy ?? null,
        input.sortOrder ?? null,
        input.metadata ? JSON.stringify(input.metadata) : null,
      ]
    );
    return result.rows[0] ? this.mapCatalog(result.rows[0]) : null;
  }

  async listSections(companyId: number, catalogId: number): Promise<CatalogSection[]> {
    return this.inScope(companyId, async (db) => {
      if (!await lockCatalog(db, companyId, catalogId, false)) {
        throw new InventoryReferenceNotFound('Catalogo no encontrado');
      }
      const result = await db.query(
        `SELECT cs.*,
            COUNT(ci.commercial_item_id)::int AS item_count
         FROM catalog_sections cs
         LEFT JOIN catalog_items ci
           ON ci.company_id = cs.company_id
          AND ci.section_id = cs.id
         WHERE cs.company_id = $1
           AND cs.catalog_id = $2
           AND cs.status <> 'archived'
         GROUP BY cs.id
         ORDER BY cs.sort_order ASC, LOWER(cs.name) ASC, cs.id ASC`,
        [companyId, catalogId]
      );
      return result.rows.map((row) => this.mapSection(row));
    });
  }

  async createSection(companyId: number, catalogId: number, input: CatalogSectionInput): Promise<CatalogSection | null> {
    return this.inScope(companyId, async (db) => {
      if (!await lockCatalog(db, companyId, catalogId, true)) return null;
      const result = await db.query(
        `INSERT INTO catalog_sections (
           company_id, catalog_id, name, description, status, ai_enabled,
           ai_instructions, sort_order, metadata_json
         )
         SELECT $1, c.id, $3, $4, $5, $6, $7, $8, $9::jsonb
         FROM catalogs c
         WHERE c.company_id = $1
           AND c.id = $2
           AND c.status <> 'archived'
         RETURNING *, 0::int AS item_count`,
        [
          companyId,
          catalogId,
          input.name.trim(),
          input.description || null,
          input.status || 'active',
          input.aiEnabled ?? true,
          input.aiInstructions || '',
          input.sortOrder ?? 0,
          JSON.stringify(input.metadata || {}),
        ]
      );
      return result.rows[0] ? this.mapSection(result.rows[0]) : null;
    });
  }

  async updateSection(companyId: number, sectionId: number, input: Partial<CatalogSectionInput>): Promise<CatalogSection | null> {
    const result = await this.query(companyId,
      `UPDATE catalog_sections
       SET name = COALESCE($3, name),
           description = COALESCE($4, description),
           status = COALESCE($5, status),
           ai_enabled = COALESCE($6, ai_enabled),
           ai_instructions = COALESCE($7, ai_instructions),
           sort_order = COALESCE($8, sort_order),
           metadata_json = COALESCE($9, metadata_json),
           updated_at = NOW()
       WHERE company_id = $1 AND id = $2
       RETURNING *,
         (
           SELECT COUNT(*)::int
           FROM catalog_items ci
           WHERE ci.company_id = catalog_sections.company_id
             AND ci.section_id = catalog_sections.id
         ) AS item_count`,
      [
        companyId,
        sectionId,
        input.name?.trim() || null,
        input.description ?? null,
        input.status || null,
        input.aiEnabled ?? null,
        input.aiInstructions ?? null,
        input.sortOrder ?? null,
        input.metadata ? JSON.stringify(input.metadata) : null,
      ]
    );
    return result.rows[0] ? this.mapSection(result.rows[0]) : null;
  }

  async addItem(companyId: number, catalogId: number, commercialItemId: number, sectionId: number | null = null): Promise<boolean> {
    return this.inScope(companyId, async (db) => {
      if (!await lockProduct(db, companyId, commercialItemId)) {
        throw new InventoryReferenceNotFound('Item de catalogo no encontrado');
      }
      await requireAssignableCatalog(db, companyId, catalogId, sectionId);
      const result = await db.query(
        `INSERT INTO catalog_items (company_id, catalog_id, commercial_item_id, section_id, sort_order)
         VALUES ($1, $2, $3, $4, 0)
         ON CONFLICT (catalog_id, commercial_item_id)
         DO UPDATE SET section_id = EXCLUDED.section_id
         WHERE catalog_items.company_id = EXCLUDED.company_id
         RETURNING id`,
        [companyId, catalogId, commercialItemId, sectionId]
      );
      return Boolean(result.rows[0]);
    });
  }

  async removeItem(companyId: number, catalogId: number, commercialItemId: number): Promise<boolean> {
    return this.inScope(companyId, async (db) => {
      if (!await lockProduct(db, companyId, commercialItemId) || !await lockCatalog(db, companyId, catalogId, false)) {
        throw new InventoryReferenceNotFound('Catalogo o item no encontrado');
      }
      const result = await db.query(
        `DELETE FROM catalog_items
         WHERE company_id = $1
           AND catalog_id = $2
           AND commercial_item_id = $3`,
        [companyId, catalogId, commercialItemId]
      );
      return (result.rowCount || 0) > 0;
    });
  }

  private mapCatalog(row: Row): Catalog {
    return {
      id: Number(row.id),
      companyId: Number(row.company_id),
      name: row.name,
      description: row.description || null,
      status: row.status,
      aiEnabled: row.ai_enabled !== false,
      aiInstructions: row.ai_instructions || '',
      salesPolicy: row.sales_policy || '',
      sortOrder: Number(row.sort_order || 0),
      itemCount: Number(row.item_count || 0),
      sections: [],
      metadata: row.metadata_json || {},
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private async listSectionsForCompany(db: Queryable, companyId: number): Promise<CatalogSection[]> {
    const result = await db.query(
      `SELECT cs.*,
          COUNT(ci.commercial_item_id)::int AS item_count
       FROM catalog_sections cs
       LEFT JOIN catalog_items ci
         ON ci.company_id = cs.company_id
        AND ci.section_id = cs.id
       WHERE cs.company_id = $1
         AND cs.status <> 'archived'
       GROUP BY cs.id
       ORDER BY cs.sort_order ASC, LOWER(cs.name) ASC, cs.id ASC`,
      [companyId]
    );
    return result.rows.map((row) => this.mapSection(row));
  }

  private mapSection(row: Row): CatalogSection {
    return {
      id: Number(row.id),
      companyId: Number(row.company_id),
      catalogId: Number(row.catalog_id),
      name: row.name,
      description: row.description || null,
      status: row.status,
      aiEnabled: row.ai_enabled !== false,
      aiInstructions: row.ai_instructions || '',
      sortOrder: Number(row.sort_order || 0),
      itemCount: Number(row.item_count || 0),
      metadata: row.metadata_json || {},
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
