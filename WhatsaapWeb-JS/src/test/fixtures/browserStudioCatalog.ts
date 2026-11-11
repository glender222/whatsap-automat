import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { tenantScopedUoW } from '../../db/TenantScopedUoW';
import { AgentRepositoryPg } from '../../modules/ai/infra/db/AgentRepositoryPg';
import { CatalogRepositoryPg } from '../../modules/inventory/infra/db/CatalogRepositoryPg';
import { ProductRepositoryPg } from '../../modules/inventory/infra/db/ProductRepositoryPg';
import { boundedTextBudget, boundedTextCapability } from '../../services/ai/gateway/BoundedTextCompletion';
import { saveDraft } from '../../services/ai/studio/AgentStudioDrafts';

const catalogRouterPrompt = 'Fixture browser catalog router';
const catalogAnswerPrompt = 'Fixture browser catalog answer';

export function fixtureCatalogReply(system: string, input: string) {
  if (system.endsWith(catalogRouterPrompt)) {
    return JSON.stringify(input.startsWith('Saludo') ? { route: 'reply' } : { route: 'catalog', query: 'Visible', limit: 3 });
  }
  if (system.endsWith(catalogAnswerPrompt)) {
    const { catalog } = JSON.parse(input);
    return catalog ? 'Producto de catálogo: ' + catalog.items[0]?.name : 'Saludo de prueba';
  }
}

export async function seedStudioCatalog(pool: Pool, companyId: number, actorId: number, name: string, graphId: string) {
  const agents = new AgentRepositoryPg(pool);
  await agents.setAutomatorMode(companyId, 'mixed');
  const catalog = await new CatalogRepositoryPg(pool).create(companyId, { name: `Catálogo QA ${name}`, status: 'active', aiEnabled: true });
  await new ProductRepositoryPg(pool).create(companyId, { name: `Visible ${name}`, status: 'active', aiEnabled: true,
    itemType: 'physical_product', price: 12, priceMode: 'fixed', currency: 'USD', catalogAssignments: [{ catalogId: catalog.id }],
    images: [{ imageUrl: '/uploads/commercial-items/catalog-fixture.png', isPrimary: true }] });
  const scope = { catalogIds: [catalog.id], sectionIds: [] };
  const agent = await agents.create(companyId, actorId, { name: `Agente de catálogo QA ${name}`, purpose: 'support', status: 'active',
    mode: 'suggest', moduleAccess: { catalog: true }, toolAccess: { catalogSearch: true }, catalogScope: scope });
  const timeoutMs = 1500;
  const maxTokens = 128;
  const budget = boundedTextBudget(maxTokens, timeoutMs)!;
  const model = { provider: 'openai', model: boundedTextCapability.model, maxTokens, timeoutMs };
  await tenantScopedUoW.run(companyId, async (db) => {
    await db.query(`INSERT INTO tenant_ai_quotas(tenant_id, monthly_token_limit, monthly_cost_limit_micro_usd)
      VALUES ($1, 20000000, 20000000) ON CONFLICT (tenant_id) DO NOTHING`, [companyId]);
    const draft = await saveDraft(db, companyId, actorId, graphId, {
      entryNodeId: 'route', policyRef: 'browser-studio-catalog', nodes: [
        { id: 'route', kind: 'router', config: { ...model, profile: 'catalog-router-v1', prompt: catalogRouterPrompt } },
        { id: 'lookup', kind: 'tool', config: { toolName: 'catalog.search', schemaVersion: 1, agentId: agent.id,
          catalogScope: scope, maxResults: 3 } },
        { id: 'answer', kind: 'agent', config: { ...model, prompt: catalogAnswerPrompt } },
        { id: 'end', kind: 'end', config: {} },
      ], edges: [
        { id: 'catalog', from: 'route', to: 'lookup', condition: 'catalog' },
        { id: 'reply', from: 'route', to: 'answer', condition: 'reply' },
        { id: 'found', from: 'lookup', to: 'answer' },
        { id: 'finish', from: 'answer', to: 'end' },
      ], limits: { maxSteps: 4, maxDelegations: 0, maxParallelNodes: 1, maxDurationSeconds: 20,
        maxModelTokens: budget.maxTokens * 4, maxCostMicroUsd: budget.maxCostMicroUsd * 4 },
    }, true);
    assert.ok(draft);
    await db.query(`INSERT INTO agent_tool_grants (tenant_id, agent_graph_id, tool_name, required_roles, is_enabled)
      VALUES ($1, $2, 'catalog.search', ARRAY['agent'], true)`, [companyId, graphId]);
  });
}
