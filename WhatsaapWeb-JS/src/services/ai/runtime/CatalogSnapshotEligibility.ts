import { createHash } from 'node:crypto';
import type { Queryable } from '../../../shared/UnitOfWorkPort';

type CatalogScope = { readonly catalogIds: readonly number[]; readonly sectionIds: readonly number[] };
type CatalogSnapshotItem = {
  readonly id: number;
  readonly name: string;
  readonly price: number | null;
  readonly priceMode: string;
  readonly currency: string;
};

export class CatalogSnapshotEligibilityError extends Error {
  readonly code = 'CATALOG_READ_DENIED';
  constructor() { super('A stored catalog result is no longer eligible for this read'); }
}

function validIds(ids: readonly number[]): boolean {
  return Array.isArray(ids) && ids.length <= 50 &&
    ids.every((id) => Number.isSafeInteger(id) && id > 0) && new Set(ids).size === ids.length;
}

/** Call in the tenant transaction that stores or releases the snapshot, keeping these locks until commit. */
export async function catalogSnapshotEligibility(
  db: Queryable, tenantId: number, scope: CatalogScope, items: readonly CatalogSnapshotItem[],
): Promise<string> {
  if (!Number.isSafeInteger(tenantId) || tenantId < 1 || !validIds(scope.catalogIds) || !validIds(scope.sectionIds) ||
      !scope.catalogIds.length && !scope.sectionIds.length || !Array.isArray(items) || items.length > 3 ||
      items.some((item) => !item || !Number.isSafeInteger(item.id) || item.id < 1) ||
      new Set(items.map((item) => item.id)).size !== items.length) throw new CatalogSnapshotEligibilityError();
  await db.query("SET LOCAL statement_timeout = '1000ms'");
  await db.query("SET LOCAL lock_timeout = '1000ms'");

  const evidence: unknown[] = [];
  // A stable lock order keeps overlapping snapshots from locking products in opposite order.
  for (const item of [...items].sort((left, right) => left.id - right.id)) {
    const { rows: [product] } = await db.query(`
      SELECT id, name, price, price_mode, currency, xmin::text AS row_version
      FROM products WHERE company_id = $1 AND id = $2 AND status = 'active' AND ai_enabled = true
      FOR SHARE
    `, [tenantId, item.id]);
    const price = product?.price === null || product?.price === undefined ? null : Number(product.price);
    if (!product || product.name !== item.name || price !== item.price ||
        (product.price_mode || (price === null ? 'consult' : 'fixed')) !== item.priceMode ||
        (product.currency || 'PEN') !== item.currency) throw new CatalogSnapshotEligibilityError();

    // Match findActiveForAgent: when both lists are present they constrain the same membership (AND).
    const { rows: [membership] } = await db.query(`
      SELECT ci.id, ci.catalog_id, ci.section_id, ci.xmin::text AS membership_version, c.xmin::text AS catalog_version
      FROM catalog_items ci JOIN catalogs c ON c.company_id = ci.company_id AND c.id = ci.catalog_id
      WHERE ci.company_id = $1 AND ci.commercial_item_id = $2 AND c.status = 'active' AND c.ai_enabled = true
        AND (cardinality($3::bigint[]) = 0 OR ci.catalog_id = ANY($3::bigint[]))
        AND (cardinality($4::bigint[]) = 0 OR ci.section_id = ANY($4::bigint[]))
        AND (ci.section_id IS NULL OR EXISTS (
          SELECT 1 FROM catalog_sections section WHERE section.company_id = ci.company_id
            AND section.catalog_id = ci.catalog_id AND section.id = ci.section_id
            AND section.status = 'active' AND section.ai_enabled = true
        ))
      ORDER BY ci.id LIMIT 1 FOR SHARE OF ci, c
    `, [tenantId, item.id, scope.catalogIds, scope.sectionIds]);
    if (!membership) throw new CatalogSnapshotEligibilityError();

    let sectionVersion: string | null = null;
    if (membership.section_id !== null) {
      // PostgreSQL cannot row-lock the nullable side of an outer join. Recheck the chosen section while locking it.
      const { rows: [section] } = await db.query(`
        SELECT xmin::text AS row_version FROM catalog_sections
        WHERE company_id = $1 AND catalog_id = $2 AND id = $3 AND status = 'active' AND ai_enabled = true FOR SHARE
      `, [tenantId, membership.catalog_id, membership.section_id]);
      if (!section) throw new CatalogSnapshotEligibilityError();
      sectionVersion = section.row_version;
    }
    evidence.push([item.id, item.name, item.price, item.priceMode, item.currency, product.row_version,
      String(membership.id), String(membership.catalog_id), membership.section_id === null ? null : String(membership.section_id),
      membership.membership_version, membership.catalog_version, sectionVersion]);
  }
  return createHash('sha256').update(JSON.stringify(['catalog-snapshot-eligibility-v1', tenantId,
    [...scope.catalogIds].sort((a, b) => a - b), [...scope.sectionIds].sort((a, b) => a - b), evidence])).digest('hex');
}
