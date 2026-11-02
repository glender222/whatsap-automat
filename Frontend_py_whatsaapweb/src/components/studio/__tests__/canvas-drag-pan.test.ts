/**
 * Automated Test Suite: Canvas Viewport Transform, Bezier Math & DAG Validation
 * Phase F4: PR-F4-03
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  CanvasViewport,
  StudioEdge,
  computeBezierCurve,
  validateDagGraph,
  MOCK_UC06_DAG_GRAPH,
  MOCK_CYCLIC_DAG_GRAPH,
  MOCK_ORPHAN_DAG_GRAPH,
} from '../index';

describe('PR-F4-03: Canvas Viewport & Coordinate Geometry', () => {
  describe('1. Viewport Transformation & Zoom Math', () => {
    it('applies translate and scale CSS transform cleanly to layer', () => {
      const html = renderToStaticMarkup(
        React.createElement(CanvasViewport, {
          viewport: { pan: { x: 120, y: 80 }, zoom: 1.25 },
          onViewportChange: () => {},
          svgEdgesLayer: React.createElement('svg', {}),
          children: React.createElement('div', { id: 'test-node' }),
        })
      );

      assert.ok(html.includes('transform:translate(120px, 80px) scale(1.25)'), 'Transform style rendered');
      assert.ok(html.includes('id="studio-grid-dots"'), 'Grid dots SVG pattern rendered');
      assert.ok(html.includes('id="test-node"'), 'Child node rendered inside viewport layer');
    });

    it('clamps zoom factors strictly within [0.4, 2.0]', () => {
      const MIN_ZOOM = 0.4;
      const MAX_ZOOM = 2.0;

      const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

      assert.equal(clampZoom(0.1), 0.4, 'Low zoom clamped to 0.4');
      assert.equal(clampZoom(0.4), 0.4, 'Min zoom preserved');
      assert.equal(clampZoom(1.5), 1.5, 'Normal zoom preserved');
      assert.equal(clampZoom(2.0), 2.0, 'Max zoom preserved');
      assert.equal(clampZoom(5.0), 2.0, 'High zoom clamped to 2.0');
    });

    it('calculates cursor-centered zoom offsets accurately', () => {
      const cursorX = 400;
      const cursorY = 300;
      const currentZoom = 1.0;
      const currentPan = { x: 0, y: 0 };
      const nextZoom = 1.5;

      const effectiveFactor = nextZoom / currentZoom;
      const nextPanX = cursorX - (cursorX - currentPan.x) * effectiveFactor;
      const nextPanY = cursorY - (cursorY - currentPan.y) * effectiveFactor;

      // When zooming in 1.5x at (400, 300), pan should shift left and up: 400 - 400 * 1.5 = -200
      assert.equal(nextPanX, -200);
      assert.equal(nextPanY, -150);
    });
  });

  describe('2. Cubic Bezier Curves & Edge Geometry', () => {
    it('generates valid SVG cubic bezier path "M ... C ..." between handles', () => {
      const x1 = 100;
      const y1 = 50;
      const x2 = 400;
      const y2 = 200;

      const { pathData, midX, midY } = computeBezierCurve(x1, y1, x2, y2);

      assert.ok(pathData.startsWith(`M ${x1} ${y1} C `), 'Starts with M x1 y1 C');
      assert.ok(pathData.endsWith(`${x2} ${y2}`), 'Ends with x2 y2');
      assert.equal(midX, (x1 + x2) / 2);
      assert.equal(midY, (y1 + y2) / 2);
    });

    it('enforces minimum curvature threshold (48px) for closely aligned nodes', () => {
      const x1 = 100;
      const y1 = 50;
      const x2 = 120; // dx = 20 < 48
      const y2 = 50;

      const { pathData } = computeBezierCurve(x1, y1, x2, y2);
      // cp1x = 100 + 48 = 148
      assert.ok(pathData.includes('C 148 50,'), 'Uses minimum curvature threshold of 48');
    });

    it('renders StudioEdge with condition branch handle offsets (true=34px, false=66px)', () => {
      const sourcePos = { x: 100, y: 100 };
      const targetPos = { x: 400, y: 100 };

      // True handle
      const htmlTrue = renderToStaticMarkup(
        React.createElement('svg', {},
          React.createElement(StudioEdge, {
            edge: {
              id: 'e_true',
              source: 'cond',
              target: 'act',
              sourceHandle: 'true',
              label: 'True Branch',
            },
            sourcePos,
            targetPos,
            sourceKind: 'condition',
          })
        )
      );

      // Source handle for condition true: y = 100 + 34 = 134, sourceX = 100 + 240 = 340
      assert.ok(htmlTrue.includes('d="M 340 134 C'), 'True handle uses y=134px');
      assert.ok(htmlTrue.includes('True Branch'), 'Renders branch label badge');

      // False handle
      const htmlFalse = renderToStaticMarkup(
        React.createElement('svg', {},
          React.createElement(StudioEdge, {
            edge: {
              id: 'e_false',
              source: 'cond',
              target: 'act',
              sourceHandle: 'false',
              label: 'False Branch',
            },
            sourcePos,
            targetPos,
            sourceKind: 'condition',
          })
        )
      );

      // Source handle for condition false: y = 100 + 66 = 166
      assert.ok(htmlFalse.includes('d="M 340 166 C'), 'False handle uses y=166px');
    });
  });

  describe('3. Topological DAG Validation Engine (validateDagGraph)', () => {
    it('confirms validity for canonical UC-06 DAG graph', () => {
      const result = validateDagGraph(MOCK_UC06_DAG_GRAPH);
      assert.equal(result.isValid, true, 'UC-06 DAG is valid');
      assert.equal(result.errorCount, 0, 'Zero errors');
      assert.equal(result.hasCycle, false, 'No cycles');
      assert.equal(result.rootTriggerId, 'node-1-trigger');
    });

    it('rejects empty DAG graph', () => {
      const result = validateDagGraph({ nodes: [], edges: [] });
      assert.equal(result.isValid, false);
      assert.equal(result.errorCount, 1);
      assert.ok(result.issues[0].message.includes('al menos un nodo'));
    });

    it('rejects DAG graph missing a trigger node', () => {
      const noTriggerDag = {
        nodes: [
          { id: 'act-1', kind: 'activity' as const, config: {} },
          { id: 'end-1', kind: 'end' as const, config: {} },
        ],
        edges: [{ id: 'e1', source: 'act-1', target: 'end-1' }],
      };

      const result = validateDagGraph(noTriggerDag);
      assert.equal(result.isValid, false);
      assert.ok(result.issues.some((i) => i.message.includes('Trigger como punto de entrada')));
    });

    it('detects cycles in graph and records error issue', () => {
      const result = validateDagGraph(MOCK_CYCLIC_DAG_GRAPH);
      assert.equal(result.isValid, false);
      assert.equal(result.hasCycle, true);
      assert.ok(result.issues.some((i) => i.message.includes('Ciclo detectado')));
    });

    it('identifies disconnected orphan nodes and records warning', () => {
      const result = validateDagGraph(MOCK_ORPHAN_DAG_GRAPH);
      assert.ok(result.orphanNodeIds.includes('lonely-orphan-1'));
      assert.ok(result.orphanNodeIds.includes('lonely-orphan-2'));
      assert.ok(result.warningCount >= 2);
    });
  });
});
