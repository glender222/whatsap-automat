/**
 * Tipos e interfaces del Spike de Temporal OSS (PR-07)
 * Diseñado conforme a los principios de BLUEPRINT v0.4 (§7):
 * - Referencias cortas en historial (sin PII ni tokens de canales).
 * - Identificadores deterministas y effectKeys para actividades idempotentes.
 */

export interface DemoEventInput {
  eventRef: string;
  tenantId: string;
  externalId: string;
  delaySeconds?: number;
  simulateFailureCount?: number;
  requireApproval?: boolean;
  metadata?: Record<string, unknown>;
}

export interface ValidationResult {
  valid: boolean;
  tenantId: string;
  normalizedId: string;
  validatedAt: number;
}

export interface FlakyOperationInput {
  attemptFailureCount: number;
  operationId: string;
  nonRetryable?: boolean;
}

export interface FlakyOperationResult {
  attempts: number;
  success: boolean;
  message: string;
}

export interface BusinessEffectResult {
  applied: boolean;
  effectKey: string;
  tenantId: string;
  executionTimestamp: number;
  cached: boolean;
}

export interface CompletionResult {
  notified: boolean;
  workflowId: string;
  eventRef: string;
  completedAt: number;
}

export type WorkflowStateStatus =
  | 'INITIALIZED'
  | 'VALIDATED'
  | 'WAITING_TIMER'
  | 'WAITING_APPROVAL'
  | 'APPLYING_EFFECT'
  | 'COMPLETED'
  | 'FAILED';

export interface WorkflowState {
  status: WorkflowStateStatus;
  currentStep: string;
  tenantId: string;
  eventRef: string;
  effectKey?: string;
  approvalReceived?: boolean;
  approvedBy?: string;
  updatedAt: number;
}

export interface ApprovalSignalInput {
  approved: boolean;
  actor: string;
  reason?: string;
}
