import { createHash } from 'node:crypto';
import type { WorkflowDagGraphV1, WorkflowExecutionLimitsV1 } from './types';

/**
 * Deterministically computes the SHA-256 spec_hash of a workflow DAG and its execution limits.
 * Excludes visual metadata (such as UI position { x, y } and visual edge labels) to guarantee
 * that purely visual drag-and-drop operations do not alter the revision's immutable execution identity.
 */
export function computeWorkflowSpecHash(
  dagGraph: WorkflowDagGraphV1,
  limits: WorkflowExecutionLimitsV1
): string {
  // Sort nodes and strip out non-executable UI positions
  const canonicalNodes = [...dagGraph.nodes]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((n) => ({
      id: n.id,
      kind: n.kind,
      config: n.config ?? {},
    }));

  // Sort edges deterministically
  const canonicalEdges = [...dagGraph.edges]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle ?? null,
      targetHandle: e.targetHandle ?? null,
      condition: e.condition ?? null,
    }));

  const canonicalPayload = {
    nodes: canonicalNodes,
    edges: canonicalEdges,
    limits: {
      maxDurationSeconds: limits.maxDurationSeconds ?? 86400,
      maxStepCount: limits.maxStepCount ?? limits.maxSteps ?? 100,
      timeoutSeconds: limits.timeoutSeconds ?? 3600,
    },
  };

  return createHash('sha256').update(JSON.stringify(canonicalPayload)).digest('hex');
}
