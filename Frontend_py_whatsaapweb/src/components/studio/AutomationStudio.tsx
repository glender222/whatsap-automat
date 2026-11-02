import React, { useState, useCallback } from 'react';
import type {
  AutomationStudioProps,
  WorkflowDagGraphV1,
  WorkflowNodePosition,
  StudioViewMode,
  ViewportTransform,
  StudioValidationResult,
  StudioValidationIssue,
  WorkflowRunV1,
  ApprovalDecisionPayload,
  RollbackWorkflowCommandV1,
} from './types';
import {
  MOCK_UC06_WORKFLOW_DEFINITION,
  MOCK_UC06_WORKFLOW_REVISION,
  MOCK_UC06_REVISIONS,
  MOCK_UC06_ACTIVE_RUN,
} from './mockData';
import { StudioToolbar } from './toolbar/StudioToolbar';
import { StudioCanvas } from './canvas/StudioCanvas';
import { StudioOutline } from './outline/StudioOutline';
import { LiveRunInspector } from './inspector/LiveRunInspector';
import { NodeConfigPanel } from './inspector/NodeConfigPanel';
import { NODE_WIDTH, NODE_HEIGHT } from './canvas/nodes/StudioNodeCard';
import { CheckCircle2, AlertTriangle, X } from 'lucide-react';

/**
 * Validates a DAG graph:
 * - Checks for minimum 1 node
 * - Verifies existence of root trigger
 * - Checks all edge references
 * - Detects cycles using DFS
 * - Identifies orphan nodes
 */
export function validateDagGraph(dag: WorkflowDagGraphV1): StudioValidationResult {
  const issues: StudioValidationIssue[] = [];
  const orphanNodeIds: string[] = [];

  if (!dag.nodes || dag.nodes.length === 0) {
    issues.push({
      level: 'error',
      message: 'El workflow debe contener al menos un nodo',
    });
    return {
      isValid: false,
      errorCount: 1,
      warningCount: 0,
      issues,
      orphanNodeIds: [],
      hasCycle: false,
    };
  }

  const nodeMap = new Map(dag.nodes.map((n) => [n.id, n]));
  const triggers = dag.nodes.filter((n) => n.kind === 'trigger');

  if (triggers.length === 0) {
    issues.push({
      level: 'error',
      message: 'El workflow debe tener al menos un nodo de tipo Trigger como punto de entrada',
    });
  }

  // Validate edge endpoints
  for (const edge of dag.edges) {
    if (!nodeMap.has(edge.source)) {
      issues.push({
        level: 'error',
        edgeId: edge.id,
        message: `El origen de la conexión '${edge.source}' no existe en el flujo`,
      });
    }
    if (!nodeMap.has(edge.target)) {
      issues.push({
        level: 'error',
        edgeId: edge.id,
        message: `El destino de la conexión '${edge.target}' no existe en el flujo`,
      });
    }
  }

  // Cycle detection via DFS (White, Grey, Black)
  const adj = new Map<string, string[]>();
  for (const node of dag.nodes) {
    adj.set(node.id, []);
  }
  for (const edge of dag.edges) {
    if (adj.has(edge.source)) {
      adj.get(edge.source)!.push(edge.target);
    }
  }

  let hasCycle = false;
  const visitedState = new Map<string, 'unvisited' | 'visiting' | 'visited'>();
  for (const node of dag.nodes) {
    visitedState.set(node.id, 'unvisited');
  }

  function dfs(nodeId: string): boolean {
    visitedState.set(nodeId, 'visiting');
    const neighbors = adj.get(nodeId) || [];

    for (const neighbor of neighbors) {
      const state = visitedState.get(neighbor);
      if (state === 'visiting') {
        hasCycle = true;
        issues.push({
          level: 'error',
          nodeId,
          message: `Ciclo detectado entre '${nodeId}' y '${neighbor}'`,
        });
        return true;
      }
      if (state === 'unvisited') {
        if (dfs(neighbor)) return true;
      }
    }

    visitedState.set(nodeId, 'visited');
    return false;
  }

  for (const node of dag.nodes) {
    if (visitedState.get(node.id) === 'unvisited') {
      dfs(node.id);
    }
  }

  // Detect orphan nodes (nodes with 0 incoming and 0 outgoing edges, excluding root trigger)
  const incomingSet = new Set(dag.edges.map((e) => e.target));
  const outgoingSet = new Set(dag.edges.map((e) => e.source));

  for (const node of dag.nodes) {
    if (!incomingSet.has(node.id) && !outgoingSet.has(node.id) && node.kind !== 'trigger') {
      orphanNodeIds.push(node.id);
      issues.push({
        level: 'warning',
        nodeId: node.id,
        message: `El nodo '${node.label || node.id}' está desconectado del flujo`,
      });
    }
  }

  const errorCount = issues.filter((i) => i.level === 'error').length;
  const warningCount = issues.filter((i) => i.level === 'warning').length;

  return {
    isValid: errorCount === 0,
    errorCount,
    warningCount,
    issues,
    orphanNodeIds,
    hasCycle,
    rootTriggerId: triggers[0]?.id,
  };
}

export const AutomationStudio: React.FC<AutomationStudioProps> = ({
  initialWorkflow = MOCK_UC06_WORKFLOW_DEFINITION,
  initialRevision = MOCK_UC06_WORKFLOW_REVISION,
  availableRevisions = MOCK_UC06_REVISIONS,
  initialActiveRun = MOCK_UC06_ACTIVE_RUN,
  onSaveDraft,
  onPublishRevision,
  onRollbackRevision,
  onApprovalDecision,
  className = '',
}) => {
  // Master State
  const [workflow, setWorkflow] = useState(initialWorkflow);
  const [activeRevision, setActiveRevision] = useState(initialRevision);
  const [revisions] = useState(availableRevisions);
  const [dagGraph, setDagGraph] = useState<WorkflowDagGraphV1>(initialRevision.dagGraph);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(() => {
    return initialActiveRun?.currentStep || dagGraph.nodes[0]?.id || null;
  });
  const [activeRun, setActiveRun] = useState<WorkflowRunV1 | null>(initialActiveRun);
  const [viewMode, setViewMode] = useState<StudioViewMode>('split');
  const [isInspectorOpen, setIsInspectorOpen] = useState(true);
  const [isApprovalSubmitting, setIsApprovalSubmitting] = useState(false);

  // Viewport Transform State
  const [viewport, setViewport] = useState<ViewportTransform>({
    pan: { x: 80, y: 40 },
    zoom: 1.0,
  });

  // Validation State & Banner
  const [validationResult, setValidationResult] = useState<StudioValidationResult | null>(null);
  const [showValidationBanner, setShowValidationBanner] = useState(false);
  const [isSimulating, setIsSimulating] = useState(false);

  // Update node position during canvas drag
  const handleUpdateNodePosition = useCallback((nodeId: string, position: WorkflowNodePosition) => {
    setDagGraph((prev) => ({
      ...prev,
      nodes: prev.nodes.map((n) => (n.id === nodeId ? { ...n, position } : n)),
    }));
  }, []);

  // Update node config from NodeConfigPanel
  const handleUpdateNodeConfig = useCallback(
    (nodeId: string, updatedConfig: Record<string, unknown>, label?: string) => {
      setDagGraph((prev) => {
        const nextDag = {
          ...prev,
          nodes: prev.nodes.map((n) =>
            n.id === nodeId ? { ...n, config: updatedConfig, label: label || n.label } : n
          ),
        };
        if (onSaveDraft) {
          onSaveDraft(nextDag);
        }
        return nextDag;
      });
    },
    [onSaveDraft]
  );

  // Connect two nodes
  const handleConnect = useCallback(
    (sourceId: string, targetId: string, sourceHandle?: string) => {
      const edgeId = `e_${sourceId}_${targetId}_${Date.now()}`;
      setDagGraph((prev) => {
        // Prevent duplicate edges
        if (prev.edges.some((e) => e.source === sourceId && e.target === targetId)) {
          return prev;
        }
        return {
          ...prev,
          edges: [
            ...prev.edges,
            {
              id: edgeId,
              source: sourceId,
              target: targetId,
              sourceHandle,
              label: sourceHandle ? `[${sourceHandle}]` : undefined,
            },
          ],
        };
      });
    },
    []
  );

  // Center node in canvas viewport
  const handleSelectNode = useCallback(
    (nodeId: string) => {
      setSelectedNodeId(nodeId);
      const targetNode = dagGraph.nodes.find((n) => n.id === nodeId);
      if (targetNode?.position) {
        setViewport((prev) => ({
          zoom: prev.zoom,
          pan: {
            x: Math.round(400 - (targetNode.position!.x + NODE_WIDTH / 2) * prev.zoom),
            y: Math.round(260 - (targetNode.position!.y + NODE_HEIGHT / 2) * prev.zoom),
          },
        }));
      }
    },
    [dagGraph.nodes]
  );

  // Zoom Helpers
  const handleZoomIn = useCallback(() => {
    setViewport((prev) => ({
      ...prev,
      zoom: Number(Math.min(2.0, prev.zoom + 0.15).toFixed(2)),
    }));
  }, []);

  const handleZoomOut = useCallback(() => {
    setViewport((prev) => ({
      ...prev,
      zoom: Number(Math.max(0.4, prev.zoom - 0.15).toFixed(2)),
    }));
  }, []);

  const handleResetZoom = useCallback(() => {
    setViewport({ pan: { x: 80, y: 40 }, zoom: 1.0 });
  }, []);

  // Validation Action
  const handleValidate = useCallback(() => {
    const result = validateDagGraph(dagGraph);
    setValidationResult(result);
    setShowValidationBanner(true);
  }, [dagGraph]);

  // Simulate Execution Action
  const handleSimulate = useCallback(() => {
    setIsSimulating(true);
    const trigger = dagGraph.nodes.find((n) => n.kind === 'trigger');
    if (!trigger) {
      setIsSimulating(false);
      return;
    }

    const simRunId = `sim_run_${Date.now()}`;
    const initialSimRun: WorkflowRunV1 = {
      id: simRunId,
      tenantId: workflow.tenantId,
      workflowId: workflow.id,
      revisionId: activeRevision.id,
      temporalWorkflowId: `temporal_${simRunId}`,
      triggerType: 'webhook',
      status: 'running',
      correlationId: `corr_sim_${Date.now()}`,
      inputPayload: { simulation: true, timestamp: new Date().toISOString() },
      outputPayload: {},
      currentStep: trigger.id,
      stepCount: 1,
      startedAt: new Date().toISOString(),
    };

    setActiveRun(initialSimRun);
    handleSelectNode(trigger.id);

    // Step through connected nodes sequentially
    let currentId = trigger.id;
    let step = 1;

    const interval = setInterval(() => {
      step++;
      const nextEdge = dagGraph.edges.find((e) => e.source === currentId);
      if (!nextEdge) {
        clearInterval(interval);
        setActiveRun((prev) =>
          prev
            ? {
                ...prev,
                status: 'completed',
                completedAt: new Date().toISOString(),
              }
            : null
        );
        setIsSimulating(false);
        return;
      }

      currentId = nextEdge.target;
      const targetNode = dagGraph.nodes.find((n) => n.id === currentId);
      handleSelectNode(currentId);

      if (targetNode?.kind === 'approval') {
        clearInterval(interval);
        setActiveRun((prev) =>
          prev
            ? {
                ...prev,
                currentStep: currentId,
                stepCount: step,
                status: 'waiting_approval',
              }
            : null
        );
        setIsSimulating(false);
        return;
      }

      if (targetNode?.kind === 'end') {
        clearInterval(interval);
        setActiveRun((prev) =>
          prev
            ? {
                ...prev,
                currentStep: currentId,
                stepCount: step,
                status: 'completed',
                completedAt: new Date().toISOString(),
              }
            : null
        );
        setIsSimulating(false);
        return;
      }

      setActiveRun((prev) =>
        prev
          ? {
              ...prev,
              currentStep: currentId,
              stepCount: step,
            }
          : null
      );
    }, 1000);
  }, [dagGraph, workflow, activeRevision, handleSelectNode]);

  // Rollback Action
  const handleRollback = useCallback(
    async (targetRevisionNumber: number, reason: string) => {
      const targetRev = revisions.find((r) => r.revisionNumber === targetRevisionNumber);
      if (!targetRev) return;

      const command: RollbackWorkflowCommandV1 = {
        schemaVersion: 1,
        tenantId: workflow.tenantId,
        workflowId: workflow.id,
        targetRevisionNumber,
        userId: 'operator_ui',
        reason,
      };

      if (onRollbackRevision) {
        await onRollbackRevision(command);
      }

      // Update active revision and DAG graph
      setActiveRevision(targetRev);
      setDagGraph(targetRev.dagGraph);
      setSelectedNodeId(targetRev.dagGraph.nodes[0]?.id || null);
    },
    [revisions, workflow, onRollbackRevision]
  );

  // Publish Action
  const handlePublish = useCallback(async () => {
    if (onPublishRevision) {
      await onPublishRevision(activeRevision.id);
    }
    setWorkflow((prev) => ({ ...prev, status: 'published' }));
    setActiveRevision((prev) => ({ ...prev, status: 'published' }));
  }, [activeRevision.id, onPublishRevision]);

  // Approval Decision Trigger
  const handleApprovalDecision = useCallback(
    async (payload: ApprovalDecisionPayload) => {
      setIsApprovalSubmitting(true);
      try {
        if (onApprovalDecision) {
          await onApprovalDecision(payload);
        }
        // Update local run state
        setActiveRun((prev) => {
          if (!prev) return null;
          return {
            ...prev,
            status: payload.decision === 'approved' ? 'running' : 'failed',
            outputPayload: {
              ...prev.outputPayload,
              approvalResult: payload,
            },
            completedAt: payload.decision === 'rejected' ? new Date().toISOString() : null,
          };
        });
      } finally {
        setIsApprovalSubmitting(false);
      }
    },
    [onApprovalDecision]
  );

  // Currently selected node object
  const selectedNode = dagGraph.nodes.find((n) => n.id === selectedNodeId) || null;

  return (
    <div
      className={`automation-studio flex flex-col h-full w-full bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-100 overflow-hidden ${className}`}
    >
      {/* Top Toolbar */}
      <StudioToolbar
        workflowName={workflow.name}
        status={workflow.status}
        revisions={revisions}
        activeRevisionNumber={activeRevision.revisionNumber}
        onSelectRevision={(num) => {
          const rev = revisions.find((r) => r.revisionNumber === num);
          if (rev) {
            setActiveRevision(rev);
            setDagGraph(rev.dagGraph);
          }
        }}
        viewMode={viewMode}
        onChangeViewMode={setViewMode}
        onValidate={handleValidate}
        onSimulate={handleSimulate}
        onPublish={handlePublish}
        onRollback={handleRollback}
        onResetZoom={handleResetZoom}
        onZoomIn={handleZoomIn}
        onZoomOut={handleZoomOut}
        zoomLevel={viewport.zoom}
        isSimulating={isSimulating}
      />

      {/* Validation Alert Banner */}
      {showValidationBanner && validationResult && (
        <div
          role="alert"
          className={`flex items-center justify-between px-4 py-2 text-xs font-semibold shrink-0 ${
            validationResult.isValid
              ? 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-800 dark:text-emerald-300 border-b border-emerald-200 dark:border-emerald-800'
              : 'bg-red-50 dark:bg-red-950/60 text-red-800 dark:text-red-300 border-b border-red-200 dark:border-red-800'
          }`}
        >
          <div className="flex items-center gap-2">
            {validationResult.isValid ? (
              <>
                <CheckCircle2 size={16} className="text-emerald-600 dark:text-emerald-400" />
                <span>Workflow topológicamente válido. Aclicidad y conectividad verificadas.</span>
              </>
            ) : (
              <>
                <AlertTriangle size={16} className="text-red-600 dark:text-red-400" />
                <span>
                  Se encontraron {validationResult.errorCount} error(es) de validación:
                  {' ' + validationResult.issues.map((i) => i.message).join('; ')}
                </span>
              </>
            )}
          </div>
          <button
            type="button"
            onClick={() => setShowValidationBanner(false)}
            className="p-1 hover:opacity-75"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* Main Workspace Body */}
      <div className="flex flex-1 overflow-hidden relative">
        {/* Outline Panel (Visible in Split or Outline Mode) */}
        {(viewMode === 'split' || viewMode === 'outline') && (
          <div
            className={`${
              viewMode === 'outline' ? 'w-full' : 'w-72 shrink-0'
            } h-full z-10 transition-all`}
          >
            <StudioOutline
              dagGraph={dagGraph}
              selectedNodeId={selectedNodeId}
              onSelectNode={handleSelectNode}
              activeRun={activeRun}
            />
          </div>
        )}

        {/* Canvas Area (Visible in Split or Canvas Mode) */}
        {(viewMode === 'split' || viewMode === 'canvas') && (
          <div className="flex-1 h-full relative">
            <StudioCanvas
              dagGraph={dagGraph}
              selectedNodeId={selectedNodeId}
              onSelectNode={handleSelectNode}
              activeRun={activeRun}
              validationResult={validationResult || undefined}
              onUpdateNodePosition={handleUpdateNodePosition}
              onConnect={handleConnect}
              viewportTransform={viewport}
              onViewportChange={setViewport}
            />
          </div>
        )}

        {/* Right Drawer: Live Run Inspector or Node Config Panel */}
        {isInspectorOpen && (
          <div className="h-full z-20 shrink-0">
            {activeRun ? (
              <LiveRunInspector
                run={activeRun}
                nodes={dagGraph.nodes}
                selectedNodeId={selectedNodeId}
                onSelectNode={handleSelectNode}
                onApprovalDecision={handleApprovalDecision}
                isApprovalSubmitting={isApprovalSubmitting}
                onClose={() => setIsInspectorOpen(false)}
              />
            ) : selectedNode ? (
              <div className="w-80 h-full flex flex-col bg-white dark:bg-slate-900 border-l border-slate-200 dark:border-slate-800">
                <NodeConfigPanel
                  node={selectedNode}
                  onUpdateConfig={handleUpdateNodeConfig}
                />
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
};
