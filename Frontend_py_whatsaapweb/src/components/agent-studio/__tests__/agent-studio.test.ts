/**
 * Unit & Integration Test Suite: Agent Studio Dual-View UI, Canvas & SSOT Sync
 * Milestone M3: PR-F5-03
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  AgentStudio,
  AgentGraphCanvas,
  CanvasViewport,
  computeBezierCurve,
  MIN_ZOOM,
  MAX_ZOOM,
  AgentStudioToolbar,
  AgentGuidedView,
  DeclarativeSchemaEditor,
  AgentNodeInspector,
  ChunkingConfigSlider,
  RightToBeForgottenModal,
  EvaluationDrawer,
  RegressionScorecardModal,
  VersionDiffModal,
  initialAgentStudioDocument,
  sampleRegressionScorecard,
  guidedToGraph,
  graphToGuided,
  toDeclarativeYaml,
  fromDeclarativeYaml,
  computeStudioSpecHash,
} from '../index';

describe('PR-F5-03: Agent Studio UI, Canvas & SSOT Sync', () => {
  describe('1. Dual-View Mode Rendering & Toolbar', () => {
    it('renders AgentStudio in Canvas mode with all 8 canonical nodes', () => {
      const html = renderToStaticMarkup(
        React.createElement(AgentStudio, {
          initialDocument: initialAgentStudioDocument,
        })
      );

      // Verify canvas region and root container
      assert.ok(html.includes('role="application"'), 'Renders application role');
      assert.ok(html.includes('aria-label="Agent Studio IDE"'), 'Has accessible ARIA label');

      // Verify all 8 canonical node kinds are rendered
      assert.ok(html.includes('id="agent-node-node-trigger"'), 'Renders trigger node');
      assert.ok(html.includes('id="agent-node-node-policy"'), 'Renders policy node');
      assert.ok(html.includes('id="agent-node-node-memory"'), 'Renders memory retrieval node');
      assert.ok(html.includes('id="agent-node-node-llm"'), 'Renders llm reasoner node');
      assert.ok(html.includes('id="agent-node-node-tool"'), 'Renders tool call node');
      assert.ok(html.includes('id="agent-node-node-gate"'), 'Renders approval gate node');
      assert.ok(html.includes('id="agent-node-node-dispatch"'), 'Renders dispatch node');
      assert.ok(html.includes('id="agent-node-node-handoff"'), 'Renders handoff node');
    });

    it('renders toolbar with mode switchers and version status', () => {
      const html = renderToStaticMarkup(
        React.createElement(AgentStudioToolbar, {
          document: initialAgentStudioDocument,
          viewMode: 'canvas',
          onChangeViewMode: () => {},
          onValidate: () => {},
          onOpenSimulator: () => {},
          onOpenDiff: () => {},
          onPublish: () => {},
          onOpenRtbfModal: () => {},
          publishBlockerCount: 0,
        })
      );

      assert.ok(html.includes('Ventas e-Commerce y Catálogo'), 'Renders agent title');
      assert.ok(html.includes('v1'), 'Renders version 1');
      assert.ok(html.includes('Borrador'), 'Renders draft status badge');
      assert.ok(html.includes('Guiada'), 'Renders guided mode button');
      assert.ok(html.includes('Grafo'), 'Renders graph canvas mode button');
      assert.ok(html.includes('YAML'), 'Renders YAML mode button');
      assert.ok(html.includes('Dividida'), 'Renders split mode button');
    });

    it('renders AgentGuidedView tabbed wizard', () => {
      const html = renderToStaticMarkup(
        React.createElement(AgentGuidedView, {
          guidedConfig: initialAgentStudioDocument.guidedConfig,
          onUpdateGuidedConfig: () => {},
        })
      );

      assert.ok(html.includes('Configuración Guiada'));
      assert.ok(html.includes('1. Modelo y Prompt'));
      assert.ok(html.includes('2. Memoria RAG'));
      assert.ok(html.includes('3. Herramientas'));
    });

    it('renders DeclarativeSchemaEditor with YAML content', () => {
      const html = renderToStaticMarkup(
        React.createElement(DeclarativeSchemaEditor, {
          document: initialAgentStudioDocument,
          onUpdateDocument: () => {},
        })
      );

      assert.ok(html.includes('schema.agent.yaml'));
      assert.ok(html.includes('schemaVersion'));
    });
  });

  describe('2. Interactive SVG Canvas & Cubic Bezier Edges', () => {
    it('computes smooth cubic Bezier curve with minimum 48px curvature', () => {
      // Horizontal span dx = 200
      const curve1 = computeBezierCurve(100, 100, 300, 100);
      assert.ok(curve1.pathData.includes('M 100 100 C 200 100, 200 100, 300 100'));
      assert.equal(curve1.midX, 200);
      assert.equal(curve1.midY, 100);

      // Tight horizontal span dx = 10 (curvature clamp applies >= 48px)
      const curve2 = computeBezierCurve(100, 100, 110, 100);
      assert.ok(curve2.pathData.includes('C 148 100, 62 100, 110 100'), 'Curvature clamped to >= 48px');
    });

    it('clamps viewport zoom strictly between 0.4x and 2.0x', () => {
      assert.equal(MIN_ZOOM, 0.4);
      assert.equal(MAX_ZOOM, 2.0);

      const html = renderToStaticMarkup(
        React.createElement(CanvasViewport, {
          viewport: { zoom: 1.5, pan: { x: 50, y: 75 } },
          onViewportChange: () => {},
          children: React.createElement('div', null, 'content'),
          svgEdgesLayer: React.createElement('svg', null),
        })
      );

      assert.ok(html.includes('translate(50px, 75px) scale(1.5)'), 'Applies pan and zoom transform');
      assert.ok(html.includes('role="region"'), 'Accessible region role');
    });

    it('renders roving tabindex on canvas node cards', () => {
      const selectedId = 'node-llm';
      const html = renderToStaticMarkup(
        React.createElement(AgentGraphCanvas, {
          document: initialAgentStudioDocument,
          selectedNodeId: selectedId,
          onSelectNode: () => {},
          onUpdateNodePosition: () => {},
          viewport: { zoom: 1.0, pan: { x: 0, y: 0 } },
          onViewportChange: () => {},
        })
      );

      // Selected node has tabIndex=0, others have tabIndex=-1
      assert.ok(html.includes('id="agent-node-node-llm"'));
      assert.ok(html.includes('tabindex="0"'), 'Selected node has tabIndex=0 for roving tabindex');
      assert.ok(html.includes('tabindex="-1"'), 'Unselected nodes have tabIndex=-1');
    });
  });

  describe('3. Single Source of Truth (SSOT) Bidirectional Sync', () => {
    it('synchronizes Guided view configuration to Graph topology preserving node coordinates', () => {
      const initialDoc = initialAgentStudioDocument;
      const originalLlmPos = initialDoc.nodes.find((n) => n.kind === 'llm_reasoner')?.position;

      const updatedConfig = {
        ...initialDoc.guidedConfig,
        reasoning: {
          ...initialDoc.guidedConfig.reasoning,
          model: 'claude-3-5-sonnet-20241022',
          temperature: 0.7,
        },
      };

      const updatedDoc = guidedToGraph(updatedConfig, initialDoc);

      const updatedLlmNode = updatedDoc.nodes.find((n) => n.kind === 'llm_reasoner');
      assert.ok(updatedLlmNode, 'LLM reasoner node exists');
      assert.equal(updatedLlmNode.config.model, 'claude-3-5-sonnet-20241022');
      assert.equal(updatedLlmNode.config.temperature, 0.7);

      // Coordinates preserved without jumping
      assert.deepEqual(updatedLlmNode.position, originalLlmPos, 'Node position preserved');
    });

    it('projects Graph node updates faithfully back into Guided config', () => {
      const initialDoc = initialAgentStudioDocument;
      const modifiedNodes = initialDoc.nodes.map((n) =>
        n.kind === 'memory_retrieval'
          ? { ...n, config: { ...n.config, topK: 7, minSimilarity: 0.85 } }
          : n
      );

      const projectedGuided = graphToGuided(modifiedNodes, initialDoc.edges, initialDoc);
      assert.equal(projectedGuided.ragMemory.topK, 7);
      assert.equal(projectedGuided.ragMemory.minSimilarity, 0.85);
    });

    it('serializes to declarative YAML and deserializes losslessly', () => {
      const initialDoc = initialAgentStudioDocument;
      const yaml = toDeclarativeYaml(initialDoc);

      assert.ok(yaml.includes('schemaVersion'), 'Contains schemaVersion');
      assert.ok(yaml.includes('agent_graph_sales_v1'), 'Contains graphId');
      assert.ok(yaml.includes('llm_reasoner'), 'Contains canonical node kind');

      const { doc: parsedDoc, error } = fromDeclarativeYaml(yaml, initialDoc);
      assert.equal(error, undefined, 'No YAML parse error');
      assert.ok(parsedDoc, 'Parsed document returned');
      assert.equal(parsedDoc?.graphId, initialDoc.graphId);
      assert.equal(parsedDoc?.nodes.length, initialDoc.nodes.length);
    });

    it('catches invalid YAML syntax without corrupting existing document', () => {
      const initialDoc = initialAgentStudioDocument;
      const malformedYaml = 'schemaVersion: 1\n  invalid: indentation: [broken:';

      const { doc, error } = fromDeclarativeYaml(malformedYaml, initialDoc);
      assert.ok(error, 'Emits syntax validation error');
      assert.equal(doc, undefined, 'Does not emit corrupted document');
    });

    it('computes deterministic spec hash invariant to UI layout coordinates', () => {
      const doc1 = initialAgentStudioDocument;
      const doc2 = {
        ...doc1,
        nodes: doc1.nodes.map((n) => ({
          ...n,
          position: { x: n.position.x + 200, y: n.position.y + 150 }, // moved visually
        })),
      };

      const hash1 = computeStudioSpecHash(doc1);
      const hash2 = computeStudioSpecHash(doc2);

      assert.equal(hash1, hash2, 'Spec hash is invariant to visual dragging coordinates');
      assert.equal(typeof hash1, 'string');
      assert.equal(hash1.length, 64, 'SHA-256 64-char hex string');
    });
  });

  describe('4. Contextual Node Inspector Drawer', () => {
    it('renders empty state when no node is selected', () => {
      const html = renderToStaticMarkup(
        React.createElement(AgentNodeInspector, {
          node: null,
          onClose: () => {},
          onUpdateNode: () => {},
          onDeleteNode: () => {},
        })
      );

      assert.ok(html.includes('Ningún nodo seleccionado'));
    });

    it('renders contextual schema form for llm_reasoner node', () => {
      const llmNode = initialAgentStudioDocument.nodes.find((n) => n.kind === 'llm_reasoner')!;
      const html = renderToStaticMarkup(
        React.createElement(AgentNodeInspector, {
          node: llmNode,
          onClose: () => {},
          onUpdateNode: () => {},
          onDeleteNode: () => {},
        })
      );

      assert.ok(html.includes('Etiqueta del Nodo'));
      assert.ok(html.includes('Proveedor'));
      assert.ok(html.includes('Modelo'));
      assert.ok(html.includes('Temperatura:'));
      assert.ok(html.includes('System Prompt'));
      assert.ok(html.includes('Eliminar Nodo'));
    });
  });

  describe('5. RAG Memory UI & GDPR Right to be Forgotten Modal', () => {
    it('renders chunking configuration slider', () => {
      const html = renderToStaticMarkup(
        React.createElement(ChunkingConfigSlider, {
          config: { chunkSize: 512, chunkOverlap: 64, strategy: 'sliding_window' },
          onChange: () => {},
        })
      );

      assert.ok(html.includes('Tamaño del Fragmento (Chunk Size): 512 tokens'));
      assert.ok(html.includes('Solapamiento (Overlap): 64 tokens'));
      assert.ok(html.includes('Ventana Deslizante con Solapamiento'));
    });

    it('renders GDPR Right to be Forgotten modal with tenant confirmation requirement', () => {
      const html = renderToStaticMarkup(
        React.createElement(RightToBeForgottenModal, {
          isOpen: true,
          onClose: () => {},
          tenantSlug: 'tenant_testing_slug',
          onConfirmPurge: () => {},
        })
      );

      assert.ok(html.includes('GDPR: Derecho al Olvido'));
      assert.ok(html.includes('tenant_testing_slug'), 'Displays required confirmation slug');
      assert.ok(html.includes('Purgar Datos Vectoriales'));
    });
  });

  describe('6. Regression Simulator Drawer & Publication Gate', () => {
    it('renders evaluation drawer with benchmark scenarios and live trace container', () => {
      const html = renderToStaticMarkup(
        React.createElement(EvaluationDrawer, {
          isOpen: true,
          onClose: () => {},
          document: initialAgentStudioDocument,
          onStepActive: () => {},
          onOpenScorecard: () => {},
        })
      );

      assert.ok(html.includes('Simulador de Evaluación en Sandbox'));
      assert.ok(html.includes('Escenario de Benchmark'));
      assert.ok(html.includes('Mensaje Mock del Cliente'));
      assert.ok(html.includes('Simular Flujo'));
      assert.ok(html.includes('Scorecard'));
    });

    it('renders regression scorecard modal with pass rate, latency, and security leak check', () => {
      const html = renderToStaticMarkup(
        React.createElement(RegressionScorecardModal, {
          isOpen: true,
          onClose: () => {},
          scorecard: sampleRegressionScorecard,
        })
      );

      assert.ok(html.includes('Scorecard de Regresión'));
      assert.ok(html.includes('96.5%'), 'Pass rate 96.5% displayed');
      assert.ok(html.includes('Agente Aprobado para Publicación'), 'Passes publication gate check');
      assert.ok(html.includes('Fugas Seguridad'));
    });

    it('renders version diff modal with side-by-side prompt comparison', () => {
      const html = renderToStaticMarkup(
        React.createElement(VersionDiffModal, {
          isOpen: true,
          onClose: () => {},
          currentDocument: initialAgentStudioDocument,
        })
      );

      assert.ok(html.includes('Comparador de Versiones (Diff)'));
      assert.ok(html.includes('System Prompt'));
      assert.ok(html.includes('Herramientas Habilitadas'));
      assert.ok(html.includes('Topología de Nodos'));
    });
  });
});
