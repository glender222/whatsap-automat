/**
 * Types and Error Classes for Workflow Revision and Ingress Services (PR-F4-02)
 */

export interface InboundWebhookResult {
  status: 'accepted';
  runId: string;
  workflowId: string;
  revisionId: string;
  idempotencyKey: string;
  duplicate: boolean;
}

export interface RollbackOptions {
  targetRevisionNumber?: number;
  targetRevisionId?: string;
  reason: string;
  userId?: string | number;
}

export interface RollbackResult {
  success: true;
  workflowId: string;
  previousRevisionId: string | null;
  publishedRevisionId: string;
  targetRevisionNumber: number;
  latencyMs: number;
  updatedAt: Date;
}

export class TriggerNotFoundError extends Error {
  readonly code = 'TRIGGER_NOT_FOUND';
  constructor(endpointKey: string) {
    super(`Webhook trigger not found for endpoint key: ${endpointKey}`);
    this.name = 'TriggerNotFoundError';
  }
}

export class TriggerInactiveError extends Error {
  readonly code = 'TRIGGER_INACTIVE';
  constructor(endpointKey: string) {
    super(`Webhook trigger is disabled: ${endpointKey}`);
    this.name = 'TriggerInactiveError';
  }
}

export class WebhookAuthenticationError extends Error {
  readonly code = 'WEBHOOK_UNAUTHORIZED';
  constructor(detail = 'Invalid or missing webhook token') {
    super(detail);
    this.name = 'WebhookAuthenticationError';
  }
}

export class WorkflowNotPublishedError extends Error {
  readonly code = 'WORKFLOW_NOT_PUBLISHED';
  constructor(workflowId: string) {
    super(`Workflow ${workflowId} has no published revision`);
    this.name = 'WorkflowNotPublishedError';
  }
}

export class WorkflowNotFoundError extends Error {
  readonly code = 'WORKFLOW_NOT_FOUND';
  constructor(workflowId: string) {
    super(`Workflow definition not found: ${workflowId}`);
    this.name = 'WorkflowNotFoundError';
  }
}

export class WorkflowArchivedError extends Error {
  readonly code = 'WORKFLOW_ARCHIVED';
  constructor(workflowId: string) {
    super(`Cannot rollback archived workflow: ${workflowId}`);
    this.name = 'WorkflowArchivedError';
  }
}

export class RevisionNotFoundError extends Error {
  readonly code = 'REVISION_NOT_FOUND';
  constructor(identifier: string | number) {
    super(`Target revision not found for identifier: ${identifier}`);
    this.name = 'RevisionNotFoundError';
  }
}
