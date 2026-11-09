import { z } from 'zod';
import {
  WORKFLOW_DEFINITION_STATUSES,
  WORKFLOW_REVISION_STATUSES,
  WORKFLOW_NODE_KINDS,
  WORKFLOW_TRIGGER_TYPES,
  WORKFLOW_RUN_STATUSES,
  AUTOMATION_STATUSES,
  AUTOMATION_TRIGGER_TYPES,
  EXECUTION_STATUSES,
} from './types';

// Enums
export const workflowDefinitionStatusSchema = z.enum(WORKFLOW_DEFINITION_STATUSES);
export const workflowRevisionStatusSchema = z.enum(WORKFLOW_REVISION_STATUSES);
export const workflowNodeKindSchema = z.enum(WORKFLOW_NODE_KINDS);
export const workflowTriggerTypeSchema = z.enum(WORKFLOW_TRIGGER_TYPES);
export const workflowRunStatusSchema = z.enum(WORKFLOW_RUN_STATUSES);

// Nodes & Edges
export const workflowNodePositionSchema = z.object({
  x: z.number(),
  y: z.number(),
});

export const workflowNodeDefinitionV1Schema = z.object({
  id: z.string().min(1),
  kind: workflowNodeKindSchema,
  label: z.string().optional(),
  config: z.record(z.string(), z.unknown()).default({}),
  position: workflowNodePositionSchema.optional(),
});

export const workflowEdgeDefinitionV1Schema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
  sourceHandle: z.string().optional(),
  targetHandle: z.string().optional(),
  label: z.string().optional(),
  condition: z.string().optional(),
});

// DAG Graph with topological validation
export const workflowDagGraphV1Schema = z
  .object({
    nodes: z.array(workflowNodeDefinitionV1Schema).min(1, 'At least one node is required in the DAG graph'),
    edges: z.array(workflowEdgeDefinitionV1Schema),
  })
  .refine(
    (data) => {
      const nodeIds = new Set(data.nodes.map((n) => n.id));
      return data.edges.every((e) => nodeIds.has(e.source) && nodeIds.has(e.target));
    },
    { message: 'All edge sources and targets must reference valid existing node IDs' }
  );

// Execution Limits
export const workflowExecutionLimitsV1Schema = z.object({
  maxDurationSeconds: z.number().int().positive().default(86400),
  maxStepCount: z.number().int().positive().default(100),
  timeoutSeconds: z.number().int().positive().default(3600),
  maxSteps: z.number().int().positive().optional(),
});

// Workflow Definition
export const workflowDefinitionV1Schema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  workspaceId: z.string().min(1).nullable().optional(),
  name: z.string().min(1).max(255),
  description: z.string().nullable().optional(),
  status: workflowDefinitionStatusSchema,
  publishedRevisionId: z.string().min(1).nullable().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

// Workflow Revision
export const workflowRevisionV1Schema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  workflowId: z.string().min(1),
  revisionNumber: z.number().int().positive(),
  status: workflowRevisionStatusSchema,
  dagGraph: workflowDagGraphV1Schema,
  specHash: z.string().regex(/^(sha256:)?[a-f0-9]{64}$/i, 'specHash must be a 64-character SHA-256 hexadecimal string'),
  limits: workflowExecutionLimitsV1Schema,
  publishedAt: z.string().datetime().nullable().optional(),
  createdAt: z.string().datetime(),
});

// Error Details
export const workflowErrorDetailsV1Schema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  nodeId: z.string().optional(),
  timestamp: z.string().datetime().optional(),
  retryable: z.boolean().optional(),
  stack: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});

// Workflow Run
export const workflowRunV1Schema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  workspaceId: z.string().min(1).nullable().optional(),
  workflowId: z.string().min(1),
  revisionId: z.string().min(1),
  temporalWorkflowId: z.string().min(1),
  temporalRunId: z.string().min(1).nullable().optional(),
  triggerType: workflowTriggerTypeSchema,
  status: workflowRunStatusSchema,
  correlationId: z.string().min(1),
  inputPayload: z.record(z.string(), z.unknown()).default({}),
  outputPayload: z.record(z.string(), z.unknown()).default({}),
  currentStep: z.string().nullable().optional(),
  stepCount: z.number().int().nonnegative().default(0),
  errorDetails: workflowErrorDetailsV1Schema.nullable().optional(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable().optional(),
});

// Commands
export const rollbackWorkflowCommandV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    tenantId: z.string().min(1),
    workflowId: z.string().min(1),
    targetRevisionNumber: z.number().int().positive().optional(),
    targetRevisionId: z.string().min(1).optional(),
    userId: z.string().min(1),
    reason: z.string().max(500).optional(),
  })
  .refine(
    (data) => data.targetRevisionNumber !== undefined || data.targetRevisionId !== undefined,
    { message: 'Must provide either targetRevisionNumber or targetRevisionId' }
  );

export const publishWorkflowRevisionCommandV1Schema = z.object({
  schemaVersion: z.literal(1),
  tenantId: z.string().min(1),
  workflowId: z.string().min(1),
  revisionId: z.string().min(1),
  userId: z.string().min(1),
  comment: z.string().max(500).optional(),
});

export const workflowTriggerV1Schema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  workflowId: z.string().min(1),
  type: z.enum(['webhook', 'schedule', 'event']),
  endpointKey: z.string().min(1).nullable().optional(),
  authTokenHash: z.string().nullable().optional(),
  cronExpression: z.string().nullable().optional(),
  isActive: z.boolean().default(true),
  metadata: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

// -----------------------------------------------------------------------------
// Legacy Backward-Compatibility Schemas
// -----------------------------------------------------------------------------
export const automationTriggerTypeSchema = z.enum(AUTOMATION_TRIGGER_TYPES);
export const automationStatusSchema = z.enum(AUTOMATION_STATUSES);
export const executionStatusSchema = z.enum(EXECUTION_STATUSES);

export const automationTriggerV1Schema = z.object({
  type: automationTriggerTypeSchema,
  config: z.record(z.string(), z.unknown()),
});

export const automationDefinitionV1Schema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  trigger: automationTriggerV1Schema,
  graphId: z.string().min(1),
  graphVersion: z.number().int().positive(),
  status: automationStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const executionRecordV1Schema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  workflowId: z.string().min(1),
  workflowRunId: z.string().min(1),
  correlationId: z.string().min(1),
  status: executionStatusSchema,
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  retryCount: z.number().int().nonnegative(),
  lastErrorCode: z.string().optional(),
  lastErrorMessage: z.string().optional(),
});
