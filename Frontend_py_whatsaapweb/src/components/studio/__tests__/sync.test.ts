/**
 * Automated Test Suite: Bidirectional Canvas-Outline Synchronization & Execution Sync
 * Phase F4: PR-F4-03
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  StudioCanvas,
  StudioOutline,
  MOCK_UC06_DAG_GRAPH,
  MOCK_UC06_ACTIVE_RUN,
  type WorkflowRunV1,
} from '../index';

describe('PR-F4-03: Bidirectional Selection & Execution Sync', () => {
  it('synchronizes selected node highlight from Canvas to Outline', () => {
    const selectedId = 'node-3-approval';

    // Render Canvas
    const canvasHtml = renderToStaticMarkup(
      React.createElement(StudioCanvas, {
        dagGraph: MOCK_UC06_DAG_GRAPH,
        selectedNodeId: selectedId,
        onSelectNode: () => {},
      })
    );

    // Canvas highlights selected node
    assert.ok(canvasHtml.includes('id="studio-node-node-3-approval"'));
    assert.ok(canvasHtml.includes('aria-selected="true"'));

    // Render Outline with same selectedId
    const outlineHtml = renderToStaticMarkup(
      React.createElement(StudioOutline, {
        dagGraph: MOCK_UC06_DAG_GRAPH,
        selectedNodeId: selectedId,
        onSelectNode: () => {},
      })
    );

    // Outline reflects aria-selected="true" on same item
    assert.ok(outlineHtml.includes('id="tree-item-node-3-approval"'));
    assert.ok(outlineHtml.includes('aria-selected="true"'));
  });

  it('synchronizes active execution step indicator simultaneously on Canvas and Outline', () => {
    const activeStepId = 'node-2-condition';
    const activeRun: WorkflowRunV1 = {
      ...MOCK_UC06_ACTIVE_RUN,
      currentStep: activeStepId,
      status: 'running',
    };

    // Render Canvas
    const canvasHtml = renderToStaticMarkup(
      React.createElement(StudioCanvas, {
        dagGraph: MOCK_UC06_DAG_GRAPH,
        selectedNodeId: null,
        onSelectNode: () => {},
        activeRun,
      })
    );

    // Canvas displays "Ejecutando" badge and pulse ring on active node
    assert.ok(canvasHtml.includes('Ejecutando'), 'Canvas displays executing badge');
    assert.ok(canvasHtml.includes('animate-pulse'), 'Canvas displays pulse animation');

    // Render Outline
    const outlineHtml = renderToStaticMarkup(
      React.createElement(StudioOutline, {
        dagGraph: MOCK_UC06_DAG_GRAPH,
        selectedNodeId: null,
        onSelectNode: () => {},
        activeRun,
      })
    );

    // Outline sets aria-current="step" on active item
    assert.ok(outlineHtml.includes('aria-current="step"'), 'Outline marks active step with aria-current="step"');
  });

  it('propagates node position updates faithfully in Canvas rendering', () => {
    const modifiedDag = {
      ...MOCK_UC06_DAG_GRAPH,
      nodes: MOCK_UC06_DAG_GRAPH.nodes.map((n) =>
        n.id === 'node-1-trigger' ? { ...n, position: { x: 950, y: 420 } } : n
      ),
    };

    const canvasHtml = renderToStaticMarkup(
      React.createElement(StudioCanvas, {
        dagGraph: modifiedDag,
        selectedNodeId: null,
        onSelectNode: () => {},
      })
    );

    assert.ok(canvasHtml.includes('left:950px;top:420px;'), 'Node rendered at new (950, 420) coordinates');
  });
});
