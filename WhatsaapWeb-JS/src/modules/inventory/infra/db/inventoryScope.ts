import { Pool } from 'pg';
import { TenantScopedUoW } from '../../../../db/TenantScopedUoW';
import type { Queryable } from '../../../../shared/UnitOfWorkPort';

export function inventoryScope(source: Queryable) {
  const tenantWork = source instanceof Pool ? new TenantScopedUoW(source) : null;
  // A transaction client supplied by another module already belongs to its caller's unit of work.
  return <T>(companyId: number, work: (db: Queryable) => Promise<T>): Promise<T> =>
    tenantWork ? tenantWork.run(companyId, work) : work(source);
}

export class InventoryReferenceNotFound extends Error {
  readonly statusCode = 404;
  readonly code = 'INVENTORY_REFERENCE_NOT_FOUND';
}

export class InventoryValidationError extends Error {
  readonly statusCode = 400;
  readonly code = 'VALIDATION_ERROR';
}

export async function lockProduct(db: Queryable, companyId: number, productId: number) {
  const { rows } = await db.query(
    'SELECT stock_available, status FROM products WHERE company_id = $1 AND id = $2 FOR UPDATE',
    [companyId, productId],
  );
  return rows[0] as { stock_available: number; status: string } | undefined;
}

export async function lockCatalog(db: Queryable, companyId: number, catalogId: number, assignable: boolean) {
  const { rows } = await db.query(
    `SELECT id FROM catalogs WHERE company_id = $1 AND id = $2 AND (NOT $3::boolean OR status <> 'archived') FOR SHARE`,
    [companyId, catalogId, assignable],
  );
  return rows.length > 0;
}

export async function requireAssignableCatalog(
  db: Queryable, companyId: number, catalogId: number, sectionId: number | null,
): Promise<void> {
  if (!await lockCatalog(db, companyId, catalogId, true)) {
    throw new InventoryReferenceNotFound('Catalogo no encontrado');
  }
  if (sectionId === null) return;
  const { rows } = await db.query(
    `SELECT id FROM catalog_sections
     WHERE company_id = $1 AND catalog_id = $2 AND id = $3 AND status <> 'archived' FOR SHARE`,
    [companyId, catalogId, sectionId],
  );
  if (!rows.length) throw new InventoryReferenceNotFound('Seccion no encontrada en el catalogo');
}
