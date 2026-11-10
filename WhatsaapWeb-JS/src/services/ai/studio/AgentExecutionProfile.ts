import {
  modelGatewayRequestSchema,
  modelMessageV1Schema,
  type AgentGraphVersionV1,
  type ModelProvider,
} from '@whatsap-automat/contracts';
import { validateDraft } from './AgentStudioDrafts';

export const executionProfile = 'linear-text-v1' as const;

const gateway = modelGatewayRequestSchema.shape;
const agentConfig = modelGatewayRequestSchema.pick({ provider: true, model: true, maxTokens: true }).extend({
  model: gateway.model.max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/),
  maxTokens: gateway.maxTokens.unwrap().max(4096),
  prompt: modelMessageV1Schema.shape.content.max(4096)
    .refine((value) => Boolean(value.trim()) && !/[\u0000\uD800-\uDFFF]/u.test(value)),
}).strict();

type Issue = ReturnType<typeof validateDraft>['issues'][number];

type ExecutionPlan = {
  readonly profile: typeof executionProfile;
  readonly tenantId: string;
  readonly graphId: string;
  readonly version: number;
  readonly specHash: string;
  readonly policyRef: string;
  readonly limits: AgentGraphVersionV1['limits'];
  readonly nodeOrder: readonly [string, string];
  readonly completion: { readonly provider: ModelProvider; readonly model: string; readonly prompt: string; readonly maxTokens: number };
};

type Compilation = { readonly compatible: true; readonly plan: ExecutionPlan } |
  { readonly compatible: false; readonly issues: Issue[] };

function incompatible(code: string, message: string, nodeId?: string): Compilation {
  return { compatible: false, issues: [{ severity: 'error', code, message, nodeId }] };
}

export function compileAgentExecutionProfile(graph: AgentGraphVersionV1): Compilation {
  const structure = validateDraft(graph);
  if (!structure.valid) return { compatible: false, issues: structure.issues };

  const entry = graph.nodes.find((node) => node.id === graph.entryNodeId);
  const end = graph.nodes.find((node) => node.kind === 'end');
  const [edge] = graph.edges;
  if (graph.nodes.length !== 2 || graph.edges.length !== 1 || entry?.kind !== 'agent' || !end ||
      edge.from !== entry.id || edge.to !== end.id || edge.condition !== undefined || edge.priority !== undefined) {
    return incompatible('PROFILE_TOPOLOGY', 'The profile requires one agent node connected directly to an end node by an unconditional edge.');
  }

  const config = agentConfig.safeParse(entry.config);
  if (!config.success) {
    return incompatible('PROFILE_AGENT_CONFIG',
      'Set a supported provider, a model identifier, a nonblank prompt of up to 4096 characters, and maxTokens between 1 and 4096.', entry.id);
  }
  if (Object.keys(end.config).length) {
    return incompatible('PROFILE_END_CONFIG', 'The end node accepts an empty configuration only.', end.id);
  }
  if (graph.limits.maxSteps < 2 || config.data.maxTokens > graph.limits.maxModelTokens) {
    return incompatible('PROFILE_LIMITS', 'The graph must allow two steps and at least maxTokens model tokens.', entry.id);
  }

  return {
    compatible: true,
    plan: {
      profile: executionProfile,
      tenantId: graph.tenantId, graphId: graph.graphId, version: graph.version, specHash: graph.specHash,
      policyRef: graph.policyRef, limits: { ...graph.limits }, nodeOrder: [entry.id, end.id],
      completion: config.data,
    },
  };
}
