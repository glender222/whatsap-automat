import { TenantActor } from '../common';

export const RISK_LEVELS = ['low', 'medium', 'high'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const APPROVAL_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'expired',
  'revoked',
] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export interface ApprovalActionDetailsV1 {
  readonly toolName: string;
  readonly summary: string;
  readonly parametersRedacted: Readonly<Record<string, unknown>>;
  readonly requiredRole?: string;
}

/**
 * Approval Request V1 contract
 * Blueprint Section 5.3
 */
export interface ApprovalRequestV1 {
  readonly id: string;
  readonly tenantId: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly effectKey: string;
  readonly proposedActionHash: string;
  readonly policyVersion: number;
  readonly risk: RiskLevel;
  readonly status: ApprovalStatus;
  readonly expiresAt: string; // ISO 8601
  readonly details?: ApprovalActionDetailsV1;
  readonly createdAt: string;
  readonly decidedAt?: string;
  readonly decidedBy?: string;
}

export interface ApprovalDecisionCommandV1 {
  readonly schemaVersion: 1;
  readonly decision: 'approved' | 'rejected';
  readonly reason?: string;
  readonly expectedVersion: number;
  readonly actor: TenantActor;
}

export interface ApprovalDecisionResultV1 {
  readonly approvalId: string;
  readonly status: ApprovalStatus;
  readonly decidedAt: string;
  readonly decidedBy: string;
}
