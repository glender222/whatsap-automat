import {
  computeAgentSpecHash,
  type AgentGraphVersionV1,
} from '@whatsap-automat/contracts';
import type { Queryable } from '../../../shared/UnitOfWorkPort';
import { PublicationGate } from '../eval/PublicationGate';

type GraphDraft = Pick<AgentGraphVersionV1, 'entryNodeId' | 'nodes' | 'edges' | 'policyRef' | 'limits'>;
type RevisionRow = {
  tenant_id: number;
  graph_id: string;
  version: number;
  spec_hash: string;
  spec: GraphDraft;
};
type GraphIssue = { severity: 'error'; code: string; message: string; nodeId?: string };

function asDraft(row: RevisionRow): AgentGraphVersionV1 {
  return {
    ...row.spec,
    schemaVersion: 1,
    tenantId: String(row.tenant_id),
    graphId: row.graph_id,
    version: row.version,
    status: 'draft',
    specHash: row.spec_hash,
  };
}

export async function saveDraft(
  db: Queryable, tenantId: number, actorId: number, graphId: string, spec: GraphDraft, create: boolean
): Promise<AgentGraphVersionV1 | null> {
  const reservation = create
    ? await db.query(`INSERT INTO agent_studio_graphs (tenant_id, graph_id) VALUES ($1, $2)
        ON CONFLICT (tenant_id, graph_id) DO NOTHING RETURNING latest_version`, [tenantId, graphId])
    : await db.query(`UPDATE agent_studio_graphs SET latest_version = latest_version + 1
        WHERE tenant_id = $1 AND graph_id = $2 RETURNING latest_version`, [tenantId, graphId]);
  if (!reservation.rows.length) return null;

  const { rows } = await db.query(`
    INSERT INTO agent_studio_revisions (tenant_id, graph_id, version, created_by, spec_hash, spec)
    VALUES ($1, $2, $3, $4, $5, $6) RETURNING tenant_id, graph_id, version, spec_hash, spec
  `, [tenantId, graphId, reservation.rows[0].latest_version, actorId, computeAgentSpecHash(spec), JSON.stringify(spec)]);
  return asDraft(rows[0]);
}

export async function loadDraft(
  db: Queryable, tenantId: number, graphId: string, version: number | null
): Promise<AgentGraphVersionV1 | null> {
  const { rows } = await db.query(`
    SELECT r.tenant_id, r.graph_id, r.version, r.spec_hash, r.spec
    FROM agent_studio_graphs g
    JOIN agent_studio_revisions r ON (r.tenant_id, r.graph_id) = (g.tenant_id, g.graph_id)
      AND r.version = COALESCE($3, g.latest_version)
    WHERE g.tenant_id = $1 AND g.graph_id = $2
  `, [tenantId, graphId, version]);
  return rows.length ? asDraft(rows[0]) : null;
}

export async function listDrafts(db: Queryable, tenantId: number, after: string, limit: number) {
  const { rows } = await db.query(`
    SELECT r.tenant_id, r.graph_id, r.version, r.spec_hash, r.spec
    FROM agent_studio_graphs g
    JOIN agent_studio_revisions r ON (r.tenant_id, r.graph_id, r.version) =
      (g.tenant_id, g.graph_id, g.latest_version)
    WHERE g.tenant_id = $1 AND g.graph_id > $2
    ORDER BY g.graph_id
    LIMIT $3
  `, [tenantId, after, limit + 1]);
  const items = rows.slice(0, limit).map(asDraft);
  return { items, nextAfter: rows.length > limit ? items[items.length - 1].graphId : null };
}

export function validateDraft(graph: AgentGraphVersionV1) {
  const issues: GraphIssue[] = [];
  const report = (code: string, message: string, nodeId?: string) => {
    issues.push({ severity: 'error', code, message, nodeId });
  };

  const nodesById = new Map<string, AgentGraphVersionV1['nodes'][number]>();
  const outbound = new Map<string, string[]>();
  for (const node of graph.nodes) {
    if (nodesById.has(node.id)) report('DUPLICATE_NODE', 'Node IDs must be unique', node.id);
    nodesById.set(node.id, node);
    outbound.set(node.id, []);
  }

  const edgeIds = new Set<string>();
  for (const edge of graph.edges) {
    if (edgeIds.has(edge.id)) report('DUPLICATE_EDGE', `Edge ${edge.id} appears more than once`);
    edgeIds.add(edge.id);
    const destinations = outbound.get(edge.from);
    if (!destinations || !nodesById.has(edge.to)) {
      report('UNKNOWN_EDGE_ENDPOINT', `Edge ${edge.id} must connect two existing nodes`);
      continue;
    }
    destinations.push(edge.to);
  }

  if (!nodesById.has(graph.entryNodeId)) {
    report('MISSING_ENTRY', 'The entry node does not exist', graph.entryNodeId);
  } else {
    const reachable = new Set<string>();
    const pending = [graph.entryNodeId];
    while (pending.length) {
      const nodeId = pending.pop()!;
      if (reachable.has(nodeId)) continue;
      reachable.add(nodeId);
      pending.push(...outbound.get(nodeId)!);
    }
    for (const nodeId of nodesById.keys()) {
      if (!reachable.has(nodeId)) report('UNREACHABLE_NODE', 'Node is unreachable from the entry', nodeId);
    }
  }

  for (const [nodeId, node] of nodesById) {
    const hasOutbound = outbound.get(nodeId)!.length > 0;
    if (node.kind === 'end' && hasOutbound) report('END_HAS_OUTBOUND', 'End nodes cannot have outgoing edges', nodeId);
    if (node.kind !== 'end' && !hasOutbound) report('DEAD_END', 'Every branch must lead to an end node', nodeId);
  }

  const cycle = PublicationGate.detectCycles(graph);
  if (cycle.hasCycle) report('GRAPH_CYCLE', 'The graph contains a cycle', cycle.path[0]);
  if (computeAgentSpecHash(graph) !== graph.specHash) report('SPEC_HASH_MISMATCH', 'Stored specification hash does not match');

  return {
    graphId: graph.graphId,
    version: graph.version,
    specHash: graph.specHash,
    scope: 'structural' as const,
    publicationEvidence: false as const,
    valid: issues.length === 0,
    issues,
  };
}
