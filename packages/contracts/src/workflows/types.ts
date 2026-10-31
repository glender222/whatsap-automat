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
