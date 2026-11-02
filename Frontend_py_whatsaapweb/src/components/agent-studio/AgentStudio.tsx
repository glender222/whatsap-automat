import React, { useState, useCallback, useMemo } from 'react';
import type {
  AgentStudioDocument,
  AgentStudioViewMode,
  ViewportTransform,
  AgentGuidedConfig,
  NodePosition,
  AgentStudioNode,
  RegressionScorecard,
  PublicationGateResult,
} from './types';
import { initialAgentStudioDocument, sampleRegressionScorecard } from './mockData';
import {
  guidedToGraph,
  graphToGuided,
  computeStudioSpecHash,
} from './sync/AgentStudioSyncEngine';
import { AgentStudioToolbar } from './toolbar/AgentStudioToolbar';
import { AgentGuidedView } from './guided/AgentGuidedView';
import { AgentGraphCanvas } from './canvas/AgentGraphCanvas';
import { DeclarativeSchemaEditor } from './declarative/DeclarativeSchemaEditor';
import { AgentNodeInspector } from './inspector/AgentNodeInspector';
import { EvaluationDrawer } from './simulator/EvaluationDrawer';
import { RegressionScorecardModal } from './simulator/RegressionScorecardModal';
import { VersionDiffModal } from './diff/VersionDiffModal';
import { RightToBeForgottenModal } from './rag/RightToBeForgottenModal';

export interface AgentStudioProps {
  initialDocument?: AgentStudioDocument;
  onSave?: (doc: AgentStudioDocument) => void;
  onPublish?: (doc: AgentStudioDocument) => Promise<void> | void;
  className?: string;
}

export const AgentStudio: React.FC<AgentStudioProps> = ({
  initialDocument = initialAgentStudioDocument,
  onSave: _onSave,
  onPublish,
  className = '',
}) => {
  // Document SSOT State
  const [document, setDocument] = useState<AgentStudioDocument>(initialDocument);

  // View & Navigation State
  const [viewMode, setViewMode] = useState<AgentStudioViewMode>('canvas');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [activeTraceNodeId, setActiveTraceNodeId] = useState<string | null>(null);
  const [viewport, setViewport] = useState<ViewportTransform>({
    zoom: 1.0,
    pan: { x: 40, y: 40 },
  });

  // Modals & Drawers State
  const [isSimulatorOpen, setIsSimulatorOpen] = useState(false);
  const [isScorecardOpen, setIsScorecardOpen] = useState(false);
  const [isDiffOpen, setIsDiffOpen] = useState(false);
  const [isRtbfOpen, setIsRtbfOpen] = useState(false);

  // Status & Announcements
  const [statusMessage, setStatusMessage] = useState<string>('');
  const [validationAlert, setValidationAlert] = useState<{
    type: 'success' | 'warning' | 'error';
    text: string;
  } | null>(null);

  // Scorecard state
  const [scorecard] = useState<RegressionScorecard>(sampleRegressionScorecard);

  // Publication Gate Evaluation
  const publicationGate = useMemo<PublicationGateResult>(() => {
    const blockers = [];
    const declaredHash = document.specHash;
    const computedHash = computeStudioSpecHash(document);

    // 1. Pass Rate Check (>= 95%)
    if (scorecard.passRatePercent < 95.0) {
      blockers.push({
        code: 'PASS_RATE_BELOW_THRESHOLD',
        message: `Tasa de éxito (${scorecard.passRatePercent}%) inferior al 95.0% requerido.`,
        remediation: 'Ejecuta simulaciones adicionales y ajusta el system prompt o herramientas.',
      });
    }

    // 2. Security Tool Leaks Check
    if (scorecard.securityToolLeaks.length > 0) {
      blockers.push({
        code: 'SECURITY_TOOL_LEAK_DETECTED',
        message: `Fugas de seguridad detectadas en: ${scorecard.securityToolLeaks.join(', ')}`,
        remediation: 'Revisa las políticas y permisos de herramientas en el broker.',
      });
    }

    // 3. Spec Hash Integrity Check
    if (declaredHash !== computedHash) {
      blockers.push({
        code: 'SPEC_HASH_MISMATCH',
        message: 'El hash declarado no coincide con la firma criptográfica calculada.',
        remediation: 'Guarda o valida el documento para regenerar la firma.',
      });
    }

    // 4. Cycle Detection (DFS 3-color)
    let cycleDetected = false;
    const adj = new Map<string, string[]>();
    for (const edge of document.edges) {
      if (!adj.has(edge.sourceNodeId)) adj.set(edge.sourceNodeId, []);
      adj.get(edge.sourceNodeId)!.push(edge.targetNodeId);
    }
    const color = new Map<string, number>(); // 0: unvisited, 1: visiting, 2: visited
    function dfs(u: string): boolean {
      color.set(u, 1);
      for (const v of adj.get(u) || []) {
        if (color.get(v) === 1) return true;
        if (!color.has(v) && dfs(v)) return true;
      }
      color.set(u, 2);
      return false;
    }
    for (const node of document.nodes) {
      if (!color.has(node.id) && dfs(node.id)) {
        cycleDetected = true;
        break;
      }
    }

    if (cycleDetected) {
      blockers.push({
        code: 'CYCLE_DETECTED',
        message: 'Se detectó un ciclo en la topología de nodos sin limitador de ejecución.',
        remediation: 'Elimina bucles cerrados o configura límites de pasos máximos.',
      });
    }

    return {
      allowed: blockers.length === 0,
      blockers,
      computedSpecHash: computedHash,
      declaredSpecHash: declaredHash,
      passRatePercent: scorecard.passRatePercent,
      securityToolLeaksCount: scorecard.securityToolLeaks.length,
      cycleDetected,
      evaluatedAt: new Date().toISOString(),
    };
  }, [document, scorecard]);

  // Selected Node
  const selectedNode = useMemo(() => {
    if (!selectedNodeId) return null;
    return document.nodes.find((n) => n.id === selectedNodeId) || null;
  }, [document.nodes, selectedNodeId]);

  // SSOT Mutators
  const handleUpdateGuidedConfig = useCallback((nextConfig: AgentGuidedConfig) => {
    setDocument((prev) => {
      const nextDoc = guidedToGraph(nextConfig, prev);
      return {
        ...nextDoc,
        isDirty: true,
      };
    });
    setStatusMessage('Configuración guiada actualizada y sincronizada con el grafo.');
  }, []);

  const handleUpdateNodePosition = useCallback((nodeId: string, position: NodePosition) => {
    setDocument((prev) => {
      const nextNodes = prev.nodes.map((n) => (n.id === nodeId ? { ...n, position } : n));
      return {
        ...prev,
        nodes: nextNodes,
        isDirty: true,
      };
    });
  }, []);

  const handleUpdateNode = useCallback(
    (nodeId: string, updates: Partial<AgentStudioNode>) => {
      setDocument((prev) => {
        const nextNodes = prev.nodes.map((n) => (n.id === nodeId ? { ...n, ...updates } : n));
        const updatedGuided = graphToGuided(nextNodes, prev.edges, prev);
        const specHash = computeStudioSpecHash({ ...prev, nodes: nextNodes });
        return {
          ...prev,
          nodes: nextNodes,
          guidedConfig: updatedGuided,
          specHash,
          isDirty: true,
        };
      });
      setStatusMessage(`Nodo #${nodeId} actualizado.`);
    },
    []
  );

  const handleDeleteNode = useCallback(
    (nodeId: string) => {
      setDocument((prev) => {
        const nextNodes = prev.nodes.filter((n) => n.id !== nodeId);
        const nextEdges = prev.edges.filter(
          (e) => e.sourceNodeId !== nodeId && e.targetNodeId !== nodeId
        );
        const updatedGuided = graphToGuided(nextNodes, nextEdges, prev);
        const specHash = computeStudioSpecHash({ ...prev, nodes: nextNodes, edges: nextEdges });
        return {
          ...prev,
          nodes: nextNodes,
          edges: nextEdges,
          guidedConfig: updatedGuided,
          specHash,
          isDirty: true,
        };
      });
      if (selectedNodeId === nodeId) {
        setSelectedNodeId(null);
      }
      setStatusMessage(`Nodo #${nodeId} eliminado.`);
    },
    [selectedNodeId]
  );

  const handleDuplicateNode = useCallback((nodeId: string) => {
    setDocument((prev) => {
      const target = prev.nodes.find((n) => n.id === nodeId);
      if (!target) return prev;

      const newId = `${target.kind}_${Date.now().toString(36)}`;
      const newNode: AgentStudioNode = {
        ...target,
        id: newId,
        label: `${target.label} (copia)`,
        position: { x: target.position.x + 40, y: target.position.y + 40 },
        isDraftModified: true,
      };

      const nextNodes = [...prev.nodes, newNode];
      const updatedGuided = graphToGuided(nextNodes, prev.edges, prev);
      const specHash = computeStudioSpecHash({ ...prev, nodes: nextNodes });
      return {
        ...prev,
        nodes: nextNodes,
        guidedConfig: updatedGuided,
        specHash,
        isDirty: true,
      };
    });
    setStatusMessage(`Nodo duplicado.`);
  }, []);

  const handleDeclarativeUpdate = useCallback((nextDoc: AgentStudioDocument) => {
    setDocument({ ...nextDoc, isDirty: true });
    setStatusMessage('Especificación YAML sincronizada con el estado del estudio.');
  }, []);

  // Validation Action
  const handleValidate = useCallback(() => {
    if (publicationGate.allowed) {
      setValidationAlert({
        type: 'success',
        text: 'Topología y configuración válidas. Lista para publicación.',
      });
      setStatusMessage('Validación exitosa: sin errores.');
    } else {
      const firstBlocker = publicationGate.blockers[0]?.message || 'Bloqueos de publicación activos.';
      setValidationAlert({
        type: 'warning',
        text: `Validación con advertencias: ${firstBlocker}`,
      });
      setStatusMessage(`Validación: ${publicationGate.blockers.length} advertencias.`);
    }

    // Auto dismiss after 4s
    setTimeout(() => setValidationAlert(null), 4000);
  }, [publicationGate]);

  // Publish Action
  const handlePublish = useCallback(async () => {
    if (!publicationGate.allowed) {
      setIsScorecardOpen(true);
      return;
    }

    try {
      if (onPublish) {
        await onPublish(document);
      }
      setDocument((prev) => ({
        ...prev,
        status: 'published',
        isDirty: false,
        version: prev.version + 1,
      }));
      setValidationAlert({
        type: 'success',
        text: `Versión v${document.version} publicada exitosamente a producción.`,
      });
      setStatusMessage(`Versión v${document.version} publicada.`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setValidationAlert({
        type: 'error',
        text: `Error al publicar: ${msg}`,
      });
    }
  }, [publicationGate, document, onPublish]);

  return (
    <div
      className={`agent-studio-root flex flex-col h-screen w-full bg-slate-100 dark:bg-[#0B0F19] text-slate-900 dark:text-slate-100 overflow-hidden ${className}`}
      role="application"
      aria-label="Agent Studio IDE"
    >
      {/* Screen Reader Live Announcements */}
      <div className="sr-only" role="status" aria-live="polite">
        {statusMessage}
      </div>

      {/* Primary Toolbar */}
      <AgentStudioToolbar
        document={document}
        viewMode={viewMode}
        onChangeViewMode={(mode) => {
          setViewMode(mode);
          setStatusMessage(`Cambiado a modo ${mode}`);
        }}
        onValidate={handleValidate}
        onOpenSimulator={() => setIsSimulatorOpen(true)}
        onOpenDiff={() => setIsDiffOpen(true)}
        onPublish={handlePublish}
        onOpenRtbfModal={() => setIsRtbfOpen(true)}
        publishBlockerCount={publicationGate.blockers.length}
      />

      {/* Validation Notification Banner */}
      {validationAlert && (
        <div
          role="alert"
          className={`px-4 py-2 text-xs font-medium flex items-center justify-between border-b transition-all ${
            validationAlert.type === 'success'
              ? 'bg-emerald-50 dark:bg-emerald-950/60 border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-200'
              : validationAlert.type === 'warning'
              ? 'bg-amber-50 dark:bg-amber-950/60 border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-200'
              : 'bg-rose-50 dark:bg-rose-950/60 border-rose-200 dark:border-rose-800 text-rose-800 dark:text-rose-200'
          }`}
        >
          <span>{validationAlert.text}</span>
          <button
            type="button"
            onClick={() => setValidationAlert(null)}
            className="text-xs font-bold px-1 rounded hover:opacity-75"
          >
            ×
          </button>
        </div>
      )}

      {/* Workspace Body */}
      <div className="flex-1 flex overflow-hidden relative">
        {/* VIEW 1: GUIDED WIZARD */}
        {viewMode === 'guided' && (
          <div className="flex-1 overflow-hidden">
            <AgentGuidedView
              guidedConfig={document.guidedConfig}
              onUpdateGuidedConfig={handleUpdateGuidedConfig}
              onOpenSimulator={() => setIsSimulatorOpen(true)}
              onPublish={handlePublish}
              publishBlockerCount={publicationGate.blockers.length}
            />
          </div>
        )}

        {/* VIEW 2: GRAPH CANVAS */}
        {viewMode === 'canvas' && (
          <div className="flex-1 flex overflow-hidden">
            <div className="flex-1 relative overflow-hidden">
              <AgentGraphCanvas
                document={document}
                selectedNodeId={selectedNodeId}
                onSelectNode={(nodeId) => setSelectedNodeId(nodeId)}
                onUpdateNodePosition={handleUpdateNodePosition}
                onDeleteNode={handleDeleteNode}
                activeNodeId={activeTraceNodeId}
                viewport={viewport}
                onViewportChange={setViewport}
              />
            </div>
            <AgentNodeInspector
              node={selectedNode}
              onClose={() => setSelectedNodeId(null)}
              onUpdateNode={handleUpdateNode}
              onDeleteNode={handleDeleteNode}
              onDuplicateNode={handleDuplicateNode}
            />
          </div>
        )}

        {/* VIEW 3: DECLARATIVE YAML */}
        {viewMode === 'declarative' && (
          <div className="flex-1 overflow-hidden">
            <DeclarativeSchemaEditor
              document={document}
              onUpdateDocument={handleDeclarativeUpdate}
            />
          </div>
        )}

        {/* VIEW 4: SPLIT VIEW (CANVAS LEFT + YAML RIGHT) */}
        {viewMode === 'split' && (
          <div className="flex-1 flex overflow-hidden">
            <div className="flex-1 relative overflow-hidden border-r border-slate-200 dark:border-slate-800">
              <AgentGraphCanvas
                document={document}
                selectedNodeId={selectedNodeId}
                onSelectNode={(nodeId) => setSelectedNodeId(nodeId)}
                onUpdateNodePosition={handleUpdateNodePosition}
                onDeleteNode={handleDeleteNode}
                activeNodeId={activeTraceNodeId}
                viewport={viewport}
                onViewportChange={setViewport}
              />
            </div>
            <div className="w-1/2 overflow-hidden">
              <DeclarativeSchemaEditor
                document={document}
                onUpdateDocument={handleDeclarativeUpdate}
              />
            </div>
          </div>
        )}
      </div>

      {/* Simulator Drawer */}
      <EvaluationDrawer
        isOpen={isSimulatorOpen}
        onClose={() => {
          setIsSimulatorOpen(false);
          setActiveTraceNodeId(null);
        }}
        document={document}
        onStepActive={setActiveTraceNodeId}
        onOpenScorecard={() => {
          setIsSimulatorOpen(false);
          setIsScorecardOpen(true);
        }}
      />

      {/* Regression Scorecard Modal */}
      <RegressionScorecardModal
        isOpen={isScorecardOpen}
        onClose={() => setIsScorecardOpen(false)}
        scorecard={scorecard}
      />

      {/* Version Diff Modal */}
      <VersionDiffModal
        isOpen={isDiffOpen}
        onClose={() => setIsDiffOpen(false)}
        currentDocument={document}
      />

      {/* Right To Be Forgotten (GDPR) Modal */}
      <RightToBeForgottenModal
        isOpen={isRtbfOpen}
        onClose={() => setIsRtbfOpen(false)}
        tenantSlug="tenant_automations"
        onConfirmPurge={async ({ scope, targetId }) => {
          setStatusMessage(`Purgados vectores para ${scope}:${targetId}`);
        }}
      />
    </div>
  );
};
