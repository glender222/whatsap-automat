import { proxyActivities, workflowInfo } from '@temporalio/workflow';
import type * as activities from '../activities/demo-activities.js';
import type { FlakyOperationInput, FlakyOperationResult } from '../interfaces.js';

// Actividades con política de reintentos específica para demostrar backoff y límites
const { executeFlakyOperation, recordAuditLog } = proxyActivities<typeof activities>({
  startToCloseTimeout: '10s',
  retry: {
    initialInterval: '100ms',
    backoffCoefficient: 2,
    maximumInterval: '1s',
    maximumAttempts: 6,
    nonRetryableErrorTypes: ['PERMANENT_ERROR', 'INVALID_ARGUMENT_ERROR'],
  },
});

export interface RetryWorkflowOutput {
  workflowId: string;
  runId: string;
  result: FlakyOperationResult;
  attemptsRequired: number;
  recovered: boolean;
}

/**
 * Workflow de demostración de reintentos automáticos y recuperación.
 */
export async function retryDemoWorkflow(
  input: FlakyOperationInput
): Promise<RetryWorkflowOutput> {
  const info = workflowInfo();

  await recordAuditLog('demo-tenant', 'RETRY_WORKFLOW_STARTED', {
    workflowId: info.workflowId,
    operationId: input.operationId,
    requiredFailures: input.attemptFailureCount,
  });

  const result = await executeFlakyOperation(input);

  await recordAuditLog('demo-tenant', 'RETRY_WORKFLOW_SUCCEEDED', {
    workflowId: info.workflowId,
    finalAttempts: result.attempts,
  });

  return {
    workflowId: info.workflowId,
    runId: info.runId,
    result,
    attemptsRequired: result.attempts,
    recovered: result.success && result.attempts > 1,
  };
}
