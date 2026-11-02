/**
 * Canonical Workflow and DAG Orchestration Types
 * Specification: Milestone M3 (PR-F4-02, WAA-011, PROD-006, UC-06)
 */

export const WORKFLOW_DEFINITION_STATUSES = ['draft', 'published', 'archived'] as const;
export type WorkflowDefinitionStatus = (typeof WORKFLOW_DEFINITION_STATUSES)[number];

export const WORKFLOW_REVISION_STATUSES = ['draft', 'published', 'archived'] as const;
export type WorkflowRevisionStatus = (typeof WORKFLOW_REVISION_STATUSES)[number];

export const WORKFLOW_NODE_KINDS = [
  'trigger',
  'condition',
  'delay',
  'activity',
  'approval',
  'end',
] as const;
export type WorkflowNodeKind = (typeof WORKFLOW_NODE_KINDS)[number];

export const WORKFLOW_TRIGGER_TYPES = [
  'webhook',
  'schedule',
  'event',
  'manual',
  'channel.message',
] as const;
export type WorkflowTriggerType = (typeof WORKFLOW_TRIGGER_TYPES)[number];

export const WORKFLOW_RUN_STATUSES = [
  'queued',
  'running',
  'waiting_timer',
  'waiting_approval',
  'completed',
  'failed',
  'cancelled',
  'timed_out',
] as const;
export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUSES)[number];

export interface WorkflowNodePosition {
  readonly x: number;
  readonly y: number;
}

export interface WorkflowNodeDefinitionV1 {
  readonly id: string;
  readonly kind: WorkflowNodeKind;
  readonly label?: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly position?: WorkflowNodePosition;
}

export interface WorkflowEdgeDefinitionV1 {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly sourceHandle?: string;
  readonly targetHandle?: string;
  readonly label?: string;
  readonly condition?: string;
}

export interface WorkflowDagGraphV1 {
  readonly nodes: readonly WorkflowNodeDefinitionV1[];
  readonly edges: readonly WorkflowEdgeDefinitionV1[];
}

export interface WorkflowExecutionLimitsV1 {
  readonly maxDurationSeconds: number;
  readonly maxStepCount: number;
  readonly timeoutSeconds: number;
  /** Optional legacy alias for maxStepCount */
  readonly maxSteps?: number;
}

export interface WorkflowDefinitionV1 {
  readonly id: string;
  readonly tenantId: string;
  readonly workspaceId?: string | null;
  readonly name: string;
  readonly description?: string | null;
  readonly status: WorkflowDefinitionStatus;
  readonly publishedRevisionId?: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorkflowRevisionV1 {
  readonly id: string;
  readonly tenantId: string;
  readonly workflowId: string;
  readonly revisionNumber: number;
  readonly status: WorkflowRevisionStatus;
  readonly dagGraph: WorkflowDagGraphV1;
  readonly specHash: string;
  readonly limits: WorkflowExecutionLimitsV1;
  readonly publishedAt?: string | null;
  readonly createdAt: string;
}

export interface WorkflowErrorDetailsV1 {
  readonly code: string;
  readonly message: string;
  readonly nodeId?: string;
  readonly timestamp?: string;
  readonly retryable?: boolean;
  readonly stack?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface WorkflowRunV1 {
  readonly id: string;
  readonly tenantId: string;
  readonly workspaceId?: string | null;
  readonly workflowId: string;
  readonly revisionId: string;
  readonly temporalWorkflowId: string;
  readonly temporalRunId?: string | null;
  readonly triggerType: WorkflowTriggerType;
  readonly status: WorkflowRunStatus;
  readonly correlationId: string;
  readonly inputPayload: Readonly<Record<string, unknown>>;
  readonly outputPayload: Readonly<Record<string, unknown>>;
  readonly currentStep?: string | null;
  readonly stepCount: number;
  readonly errorDetails?: WorkflowErrorDetailsV1 | null;
  readonly startedAt: string;
  readonly completedAt?: string | null;
}

export interface RollbackWorkflowCommandV1 {
  readonly schemaVersion: 1;
  readonly tenantId: string;
  readonly workflowId: string;
  readonly targetRevisionNumber?: number;
  readonly targetRevisionId?: string;
  readonly userId: string;
  readonly reason?: string;
}

export interface PublishWorkflowRevisionCommandV1 {
  readonly schemaVersion: 1;
  readonly tenantId: string;
  readonly workflowId: string;
  readonly revisionId: string;
  readonly userId: string;
  readonly comment?: string;
}

export interface WorkflowTriggerV1 {
  readonly id: string;
  readonly tenantId: string;
  readonly workflowId: string;
  readonly type: 'webhook' | 'schedule' | 'event';
  readonly endpointKey?: string | null;
  readonly authTokenHash?: string | null;
  readonly cronExpression?: string | null;
  readonly isActive: boolean;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// -----------------------------------------------------------------------------
// Legacy Backward-Compatibility Exports
// -----------------------------------------------------------------------------
export const AUTOMATION_TRIGGER_TYPES = [
  'channel.message',
  'schedule',
  'manual',
  'webhook',
] as const;
export type AutomationTriggerType = (typeof AUTOMATION_TRIGGER_TYPES)[number];

export const AUTOMATION_STATUSES = ['active', 'inactive', 'draft'] as const;
export type AutomationStatus = (typeof AUTOMATION_STATUSES)[number];

export interface AutomationTriggerV1 {
  readonly type: AutomationTriggerType;
  readonly config: Readonly<Record<string, unknown>>;
}

export interface AutomationDefinitionV1 {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly description?: string;
  readonly trigger: AutomationTriggerV1;
  readonly graphId: string;
  readonly graphVersion: number;
  readonly status: AutomationStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const EXECUTION_STATUSES = [
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

export interface ExecutionRecordV1 {
  readonly id: string;
  readonly tenantId: string;
  readonly workflowId: string;
  readonly workflowRunId: string;
  readonly correlationId: string;
  readonly status: ExecutionStatus;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly retryCount: number;
  readonly lastErrorCode?: string;
  readonly lastErrorMessage?: string;
}
