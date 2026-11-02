/**
 * Adversarial Empirical Stress Test Suite: DAG Topology, Cycle Detection,
 * Diamond DAG Reconvergences & Viewport / Bezier Geometry
 *
 * Authored by teamwork_challenger_m4_1 (Empirical Challenger)
 * Milestone: M4 (PR-F4-03 Automation Studio UI)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  validateDagGraph,
  buildTreeFromDag,
  computeBezierCurve,
  CanvasViewport,
  StudioEdge,
} from '../index';
import type {
  WorkflowDagGraphV1,
  WorkflowNodeDefinitionV1,
  WorkflowEdgeDefinitionV1,
  OutlineTreeItem,
} from '../types';

describe('ADVERSARIAL STRESS SUITE: M4 Automation Studio DAG & Canvas Math', () => {
  // =========================================================================
  // SECTION 1: DAG Topology Validation & Cycle Detection Stress Tests
  // =========================================================================
  describe('1. DAG Topology Validation & Cycle Detection (validateDagGraph)', () => {
    it('detects direct self-loop (Node A -> Node A)', () => {
      const selfLoopDag: WorkflowDagGraphV1 = {
        nodes: [
          { id: 'trig', kind: 'trigger', label: 'Start Trigger', config: {} },
          { id: 'act-self', kind: 'activity', label: 'Self Looping Activity', config: {} },
        ],
        edges: [
          { id: 'e1', source: 'trig', target: 'act-self' },
          { id: 'e_self', source: 'act-self', target: 'act-self' },
        ],
      };

      const result = validateDagGraph(selfLoopDag);
      assert.equal(result.isValid, false, 'Self loop must invalidate DAG');
      assert.equal(result.hasCycle, true, 'hasCycle flag must be true');
      assert.ok(
        result.issues.some(
          (i) => i.level === 'error' && i.message.includes('Ciclo detectado') && i.nodeId === 'act-self'
        ),
        'Reports cycle error with nodeId act-self'
      );
    });

    it('detects direct 2-node cycle (A -> B -> A)', () => {
      const twoNodeCycleDag: WorkflowDagGraphV1 = {
        nodes: [
          { id: 'trig', kind: 'trigger', label: 'Trigger', config: {} },
          { id: 'nodeA', kind: 'activity', label: 'Node A', config: {} },
          { id: 'nodeB', kind: 'activity', label: 'Node B', config: {} },
        ],
        edges: [
          { id: 'e1', source: 'trig', target: 'nodeA' },
          { id: 'e2', source: 'nodeA', target: 'nodeB' },
          { id: 'e3', source: 'nodeB', target: 'nodeA' },
        ],
      };

      const result = validateDagGraph(twoNodeCycleDag);
      assert.equal(result.isValid, false);
      assert.equal(result.hasCycle, true);
      assert.ok(result.issues.some((i) => i.message.includes('Ciclo detectado')));
    });

    it('detects complex multi-node cycle (A -> B -> C -> D -> A)', () => {
      const multiCycleDag: WorkflowDagGraphV1 = {
        nodes: [
          { id: 'trig', kind: 'trigger', config: {} },
          { id: 'nA', kind: 'activity', config: {} },
          { id: 'nB', kind: 'activity', config: {} },
          { id: 'nC', kind: 'activity', config: {} },
          { id: 'nD', kind: 'activity', config: {} },
        ],
        edges: [
          { id: 'e1', source: 'trig', target: 'nA' },
          { id: 'e2', source: 'nA', target: 'nB' },
          { id: 'e3', source: 'nB', target: 'nC' },
          { id: 'e4', source: 'nC', target: 'nD' },
          { id: 'e5', source: 'nD', target: 'nA' },
        ],
      };

      const result = validateDagGraph(multiCycleDag);
      assert.equal(result.isValid, false);
      assert.equal(result.hasCycle, true);
    });

    it('detects nested cycle inside a branching condition while other branch is valid', () => {
      const branchedCycleDag: WorkflowDagGraphV1 = {
        nodes: [
          { id: 'trig', kind: 'trigger', config: {} },
          { id: 'cond', kind: 'condition', config: {} },
          { id: 'cleanEnd', kind: 'end', config: {} },
          { id: 'cycleA', kind: 'activity', config: {} },
          { id: 'cycleB', kind: 'activity', config: {} },
        ],
        edges: [
          { id: 'e1', source: 'trig', target: 'cond' },
          { id: 'e_false', source: 'cond', target: 'cleanEnd', sourceHandle: 'false' },
          { id: 'e_true', source: 'cond', target: 'cycleA', sourceHandle: 'true' },
          { id: 'e_cycle1', source: 'cycleA', target: 'cycleB' },
          { id: 'e_cycle2', source: 'cycleB', target: 'cycleA' },
        ],
      };

      const result = validateDagGraph(branchedCycleDag);
      assert.equal(result.isValid, false);
      assert.equal(result.hasCycle, true);
    });

    it('detects disconnected cycle in an independent subgraph forest', () => {
      const disconnectedForestDag: WorkflowDagGraphV1 = {
        nodes: [
          { id: 'trig', kind: 'trigger', config: {} },
          { id: 'mainEnd', kind: 'end', config: {} },
          // Independent disconnected cycle
          { id: 'ghost1', kind: 'activity', config: {} },
          { id: 'ghost2', kind: 'activity', config: {} },
        ],
        edges: [
          { id: 'e_main', source: 'trig', target: 'mainEnd' },
          { id: 'e_g1', source: 'ghost1', target: 'ghost2' },
          { id: 'e_g2', source: 'ghost2', target: 'ghost1' },
        ],
      };

      const result = validateDagGraph(disconnectedForestDag);
      assert.equal(result.isValid, false);
      assert.equal(result.hasCycle, true);
      assert.ok(result.issues.some((i) => i.message.includes('Ciclo detectado')));
    });

    it('detects terminal EndNode pointing backwards to root trigger', () => {
      const terminalBackDag: WorkflowDagGraphV1 = {
        nodes: [
          { id: 'trig', kind: 'trigger', config: {} },
          { id: 'act', kind: 'activity', config: {} },
          { id: 'end', kind: 'end', config: {} },
        ],
        edges: [
          { id: 'e1', source: 'trig', target: 'act' },
          { id: 'e2', source: 'act', target: 'end' },
          { id: 'e3_back', source: 'end', target: 'trig' },
        ],
      };

      const result = validateDagGraph(terminalBackDag);
      assert.equal(result.isValid, false);
      assert.equal(result.hasCycle, true);
    });

    it('identifies completely disconnected orphan nodes (0 in, 0 out)', () => {
      const orphanDag: WorkflowDagGraphV1 = {
        nodes: [
          { id: 'trig', kind: 'trigger', label: 'Active Trigger', config: {} },
          { id: 'sink', kind: 'end', label: 'Active End', config: {} },
          { id: 'orphanA', kind: 'activity', label: 'Floating Node A', config: {} },
          { id: 'orphanB', kind: 'delay', label: 'Floating Node B', config: {} },
        ],
        edges: [
          { id: 'e1', source: 'trig', target: 'sink' },
        ],
      };

      const result = validateDagGraph(orphanDag);
      assert.equal(result.isValid, true, 'Warnings alone do not invalidate graph');
      assert.equal(result.warningCount, 2);
      assert.deepEqual([...result.orphanNodeIds].sort(), ['orphanA', 'orphanB'].sort());
    });

    it('safely handles edges with dangling non-existent node references without throwing', () => {
      const danglingDag: WorkflowDagGraphV1 = {
        nodes: [
          { id: 'trig', kind: 'trigger', config: {} },
          { id: 'act', kind: 'activity', config: {} },
        ],
        edges: [
          { id: 'e_valid', source: 'trig', target: 'act' },
          { id: 'e_dangling_src', source: 'non-existent-source', target: 'act' },
          { id: 'e_dangling_tgt', source: 'act', target: 'non-existent-target' },
        ],
      };

      const result = validateDagGraph(danglingDag);
      assert.equal(result.isValid, false);
      assert.ok(result.issues.some((i) => i.message.includes("'non-existent-source' no existe")));
      assert.ok(result.issues.some((i) => i.message.includes("'non-existent-target' no existe")));
    });

    it('supports multiple root triggers seamlessly', () => {
      const multiTriggerDag: WorkflowDagGraphV1 = {
        nodes: [
          { id: 'trig-webhook', kind: 'trigger', label: 'Webhook Ingress', config: {} },
          { id: 'trig-cron', kind: 'trigger', label: 'Cron Timer', config: {} },
          { id: 'commonAct', kind: 'activity', label: 'Shared Worker', config: {} },
        ],
        edges: [
          { id: 'e1', source: 'trig-webhook', target: 'commonAct' },
          { id: 'e2', source: 'trig-cron', target: 'commonAct' },
        ],
      };

      const result = validateDagGraph(multiTriggerDag);
      assert.equal(result.isValid, true);
      assert.equal(result.errorCount, 0);
      assert.equal(result.hasCycle, false);
    });
  });

  // =========================================================================
  // SECTION 2: Diamond DAG Reconvergences & Infinite Recursion Prevention
  // =========================================================================
  describe('2. Diamond DAG Reconvergences (buildTreeFromDag)', () => {
    it('handles canonical diamond DAG (Trigger -> Cond -> [True, False] -> Reconverge -> End) without infinite recursion', () => {
      const diamondNodes: WorkflowNodeDefinitionV1[] = [
        { id: 'n_trig', kind: 'trigger', label: 'Ingress Webhook', config: {} },
        { id: 'n_cond', kind: 'condition', label: 'Check Threshold', config: {} },
        { id: 'n_true_act', kind: 'activity', label: 'High Priority Action', config: {} },
        { id: 'n_false_act', kind: 'activity', label: 'Low Priority Action', config: {} },
        { id: 'n_reconverge', kind: 'activity', label: 'Common Processor', config: {} },
        { id: 'n_end', kind: 'end', label: 'Finish Pipeline', config: {} },
      ];

      const diamondEdges: WorkflowEdgeDefinitionV1[] = [
        { id: 'e0', source: 'n_trig', target: 'n_cond' },
        { id: 'e_true', source: 'n_cond', target: 'n_true_act', sourceHandle: 'true', label: 'True Branch' },
        { id: 'e_false', source: 'n_cond', target: 'n_false_act', sourceHandle: 'false', label: 'False Branch' },
        { id: 'e_true_conv', source: 'n_true_act', target: 'n_reconverge' },
        { id: 'e_false_conv', source: 'n_false_act', target: 'n_reconverge' },
        { id: 'e_sink', source: 'n_reconverge', target: 'n_end' },
      ];

      const tree = buildTreeFromDag(diamondNodes, diamondEdges, 'n_reconverge', new Set());

      // Helper to collect all items recursively
      function flattenTree(items: readonly OutlineTreeItem[]): OutlineTreeItem[] {
        const flat: OutlineTreeItem[] = [];
        for (const item of items) {
          flat.push(item);
          if (item.children && item.children.length > 0) {
            flat.push(...flattenTree(item.children));
          }
        }
        return flat;
      }

      const allItems = flattenTree(tree);

      // Verify termination and reconvergence representation
      const reconvergenceItems = allItems.filter((i) => i.isReconvergence);
      assert.equal(reconvergenceItems.length, 1, 'Exactly 1 reconvergence node created for diamond convergence');

      const reconItem = reconvergenceItems[0];
      assert.equal(reconItem.nodeId, 'n_reconverge');
      assert.equal(reconItem.children.length, 0, 'Reconvergence node must have 0 children (no recursion)');
      assert.equal(reconItem.hasChildren, false);
      assert.ok(reconItem.label.includes('↳ Continúa en Common Processor'));
      assert.equal(reconItem.isSelected, true, 'Preserves selected state');

      // Verify the original instance of the reconverged node has its children (n_end)
      const primaryItems = allItems.filter((i) => i.nodeId === 'n_reconverge' && !i.isReconvergence);
      assert.equal(primaryItems.length, 1, 'Exactly 1 primary instance of reconverged node');
      assert.equal(primaryItems[0].children[0].nodeId, 'n_end', 'Primary instance preserves children');
    });

    it('handles multi-tier nested diamond DAGs with multiple reconvergence points', () => {
      // Structure:
      // Trig -> Cond1
      //   Cond1 (True) -> Cond2
      //     Cond2 (True) -> ActA -> MidConv
      //     Cond2 (False) -> ActB -> MidConv
      //   Cond1 (False) -> ActC -> FinalSink
      // MidConv -> FinalSink
      const nestedNodes: WorkflowNodeDefinitionV1[] = [
        { id: 't', kind: 'trigger', label: 'T', config: {} },
        { id: 'c1', kind: 'condition', label: 'C1', config: {} },
        { id: 'c2', kind: 'condition', label: 'C2', config: {} },
        { id: 'actA', kind: 'activity', label: 'ActA', config: {} },
        { id: 'actB', kind: 'activity', label: 'ActB', config: {} },
        { id: 'actC', kind: 'activity', label: 'ActC', config: {} },
        { id: 'midConv', kind: 'activity', label: 'MidConv', config: {} },
        { id: 'finalSink', kind: 'end', label: 'FinalSink', config: {} },
      ];

      const nestedEdges: WorkflowEdgeDefinitionV1[] = [
        { id: 'e1', source: 't', target: 'c1' },
        { id: 'e2', source: 'c1', target: 'c2', sourceHandle: 'true' },
        { id: 'e3', source: 'c1', target: 'actC', sourceHandle: 'false' },
        { id: 'e4', source: 'c2', target: 'actA', sourceHandle: 'true' },
        { id: 'e5', source: 'c2', target: 'actB', sourceHandle: 'false' },
        { id: 'e6', source: 'actA', target: 'midConv' },
        { id: 'e7', source: 'actB', target: 'midConv' },
        { id: 'e8', source: 'midConv', target: 'finalSink' },
        { id: 'e9', source: 'actC', target: 'finalSink' },
      ];

      const tree = buildTreeFromDag(nestedNodes, nestedEdges, null, new Set());

      function countReconvergences(items: readonly OutlineTreeItem[]): number {
        let count = 0;
        for (const item of items) {
          if (item.isReconvergence) count++;
          count += countReconvergences(item.children);
        }
        return count;
      }

      const totalReconvergences = countReconvergences(tree);
      // midConv has 1 reconvergence (from actB), and finalSink has 1 reconvergence (from actC)
      assert.equal(totalReconvergences, 2, 'Detects both nested reconvergences');
    });

    it('handles symmetric triple-fork reconvergence (3 paths into 1 sink)', () => {
      const tripleForkNodes: WorkflowNodeDefinitionV1[] = [
        { id: 't', kind: 'trigger', label: 'Trigger', config: {} },
        { id: 'p1', kind: 'activity', label: 'Branch 1', config: {} },
        { id: 'p2', kind: 'activity', label: 'Branch 2', config: {} },
        { id: 'p3', kind: 'activity', label: 'Branch 3', config: {} },
        { id: 'sink', kind: 'end', label: 'Common Sink', config: {} },
      ];

      const tripleForkEdges: WorkflowEdgeDefinitionV1[] = [
        { id: 'e1', source: 't', target: 'p1' },
        { id: 'e2', source: 't', target: 'p2' },
        { id: 'e3', source: 't', target: 'p3' },
        { id: 'es1', source: 'p1', target: 'sink' },
        { id: 'es2', source: 'p2', target: 'sink' },
        { id: 'es3', source: 'p3', target: 'sink' },
      ];

      const tree = buildTreeFromDag(tripleForkNodes, tripleForkEdges, null, new Set());

      function findNodesById(items: readonly OutlineTreeItem[], id: string): OutlineTreeItem[] {
        const result: OutlineTreeItem[] = [];
        for (const item of items) {
          if (item.nodeId === id) result.push(item);
          result.push(...findNodesById(item.children, id));
        }
        return result;
      }

      const sinkItems = findNodesById(tree, 'sink');
      assert.equal(sinkItems.length, 3, 'Sink referenced from all 3 branches');
      assert.equal(sinkItems.filter((s) => !s.isReconvergence).length, 1, '1 primary instance');
      assert.equal(sinkItems.filter((s) => s.isReconvergence).length, 2, '2 reconvergence pointers');
    });

    it('terminates immediately and safely when cycle is combined with diamond reconvergence', () => {
      const cyclicDiamondNodes: WorkflowNodeDefinitionV1[] = [
        { id: 't', kind: 'trigger', label: 'Trigger', config: {} },
        { id: 'c', kind: 'condition', label: 'Condition', config: {} },
        { id: 'a', kind: 'activity', label: 'A', config: {} },
        { id: 'b', kind: 'activity', label: 'B', config: {} },
        { id: 'conv', kind: 'activity', label: 'Conv', config: {} },
      ];

      const cyclicDiamondEdges: WorkflowEdgeDefinitionV1[] = [
        { id: 'e1', source: 't', target: 'c' },
        { id: 'e2', source: 'c', target: 'a' },
        { id: 'e3', source: 'c', target: 'b' },
        { id: 'e4', source: 'a', target: 'conv' },
        { id: 'e5', source: 'b', target: 'conv' },
        { id: 'e_back', source: 'conv', target: 'c' }, // Back cycle to ancestor!
      ];

      const startTime = performance.now();
      const tree = buildTreeFromDag(cyclicDiamondNodes, cyclicDiamondEdges, null, new Set());
      const elapsed = performance.now() - startTime;

      assert.ok(elapsed < 200, `Must complete in < 200ms without loop freeze (took ${elapsed.toFixed(1)}ms)`);
      assert.ok(tree.length > 0);
    });

    it('groups unreachable islands of connected subgraphs under orphan group', () => {
      const disconnectedIslandNodes: WorkflowNodeDefinitionV1[] = [
        { id: 'trig', kind: 'trigger', label: 'Trigger', config: {} },
        { id: 'mainEnd', kind: 'end', label: 'Main End', config: {} },
        // Disconnected island: island1 -> island2
        { id: 'island1', kind: 'activity', label: 'Island One', config: {} },
        { id: 'island2', kind: 'activity', label: 'Island Two', config: {} },
      ];

      const disconnectedIslandEdges: WorkflowEdgeDefinitionV1[] = [
        { id: 'e1', source: 'trig', target: 'mainEnd' },
        { id: 'e_island', source: 'island1', target: 'island2' },
      ];

      const tree = buildTreeFromDag(disconnectedIslandNodes, disconnectedIslandEdges, null, new Set());

      const orphanGroup = tree.find((item) => item.id === 'tree-item-group-orphans');
      assert.ok(orphanGroup, 'Unreachable island nodes are collected into orphan folder');
      assert.equal(orphanGroup.children.length, 2, 'Contains both island nodes');
      assert.ok(orphanGroup.children.some((c) => c.nodeId === 'island1'));
      assert.ok(orphanGroup.children.some((c) => c.nodeId === 'island2'));
    });

    it('survives deep linear chain (100 nodes) without recursion overflow', () => {
      const CHAIN_LENGTH = 100;
      const nodes: WorkflowNodeDefinitionV1[] = [
        { id: 'node_0', kind: 'trigger', label: 'Start 0', config: {} },
      ];
      const edges: WorkflowEdgeDefinitionV1[] = [];

      for (let i = 1; i < CHAIN_LENGTH; i++) {
        nodes.push({ id: `node_${i}`, kind: 'activity', label: `Step ${i}`, config: {} });
        edges.push({ id: `edge_${i - 1}_${i}`, source: `node_${i - 1}`, target: `node_${i}` });
      }

      const tree = buildTreeFromDag(nodes, edges, null, new Set());
      assert.equal(tree.length, 1);

      // Traverse depth
      let current: OutlineTreeItem = tree[0];
      let depth = 1;
      while (current.children && current.children.length > 0) {
        current = current.children[0];
        depth++;
      }

      assert.equal(depth, CHAIN_LENGTH, 'Deep chain fully traversed to depth 100');
    });
  });

  // =========================================================================
  // SECTION 3: Viewport Transform & Extreme Zoom / Coordinate Math
  // =========================================================================
  describe('3. Viewport Transform & Extreme Zoom / Coordinate Math', () => {
    it('strictly clamps extreme zoom levels within [0.4, 2.0]', () => {
      const clampZoom = (z: number) => Math.min(2.0, Math.max(0.4, z));

      // Underflow tests
      assert.equal(clampZoom(-100), 0.4);
      assert.equal(clampZoom(-0.001), 0.4);
      assert.equal(clampZoom(0), 0.4);
      assert.equal(clampZoom(0.0001), 0.4);
      assert.equal(clampZoom(0.3999), 0.4);

      // Exact boundaries
      assert.equal(clampZoom(0.4), 0.4);
      assert.equal(clampZoom(1.0), 1.0);
      assert.equal(clampZoom(2.0), 2.0);

      // Overflow tests
      assert.equal(clampZoom(2.0001), 2.0);
      assert.equal(clampZoom(5.0), 2.0);
      assert.equal(clampZoom(100.0), 2.0);
      assert.equal(clampZoom(1e6), 2.0);
    });

    it('accurately computes cursor-centered zoom offsets across different anchor points', () => {
      const calcZoomPan = (
        cursorX: number,
        cursorY: number,
        curPanX: number,
        curPanY: number,
        curZoom: number,
        targetZoom: number
      ) => {
        const factor = targetZoom / curZoom;
        const nextPanX = cursorX - (cursorX - curPanX) * factor;
        const nextPanY = cursorY - (cursorY - curPanY) * factor;
        return { x: Math.round(nextPanX), y: Math.round(nextPanY) };
      };

      // 1. Center of 800x600 viewport at (400, 300) zooming from 1.0 to 2.0
      const centerZoom = calcZoomPan(400, 300, 0, 0, 1.0, 2.0);
      // nextPanX = 400 - (400 - 0) * 2 = 400 - 800 = -400
      // nextPanY = 300 - (300 - 0) * 2 = 300 - 600 = -300
      assert.deepEqual(centerZoom, { x: -400, y: -300 });

      // 2. Top-left corner at (0, 0) zooming from 1.0 to 1.5
      const cornerZoom = calcZoomPan(0, 0, 100, 50, 1.0, 1.5);
      // nextPanX = 0 - (0 - 100) * 1.5 = 150
      // nextPanY = 0 - (0 - 50) * 1.5 = 75
      assert.deepEqual(cornerZoom, { x: 150, y: 75 });

      // 3. Zooming out from 2.0 to 0.4 (factor = 0.2)
      const zoomOut = calcZoomPan(400, 300, -400, -300, 2.0, 0.4);
      // nextPanX = 400 - (400 - (-400)) * 0.2 = 400 - 800 * 0.2 = 400 - 160 = 240
      // nextPanY = 300 - (300 - (-300)) * 0.2 = 300 - 600 * 0.2 = 300 - 120 = 180
      assert.deepEqual(zoomOut, { x: 240, y: 180 });
    });

    it('correctly handles extreme negative pan coordinates without NaN or CSS errors', () => {
      const extremeViewport = {
        pan: { x: -50000, y: -90000 },
        zoom: 0.4,
      };

      const html = renderToStaticMarkup(
        React.createElement(CanvasViewport, {
          viewport: extremeViewport,
          onViewportChange: () => {},
          svgEdgesLayer: React.createElement('svg', {}),
          children: React.createElement('div', { id: 'child-marker' }),
        })
      );

      assert.ok(html.includes('transform:translate(-50000px, -90000px) scale(0.4)'));
      assert.ok(html.includes('patternTransform="translate(-3.1999'), 'SVG modulo pattern renders cleanly');
      assert.ok(!html.includes('NaN'), 'Zero NaN values in rendered HTML');
      assert.ok(!html.includes('undefined'), 'Zero undefined values in rendered HTML');
    });

    it('correctly auto-centers viewport onto nodes with large negative coordinates', () => {
      const NODE_W = 240;
      const NODE_H = 96;
      const viewportCenterX = 400;
      const viewportCenterY = 300;
      const zoom = 1.0;

      // Node placed at (-1200, -800)
      const targetPos = { x: -1200, y: -800 };
      const targetX = targetPos.x + NODE_W / 2; // -1200 + 120 = -1080
      const targetY = targetPos.y + NODE_H / 2; // -800 + 48 = -752

      const nextPanX = Math.round(viewportCenterX - targetX * zoom); // 400 - (-1080) = 1480
      const nextPanY = Math.round(viewportCenterY - targetY * zoom); // 300 - (-752) = 1052

      assert.equal(nextPanX, 1480);
      assert.equal(nextPanY, 1052);
    });
  });

  // =========================================================================
  // SECTION 4: Cubic Bezier Curve Math & Edge Geometry Edge Cases
  // =========================================================================
  describe('4. Cubic Bezier Curve Math & Edge Geometry (computeBezierCurve)', () => {
    it('handles coincident nodes (dx = 0, dy = 0) with minimum curvature fallback', () => {
      const x = 300;
      const y = 200;
      const { pathData, midX, midY } = computeBezierCurve(x, y, x, y);

      assert.equal(midX, x);
      assert.equal(midY, y);
      assert.equal(pathData, `M ${x} ${y} C ${x + 48} ${y}, ${x - 48} ${y}, ${x} ${y}`);
      assert.ok(!pathData.includes('NaN'));
    });

    it('handles backward connections (target.x < source.x) with proper control point loops', () => {
      // Source node is at x=700, target node is to the left at x=200
      const x1 = 700;
      const y1 = 150;
      const x2 = 200;
      const y2 = 350;

      const { pathData, midX, midY } = computeBezierCurve(x1, y1, x2, y2);
      const dx = Math.abs(x2 - x1); // 500
      const curvature = Math.max(0.5 * dx, 48); // 250

      assert.equal(curvature, 250);
      assert.equal(midX, 450);
      assert.equal(midY, 250);
      // cp1x = 700 + 250 = 950 (loops right from output)
      // cp2x = 200 - 250 = -50 (loops in from left to target input)
      assert.equal(pathData, `M 700 150 C 950 150, -50 350, 200 350`);
      assert.ok(!pathData.includes('NaN'));
    });

    it('handles perfectly vertical alignment (dx = 0, dy != 0)', () => {
      const x = 400;
      const y1 = 100;
      const y2 = 600;

      const { pathData, midX, midY } = computeBezierCurve(x, y1, x, y2);
      assert.equal(midX, 400);
      assert.equal(midY, 350);
      // dx = 0 => curvature = 48
      assert.equal(pathData, `M 400 100 C 448 100, 352 600, 400 600`);
    });

    it('handles high-magnitude floating point coordinates accurately', () => {
      const x1 = 10000000.5;
      const y1 = 20000000.5;
      const x2 = 30000000.5;
      const y2 = 40000000.5;

      const { pathData, midX, midY } = computeBezierCurve(x1, y1, x2, y2);
      assert.equal(midX, 20000000.5);
      assert.equal(midY, 30000000.5);
      assert.ok(pathData.startsWith(`M ${x1} ${y1} C `));
      assert.ok(!pathData.includes('NaN'));
    });

    it('renders StudioEdge with condition true/false handle offsets even with coincident card positions', () => {
      // Both source and target cards share position (100, 100)
      const sourcePos = { x: 100, y: 100 };
      const targetPos = { x: 100, y: 100 };

      // True handle (sourceKind condition)
      // sourceX = 100 + 240 = 340, sourceY = 100 + 34 = 134
      // targetX = 100, targetY = 100 + 48 = 148
      const htmlTrue = renderToStaticMarkup(
        React.createElement('svg', {},
          React.createElement(StudioEdge, {
            edge: {
              id: 'edge_coincident',
              source: 'cond-1',
              target: 'cond-1',
              sourceHandle: 'true',
              condition: 'true',
              label: 'True Loop',
            },
            sourcePos,
            targetPos,
            sourceKind: 'condition',
          })
        )
      );

      assert.ok(htmlTrue.includes('d="M 340 134 C'), 'True handle starts at (340, 134)');
      assert.ok(htmlTrue.includes('100 148'), 'Target port ends at (100, 148)');
      assert.ok(htmlTrue.includes('True Loop'), 'Renders badge label');
      assert.ok(!htmlTrue.includes('NaN'), 'No NaN in rendered SVG');
    });
  });

  // =========================================================================
  // SECTION 5: Randomized Property-Based Fuzzing & Degenerate Cases
  // =========================================================================
  describe('5. Randomized Property-Based Fuzzing & Degenerate Topologies', () => {
    it('generates 10 random valid DAGs and asserts all pass validation and tree projection', () => {
      // Deterministic PRNG seed for reproducible fuzzing
      let seed = 42;
      const rnd = () => {
        seed = (seed * 16807) % 2147483647;
        return (seed - 1) / 2147483646;
      };

      for (let run = 0; run < 10; run++) {
        const nodeCount = 5 + Math.floor(rnd() * 8); // 5 to 12 nodes
        const nodes: WorkflowNodeDefinitionV1[] = [
          { id: 'fuzz_trig', kind: 'trigger', label: 'Fuzz Trigger', config: {} },
        ];

        for (let i = 1; i < nodeCount; i++) {
          const kind = i === nodeCount - 1 ? 'end' : rnd() > 0.5 ? 'activity' : 'condition';
          nodes.push({ id: `fuzz_node_${i}`, kind, label: `Fuzz Node ${i}`, config: {} });
        }

        // Connect strictly forwards (i < j) to guarantee DAG acyclicity
        const edges: WorkflowEdgeDefinitionV1[] = [];
        let edgeId = 0;
        for (let i = 0; i < nodeCount - 1; i++) {
          // At least connect i -> i + 1
          edges.push({ id: `e_${edgeId++}`, source: nodes[i].id, target: nodes[i + 1].id });

          // Optional random forward bypass / diamond reconvergence edge
          if (i + 2 < nodeCount && rnd() > 0.6) {
            edges.push({ id: `e_${edgeId++}`, source: nodes[i].id, target: nodes[i + 2].id });
          }
        }

        const validDag: WorkflowDagGraphV1 = { nodes, edges };

        // 1. Validation check
        const valResult = validateDagGraph(validDag);
        assert.equal(valResult.isValid, true, `Generated DAG #${run} must be valid`);
        assert.equal(valResult.hasCycle, false, `Generated DAG #${run} must have no cycles`);
        assert.equal(valResult.errorCount, 0);

        // 2. Tree projection check
        const t0 = performance.now();
        const tree = buildTreeFromDag(nodes, edges, null, new Set());
        const tElapsed = performance.now() - t0;

        assert.ok(tElapsed < 50, `Tree projection #${run} took ${tElapsed.toFixed(2)}ms (< 50ms)`);
        assert.ok(tree.length > 0, `Tree #${run} has root`);

        // 3. Mutate: Inject backward cycle edge (descendant -> ancestor)
        const cyclicEdges = [
          ...edges,
          { id: 'e_injected_cycle', source: nodes[nodeCount - 1].id, target: nodes[0].id },
        ];
        const cyclicDag: WorkflowDagGraphV1 = { nodes, edges: cyclicEdges };

        const cyclicValResult = validateDagGraph(cyclicDag);
        assert.equal(cyclicValResult.isValid, false, `Cyclic DAG #${run} must fail validation`);
        assert.equal(cyclicValResult.hasCycle, true, `Cyclic DAG #${run} must report cycle`);

        // 4. Assert tree projection still terminates cleanly despite cycle
        const t1 = performance.now();
        const cyclicTree = buildTreeFromDag(nodes, cyclicEdges, null, new Set());
        const t1Elapsed = performance.now() - t1;

        assert.ok(t1Elapsed < 50, `Cyclic tree #${run} terminated in ${t1Elapsed.toFixed(2)}ms`);
        assert.ok(cyclicTree.length > 0);
      }
    });

    it('safely handles degenerate empty and single-node inputs in buildTreeFromDag', () => {
      assert.deepEqual(buildTreeFromDag([], [], null, new Set()), []);

      const singleNode: WorkflowNodeDefinitionV1[] = [
        { id: 'solo', kind: 'activity', label: 'Solo Node', config: {} },
      ];
      const singleTree = buildTreeFromDag(singleNode, [], null, new Set());
      assert.equal(singleTree.length, 1);
      assert.equal(singleTree[0].nodeId, 'solo');
      assert.equal(singleTree[0].level, 1);
      assert.equal(singleTree[0].children.length, 0);
    });

    it('handles multiple triggers that reconverge into the same shared step', () => {
      const dualTriggerDag: WorkflowDagGraphV1 = {
        nodes: [
          { id: 'trig1', kind: 'trigger', label: 'Trigger Webhook', config: {} },
          { id: 'trig2', kind: 'trigger', label: 'Trigger Cron', config: {} },
          { id: 'sharedStep', kind: 'activity', label: 'Shared Activity', config: {} },
          { id: 'sharedEnd', kind: 'end', label: 'End Step', config: {} },
        ],
        edges: [
          { id: 'e1', source: 'trig1', target: 'sharedStep' },
          { id: 'e2', source: 'trig2', target: 'sharedStep' },
          { id: 'e3', source: 'sharedStep', target: 'sharedEnd' },
        ],
      };

      const val = validateDagGraph(dualTriggerDag);
      assert.equal(val.isValid, true);
      assert.equal(val.hasCycle, false);

      const tree = buildTreeFromDag(dualTriggerDag.nodes, dualTriggerDag.edges, null, new Set());
      assert.equal(tree.length, 2, '2 root tree items for 2 triggers');
      assert.equal(tree[0].nodeId, 'trig1');
      assert.equal(tree[1].nodeId, 'trig2');

      // First trigger traverses sharedStep fully
      assert.equal(tree[0].children[0].nodeId, 'sharedStep');
      assert.equal(tree[0].children[0].isReconvergence, false);

      // Second trigger encounters already visited sharedStep and marks reconvergence
      assert.equal(tree[1].children[0].nodeId, 'sharedStep');
      assert.equal(tree[1].children[0].isReconvergence, true);
    });

    it('handles duplicate outgoing edges to the same target node gracefully', () => {
      const duplicateEdgesDag: WorkflowDagGraphV1 = {
        nodes: [
          { id: 'trig', kind: 'trigger', label: 'Trigger', config: {} },
          { id: 'act', kind: 'activity', label: 'Activity', config: {} },
        ],
        edges: [
          { id: 'e_dup1', source: 'trig', target: 'act' },
          { id: 'e_dup2', source: 'trig', target: 'act' }, // Duplicate edge
        ],
      };

      const tree = buildTreeFromDag(duplicateEdgesDag.nodes, duplicateEdgesDag.edges, null, new Set());
      const root = tree[0];
      assert.equal(root.children.length, 2, 'Both edges evaluated');
      assert.equal(root.children[0].isReconvergence, false, 'First traversal is primary');
      assert.equal(root.children[1].isReconvergence, true, 'Second traversal flags reconvergence');
    });
  });
});

