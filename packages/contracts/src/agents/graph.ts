/**
 * Canonical Agent Graph definition contracts
 * Blueprint Section 5.3
 */

export const NODE_KINDS = [
  'agent',
  'router',
  'condition',
  'tool',
  'approval',
  'subgraph',
  'parallel',
  'join',
  'handoff',
  'end',
] as const;

export type NodeKind = (typeof NODE_KINDS)[number];

export const GRAPH_STATUSES = [
  'draft',
  'published',
  'retired',
] as const;

export type GraphStatus = (typeof GRAPH_STATUSES)[number];

export interface GraphNodeDefinitionV1 {
  readonly id: string;
  readonly kind: NodeKind;
  readonly config: Readonly<Record<string, unknown>>;
}

export interface GraphEdgeDefinitionV1 {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly condition?: string;
  readonly priority?: number;
}

export interface GraphExecutionLimitsV1 {
  readonly maxSteps: number;
  readonly maxDelegations: number;
  readonly maxParallelNodes: number;
  readonly maxDurationSeconds: number;
  readonly maxModelTokens: number;
  readonly maxCostMicroUsd: number;
}

export interface AgentGraphVersionV1 {
  readonly schemaVersion: 1;
  readonly graphId: string;
  readonly version: number;
  readonly tenantId: string;
  readonly entryNodeId: string;
  readonly nodes: readonly GraphNodeDefinitionV1[];
  readonly edges: readonly GraphEdgeDefinitionV1[];
  readonly policyRef: string;
  readonly limits: GraphExecutionLimitsV1;
  readonly status: GraphStatus;
  readonly specHash: string;
}
