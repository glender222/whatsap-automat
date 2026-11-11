import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeAgentSpecHash, type AgentGraphVersionV1 } from '@whatsap-automat/contracts';
import { boundedTextBudget, boundedTextCapability } from '../services/ai/gateway/BoundedTextCompletion';
import { compileAgentExecutionProfile } from '../services/ai/studio/AgentExecutionProfile';
import {
  catalogRouterExecutionProfile, compileCatalogRouterExecutionProfile, parseCatalogRoute,
} from '../services/ai/studio/CatalogRouterExecutionProfile';

const router = {
  profile: 'catalog-router-v1', provider: boundedTextCapability.provider,
  model: boundedTextCapability.model, prompt: 'Choose catalog or reply.', maxTokens: 128, timeoutMs: 10_000,
};
const answer = {
  provider: boundedTextCapability.provider, model: boundedTextCapability.model,
  prompt: 'Answer using the supplied catalog evidence.', maxTokens: 512, timeoutMs: 20_000,
};
const catalog = {
  toolName: 'catalog.search', schemaVersion: 1, agentId: 17,
  catalogScope: { catalogIds: [2], sectionIds: [4] }, maxResults: 3,
};
const routerBudget = boundedTextBudget(router.maxTokens, router.timeoutMs)!;
const answerBudget = boundedTextBudget(answer.maxTokens, answer.timeoutMs)!;

function fixture(overrides: Partial<AgentGraphVersionV1> = {}): AgentGraphVersionV1 {
  const graph: AgentGraphVersionV1 = {
    schemaVersion: 1, tenantId: '71', graphId: 'catalog-fixture', version: 3, status: 'draft',
    specHash: '', policyRef: 'strict-catalog-fixture', entryNodeId: 'choose',
    nodes: [
      { id: 'choose', kind: 'router', config: structuredClone(router) },
      { id: 'lookup', kind: 'tool', config: structuredClone(catalog) },
      { id: 'answer', kind: 'agent', config: structuredClone(answer) },
      { id: 'done', kind: 'end', config: {} },
    ],
    edges: [
      { id: 'lookup-route', from: 'choose', to: 'lookup', condition: 'catalog' },
      { id: 'reply-route', from: 'choose', to: 'answer', condition: 'reply' },
      { id: 'evidence', from: 'lookup', to: 'answer' },
      { id: 'finish', from: 'answer', to: 'done' },
    ],
    limits: {
      maxSteps: 4, maxDelegations: 0, maxParallelNodes: 1, maxDurationSeconds: 31,
      maxModelTokens: routerBudget.maxTokens + answerBudget.maxTokens,
      maxCostMicroUsd: routerBudget.maxCostMicroUsd + answerBudget.maxCostMicroUsd,
    },
    ...overrides,
  };
  return { ...graph, specHash: overrides.specHash ?? computeAgentSpecHash(graph) };
}

test('the explicit catalog router profile compiles a bounded four-node plan', () => {
  const graph = fixture();
  const result = compileCatalogRouterExecutionProfile(graph);
  assert.equal(result.compatible, true);
  if (!result.compatible) return;
  assert.deepEqual(result.plan, {
    profile: catalogRouterExecutionProfile, tenantId: graph.tenantId, graphId: graph.graphId,
    version: graph.version, specHash: graph.specHash, policyRef: graph.policyRef, limits: graph.limits,
    router: { nodeId: 'choose', ...router }, answer: { nodeId: 'answer', ...answer },
    catalog: { nodeId: 'lookup', ...catalog },
    maxTokens: routerBudget.maxTokens + answerBudget.maxTokens,
    maxCostMicroUsd: routerBudget.maxCostMicroUsd + answerBudget.maxCostMicroUsd,
  });
  assert.notEqual(result.plan.limits, graph.limits);
  assert.notEqual(result.plan.catalog.catalogScope, graph.nodes[1].config.catalogScope);
});

function withConfig(nodeId: string, patch: Record<string, unknown>): AgentGraphVersionV1 {
  return fixture({ nodes: fixture().nodes.map((node) => node.id === nodeId ? { ...node, config: { ...node.config, ...patch } } : node) });
}

function rejected(graph: AgentGraphVersionV1, code: string, reason: string): void {
  const result = compileCatalogRouterExecutionProfile(graph);
  assert.equal(result.compatible, false, reason);
  if (!result.compatible) assert.ok(result.issues.some((issue) => issue.code === code), `${reason}: ${JSON.stringify(result.issues)}`);
}

test('the new compiler never expands the linear execution profile', () => {
  const linear = fixture({
    entryNodeId: 'answer',
    nodes: [
      { id: 'answer', kind: 'agent', config: { provider: answer.provider, model: answer.model, prompt: answer.prompt, maxTokens: answer.maxTokens } },
      { id: 'done', kind: 'end', config: {} },
    ],
    edges: [{ id: 'finish', from: 'answer', to: 'done' }],
  });
  assert.equal(compileAgentExecutionProfile(linear).compatible, true);
  rejected(linear, 'PROFILE_TOPOLOGY', 'linear is not implicitly a catalog plan');
  assert.equal(compileAgentExecutionProfile(fixture()).compatible, false);
  rejected(withConfig('choose', { profile: 'linear-text-v1' }), 'PROFILE_ROUTER_CONFIG', 'explicit opt-in required');
});

test('structural validation and exact routing reject changed hashes, cycles and extra paths', () => {
  rejected(fixture({ specHash: 'changed' }), 'SPEC_HASH_MISMATCH', 'hash is verified');
  rejected(fixture({ entryNodeId: 'missing' }), 'MISSING_ENTRY', 'entry must exist');
  rejected(fixture({ nodes: [...fixture().nodes, fixture().nodes[0]] }), 'DUPLICATE_NODE', 'node IDs are unique');
  rejected(fixture({ edges: [...fixture().edges, { id: 'loop', from: 'answer', to: 'choose' }] }), 'GRAPH_CYCLE', 'cycles cannot dispatch');
  rejected(fixture({ edges: fixture().edges.map((edge) => edge.id === 'reply-route' ? { ...edge, id: 'lookup-route' } : edge) }), 'DUPLICATE_EDGE', 'edge IDs are unique');
  for (const [label, patch] of [
    ['arbitrary branch', { condition: 'sales' }],
    ['unconditional router branch', { condition: undefined }],
    ['priority', { priority: 0 }],
  ] as const) {
    rejected(fixture({ edges: fixture().edges.map((edge, index) => index === 0 ? { ...edge, ...patch } : edge) }), 'PROFILE_TOPOLOGY', label);
  }
  rejected(fixture({ edges: fixture().edges.map((edge) => edge.id === 'evidence' ? { ...edge, condition: 'true' } : edge) }), 'PROFILE_TOPOLOGY', 'tool must flow unconditionally to answer');
  rejected(fixture({ edges: [...fixture().edges, { id: 'bypass-answer', from: 'lookup', to: 'done' }] }), 'PROFILE_TOPOLOGY', 'no extra edge');
  rejected(withConfig('done', { send: true }), 'PROFILE_END_CONFIG', 'end cannot send');
  assert.equal(compileCatalogRouterExecutionProfile(fixture({ nodes: [...fixture().nodes].reverse(), edges: [...fixture().edges].reverse() })).compatible, true);
});

test('model configs require the exact capability and independently bounded prompts, tokens and timeouts', () => {
  for (const node of ['choose', 'answer']) {
    const code = node === 'choose' ? 'PROFILE_ROUTER_CONFIG' : 'PROFILE_AGENT_CONFIG';
    const maxTokens = node === 'choose' ? 256 : 1024;
    for (const patch of [
      { provider: 'opencode' }, { model: 'gpt-4o-mini' }, { prompt: '' }, { prompt: '  ' },
      { prompt: 'a'.repeat(3001) }, { prompt: 'nul\u0000' }, { prompt: 'invalid\uD800' },
      { maxTokens: 0 }, { maxTokens: 1.5 }, { maxTokens: maxTokens + 1 },
      { timeoutMs: 0 }, { timeoutMs: 1.5 }, { timeoutMs: 30_001 }, { timeoutMs: '1000' },
      { tools: ['catalog.search'] }, { tenantId: '72' }, { temperature: 0 },
    ]) rejected(withConfig(node, patch), code, `${node}: ${Object.keys(patch)[0]}=${String(Object.values(patch)[0]).slice(0, 30)}`);
    rejected(fixture({ nodes: fixture().nodes.map((item) => item.id === node ? {
      ...item, config: Object.fromEntries(Object.entries(item.config).filter(([key]) => key !== 'timeoutMs')),
    } : item) }), code, 'timeout is explicit');
  }
  rejected(withConfig('answer', { profile: 'catalog-router-v1' }), 'PROFILE_AGENT_CONFIG', 'answer does not choose a profile');
  const boundary = fixture({ nodes: fixture().nodes.map((node) => ['choose', 'answer'].includes(node.id) ? {
    ...node, config: { ...node.config, prompt: 'x'.repeat(3000), maxTokens: node.id === 'choose' ? 256 : 1024, timeoutMs: 1 },
  } : node), limits: { ...fixture().limits, maxDurationSeconds: 2, maxModelTokens: 801_280, maxCostMicroUsd: 605_760 } });
  assert.equal(compileCatalogRouterExecutionProfile(boundary).compatible, true);
});

test('catalog config allows only scoped catalog.search with bounded unique IDs and result count', () => {
  for (const patch of [
    { toolName: 'availability.check' }, { toolName: 'handoff.create' }, { schemaVersion: 2 },
    { agentId: 0 }, { agentId: -1 }, { agentId: 1.5 }, { agentId: Number.MAX_SAFE_INTEGER + 1 },
    { maxResults: 0 }, { maxResults: 4 }, { maxResults: 1.5 },
    { moduleAccess: { catalog: true } }, { toolAccess: { messageSendProductCard: true } }, { tenantId: '72' },
    { catalogScope: {} }, { catalogScope: { catalogIds: [], sectionIds: [] } },
    { catalogScope: { catalogIds: [2, 2], sectionIds: [] } },
    { catalogScope: { catalogIds: [], sectionIds: [4, 4] } },
    { catalogScope: { catalogIds: [0], sectionIds: [] } },
    { catalogScope: { catalogIds: ['2'], sectionIds: [] } },
    { catalogScope: { catalogIds: [], sectionIds: [1.2] } },
    { catalogScope: { catalogIds: Array.from({ length: 51 }, (_, index) => index + 1), sectionIds: [] } },
    { catalogScope: { catalogIds: [], sectionIds: Array.from({ length: 51 }, (_, index) => index + 1) } },
    { catalogScope: { catalogIds: [2], sectionIds: [], all: true } },
  ]) rejected(withConfig('lookup', patch), 'PROFILE_TOOL_CONFIG', JSON.stringify(patch));
  for (const catalogScope of [
    { catalogIds: [2], sectionIds: [] }, { catalogIds: [], sectionIds: [4] },
    { catalogIds: Array.from({ length: 50 }, (_, index) => index + 1), sectionIds: [4] },
  ]) assert.equal(compileCatalogRouterExecutionProfile(withConfig('lookup', { catalogScope })).compatible, true);
});

test('the graph reserves both complete model budgets and bounded execution time', () => {
  const limits = fixture().limits;
  for (const patch of [
    { maxSteps: 3 }, { maxSteps: 5 }, { maxDelegations: 1 }, { maxParallelNodes: 2 },
    { maxDurationSeconds: 30 }, { maxDurationSeconds: 61 }, { maxDurationSeconds: 31.5 },
    { maxModelTokens: limits.maxModelTokens - 1 }, { maxCostMicroUsd: limits.maxCostMicroUsd - 1 },
    { maxModelTokens: routerBudget.maxTokens }, { maxCostMicroUsd: answerBudget.maxCostMicroUsd },
    { maxModelTokens: Number.MAX_SAFE_INTEGER + 1 }, { maxCostMicroUsd: Number.NaN },
  ]) rejected(fixture({ limits: { ...limits, ...patch } }), 'PROFILE_LIMITS', JSON.stringify(patch));
  assert.equal(compileCatalogRouterExecutionProfile(fixture({ limits: { ...limits, maxDurationSeconds: 60 } })).compatible, true);
  const bothMaximumTimeouts = fixture({
    nodes: fixture().nodes.map((node) => ['choose', 'answer'].includes(node.id) ? { ...node, config: { ...node.config, timeoutMs: 30_000 } } : node),
    limits: { ...limits, maxDurationSeconds: 60 },
  });
  rejected(bothMaximumTimeouts, 'PROFILE_LIMITS', '60 seconds leaves no catalog allowance for two 30-second calls');
});

test('router output accepts exactly one reply or bounded catalog decision', () => {
  assert.deepEqual(parseCatalogRoute('{"route":"reply"}', 3), { route: 'reply' });
  const request = { route: 'catalog', query: 'red mug', limit: 2 };
  assert.deepEqual(parseCatalogRoute(JSON.stringify(request), 2), request);
  assert.deepEqual(parseCatalogRoute(JSON.stringify({ ...request, query: 'q'.repeat(200), limit: 1 }), 1), { ...request, query: 'q'.repeat(200), limit: 1 });
  for (const value of [
    null, [], [{ route: 'reply' }], 'reply', { route: 'other' },
    { route: 'reply', query: 'mug' }, { route: 'reply', tool_calls: [] },
    { ...request, toolName: 'catalog.search' }, { ...request, tenantId: '72' },
    { ...request, catalogScope: { catalogIds: [999] } }, { ...request, calls: [{ toolName: 'order.upsertPreorder' }] },
    { route: 'catalog', query: 'mug' }, { ...request, limit: 0 }, { ...request, limit: 3 },
    { ...request, limit: 1.5 }, { ...request, limit: '1' }, { ...request, query: '' },
    { ...request, query: '  ' }, { ...request, query: 'q'.repeat(201) },
    { ...request, query: 'nul\u0000' }, { ...request, query: 'invalid\uD800' }, { ...request, actorId: 2 },
  ]) assert.equal(parseCatalogRoute(JSON.stringify(value), 2), null, JSON.stringify(value));
  for (const text of [
    'not JSON', '```json\n{"route":"reply"}\n```', '{"route":"reply"}{"route":"reply"}',
    '{"route":"reply","__proto__":{"tenantId":72}}', '{"route":"reply"}' + ' '.repeat(4096),
  ]) {
    assert.equal(parseCatalogRoute(text, 3), null);
  }
  for (const limit of [0, 4, 1.5, Number.NaN]) assert.equal(parseCatalogRoute('{"route":"reply"}', limit), null);
});
