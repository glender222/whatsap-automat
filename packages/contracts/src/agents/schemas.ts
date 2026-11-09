import { z } from 'zod';
import { GRAPH_STATUSES, NODE_KINDS } from './graph';
import { AGENT_RUN_STATES } from './runs';

export const nodeKindSchema = z.enum(NODE_KINDS);
export const graphStatusSchema = z.enum(GRAPH_STATUSES);
export const agentRunStateSchema = z.enum(AGENT_RUN_STATES);

export const graphNodeDefinitionSchema = z.object({
  id: z.string().min(1),
  kind: nodeKindSchema,
  config: z.record(z.string(), z.unknown()),
});

export const graphEdgeDefinitionSchema = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  condition: z.string().optional(),
  priority: z.number().int().optional(),
});

export const graphExecutionLimitsSchema = z.object({
  maxSteps: z.number().int().positive(),
  maxDelegations: z.number().int().nonnegative(),
  maxParallelNodes: z.number().int().positive(),
  maxDurationSeconds: z.number().int().positive(),
  maxModelTokens: z.number().int().positive(),
  maxCostMicroUsd: z.number().int().positive(),
});

export const agentGraphVersionV1Schema = z.object({
  schemaVersion: z.literal(1),
  graphId: z.string().min(1),
  version: z.number().int().positive(),
  tenantId: z.string().min(1),
  entryNodeId: z.string().min(1),
  nodes: z.array(graphNodeDefinitionSchema).min(1),
  edges: z.array(graphEdgeDefinitionSchema),
  policyRef: z.string().min(1),
  limits: graphExecutionLimitsSchema,
  status: graphStatusSchema,
  specHash: z.string().min(1),
});

export const toolInvocationV1Schema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  agentRunId: z.string().min(1),
  graphVersion: z.number().int().positive(),
  toolName: z.string().min(1),
  schemaVersion: z.number().int().positive(),
  input: z.record(z.string(), z.unknown()),
  effectKey: z.string().min(1),
  expectedConversationVersion: z.number().int().nonnegative(),
  requestedByNodeId: z.string().min(1),
});

export const agentTimelineStepSchema = z.object({
  timestamp: z.string().datetime(),
  step: z.number().int().positive(),
  nodeId: z.string().min(1),
  event: z.string().min(1),
  detailsRedacted: z.record(z.string(), z.unknown()).optional(),
});

export const agentRunTraceV1Schema = z.object({
  runId: z.string().min(1),
  tenantId: z.string().min(1),
  graphId: z.string().min(1),
  graphVersion: z.number().int().positive(),
  state: agentRunStateSchema,
  timeline: z.array(agentTimelineStepSchema),
  totalSteps: z.number().int().nonnegative(),
  totalTokensUsed: z.number().int().nonnegative().optional(),
  totalCostMicroUsd: z.number().int().nonnegative().optional(),
});

export const agentSimulationRequestV1Schema = z.object({
  graphId: z.string().min(1),
  graphVersion: z.number().int().positive().optional(),
  mockInput: z.string().min(1),
  mockConversationState: z.record(z.string(), z.unknown()).optional(),
});

export const agentSimulationResultV1Schema = z.object({
  executedNodes: z.array(
    z.object({
      nodeId: z.string().min(1),
      kind: z.string().min(1),
      output: z.record(z.string(), z.unknown()),
      durationMs: z.number().nonnegative(),
    })
  ),
  simulatedMessages: z.array(
    z.object({
      kind: z.string().min(1),
      text: z.string().optional(),
    })
  ),
  approvalsTriggered: z.array(
    z.object({
      nodeId: z.string().min(1),
      risk: z.string().min(1),
      action: z.string().min(1),
    })
  ),
  finalState: agentRunStateSchema,
  totalSteps: z.number().int().nonnegative(),
});
