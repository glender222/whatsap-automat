import type { AgentGraphVersionV1 } from '@whatsap-automat/contracts';
import { boundedTextBudget, boundedTextCapability, isBoundedText } from '../gateway/BoundedTextCompletion';
import { validateDraft } from './AgentStudioDrafts';

export const catalogRouterExecutionProfile = 'catalog-router-v1' as const;
export const catalogReadTimeoutMs = 1000;

export type CatalogRouterModelConfig = {
  readonly provider: typeof boundedTextCapability.provider;
  readonly model: typeof boundedTextCapability.model;
  readonly prompt: string;
  readonly maxTokens: number;
  readonly timeoutMs: number;
};

export type CatalogRouterToolConfig = {
  readonly toolName: 'catalog.search';
  readonly schemaVersion: 1;
  readonly agentId: number;
  readonly catalogScope: { readonly catalogIds: readonly number[]; readonly sectionIds: readonly number[] };
  readonly maxResults: number;
};

export type CatalogRouterExecutionPlan = {
  readonly profile: typeof catalogRouterExecutionProfile;
  readonly tenantId: string;
  readonly graphId: string;
  readonly version: number;
  readonly specHash: string;
  readonly policyRef: string;
  readonly limits: AgentGraphVersionV1['limits'];
  readonly router: CatalogRouterModelConfig & { readonly nodeId: string; readonly profile: typeof catalogRouterExecutionProfile };
  readonly answer: CatalogRouterModelConfig & { readonly nodeId: string };
  readonly catalog: CatalogRouterToolConfig & { readonly nodeId: string };
  readonly maxTokens: number;
  readonly maxCostMicroUsd: number;
};

export type CatalogRouterCompilation =
  | { readonly compatible: true; readonly plan: CatalogRouterExecutionPlan }
  | { readonly compatible: false; readonly issues: ReturnType<typeof validateDraft>['issues'] };

export type CatalogRoute =
  | { readonly route: 'catalog'; readonly query: string; readonly limit: number }
  | { readonly route: 'reply' };

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function integerBetween(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

function parseModelConfig(value: Record<string, unknown>, router: boolean): CatalogRouterModelConfig | null {
  const keys = ['provider', 'model', 'prompt', 'maxTokens', 'timeoutMs'];
  if (router) keys.push('profile');
  if (!hasExactKeys(value, keys) || (router && value.profile !== catalogRouterExecutionProfile) ||
      value.provider !== boundedTextCapability.provider || value.model !== boundedTextCapability.model ||
      !isBoundedText(value.prompt) || value.prompt.length > 3000 ||
      !integerBetween(value.maxTokens, 1, router ? 256 : 1024) ||
      !integerBetween(value.timeoutMs, 1, boundedTextCapability.maxTimeoutMs)) return null;
  return {
    provider: value.provider, model: value.model, prompt: value.prompt,
    maxTokens: value.maxTokens, timeoutMs: value.timeoutMs,
  };
}

function validScopeIds(value: unknown): value is number[] {
  return Array.isArray(value) && value.length <= 50 &&
    value.every((id) => integerBetween(id, 1, Number.MAX_SAFE_INTEGER)) && new Set(value).size === value.length;
}

function parseToolConfig(value: Record<string, unknown>): CatalogRouterToolConfig | null {
  if (!hasExactKeys(value, ['toolName', 'schemaVersion', 'agentId', 'catalogScope', 'maxResults']) ||
      value.toolName !== 'catalog.search' || value.schemaVersion !== 1 ||
      !integerBetween(value.agentId, 1, Number.MAX_SAFE_INTEGER) || !integerBetween(value.maxResults, 1, 3) ||
      !hasExactKeys(value.catalogScope, ['catalogIds', 'sectionIds'])) return null;
  const { catalogIds, sectionIds } = value.catalogScope;
  if (!validScopeIds(catalogIds) || !validScopeIds(sectionIds) || !catalogIds.length && !sectionIds.length) return null;
  return {
    toolName: 'catalog.search', schemaVersion: 1, agentId: value.agentId,
    catalogScope: { catalogIds: [...catalogIds], sectionIds: [...sectionIds] }, maxResults: value.maxResults,
  };
}

function incompatible(code: string, message: string, nodeId?: string): CatalogRouterCompilation {
  return { compatible: false, issues: [{ severity: 'error', code, message, nodeId }] };
}

/** An opt-in compiler only; compilation does not grant access to the configured agent or catalog. */
export function compileCatalogRouterExecutionProfile(graph: AgentGraphVersionV1): CatalogRouterCompilation {
  const structure = validateDraft(graph);
  if (!structure.valid) return { compatible: false, issues: structure.issues };

  const router = graph.nodes.find((node) => node.id === graph.entryNodeId);
  const tool = graph.nodes.find((node) => node.kind === 'tool');
  const answer = graph.nodes.find((node) => node.kind === 'agent');
  const end = graph.nodes.find((node) => node.kind === 'end');
  if (graph.nodes.length !== 4 || graph.edges.length !== 4 || router?.kind !== 'router' || !tool || !answer || !end) {
    return incompatible('PROFILE_TOPOLOGY', 'The profile requires one entry router, one catalog tool, one answer agent and one end node.');
  }
  const expectedEdges = [
    { from: router.id, to: tool.id, condition: 'catalog' },
    { from: router.id, to: answer.id, condition: 'reply' },
    { from: tool.id, to: answer.id, condition: undefined },
    { from: answer.id, to: end.id, condition: undefined },
  ];
  if (graph.edges.some((edge) => edge.priority !== undefined) || expectedEdges.some((expected) =>
    graph.edges.filter((edge) => edge.from === expected.from && edge.to === expected.to && edge.condition === expected.condition).length !== 1)) {
    return incompatible('PROFILE_TOPOLOGY', 'Only catalog/reply router branches, catalog-to-answer and answer-to-end edges are supported, without priorities.');
  }

  const routerConfig = parseModelConfig(router.config, true);
  if (!routerConfig) return incompatible('PROFILE_ROUTER_CONFIG', 'Set the catalog router profile, exact bounded model capability, prompt up to 3000 characters, maxTokens 1..256 and timeoutMs 1..30000.', router.id);
  const answerConfig = parseModelConfig(answer.config, false);
  if (!answerConfig) return incompatible('PROFILE_AGENT_CONFIG', 'Set the exact bounded model capability, prompt up to 3000 characters, maxTokens 1..1024 and timeoutMs 1..30000.', answer.id);
  const toolConfig = parseToolConfig(tool.config);
  if (!toolConfig) return incompatible('PROFILE_TOOL_CONFIG', 'Set catalog.search schemaVersion 1, a positive agentId, an explicit nonempty scope of up to 50 unique IDs per list and maxResults 1..3.', tool.id);
  if (!hasExactKeys(end.config, [])) return incompatible('PROFILE_END_CONFIG', 'The end node accepts an empty configuration only.', end.id);

  const routerBudget = boundedTextBudget(routerConfig.maxTokens, routerConfig.timeoutMs)!;
  const answerBudget = boundedTextBudget(answerConfig.maxTokens, answerConfig.timeoutMs)!;
  const maxTokens = routerBudget.maxTokens + answerBudget.maxTokens;
  const maxCostMicroUsd = routerBudget.maxCostMicroUsd + answerBudget.maxCostMicroUsd;
  const { limits } = graph;
  if (limits.maxSteps !== 4 || limits.maxDelegations !== 0 || limits.maxParallelNodes !== 1 ||
      !integerBetween(limits.maxDurationSeconds, 1, 60) ||
      limits.maxDurationSeconds * 1000 < routerConfig.timeoutMs + answerConfig.timeoutMs + catalogReadTimeoutMs ||
      !integerBetween(limits.maxModelTokens, maxTokens, Number.MAX_SAFE_INTEGER) ||
      !integerBetween(limits.maxCostMicroUsd, maxCostMicroUsd, Number.MAX_SAFE_INTEGER)) {
    return incompatible('PROFILE_LIMITS', 'Allow exactly four steps, zero delegations, one parallel node, both bounded model budgets and their timeouts plus 1000ms within 60 seconds.');
  }

  return {
    compatible: true,
    plan: {
      profile: catalogRouterExecutionProfile, tenantId: graph.tenantId, graphId: graph.graphId,
      version: graph.version, specHash: graph.specHash, policyRef: graph.policyRef, limits: { ...limits },
      router: { nodeId: router.id, profile: catalogRouterExecutionProfile, ...routerConfig },
      answer: { nodeId: answer.id, ...answerConfig }, catalog: { nodeId: tool.id, ...toolConfig },
      maxTokens, maxCostMicroUsd,
    },
  };
}

/** Accept exactly one bounded decision, never tool names, scope overrides or chained calls. */
export function parseCatalogRoute(text: string, maxResults: number): CatalogRoute | null {
  if (!isBoundedText(text) || !integerBetween(maxResults, 1, 3)) return null;
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  if (hasExactKeys(value, ['route']) && value.route === 'reply') return { route: 'reply' };
  if (!hasExactKeys(value, ['route', 'query', 'limit']) || value.route !== 'catalog' ||
      !isBoundedText(value.query) || value.query.length > 200 || !integerBetween(value.limit, 1, maxResults)) return null;
  return { route: 'catalog', query: value.query, limit: value.limit };
}
