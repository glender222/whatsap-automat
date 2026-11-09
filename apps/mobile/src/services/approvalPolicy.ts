import type { MobileApproval } from './apiClient';

const ordinaryRisks = new Set(['low', 'medium', 'read', 'write', 'send']);

export function canReviewRiskOnMobile(risk: string): boolean {
  return ordinaryRisks.has(risk);
}

export function canDecideMobileApproval(approval: MobileApproval, now = Date.now()): boolean {
  return approval.status === 'pending' && canReviewRiskOnMobile(approval.risk) &&
    Number.isSafeInteger(approval.policyVersion) && approval.policyVersion > 0 &&
    Date.parse(approval.expiresAt) > now;
}
