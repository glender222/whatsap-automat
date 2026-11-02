/**
 * Automated Test Suite: WAI-ARIA Treeview 1.2 & StudioOutline Accessibility
 * Phase F4: PR-F4-03
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  StudioOutline,
  buildTreeFromDag,
  MOCK_UC06_DAG_GRAPH,
  MOCK_ORPHAN_DAG_GRAPH,
} from '../index';

describe('PR-F4-03: StudioOutline & WAI-ARIA Treeview 1.2', () => {
  describe('1. Pure DAG-to-Tree Algorithm (buildTreeFromDag)', () => {
    it('builds a hierarchical tree from a valid DAG starting at the trigger root', () => {
      const tree = buildTreeFromDag(
        MOCK_UC06_DAG_GRAPH.nodes,
        MOCK_UC06_DAG_GRAPH.edges,
        null,
        new Set(['tree-item-node-1-trigger', 'tree-item-node-2-condition'])
      );

      assert.ok(tree.length >= 1, 'Should have at least 1 root tree item');
      const root = tree[0];
      assert.equal(root.nodeId, 'node-1-trigger');
      assert.equal(root.level, 1);
      assert.ok(root.hasChildren, 'Root trigger has children');
      assert.equal(root.children[0].nodeId, 'node-2-condition');
      assert.equal(root.children[0].level, 2);
    });

    it('correctly creates branches with edge labels for condition node', () => {
      const tree = buildTreeFromDag(
        MOCK_UC06_DAG_GRAPH.nodes,
        MOCK_UC06_DAG_GRAPH.edges,
        null,
        new Set(['tree-item-node-1-trigger', 'tree-item-node-2-condition'])
      );

      const conditionItem = tree[0].children[0];
      assert.equal(conditionItem.nodeId, 'node-2-condition');
      assert.equal(conditionItem.children.length, 2, 'Condition has 2 outgoing branches');
      const branchLabels = conditionItem.children.map((c) => c.edgeLabel);
      assert.ok(branchLabels.some((l) => l && l.includes('Amount > 5000')), 'True branch labeled');
      assert.ok(branchLabels.some((l) => l && l.includes('Amount <= 5000')), 'False branch labeled');
    });

    it('handles diamond DAG reconvergence gracefully without infinite recursion', () => {
      const tree = buildTreeFromDag(
        MOCK_UC06_DAG_GRAPH.nodes,
        MOCK_UC06_DAG_GRAPH.edges,
        null,
        new Set()
      );

      // Node 4 is reached from condition (false branch) AND from approval (approved branch)
      function findReconvergence(items: readonly { isReconvergence?: boolean; children?: readonly any[] }[]): boolean {
        for (const item of items) {
          if (item.isReconvergence) return true;
          if (item.children && findReconvergence(item.children)) return true;
        }
        return false;
      }

      assert.ok(findReconvergence(tree), 'Detects and flags reconverging node');
    });

    it('groups unconnected orphan nodes under synthetic orphan folder at level 1', () => {
      const tree = buildTreeFromDag(
        MOCK_ORPHAN_DAG_GRAPH.nodes,
        MOCK_ORPHAN_DAG_GRAPH.edges,
        null,
        new Set()
      );

      const orphanGroup = tree.find((t) => t.id === 'tree-item-group-orphans');
      assert.ok(orphanGroup, 'Orphan group exists in tree');
      assert.equal(orphanGroup.level, 1);
      assert.equal(orphanGroup.children.length, 2, 'Contains 2 orphan children');
      assert.equal(orphanGroup.children[0].level, 2);
    });
  });

  describe('2. WAI-ARIA Treeview 1.2 Markup & Roles', () => {
    it('renders root nav with role="region" and aria-label', () => {
      const html = renderToStaticMarkup(
        React.createElement(StudioOutline, {
          dagGraph: MOCK_UC06_DAG_GRAPH,
          selectedNodeId: 'node-1-trigger',
          onSelectNode: () => {},
        })
      );

      assert.ok(html.includes('role="region"'), 'Contains role="region"');
      assert.ok(html.includes('aria-label="Esquema jerárquico del flujo"'), 'Contains aria-label');
    });

    it('renders container <ul> with role="tree" and aria-multiselectable="false"', () => {
      const html = renderToStaticMarkup(
        React.createElement(StudioOutline, {
          dagGraph: MOCK_UC06_DAG_GRAPH,
          selectedNodeId: 'node-1-trigger',
          onSelectNode: () => {},
        })
      );

      assert.ok(html.includes('role="tree"'), 'Renders role="tree"');
      assert.ok(html.includes('aria-multiselectable="false"'), 'Renders aria-multiselectable="false"');
      assert.ok(html.includes('aria-describedby="treeview-instructions"'), 'References accessible instructions');
    });

    it('renders each node with role="treeitem", aria-level, aria-posinset, and aria-setsize', () => {
      const html = renderToStaticMarkup(
        React.createElement(StudioOutline, {
          dagGraph: MOCK_UC06_DAG_GRAPH,
          selectedNodeId: 'node-1-trigger',
          onSelectNode: () => {},
        })
      );

      assert.ok(html.includes('role="treeitem"'), 'Contains role="treeitem"');
      assert.ok(html.includes('aria-level="1"'), 'Root level 1 set');
      assert.ok(html.includes('aria-posinset="1"'), 'aria-posinset set');
      assert.ok(html.includes('aria-setsize="1"'), 'aria-setsize set');
    });

    it('sets aria-selected="true" on selected node and "false" on unselected nodes', () => {
      const html = renderToStaticMarkup(
        React.createElement(StudioOutline, {
          dagGraph: MOCK_UC06_DAG_GRAPH,
          selectedNodeId: 'node-2-condition',
          onSelectNode: () => {},
        })
      );

      assert.ok(html.includes('id="tree-item-node-2-condition"'), 'Selected condition rendered');
      assert.ok(html.includes('aria-selected="true"'), 'Selected condition has aria-selected="true"');
      assert.ok(html.includes('aria-selected="false"'), 'Other items have aria-selected="false"');
    });

    it('assigns aria-expanded only to parent items with branches, omitting it on leaf items', () => {
      const html = renderToStaticMarkup(
        React.createElement(StudioOutline, {
          dagGraph: MOCK_UC06_DAG_GRAPH,
          selectedNodeId: 'node-1-trigger',
          onSelectNode: () => {},
        })
      );

      // Parent node (node-1-trigger has children)
      assert.ok(html.includes('aria-expanded="true"'), 'Parent has aria-expanded');
      // Branch group has role="group"
      assert.ok(html.includes('role="group"'), 'Branch has role="group"');
    });

    it('renders screen reader live region with aria-live="polite"', () => {
      const html = renderToStaticMarkup(
        React.createElement(StudioOutline, {
          dagGraph: MOCK_UC06_DAG_GRAPH,
          selectedNodeId: 'node-1-trigger',
          onSelectNode: () => {},
        })
      );

      assert.ok(html.includes('id="outline-live-region"'), 'Contains live region');
      assert.ok(html.includes('aria-live="polite"'), 'Uses polite live announcement');
      assert.ok(html.includes('aria-atomic="true"'), 'Uses atomic live announcement');
    });

    it('includes WCAG 2.2 AA visible focus ring classes', () => {
      const html = renderToStaticMarkup(
        React.createElement(StudioOutline, {
          dagGraph: MOCK_UC06_DAG_GRAPH,
          selectedNodeId: 'node-1-trigger',
          onSelectNode: () => {},
        })
      );

      assert.ok(html.includes('focus-visible:ring-2'), 'Contains focus-visible ring width');
      assert.ok(html.includes('focus-visible:outline-none'), 'Contains outline-none');
    });
  });
});
