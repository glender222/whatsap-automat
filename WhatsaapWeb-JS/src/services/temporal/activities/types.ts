/**
 * Activity Contracts for Temporal Durable Workflows (PR-F4-02)
 */

export interface HttpRequestActivityInput {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  idempotencyKey?: string;
  correlationId?: string;
  runId?: string;
}

export interface HttpRequestActivityResult {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  resolvedIp?: string;
}

export interface BusinessEffectInput {
  tenantId: number;
  workflowId: string;
  runId: string;
  stepId: string;
  effectType: string;
  parameters: Record<string, unknown>;
  effectKey?: string;
}

export interface BusinessEffectResult {
  applied: boolean;
  cached: boolean;
  effectKey: string;
  resultData: Record<string, unknown>;
  timestamp: string;
}

export interface CheckpointInput {
  runId: string;
  tenantId: number;
  workflowId?: string;
  currentStep: string;
  stepCount: number;
  stateSnapshot: Record<string, unknown>;
  status: 'queued' | 'running' | 'waiting_timer' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled';
  errorDetails?: Record<string, unknown> | null;
}

export interface CheckpointResult {
  runId: string;
  stepCount: number;
  status: string;
  updatedAt: string;
}
