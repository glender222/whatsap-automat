import type { WorkflowDagGraphV1, WorkflowExecutionLimitsV1 } from '@whatsap-automat/contracts';

export interface DurableWorkflowInput {
  tenantId: number;
  workflowId: string;
  runId: string;
  revisionId: string;
  dagGraph: WorkflowDagGraphV1;
  limits?: WorkflowExecutionLimitsV1;
  triggerType: string;
  triggerPayload: Record<string, unknown>;
  correlationId: string;
}

export interface DurableWorkflowResult {
  runId: string;
  workflowId: string;
  status: 'completed' | 'failed' | 'cancelled';
  stepCount: number;
  outputPayload: Record<string, unknown>;
  historyTrace: Array<{
    nodeId: string;
    status: string;
    timestamp: string;
    details?: Record<string, unknown>;
  }>;
}

export interface ChannelLessWorkflowInput {
  tenantId: number;
  workflowId: string;
  runId: string;
  revisionId: string;
  endpointKey: string;
  triggerPayload: Record<string, unknown>;
  correlationId: string;
  approvalThresholdAmount?: number;
}

export interface ChannelLessWorkflowResult {
  runId: string;
  workflowId: string;
  status: 'completed' | 'failed' | 'cancelled';
  orderId?: string;
  amount?: number;
  approved: boolean;
  effectResult?: Record<string, unknown>;
  confirmationSent: boolean;
  completedAt: string;
}
