import { Queryable } from '../../../../shared/UnitOfWorkPort';
import { ProductRepositoryPg } from '../../../inventory';
import type { Product } from '../../../inventory';
import type { AgentToolContext, ToolExecutorOutcome } from '../../domain/tool.types';
import { MAX_CATALOG_ITEMS_PER_TOOL } from '../../domain/tool.types';

type SearchInput = {
  q?: string;
  type?: string | null;
  catalogId?: number | null;
  sectionId?: number | null;
  limit?: number;
};

type GetItemInput = {
  commercialItemId: number;
};

type RecommendInput = {
  commercialItemId: number;
  reason?: string | null;
  limit?: number;
};

function scoreMatch(product: Product, query: string): number {
  if (!query) return 0.6;
  const q = query.trim().toLowerCase();
  const name = String(product.name || '').toLowerCase();
  const sku = String(product.sku || '').toLowerCase();
  if (!q) return 0.6;
  if (name === q || sku === q) return 1.0;
  if (name.includes(q) || sku.includes(q)) return 0.85;
  const tokens = q.split(/\s+/).filter(Boolean);
  const hits = tokens.filter((t) => name.includes(t) || sku.includes(t)).length;
  if (hits === 0) return 0.3;
  return Math.min(0.8, 0.5 + (hits / tokens.length) * 0.3);
}

function inScope(product: Product, ctx: AgentToolContext): boolean {
  const { catalogIds, sectionIds } = ctx.catalogScope;
  if (catalogIds.length === 0 && sectionIds.length === 0) return false;
  const productCatalogIds = product.catalogs.map((c) => Number(c.id));
  const productSectionIds = product.sections.map((s) => Number(s.id));
  if (catalogIds.length > 0 && catalogIds.some((id) => productCatalogIds.includes(id))) return true;
  if (sectionIds.length > 0 && sectionIds.some((id) => productSectionIds.includes(id))) return true;
  return false;
}

function summarize(product: Product) {
  return {
    id: product.id,
    name: product.name,
    type: product.itemType,
    priceMode: product.priceMode,
    price: product.price,
    currency: product.currency,
    availabilityType: product.availabilityType,
    primaryImageUrl: product.primaryImage?.url || product.imageUrl || null,
    shortDescription: product.aiDescription || product.description || null,
    catalogs: product.catalogs.map((c) => ({ id: c.id, name: c.name })),
    section: product.sections[0] ? { id: product.sections[0].id, name: product.sections[0].name } : null,
    matchConfidence: 0,
  };
}

export class CommercialCatalogToolService {
  constructor(private readonly productRepo: ProductRepositoryPg) {}

  async search(ctx: AgentToolContext, raw: SearchInput): Promise<ToolExecutorOutcome> {
    const { catalogIds, sectionIds } = ctx.catalogScope;
    if (catalogIds.length === 0 && sectionIds.length === 0) {
      return { status: 'scope_empty', output: { items: [], total: 0 } };
    }
    const products = await this.productRepo.findActiveForAgent(ctx.companyId, { catalogIds, sectionIds });
    const scoped = products.filter((p) => inScope(p, ctx));
    const query = String(raw.q || '').trim();
    const typeFilter = raw.type || null;
    const catalogFilter = raw.catalogId ? Number(raw.catalogId) : null;
    const sectionFilter = raw.sectionId ? Number(raw.sectionId) : null;

    let filtered = scoped;
    if (typeFilter) filtered = filtered.filter((p) => p.itemType === typeFilter);
    if (catalogFilter) filtered = filtered.filter((p) => p.catalogs.some((c) => Number(c.id) === catalogFilter));
    if (sectionFilter) filtered = filtered.filter((p) => p.sections.some((s) => Number(s.id) === sectionFilter));

    const scored = filtered
      .map((p) => ({ product: p, score: scoreMatch(p, query) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.min(MAX_CATALOG_ITEMS_PER_TOOL, Math.max(1, Number(raw.limit || MAX_CATALOG_ITEMS_PER_TOOL))));

    const items = scored.map(({ product, score }) => ({ ...summarize(product), matchConfidence: Number(score.toFixed(2)) }));

    return { status: 'ok', output: { items, total: items.length } };
  }

  async getItem(ctx: AgentToolContext, raw: GetItemInput): Promise<ToolExecutorOutcome> {
    const { catalogIds, sectionIds } = ctx.catalogScope;
    if (catalogIds.length === 0 && sectionIds.length === 0) {
      return { status: 'not_found', output: { item: null } };
    }
    const id = Number(raw.commercialItemId);
    if (!Number.isInteger(id) || id <= 0) return { status: 'invalid_input', output: { item: null } };
    const product = await this.productRepo.get(ctx.companyId, id);
    if (!product || product.status !== 'active' || !product.aiEnabled) {
      return { status: 'not_found', output: { item: null } };
    }
    if (!inScope(product, ctx)) return { status: 'not_found', output: { item: null } };

    const item = {
      id: product.id,
      name: product.name,
      description: product.description,
      type: product.itemType,
      priceMode: product.priceMode,
      price: product.price,
      currency: product.currency,
      availabilityType: product.availabilityType,
      stockAvailable: product.stockAvailable,
      stockReserved: product.stockReserved,
      capacity: product.capacity,
      requiresHumanApproval: product.requiresHumanApproval,
      primaryImageUrl: product.primaryImage?.url || product.imageUrl || null,
      images: product.images.map((img) => ({ id: img.id, url: img.url, isPrimary: img.isPrimary })),
      aiNotes: {
        description: product.aiDescription,
        salesInstructions: product.aiSalesInstructions,
      },
    };
    return { status: 'ok', output: { item } };
  }

  async recommendAlternatives(ctx: AgentToolContext, raw: RecommendInput): Promise<ToolExecutorOutcome> {
    const { catalogIds, sectionIds } = ctx.catalogScope;
    if (catalogIds.length === 0 && sectionIds.length === 0) {
      return { status: 'scope_empty', output: { alternatives: [] } };
    }
    const id = Number(raw.commercialItemId);
    if (!Number.isInteger(id) || id <= 0) return { status: 'invalid_input', output: { alternatives: [] } };

    const products = await this.productRepo.findActiveForAgent(ctx.companyId, { catalogIds, sectionIds });
    const scoped = products.filter((p) => inScope(p, ctx));
    const reference = scoped.find((p) => p.id === id);
    if (!reference) return { status: 'not_found', output: { alternatives: [] } };

    const reason = raw.reason || 'similar';
    const candidates = scoped
      .filter((p) => p.id !== id)
      .map((p) => {
        let rank = 0;
        if (p.itemType === reference.itemType) rank += 0.3;
        const sharedSections = p.sections.filter((s) => reference.sections.some((rs) => rs.id === s.id)).length;
        rank += sharedSections * 0.25;
        const sharedCatalogs = p.catalogs.filter((c) => reference.catalogs.some((rc) => rc.id === c.id)).length;
        rank += sharedCatalogs * 0.15;
        if (reason === 'cheaper' && reference.price && p.price && p.price < reference.price) rank += 0.2;
        if (reason === 'out_of_stock' && (p.stockAvailable > 0 || p.availabilityType === 'unlimited')) rank += 0.2;
        return { product: p, rank };
      })
      .sort((a, b) => b.rank - a.rank)
      .slice(0, Math.min(MAX_CATALOG_ITEMS_PER_TOOL, Math.max(1, Number(raw.limit || MAX_CATALOG_ITEMS_PER_TOOL))));

    const alternatives = candidates.map(({ product }) => ({
      id: product.id,
      name: product.name,
      priceMode: product.priceMode,
      price: product.price,
      currency: product.currency,
      primaryImageUrl: product.primaryImage?.url || product.imageUrl || null,
      reason: this.reasonText(reason, product, reference),
    }));

    return { status: 'ok', output: { alternatives } };
  }

  private reasonText(reason: string, product: Product, reference: Product): string {
    if (reason === 'cheaper') return 'Opcion mas economica en la misma seccion.';
    if (reason === 'out_of_stock') return 'Disponible en la misma seccion.';
    if (reason === 'ambiguous') return 'Opcion cercana a la consulta del cliente.';
    return 'Misma seccion y disponible.';
  }
}

let instance: CommercialCatalogToolService | null = null;

export function getCommercialCatalogToolService(pool: Queryable): CommercialCatalogToolService {
  if (!instance) instance = new CommercialCatalogToolService(new ProductRepositoryPg(pool));
  return instance;
}
