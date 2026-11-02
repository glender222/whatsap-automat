import { createHash } from 'node:crypto';
import type { AgentGraphVersionV1 } from './graph';

/**
 * Deterministically computes the SHA-256 spec_hash of an Agent Graph version.
 * Strips out visual layout metadata (such as UI position { x, y } and UI display labels)
 * to guarantee that canvas movement does not alter the graph's immutable execution identity.
 */
export function computeAgentSpecHash(
  graph: Pick<AgentGraphVersionV1, 'entryNodeId' | 'nodes' | 'edges' | 'policyRef' | 'limits'>
): string {
  // 1. Sort and canonicalize nodes
  const canonicalNodes = [...graph.nodes]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((n) => ({
      id: n.id,
      kind: n.kind,
      config: n.config ?? {},
    }));

  // 2. Sort and canonicalize edges
  const canonicalEdges = [...graph.edges]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((e) => ({
      id: e.id,
      from: e.from,
      to: e.to,
      condition: e.condition ?? null,
      priority: e.priority ?? null,
    }));

  // 3. Normalized payload
  const canonicalPayload = {
    entryNodeId: graph.entryNodeId,
    nodes: canonicalNodes,
    edges: canonicalEdges,
    policyRef: graph.policyRef,
    limits: {
      maxSteps: graph.limits.maxSteps,
      maxDelegations: graph.limits.maxDelegations,
      maxParallelNodes: graph.limits.maxParallelNodes,
      maxDurationSeconds: graph.limits.maxDurationSeconds,
      maxModelTokens: graph.limits.maxModelTokens,
      maxCostMicroUsd: graph.limits.maxCostMicroUsd,
    },
  };

  return createHash('sha256').update(JSON.stringify(canonicalPayload)).digest('hex');
}
