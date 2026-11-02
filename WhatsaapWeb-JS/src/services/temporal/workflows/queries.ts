import { defineQuery } from '@temporalio/workflow';
import type { ApprovalDecisionInput } from './signals';

export interface WorkflowRunHistoryItem {
  nodeId: string;
  status: string;
  timestamp: string;
  details?: Record<string, unknown>;
}

export interface PendingApprovalState {
  approvalId: string;
  nodeId: string;
  requestedAt: string;
  expiresAt?: string;
  timeoutMs?: number;
}

export interface WorkflowRunState {
  workflowId: string;
  runId: string;
  tenantId: number;
  revisionId?: string;
  status: 'running' | 'waiting_timer' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled';
  currentNodeId: string;
  stepCount: number;
  variables: Record<string, unknown>;
  historyTrace: WorkflowRunHistoryItem[];
  pendingApproval?: PendingApprovalState | null;
  approvalDecision?: ApprovalDecisionInput | null;
  lastUpdated: string;
}

export const getWorkflowRunStateQuery = defineQuery<WorkflowRunState>('getWorkflowRunState');
