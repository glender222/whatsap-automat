import { createHash } from 'node:crypto';
import type { ToolDefinitionV1 } from '@whatsap-automat/contracts';
import { TenantScopedUoW } from '../../../db/TenantScopedUoW';
import type { Queryable } from '../../../shared/UnitOfWorkPort';
import { ProductRepositoryPg } from '../../../modules/inventory/infra/db/ProductRepositoryPg';
import { CommercialCatalogToolService } from '../../../modules/ai/application/tools/CommercialCatalogToolService';
import type { AgentToolContext } from '../../../modules/ai/domain/tool.types';
import type { IToolImplementation, ToolExecutionContext } from '../broker/types';
import { catalogSnapshotEligibility } from './CatalogSnapshotEligibility';
import { TenantAiDispatchPolicy } from '../gateway/TenantAiDispatchPolicy';
import { catalogReadTimeoutMs, type CatalogRouterExecutionPlan } from '../studio/CatalogRouterExecutionProfile';

export class CatalogReadDeniedError extends Error {
  readonly code = 'CATALOG_READ_DENIED';
  constructor() { super('The pinned catalog read is not currently authorized'); }
}

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function scopeIds(value: unknown): number[] {
  if (!Array.isArray(value) || value.length > 50 || value.some((id) => !Number.isSafeInteger(id) || id < 1)) {
    throw new CatalogReadDeniedError();
  }
  return [...new Set(value as number[])].sort((a, b) => a - b);
}
function intersect(pinned: readonly number[], current: number[]): number[] {
  if (!pinned.length) return current;
  if (!current.length) return [...pinned];
  const allowed = pinned.filter((id) => current.includes(id));
  if (!allowed.length) throw new CatalogReadDeniedError();
  return allowed;
}

/** Read adapter for the isolated catalog profile; never registered in the production broker. */
export class StrictCatalogSearchTool implements IToolImplementation {
  readonly definition: ToolDefinitionV1 = {
    schemaVersion: 1, name: 'catalog.search', description: 'Read only the pinned, currently authorized catalog scope.',
    riskLevel: 'read', requiredRoles: ['agent'], parameters: { type: 'object' }, timeoutMs: catalogReadTimeoutMs,
    requiresApproval: false, requiresCasFencing: false, isEgressNetworkTool: false, idempotent: true,
  };
  constructor(private readonly uow: TenantScopedUoW, private readonly plan: CatalogRouterExecutionPlan) {}

  validateInput(input: Record<string, unknown>) {
    const valid = Object.keys(input).every((key) => key === 'q' || key === 'limit') &&
      typeof input.q === 'string' && Boolean(input.q.trim()) && input.q.length <= 200 &&
      !/[\u0000\uD800-\uDFFF]/u.test(input.q) && Number.isSafeInteger(input.limit) &&
      Number(input.limit) >= 1 && Number(input.limit) <= this.plan.catalog.maxResults;
    return { valid, ...(valid ? {} : { errors: ['A bounded query and result limit are required'] }) };
  }

  async assertAuthorized(tenantId: number, client?: Queryable): Promise<string> {
    return this.uow.run(tenantId, async (db) => (await this.authorize(db, tenantId)).authorizationHash,
      client ? { client, activeTenantId: tenantId } : undefined);
  }

  async assertSnapshotAuthorized(tenantId: number, snapshot: Record<string, unknown>, client?: Queryable): Promise<void> {
    await this.uow.run(tenantId, async (db) => {
      const { context, authorizationHash } = await this.authorize(db, tenantId);
      if (snapshot.authorizationHash !== authorizationHash || !Array.isArray(snapshot.items) ||
          snapshot.items.length > this.plan.catalog.maxResults || snapshot.outputHash !== digest({ items: snapshot.items })) {
        throw new CatalogReadDeniedError();
      }
      const current = await catalogSnapshotEligibility(db, tenantId, context.catalogScope,
        snapshot.items as Parameters<typeof catalogSnapshotEligibility>[3]);
      if (current !== snapshot.eligibilityHash) throw new CatalogReadDeniedError();
    }, client ? { client, activeTenantId: tenantId } : undefined);
  }

  async execute(input: Record<string, unknown>, caller: ToolExecutionContext) {
    return this.uow.run(caller.tenantId, (db) => this.executeInTransaction(db, input, caller));
  }

  /** The checkpoint and SELECT share a tenant transaction; this adapter performs no external effects. */
  async executeInTransaction(db: Queryable, input: Record<string, unknown>, caller: ToolExecutionContext) {
    if (!this.validateInput(input).valid || caller.agentGraphId !== this.plan.graphId ||
        !caller.actorRoles.includes('agent')) throw new CatalogReadDeniedError();
    await db.query("SET LOCAL statement_timeout = '1000ms'");
    const { context, authorizationHash } = await this.authorize(db, caller.tenantId);
    const service = new CommercialCatalogToolService(new ProductRepositoryPg(db));
    const result = await service.search(context, { q: String(input.q), limit: Number(input.limit) });
    if (result.status !== 'ok') throw new CatalogReadDeniedError();
    const source = result.output as { items?: unknown[] } | null;
    if (!Array.isArray(source?.items) || source.items.length > this.plan.catalog.maxResults) throw new CatalogReadDeniedError();
    const items = source.items.map((value) => {
      const item = value as Record<string, unknown> | null;
      if (!item || !Number.isSafeInteger(item.id) || Number(item.id) < 1 || typeof item.name !== 'string' ||
          !item.name.trim() || item.name.length > 160 || typeof item.currency !== 'string' || !/^[A-Z]{3}$/.test(item.currency) ||
          (item.price !== null && (typeof item.price !== 'number' || !Number.isFinite(item.price) || item.price < 0)) ||
          !['fixed', 'from', 'free', 'consult'].includes(String(item.priceMode))) throw new CatalogReadDeniedError();
      // Do not expose unrelated catalog membership, internal sales notes or image URLs.
      return { id: Number(item.id), name: item.name, price: item.price, priceMode: String(item.priceMode), currency: item.currency };
    });
    const output = { items };
    if (JSON.stringify(output).length > 2048) throw new CatalogReadDeniedError();
    const eligibilityHash = await catalogSnapshotEligibility(db, caller.tenantId, context.catalogScope, items);
    return { ...output, authorizationHash, eligibilityHash, outputHash: digest(output), inputHash: digest(input) };
  }

  private async authorize(db: Queryable, tenantId: number) {
    if (String(tenantId) !== this.plan.tenantId) throw new CatalogReadDeniedError();
    await db.query("SET LOCAL statement_timeout = '1000ms'");
    await db.query("SET LOCAL lock_timeout = '1000ms'");
    await new TenantAiDispatchPolicy(this.uow).assertStrict(db, tenantId);
    const { rows: [grant] } = await db.query(`SELECT xmin::text AS revision, is_enabled, required_roles, limits_override FROM agent_tool_grants
      WHERE tenant_id = $1 AND agent_graph_id = $2 AND tool_name = 'catalog.search' FOR SHARE`, [tenantId, this.plan.graphId]);
    if (!grant?.is_enabled || !grant.limits_override || Object.keys(grant.limits_override).length || (grant.required_roles?.length &&
        !grant.required_roles.some((role: string) => role.toLowerCase() === 'agent'))) throw new CatalogReadDeniedError();
    const { rows: [settings] } = await db.query('SELECT xmin::text AS revision, automator_mode FROM company_settings WHERE company_id=$1 FOR SHARE', [tenantId]);
    const { rows: [agent] } = await db.query(`SELECT xmin::text AS revision, mode, status, module_access_json, tool_access_json, catalog_scope_json
      FROM ai_agents WHERE company_id=$1 AND id=$2 FOR SHARE`, [tenantId, this.plan.catalog.agentId]);
    if (!['mixed', 'automator'].includes(settings?.automator_mode) || agent?.status !== 'active' ||
        !['suggest', 'auto'].includes(agent?.mode) || agent.module_access_json?.catalog !== true ||
        agent.tool_access_json?.catalogSearch !== true) throw new CatalogReadDeniedError();
    const { rows: [policy] } = await db.query('SELECT xmin::text AS revision FROM tenant_ai_dispatch_policies WHERE tenant_id=$1 FOR SHARE', [tenantId]);
    const current = { catalogIds: scopeIds(agent.catalog_scope_json?.catalogIds),
      sectionIds: scopeIds(agent.catalog_scope_json?.sectionIds) };
    if (!current.catalogIds.length && !current.sectionIds.length) throw new CatalogReadDeniedError();
    const scope = { catalogIds: intersect(this.plan.catalog.catalogScope.catalogIds, current.catalogIds),
      sectionIds: intersect(this.plan.catalog.catalogScope.sectionIds, current.sectionIds) };
    const context: AgentToolContext = {
      companyId: tenantId, conversationId: null, chatId: null, agentId: this.plan.catalog.agentId,
      agentPurpose: 'support', companyMode: settings.automator_mode, agentMode: agent.mode,
      moduleAccess: { catalog: true }, toolAccess: { catalogSearch: true }, catalogScope: scope,
      inboundProviderMessageId: null, actorUserId: null,
    };
    return { context, authorizationHash: digest([tenantId, this.plan.graphId, this.plan.version,
      this.plan.specHash, this.plan.catalog.agentId, agent.mode, settings.automator_mode, scope, grant.required_roles,
      grant.revision, agent.revision, settings.revision, policy.revision]) };
  }
}
