import {
  proxyActivities,
  setHandler,
  sleep,
  condition,
  workflowInfo,
  ApplicationFailure,
} from '@temporalio/workflow';
import type * as activities from '../activities';
import { humanApprovalSignal, cancelWorkflowSignal, ApprovalDecisionInput } from './signals';
import { getWorkflowRunStateQuery, WorkflowRunState, WorkflowRunHistoryItem } from './queries';
import type { DurableWorkflowInput, DurableWorkflowResult } from './types';
import type { WorkflowNodeDefinitionV1, WorkflowEdgeDefinitionV1 } from '@whatsap-automat/contracts';
import { evaluateCondition } from './evaluateCondition';

const {
  executeHttpRequestActivity,
  executeBusinessEffectActivity,
} = proxyActivities<typeof activities>({
  startToCloseTimeout: '1m',
  retry: {
    initialInterval: '500ms',
    backoffCoefficient: 2,
    maximumAttempts: 3,
    nonRetryableErrorTypes: ['SSRF_BLOCKED', 'HTTP_CLIENT_ERROR', 'LOOP_LIMIT_EXCEEDED'],
  },
});

const { recordWorkflowRunCheckpointActivity } = proxyActivities<typeof activities>({
  startToCloseTimeout: '10s',
  retry: { initialInterval: '500ms', maximumInterval: '10s' },
});

/**
 * Generic, deterministic DAG Workflow Engine for Whatsap-Automat
 */
export async function DurableAutomationWorkflow(
  input: DurableWorkflowInput
): Promise<DurableWorkflowResult> {
  const info = workflowInfo();
  const maxSteps = input.limits?.maxStepCount ?? input.limits?.maxSteps ?? 100;
  const historyTrace: WorkflowRunHistoryItem[] = [];

  const variables: Record<string, unknown> = {
    ...input.triggerPayload,
    triggerType: input.triggerType,
    correlationId: input.correlationId,
    workflowId: input.workflowId,
    runId: input.runId,
  };

  let currentNode: WorkflowNodeDefinitionV1 | undefined =
    input.dagGraph.nodes.find((n) => n.kind === 'trigger') || input.dagGraph.nodes[0];

  let stepCount = 0;
  let status: WorkflowRunState['status'] = 'running';
  const stateHolder: { approvalDecision: ApprovalDecisionInput | null } = {
    approvalDecision: null,
  };
  let isCancelled = false;
  let cancelReason: string | undefined = undefined;

  let pendingApproval: WorkflowRunState['pendingApproval'] = null;

  // 1. Setup Signal Handlers
  setHandler(humanApprovalSignal, (decision: ApprovalDecisionInput) => {
    stateHolder.approvalDecision = decision;
    if (pendingApproval) {
      pendingApproval = null;
    }
    historyTrace.push({
      nodeId: currentNode?.id || 'unknown',
      status: decision.decision === 'approved' ? 'approval_granted' : 'approval_rejected',
      timestamp: decision.timestamp || new Date().toISOString(),
      details: { actor: decision.actor, reason: decision.reason },
    });
  });

  setHandler(cancelWorkflowSignal, (sig: { reason?: string }) => {
    isCancelled = true;
    cancelReason = sig.reason;
    status = 'cancelled';
    historyTrace.push({
      nodeId: currentNode?.id || 'unknown',
      status: 'workflow_cancelled',
      timestamp: new Date().toISOString(),
      details: { reason: sig.reason },
    });
  });

  // 2. Setup Query Handler
  setHandler(getWorkflowRunStateQuery, (): WorkflowRunState => ({
    workflowId: input.workflowId,
    runId: input.runId,
    tenantId: input.tenantId,
    revisionId: input.revisionId,
    status,
    currentNodeId: currentNode ? currentNode.id : 'completed',
    stepCount,
    variables,
    historyTrace,
    pendingApproval,
    approvalDecision: stateHolder.approvalDecision,
    lastUpdated: new Date().toISOString(),
  }));

  async function checkpoint(
    currentStep: string,
    checkpointStatus: WorkflowRunState['status'],
    errorDetails?: Record<string, unknown>
  ): Promise<void> {
    await recordWorkflowRunCheckpointActivity({
      runId: input.runId,
      tenantId: input.tenantId,
      workflowId: input.workflowId,
      temporalWorkflowId: info.workflowId,
      temporalRunId: info.runId,
      currentStep,
      stepCount,
      stateSnapshot: variables,
      status: checkpointStatus,
      errorDetails,
    });
  }

  await checkpoint(currentNode?.id || 'start', 'running');

  // 3. DAG Execution Loop
  while (currentNode && currentNode.kind !== 'end' && !isCancelled) {
    // Loop guard
    if (stepCount >= maxSteps) {
      status = 'failed';
      const err = ApplicationFailure.nonRetryable(
        `Execution step limit of ${maxSteps} steps exceeded: loop detected`,
        'LOOP_LIMIT_EXCEEDED'
      );
      historyTrace.push({
        nodeId: currentNode.id,
        status: 'loop_limit_exceeded',
        timestamp: new Date().toISOString(),
      });
      await checkpoint(currentNode.id, 'failed', { code: 'LOOP_LIMIT_EXCEEDED', message: err.message });
      throw err;
    }

    stepCount++;
    const activeNodeId: string = currentNode.id;
    let transitionHandle: string | undefined = undefined;

    historyTrace.push({
      nodeId: activeNodeId,
      status: `node_started_${currentNode.kind}`,
      timestamp: new Date().toISOString(),
    });

    switch (currentNode.kind) {
      case 'trigger': {
        // Entry trigger already injected variables
        break;
      }

      case 'delay': {
        status = 'waiting_timer';
        const delayMs =
          Number(currentNode.config?.durationMs) ||
          (Number(currentNode.config?.seconds) ? Number(currentNode.config.seconds) * 1000 : 1000);

        await checkpoint(activeNodeId, 'waiting_timer');

        await sleep(delayMs);
        status = 'running';
        break;
      }

      case 'approval': {
        status = 'waiting_approval';
        const timeoutMs = Number(currentNode.config?.timeoutMs) || 86_400_000;
        const approvalId = `app_${input.runId}_${activeNodeId}`;
        pendingApproval = {
          approvalId,
          nodeId: activeNodeId,
          requestedAt: new Date().toISOString(),
          timeoutMs,
        };

        await checkpoint(activeNodeId, 'waiting_approval');

        const signalReceived = await condition(() => stateHolder.approvalDecision !== null, timeoutMs);

        if (!signalReceived || stateHolder.approvalDecision === null) {
          transitionHandle = 'timeout';
          historyTrace.push({
            nodeId: activeNodeId,
            status: 'approval_timeout',
            timestamp: new Date().toISOString(),
          });
        } else {
          transitionHandle = stateHolder.approvalDecision.decision; // 'approved' | 'rejected'
          variables[`${activeNodeId}_approval`] = stateHolder.approvalDecision;
        }

        status = 'running';
        pendingApproval = null;
        break;
      }

      case 'condition': {
        const expression = String(currentNode.config?.expression || '');
        const passed = evaluateCondition(expression, variables);
        transitionHandle = passed ? 'true' : 'false';
        variables[`${activeNodeId}_condition`] = passed;
        break;
      }

      case 'activity': {
        const cfg = currentNode.config || {};
        if (cfg.url) {
          const httpRes = await executeHttpRequestActivity({
            url: String(cfg.url),
            method: (cfg.method as any) || 'GET',
            headers: (cfg.headers as any) || {},
            body: cfg.body || variables,
            correlationId: input.correlationId,
            runId: input.runId,
            idempotencyKey: `wf_${input.tenantId}_${input.runId}_${activeNodeId}`,
          });
          variables[activeNodeId] = httpRes.body;
        } else if (cfg.effectType) {
          const effectRes = await executeBusinessEffectActivity({
            tenantId: input.tenantId,
            workflowId: input.workflowId,
            runId: input.runId,
            stepId: activeNodeId,
            effectType: String(cfg.effectType),
            parameters: (cfg.parameters as Record<string, unknown>) || variables,
          });
          variables[activeNodeId] = effectRes.resultData;
        }
        break;
      }

      default: {
        break;
      }
    }

    await checkpoint(activeNodeId, isCancelled ? 'cancelled' : 'running');

    // Find outgoing edge
    const outgoingEdges: readonly WorkflowEdgeDefinitionV1[] = input.dagGraph.edges.filter(
      (e: WorkflowEdgeDefinitionV1) => e.source === activeNodeId
    );
    let nextEdge: WorkflowEdgeDefinitionV1 | undefined = outgoingEdges[0];

    if (transitionHandle) {
      const matched = outgoingEdges.find(
        (e: WorkflowEdgeDefinitionV1) =>
          e.sourceHandle === transitionHandle ||
          e.condition === transitionHandle ||
          e.label?.toLowerCase() === transitionHandle?.toLowerCase()
      );
      if (matched) {
        nextEdge = matched;
      }
    }

    if (nextEdge) {
      currentNode = input.dagGraph.nodes.find((n) => n.id === nextEdge.target);
    } else {
      currentNode = undefined;
    }
  }

  // 4. Final Completion
  status = isCancelled ? 'cancelled' : 'completed';
  await checkpoint(status, status);

  historyTrace.push({
    nodeId: currentNode?.id || 'end',
    status: `workflow_${status}`,
    timestamp: new Date().toISOString(),
  });

  return {
    runId: input.runId,
    workflowId: input.workflowId,
    status,
    stepCount,
    outputPayload: variables,
    historyTrace,
  };
}
