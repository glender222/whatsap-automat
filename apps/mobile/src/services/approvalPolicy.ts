import type { MobileApproval } from './apiClient';

const ordinaryRisks = new Set(['low', 'medium', 'read', 'write']);
const sensitiveRisks = new Set(['high', 'send', 'financial', 'destructive']);
export const APPROVAL_REAUTH_CAPABILITY = 'approvals.reauthenticate';
export const MAX_APPROVAL_REASON_LENGTH = 1000;

export function requiresApprovalReauthentication(risk: string): boolean {
  return sensitiveRisks.has(risk);
}

export function canReviewRiskOnMobile(risk: string, reauthenticationSupported = false): boolean {
  return ordinaryRisks.has(risk) || (reauthenticationSupported && requiresApprovalReauthentication(risk));
}

export function canDecideMobileApproval(approval: MobileApproval, now = Date.now(), reauthenticationSupported = false): boolean {
  return approval.status === 'pending' && canReviewRiskOnMobile(approval.risk, reauthenticationSupported) &&
    Number.isSafeInteger(approval.policyVersion) && approval.policyVersion > 0 &&
    Date.parse(approval.expiresAt) > now;
}
