/**
 * Pure algorithm transforming a Directed Acyclic Graph (WorkflowDagGraphV1)
 * into a hierarchical tree suitable for WAI-ARIA Treeview 1.2 navigation.
 * Handles linear paths, condition/approval branching, and diamond reconvergences.
 */

import type {
  WorkflowNodeDefinitionV1,
  WorkflowEdgeDefinitionV1,
  OutlineTreeItem,
} from '../types';

export function buildTreeFromDag(
  nodes: readonly WorkflowNodeDefinitionV1[],
  edges: readonly WorkflowEdgeDefinitionV1[],
  selectedNodeId: string | null,
  expandedNodeIds: ReadonlySet<string>,
  activeStepNodeId?: string | null
): OutlineTreeItem[] {
  if (!nodes || nodes.length === 0) return [];

  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const outgoingMap = new Map<string, WorkflowEdgeDefinitionV1[]>();

  for (const edge of edges) {
    const list = outgoingMap.get(edge.source) || [];
    list.push(edge);
    outgoingMap.set(edge.source, list);
  }

  // Identify root nodes (nodes of kind 'trigger', or nodes with no incoming edges if no trigger)
  const triggers = nodes.filter((n) => n.kind === 'trigger');
  const incomingTargetSet = new Set(edges.map((e) => e.target));
  let rootNodes = triggers.length > 0 ? triggers : nodes.filter((n) => !incomingTargetSet.has(n.id));
  if (rootNodes.length === 0) {
    rootNodes = [nodes[0]];
  }

  const visitedGlobalSet = new Set<string>();

  function traverse(
    node: WorkflowNodeDefinitionV1,
    level: number,
    ancestorPath: Set<string>,
    edgeLabel?: string
  ): OutlineTreeItem {
    const isAlreadyVisited = visitedGlobalSet.has(node.id);
    visitedGlobalSet.add(node.id);

    const treeItemId = `tree-item-${node.id}`;
    const outgoing = outgoingMap.get(node.id) || [];

    // Detect reconvergence (diamond convergence or ancestor cycle)
    if (ancestorPath.has(node.id) || isAlreadyVisited) {
      return {
        id: `${treeItemId}-reconvergence-${level}`,
        nodeId: node.id,
        kind: node.kind,
        label: `↳ Continúa en ${node.label || node.id}`,
        level,
        edgeLabel,
        children: [],
        hasChildren: false,
        isExpanded: false,
        isSelected: node.id === selectedNodeId,
        isReconvergence: true,
      };
    }

    const nextAncestorPath = new Set(ancestorPath);
    nextAncestorPath.add(node.id);

    const children: OutlineTreeItem[] = [];
    for (const edge of outgoing) {
      const targetNode = nodeMap.get(edge.target);
      if (targetNode) {
        const branchLabel =
          edge.label ||
          edge.condition ||
          (edge.sourceHandle ? `[${edge.sourceHandle}]` : undefined);

        children.push(traverse(targetNode, level + 1, nextAncestorPath, branchLabel));
      }
    }

    const hasChildren = children.length > 0;
    const isExpanded = hasChildren && expandedNodeIds.has(treeItemId);

    return {
      id: treeItemId,
      nodeId: node.id,
      kind: node.kind,
      label: node.label || node.id,
      level,
      edgeLabel,
      children,
      hasChildren,
      isExpanded,
      isSelected: node.id === selectedNodeId,
      isReconvergence: false,
      status: node.id === activeStepNodeId ? 'running' : undefined,
    };
  }

  const tree: OutlineTreeItem[] = [];
  for (const root of rootNodes) {
    tree.push(traverse(root, 1, new Set()));
  }

  // Collect unconnected / orphan nodes
  const orphanNodes = nodes.filter((n) => !visitedGlobalSet.has(n.id));
  if (orphanNodes.length > 0) {
    const orphanGroupId = 'tree-item-group-orphans';
    tree.push({
      id: orphanGroupId,
      nodeId: '__orphans__',
      kind: 'activity',
      label: `Nodos sin conectar (${orphanNodes.length})`,
      level: 1,
      children: orphanNodes.map((orphan) => ({
        id: `tree-item-${orphan.id}`,
        nodeId: orphan.id,
        kind: orphan.kind,
        label: orphan.label || orphan.id,
        level: 2,
        children: [],
        hasChildren: false,
        isExpanded: false,
        isSelected: orphan.id === selectedNodeId,
        isReconvergence: false,
      })),
      hasChildren: true,
      isExpanded: expandedNodeIds.has(orphanGroupId),
      isSelected: false,
      isReconvergence: false,
    });
  }

  return tree;
}
