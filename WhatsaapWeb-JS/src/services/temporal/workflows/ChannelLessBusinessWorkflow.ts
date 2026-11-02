import {
  proxyActivities,
  setHandler,
  condition,
  workflowInfo,
  ApplicationFailure,
} from '@temporalio/workflow';
import type * as activities from '../activities';
import { humanApprovalSignal, cancelWorkflowSignal, ApprovalDecisionInput } from './signals';
import { getWorkflowRunStateQuery, WorkflowRunState, WorkflowRunHistoryItem } from './queries';
import type { ChannelLessWorkflowInput, ChannelLessWorkflowResult } from './types';

const {
  executeHttpRequestActivity,
  executeBusinessEffectActivity,
  recordWorkflowRunCheckpointActivity,
} = proxyActivities<typeof activities>({
  startToCloseTimeout: '1m',
  retry: {
    initialInterval: '500ms',
    backoffCoefficient: 2,
    maximumAttempts: 3,
    nonRetryableErrorTypes: ['SSRF_BLOCKED', 'HTTP_CLIENT_ERROR', 'INVALID_ORDER_PAYLOAD'],
  },
});

/**
 * UC-06 Dedicated Channel-Less Business Workflow.
 * Orchestrates ERP, CRM, billing, and inventory processes completely decoupled from messaging channels.
 */
export async function ChannelLessBusinessWorkflow(
  input: ChannelLessWorkflowInput
): Promise<ChannelLessWorkflowResult> {
  const info = workflowInfo();
  const historyTrace: WorkflowRunHistoryItem[] = [];
  const variables: Record<string, unknown> = {
    ...input.triggerPayload,
    workflowId: input.workflowId,
    runId: input.runId,
    correlationId: input.correlationId,
    endpointKey: input.endpointKey,
  };

  let status: WorkflowRunState['status'] = 'running';
  const stateHolder: { approvalDecision: ApprovalDecisionInput | null } = {
    approvalDecision: null,
  };
  let pendingApproval: WorkflowRunState['pendingApproval'] = null;

  // Signal Handlers
  setHandler(humanApprovalSignal, (decision: ApprovalDecisionInput) => {
    stateHolder.approvalDecision = decision;
    pendingApproval = null;
    historyTrace.push({
      nodeId: 'approval_gate',
      status: decision.decision === 'approved' ? 'approval_granted' : 'approval_rejected',
      timestamp: decision.timestamp || new Date().toISOString(),
      details: { actor: decision.actor, reason: decision.reason },
    });
  });

  setHandler(cancelWorkflowSignal, (sig: { reason?: string }) => {
    status = 'cancelled';
    historyTrace.push({
      nodeId: 'cancellation',
      status: 'workflow_cancelled',
      timestamp: new Date().toISOString(),
      details: { reason: sig.reason },
    });
  });

  // Query Handler
  setHandler(getWorkflowRunStateQuery, (): WorkflowRunState => ({
    workflowId: input.workflowId,
    runId: input.runId,
    tenantId: input.tenantId,
    revisionId: input.revisionId,
    status,
    currentNodeId: 'business_pipeline',
    stepCount: historyTrace.length,
    variables,
    historyTrace,
    pendingApproval,
    approvalDecision: stateHolder.approvalDecision,
    lastUpdated: new Date().toISOString(),
  }));

  // =========================================================================
  // Phase 1: Ingestion & Validation
  // =========================================================================
  const orderId = String(input.triggerPayload.orderId || input.triggerPayload.id || `ord_${Date.now()}`);
  const amount = Number(input.triggerPayload.amount || input.triggerPayload.total || 0);

  historyTrace.push({
    nodeId: 'phase_ingestion',
    status: 'order_ingested',
    timestamp: new Date().toISOString(),
    details: { orderId, amount },
  });

  await recordWorkflowRunCheckpointActivity({
    runId: input.runId,
    tenantId: input.tenantId,
    workflowId: input.workflowId,
    currentStep: 'phase_ingestion',
    stepCount: 1,
    stateSnapshot: variables,
    status: 'running',
  });

  // =========================================================================
  // Phase 2: Verification & Credit Check (Optional HTTP Activity)
  // =========================================================================
  const verificationUrl = input.triggerPayload.verificationUrl as string | undefined;
  if (verificationUrl) {
    historyTrace.push({
      nodeId: 'phase_verification',
      status: 'http_verification_invoked',
      timestamp: new Date().toISOString(),
    });

    const verifyRes = await executeHttpRequestActivity({
      url: verificationUrl,
      method: 'POST',
      body: { orderId, amount, tenantId: input.tenantId },
      correlationId: input.correlationId,
      runId: input.runId,
    });
    variables.verification = verifyRes.body;
  }

  // =========================================================================
  // Phase 3: Human Approval Gate (Threshold Check)
  // =========================================================================
  const approvalThreshold = input.approvalThresholdAmount ?? 5000;
  let isApproved = true;

  if (amount >= approvalThreshold) {
    status = 'waiting_approval';
    const approvalId = `app_${input.runId}_order_${orderId}`;
    pendingApproval = {
      approvalId,
      nodeId: 'approval_gate',
      requestedAt: new Date().toISOString(),
      timeoutMs: 86_400_000,
    };

    await recordWorkflowRunCheckpointActivity({
      runId: input.runId,
      tenantId: input.tenantId,
      workflowId: input.workflowId,
      currentStep: 'phase_approval_gate',
      stepCount: 2,
      stateSnapshot: variables,
      status: 'waiting_approval',
    });

    const signalArrived = await condition(() => stateHolder.approvalDecision !== null, 86_400_000);

    if (!signalArrived || stateHolder.approvalDecision?.decision !== 'approved') {
      isApproved = false;
      status = 'failed';
      await recordWorkflowRunCheckpointActivity({
        runId: input.runId,
        tenantId: input.tenantId,
        workflowId: input.workflowId,
        currentStep: 'phase_approval_gate',
        stepCount: 3,
        stateSnapshot: variables,
        status: 'failed',
        errorDetails: {
          code: 'APPROVAL_REJECTED_OR_TIMEOUT',
          message: 'Order exceeded threshold and was rejected or timed out',
        },
      });

      throw ApplicationFailure.nonRetryable(
        'Workflow halted: manager approval rejected or timed out',
        'APPROVAL_REJECTED'
      );
    }

    status = 'running';
    pendingApproval = null;
  }

  // =========================================================================
  // Phase 4: Atomic Business Mutation (idempotency_ledger)
  // =========================================================================
  historyTrace.push({
    nodeId: 'phase_business_mutation',
    status: 'applying_business_effect',
    timestamp: new Date().toISOString(),
  });

  const effectResult = await executeBusinessEffectActivity({
    tenantId: input.tenantId,
    workflowId: input.workflowId,
    runId: input.runId,
    stepId: 'phase_business_mutation',
    effectType: 'order.approve',
    parameters: {
      orderId,
      amount,
      approvedBy: stateHolder.approvalDecision?.actor?.userId || 'system_auto_approval',
      newStatus: 'approved',
    },
    effectKey: `wf_${input.tenantId}_${input.workflowId}_${input.runId}_order_approve`,
  });

  variables.businessEffect = effectResult.resultData;

  // =========================================================================
  // Phase 5: Outbound ERP Webhook (SSRF Protected)
  // =========================================================================
  let confirmationSent = false;
  const outboundWebhookUrl = input.triggerPayload.outboundWebhookUrl as string | undefined;
  if (outboundWebhookUrl) {
    historyTrace.push({
      nodeId: 'phase_outbound_webhook',
      status: 'sending_erp_notification',
      timestamp: new Date().toISOString(),
    });

    await executeHttpRequestActivity({
      url: outboundWebhookUrl,
      method: 'POST',
      body: {
        orderId,
        amount,
        status: 'approved',
        effectKey: effectResult.effectKey,
      },
      correlationId: input.correlationId,
      runId: input.runId,
    });
    confirmationSent = true;
  }

  // =========================================================================
  // Phase 6: Final Completion & Checkpoint
  // =========================================================================
  status = 'completed';
  await recordWorkflowRunCheckpointActivity({
    runId: input.runId,
    tenantId: input.tenantId,
    workflowId: input.workflowId,
    currentStep: 'completed',
    stepCount: 5,
    stateSnapshot: variables,
    status: 'completed',
  });

  historyTrace.push({
    nodeId: 'completed',
    status: 'workflow_completed',
    timestamp: new Date().toISOString(),
  });

  return {
    runId: input.runId,
    workflowId: input.workflowId,
    status: 'completed',
    orderId,
    amount,
    approved: isApproved,
    effectResult: effectResult.resultData,
    confirmationSent,
    completedAt: new Date().toISOString(),
  };
}
