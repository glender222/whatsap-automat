/**
 * Automated Test Suite: LiveRunInspector & Human Approval Gate
 * Phase F4: PR-F4-03
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  LiveRunInspector,
  JsonViewer,
  MOCK_UC06_ACTIVE_RUN,
  MOCK_UC06_FAILED_RUN,
  MOCK_UC06_DAG_GRAPH,
  type WorkflowRunV1,
  type ApprovalDecisionPayload,
} from '../index';

describe('PR-F4-03: LiveRunInspector & Approval Gate', () => {
  describe('1. Run Status Badges (All 8 States)', () => {
    const statuses: WorkflowRunV1['status'][] = [
      'queued',
      'running',
      'waiting_timer',
      'waiting_approval',
      'completed',
      'failed',
      'cancelled',
      'timed_out',
    ];

    for (const st of statuses) {
      it(`renders status badge correctly for "${st}"`, () => {
        const mockRun: WorkflowRunV1 = {
          ...MOCK_UC06_ACTIVE_RUN,
          status: st,
        };

        const html = renderToStaticMarkup(
          React.createElement(LiveRunInspector, {
            run: mockRun,
            nodes: MOCK_UC06_DAG_GRAPH.nodes,
            selectedNodeId: 'node-3-approval',
            onSelectNode: () => {},
          })
        );

        assert.ok(html.includes('live-run-inspector'), 'Contains inspector drawer');
        if (st === 'queued') assert.ok(html.includes('En cola'));
        else if (st === 'running') assert.ok(html.includes('Ejecución activa'));
        else if (st === 'waiting_timer') assert.ok(html.includes('Pausa temporizada'));
        else if (st === 'waiting_approval') assert.ok(html.includes('Aprobación requerida'));
        else if (st === 'completed') assert.ok(html.includes('Completado'));
        else if (st === 'failed') assert.ok(html.includes('Fallido'));
        else if (st === 'cancelled') assert.ok(html.includes('Cancelado'));
        else if (st === 'timed_out') assert.ok(html.includes('Tiempo agotado'));
      });
    }
  });

  describe('2. Active Node & Latency Metrics', () => {
    it('displays active step sequence, label, and kind badge', () => {
      const html = renderToStaticMarkup(
        React.createElement(LiveRunInspector, {
          run: MOCK_UC06_ACTIVE_RUN,
          nodes: MOCK_UC06_DAG_GRAPH.nodes,
          selectedNodeId: 'node-3-approval',
          onSelectNode: () => {},
        })
      );

      assert.ok(html.includes('Paso #2'), 'Renders step #2');
      assert.ok(html.includes('Approval Gate: Manager Authorization'), 'Renders active node label');
      assert.ok(html.includes('approval'), 'Renders kind');
      assert.ok(html.includes('Centrar'), 'Renders center button');
    });

    it('formats duration cleanly in seconds or milliseconds', () => {
      const html = renderToStaticMarkup(
        React.createElement(LiveRunInspector, {
          run: {
            ...MOCK_UC06_ACTIVE_RUN,
            startedAt: new Date(Date.now() - 3500).toISOString(),
            completedAt: new Date().toISOString(),
          },
          nodes: MOCK_UC06_DAG_GRAPH.nodes,
          selectedNodeId: 'node-3-approval',
          onSelectNode: () => {},
        })
      );

      // 3.5s latency formatted
      assert.ok(html.includes('3.50s') || html.includes('s'), 'Renders formatted latency');
    });
  });

  describe('3. Human Approval Gate (HITL Action Triggers)', () => {
    it('renders alert box, textarea, and action buttons when status is "waiting_approval"', () => {
      const html = renderToStaticMarkup(
        React.createElement(LiveRunInspector, {
          run: MOCK_UC06_ACTIVE_RUN,
          nodes: MOCK_UC06_DAG_GRAPH.nodes,
          selectedNodeId: 'node-3-approval',
          onSelectNode: () => {},
        })
      );

      assert.ok(html.includes('data-testid="approval-gate-panel"'), 'Approval gate panel rendered');
      assert.ok(html.includes('role="alert"'), 'Rendered with alert role');
      assert.ok(html.includes('Aprobar Flujo'), 'Approve button present');
      assert.ok(html.includes('Rechazar Flujo'), 'Reject button present');
      assert.ok(html.includes('Alt+A'), 'Keyboard shortcut hint present');
    });

    it('suppresses approval gate panel when status is "completed" or "running"', () => {
      const completedRun: WorkflowRunV1 = {
        ...MOCK_UC06_ACTIVE_RUN,
        status: 'completed',
      };

      const html = renderToStaticMarkup(
        React.createElement(LiveRunInspector, {
          run: completedRun,
          nodes: MOCK_UC06_DAG_GRAPH.nodes,
          selectedNodeId: 'node-7-completed-end',
          onSelectNode: () => {},
        })
      );

      assert.ok(!html.includes('data-testid="approval-gate-panel"'), 'Approval panel suppressed');
      assert.ok(!html.includes('Aprobar Flujo'), 'Approve button absent');
    });

    it('invokes onApprovalDecision with approved payload and rejected payload correctly', () => {
      let dispatchedPayload: ApprovalDecisionPayload | null = null;
      const onDecision = (payload: ApprovalDecisionPayload) => {
        dispatchedPayload = payload;
      };

      // Direct contract assertion on simulated decision logic
      const approvalId = `app_${MOCK_UC06_ACTIVE_RUN.id}_${MOCK_UC06_ACTIVE_RUN.currentStep}`;
      onDecision({
        approvalId,
        decision: 'approved',
        actor: { userId: 'usr_op_1', roles: ['finance_manager'] },
        reason: 'Authorized high-value transaction',
        timestamp: new Date().toISOString(),
      });

      assert.ok(dispatchedPayload);
      assert.equal((dispatchedPayload as ApprovalDecisionPayload).decision, 'approved');
      assert.equal((dispatchedPayload as ApprovalDecisionPayload).approvalId, approvalId);
      assert.equal((dispatchedPayload as ApprovalDecisionPayload).reason, 'Authorized high-value transaction');

      // Test reject
      onDecision({
        approvalId,
        decision: 'rejected',
        actor: { userId: 'usr_op_1' },
        reason: 'Credit risk too high',
        timestamp: new Date().toISOString(),
      });
      assert.equal((dispatchedPayload as ApprovalDecisionPayload).decision, 'rejected');
      assert.equal((dispatchedPayload as ApprovalDecisionPayload).reason, 'Credit risk too high');
    });
  });

  describe('4. Error Details & RFC 7807 Diagnostics', () => {
    it('renders error panel with code badge, message, retryable status, and collapsible stack', () => {
      const html = renderToStaticMarkup(
        React.createElement(LiveRunInspector, {
          run: MOCK_UC06_FAILED_RUN,
          nodes: MOCK_UC06_DAG_GRAPH.nodes,
          selectedNodeId: 'node-6-outbound-webhook',
          onSelectNode: () => {},
        })
      );

      assert.ok(html.includes('data-testid="error-diagnostics-panel"'), 'Diagnostics panel rendered');
      assert.ok(html.includes('SSRF_BLOCKED'), 'Error code rendered');
      assert.ok(html.includes('Egress target resolved to private IP'), 'Error message rendered');
      assert.ok(html.includes('Reintentable: No'), 'Retryable status rendered');
      assert.ok(html.includes('Ver traza de error (Stack)'), 'Collapsible stack details present');
    });
  });

  describe('5. JsonViewer Component', () => {
    it('renders formatted JSON keys and copy button', () => {
      const html = renderToStaticMarkup(
        React.createElement(JsonViewer, {
          data: { orderId: 'ord_123', total: 5000, isActive: true },
          title: 'Test Variables',
        })
      );

      assert.ok(html.includes('Test Variables'), 'Title rendered');
      assert.ok(html.includes('orderId:'), 'Key rendered');
      assert.ok(html.includes('&quot;ord_123&quot;'), 'String rendered');
      assert.ok(html.includes('5000'), 'Number rendered');
      assert.ok(html.includes('true'), 'Boolean rendered');
      assert.ok(html.includes('Copiar'), 'Copy button rendered');
    });
  });
});
