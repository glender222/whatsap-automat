import { defineSignal } from '@temporalio/workflow';

export interface ApprovalDecisionInput {
  approvalId: string;
  decision: 'approved' | 'rejected';
  actor: {
    userId: string;
    roles?: string[];
  };
  reason?: string;
  timestamp?: string;
}

export const humanApprovalSignal = defineSignal<[ApprovalDecisionInput]>('humanApprovalSignal');

export interface CancelWorkflowInput {
  reason?: string;
  userId?: string;
}

export const cancelWorkflowSignal = defineSignal<[CancelWorkflowInput]>('cancelWorkflowSignal');
