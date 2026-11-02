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
    nonRetryableErrorTypes: ['SSRF_BLOCKED', 'HTTP_CLIENT_ERROR', 'LOOP_LIMIT_EXCEEDED'],
  },
});

function evaluateCondition(
  expression: string | undefined,
  variables: Record<string, unknown>
): boolean {
  if (!expression || expression.trim().length === 0) {
    return true;
  }

  // Simple safe expression evaluator (no eval or Function constructor)
  // Supports: "var > 1000", "var == value", "var != value", "var < 1000", "boolean_var"
  const cleanExpr = expression.trim();

  // Greater than / less than
  const gtMatch = cleanExpr.match(/^([a-zA-Z0-9_.]+)\s*>\s*([0-9.]+)/);
  if (gtMatch) {
    const val = getNestedValue(variables, gtMatch[1]);
    return typeof val === 'number' && val > Number(gtMatch[2]);
  }

  const ltMatch = cleanExpr.match(/^([a-zA-Z0-9_.]+)\s*<\s*([0-9.]+)/);
  if (ltMatch) {
    const val = getNestedValue(variables, ltMatch[1]);
    return typeof val === 'number' && val < Number(ltMatch[2]);
  }

  // Equality
  const eqMatch = cleanExpr.match(/^([a-zA-Z0-9_.]+)\s*===?\s*['"]?([^'"]+)['"]?/);
  if (eqMatch) {
    const val = String(getNestedValue(variables, eqMatch[1]));
    return val === eqMatch[2];
  }

  // Truthy check on variable
  const val = getNestedValue(variables, cleanExpr);
  return Boolean(val);
}

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: any = obj;
  for (const part of parts) {
    if (current === undefined || current === null) return undefined;
    current = current[part];
  }
  return current;
}

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

  // Initial Checkpoint
  try {
    await recordWorkflowRunCheckpointActivity({
      runId: input.runId,
      tenantId: input.tenantId,
      workflowId: input.workflowId,
      currentStep: currentNode ? currentNode.id : 'start',
      stepCount: 0,
      stateSnapshot: variables,
      status: 'running',
    });
  } catch {
    // Non-fatal if checkpoint activity fails during replay or testing harness
  }

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

        try {
          await recordWorkflowRunCheckpointActivity({
            runId: input.runId,
            tenantId: input.tenantId,
            currentStep: activeNodeId,
            stepCount,
            stateSnapshot: variables,
            status: 'waiting_timer',
          });
        } catch {}

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

        try {
          await recordWorkflowRunCheckpointActivity({
            runId: input.runId,
            tenantId: input.tenantId,
            currentStep: activeNodeId,
            stepCount,
            stateSnapshot: variables,
            status: 'waiting_approval',
          });
        } catch {}

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

    // Step Checkpoint
    try {
      await recordWorkflowRunCheckpointActivity({
        runId: input.runId,
        tenantId: input.tenantId,
        currentStep: activeNodeId,
        stepCount,
        stateSnapshot: variables,
        status: 'running',
      });
    } catch {}

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
  try {
    await recordWorkflowRunCheckpointActivity({
      runId: input.runId,
      tenantId: input.tenantId,
      currentStep: 'completed',
      stepCount,
      stateSnapshot: variables,
      status,
    });
  } catch {}

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
