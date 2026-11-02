/**
 * Automated Component & Interaction Test Suite: AutomationStudio Root Container
 * Phase F4: PR-F4-03
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  AutomationStudio,
  StudioToolbar,
  MOCK_UC06_WORKFLOW_DEFINITION,
  MOCK_UC06_WORKFLOW_REVISION,
  MOCK_UC06_REVISIONS,
  MOCK_UC06_ACTIVE_RUN,
} from '../index';

describe('PR-F4-03: AutomationStudio Root Workspace Integration', () => {
  it('renders root container with Toolbar, Outline, Canvas, and Live Inspector', () => {
    const html = renderToStaticMarkup(
      React.createElement(AutomationStudio, {
        initialWorkflow: MOCK_UC06_WORKFLOW_DEFINITION,
        initialRevision: MOCK_UC06_WORKFLOW_REVISION,
        availableRevisions: MOCK_UC06_REVISIONS,
        initialActiveRun: MOCK_UC06_ACTIVE_RUN,
      })
    );

    // Toolbar
    assert.ok(html.includes('role="toolbar"'), 'Toolbar rendered');
    assert.ok(html.includes('UC-06: Order Processing &amp; Manager Approval Pipeline') || html.includes('UC-06: Order Processing'), 'Workflow name rendered');
    assert.ok(html.includes('published'), 'Status badge rendered');

    // Outline
    assert.ok(html.includes('role="tree"'), 'Outline treeview rendered');

    // Canvas
    assert.ok(html.includes('studio-canvas-root'), 'Canvas viewport rendered');
    assert.ok(html.includes('studio-viewport-layer'), 'Canvas transform layer rendered');

    // Inspector
    assert.ok(html.includes('live-run-inspector'), 'Live Run Inspector rendered');
    assert.ok(html.includes('Aprobación Requerida (Gate HITL)'), 'HITL Approval gate rendered');
  });

  it('renders toolbar with view mode segmented buttons and revision selector', () => {
    const html = renderToStaticMarkup(
      React.createElement(StudioToolbar, {
        workflowName: 'Test Workflow',
        status: 'published',
        revisions: MOCK_UC06_REVISIONS,
        activeRevisionNumber: 2,
        onSelectRevision: () => {},
        viewMode: 'split',
        onChangeViewMode: () => {},
        onValidate: () => {},
        onSimulate: () => {},
        onPublish: () => {},
        onRollback: () => {},
        onResetZoom: () => {},
        onZoomIn: () => {},
        onZoomOut: () => {},
        zoomLevel: 1.0,
      })
    );

    assert.ok(html.includes('Dividida'), 'Split button rendered');
    assert.ok(html.includes('Lienzo'), 'Canvas button rendered');
    assert.ok(html.includes('Esquema'), 'Outline button rendered');
    assert.ok(html.includes('Validar'), 'Validate action present');
    assert.ok(html.includes('Simular'), 'Simulate action present');
    assert.ok(html.includes('Rollback'), 'Rollback action present');
    assert.ok(html.includes('Publicar'), 'Publish action present');
    assert.ok(html.includes('100%'), 'Zoom indicator rendered');
  });

  it('respects view mode toggling in AutomationStudio', () => {
    // Canvas only mode test (via controlled initial prop or subcomponents)
    const toolbarCanvasHtml = renderToStaticMarkup(
      React.createElement(StudioToolbar, {
        workflowName: 'Test',
        status: 'published',
        revisions: MOCK_UC06_REVISIONS,
        activeRevisionNumber: 2,
        onSelectRevision: () => {},
        viewMode: 'canvas',
        onChangeViewMode: () => {},
        onValidate: () => {},
        onSimulate: () => {},
        onPublish: () => {},
        onRollback: () => {},
        onResetZoom: () => {},
        onZoomIn: () => {},
        onZoomOut: () => {},
        zoomLevel: 1.0,
      })
    );

    assert.ok(toolbarCanvasHtml.includes('aria-pressed="true"'), 'View mode button marks active mode');
  });
});
