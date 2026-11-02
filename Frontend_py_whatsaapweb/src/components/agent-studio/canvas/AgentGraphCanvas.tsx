import React, { useState, useRef, useCallback } from 'react';
import {
  Bot,
  Shield,
  Database,
  Cpu,
  Wrench,
  UserCheck,
  Send,
  Users,
  ZoomIn,
  ZoomOut,
  Maximize2,
} from 'lucide-react';
import type {
  AgentStudioDocument,
  AgentStudioNode,
  ViewportTransform,
  CanonicalNodeKind,
  NodePosition,
} from '../types';
import { CanvasViewport, MIN_ZOOM, MAX_ZOOM } from './CanvasViewport';
import { BezierEdge, NODE_WIDTH, NODE_HEIGHT } from './edges/BezierEdge';

export interface AgentGraphCanvasProps {
  document: AgentStudioDocument;
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string | null) => void;
  onUpdateNodePosition: (nodeId: string, position: NodePosition) => void;
  onDeleteNode?: (nodeId: string) => void;
  activeNodeId?: string | null;
  viewport: ViewportTransform;
  onViewportChange: (viewport: ViewportTransform) => void;
}

const KIND_METADATA: Record<
  CanonicalNodeKind,
  {
    icon: React.ComponentType<{ className?: string; size?: number }>;
    colorBadge: string;
    label: string;
  }
> = {
  trigger: {
    icon: Bot,
    colorBadge: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300 border-emerald-300 dark:border-emerald-800',
    label: 'Disparador',
  },
  policy_guard: {
    icon: Shield,
    colorBadge: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300 border-amber-300 dark:border-amber-800',
    label: 'Guardián de Políticas',
  },
  memory_retrieval: {
    icon: Database,
    colorBadge: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-300 border-indigo-300 dark:border-indigo-800',
    label: 'Memoria RAG',
  },
  llm_reasoner: {
    icon: Cpu,
    colorBadge: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300 border-blue-300 dark:border-blue-800',
    label: 'Razonador LLM',
  },
  tool_call: {
    icon: Wrench,
    colorBadge: 'bg-purple-100 text-purple-800 dark:bg-purple-950 dark:text-purple-300 border-purple-300 dark:border-purple-800',
    label: 'Herramienta',
  },
  gate: {
    icon: UserCheck,
    colorBadge: 'bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300 border-rose-300 dark:border-rose-800',
    label: 'Puerta de Aprobación',
  },
  dispatch: {
    icon: Send,
    colorBadge: 'bg-teal-100 text-teal-800 dark:bg-teal-950 dark:text-teal-300 border-teal-300 dark:border-teal-800',
    label: 'Envío de Mensaje',
  },
  handoff: {
    icon: Users,
    colorBadge: 'bg-slate-200 text-slate-800 dark:bg-slate-800 dark:text-slate-200 border-slate-300 dark:border-slate-700',
    label: 'Derivación Humana',
  },
};

export const AgentGraphCanvas: React.FC<AgentGraphCanvasProps> = ({
  document,
  selectedNodeId,
  onSelectNode,
  onUpdateNodePosition,
  onDeleteNode,
  activeNodeId,
  viewport,
  onViewportChange,
}) => {
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null);
  const dragStartRef = useRef<{ clientX: number; clientY: number; initialPos: NodePosition }>({
    clientX: 0,
    clientY: 0,
    initialPos: { x: 0, y: 0 },
  });

  const nodeMap = new Map<string, AgentStudioNode>();
  for (const node of document.nodes) {
    nodeMap.set(node.id, node);
  }

  // Node Drag Handlers
  const handleNodeMouseDown = (e: React.MouseEvent, node: AgentStudioNode) => {
    // If clicking a button or link inside node, don't drag
    if ((e.target as HTMLElement).closest('button, input, select, textarea')) return;
    e.stopPropagation();

    onSelectNode(node.id);
    setDraggingNodeId(node.id);
    dragStartRef.current = {
      clientX: e.clientX,
      clientY: e.clientY,
      initialPos: { ...node.position },
    };
  };

  const handleCanvasMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!draggingNodeId) return;
      const dx = (e.clientX - dragStartRef.current.clientX) / viewport.zoom;
      const dy = (e.clientY - dragStartRef.current.clientY) / viewport.zoom;

      const nextX = Math.round(dragStartRef.current.initialPos.x + dx);
      const nextY = Math.round(dragStartRef.current.initialPos.y + dy);

      onUpdateNodePosition(draggingNodeId, { x: nextX, y: nextY });
    },
    [draggingNodeId, viewport.zoom, onUpdateNodePosition]
  );

  const handleCanvasMouseUp = useCallback(() => {
    if (draggingNodeId) {
      setDraggingNodeId(null);
    }
  }, [draggingNodeId]);

  // Zoom control buttons
  const handleZoomIn = () => {
    const nextZoom = Math.min(MAX_ZOOM, Number((viewport.zoom * 1.2).toFixed(2)));
    onViewportChange({ ...viewport, zoom: nextZoom });
  };

  const handleZoomOut = () => {
    const nextZoom = Math.max(MIN_ZOOM, Number((viewport.zoom * 0.8).toFixed(2)));
    onViewportChange({ ...viewport, zoom: nextZoom });
  };

  const handleResetZoom = () => {
    onViewportChange({ zoom: 1.0, pan: { x: 0, y: 0 } });
  };

  const handleFitView = () => {
    if (document.nodes.length === 0) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const node of document.nodes) {
      if (node.position.x < minX) minX = node.position.x;
      if (node.position.y < minY) minY = node.position.y;
      if (node.position.x + NODE_WIDTH > maxX) maxX = node.position.x + NODE_WIDTH;
      if (node.position.y + NODE_HEIGHT > maxY) maxY = node.position.y + NODE_HEIGHT;
    }

    const padding = 60;
    const width = maxX - minX + padding * 2;
    const height = maxY - minY + padding * 2;

    const scaleX = 900 / width;
    const scaleY = 600 / height;
    const fitZoom = Math.min(1.2, Math.max(MIN_ZOOM, Math.min(scaleX, scaleY)));

    onViewportChange({
      zoom: Number(fitZoom.toFixed(2)),
      pan: {
        x: Math.round(padding - minX * fitZoom),
        y: Math.round(padding - minY * fitZoom),
      },
    });
  };

  // Node Key Down (WCAG roving tabindex)
  const handleNodeKeyDown = (e: React.KeyboardEvent, node: AgentStudioNode) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelectNode(node.id);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onSelectNode(null);
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && onDeleteNode) {
      e.preventDefault();
      onDeleteNode(node.id);
    }
  };

  // SVG Edges Layer
  const svgEdges = (
    <svg
      className="absolute inset-0 w-full h-full overflow-visible pointer-events-none"
      aria-hidden="true"
    >
      <defs>
        <marker
          id="agent-arrow-default"
          viewBox="0 0 10 10"
          refX="6"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M 0 1 L 8 5 L 0 9 z" fill="#94A3B8" />
        </marker>
        <marker
          id="agent-arrow-selected"
          viewBox="0 0 10 10"
          refX="6"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M 0 1 L 8 5 L 0 9 z" fill="#0D9488" />
        </marker>
      </defs>

      {document.edges.map((edge) => {
        const sourceNode = nodeMap.get(edge.sourceNodeId);
        const targetNode = nodeMap.get(edge.targetNodeId);
        if (!sourceNode || !targetNode) return null;

        const isTraversed =
          activeNodeId === edge.sourceNodeId || activeNodeId === edge.targetNodeId;

        return (
          <BezierEdge
            key={edge.id}
            edge={edge}
            sourcePos={sourceNode.position}
            targetPos={targetNode.position}
            sourceKind={sourceNode.kind}
            isSelected={selectedNodeId === edge.sourceNodeId || selectedNodeId === edge.targetNodeId}
            isTraversed={isTraversed}
          />
        );
      })}
    </svg>
  );

  return (
    <div
      className="relative w-full h-full flex flex-col overflow-hidden"
      onMouseMove={handleCanvasMouseMove}
      onMouseUp={handleCanvasMouseUp}
    >
      <CanvasViewport
        viewport={viewport}
        onViewportChange={onViewportChange}
        svgEdgesLayer={svgEdges}
      >
        {document.nodes.map((node) => {
          const isSelected = selectedNodeId === node.id;
          const isActive = activeNodeId === node.id;
          const meta = KIND_METADATA[node.kind] || {
            icon: Bot,
            colorBadge: 'bg-slate-100 text-slate-700',
            label: node.kind,
          };
          const Icon = meta.icon;

          return (
            <div
              key={node.id}
              id={`agent-node-${node.id}`}
              data-testid={`agent-node-${node.id}`}
              role="button"
              aria-label={`Nodo ${node.label}, tipo ${meta.label}`}
              aria-pressed={isSelected}
              tabIndex={isSelected ? 0 : -1}
              style={{
                left: `${node.position.x}px`,
                top: `${node.position.y}px`,
                width: `${NODE_WIDTH}px`,
                minHeight: `${NODE_HEIGHT}px`,
              }}
              className={`absolute select-none rounded-xl bg-white dark:bg-[#131B2E] border cursor-move transition-all duration-150 ${
                isSelected
                  ? 'border-teal-500 ring-2 ring-teal-500/30 shadow-md shadow-teal-500/10'
                  : 'border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700 shadow-sm'
              } ${
                isActive
                  ? 'ring-4 ring-teal-400 dark:ring-teal-400 shadow-lg shadow-teal-500/30 animate-pulse border-teal-400'
                  : ''
              }`}
              onMouseDown={(e) => handleNodeMouseDown(e, node)}
              onKeyDown={(e) => handleNodeKeyDown(e, node)}
              onClick={(e) => {
                e.stopPropagation();
                onSelectNode(node.id);
              }}
            >
              {/* Header */}
              <div className="flex items-center justify-between px-3 py-2 border-b border-slate-100 dark:border-slate-800/80 bg-slate-50/60 dark:bg-slate-900/40 rounded-t-xl">
                <div className="flex items-center space-x-1.5 overflow-hidden">
                  <Icon className="w-3.5 h-3.5 shrink-0 text-slate-600 dark:text-slate-400" />
                  <span
                    className={`px-1.5 py-0.5 rounded text-[10px] font-semibold border ${meta.colorBadge}`}
                  >
                    {meta.label}
                  </span>
                </div>
                {node.isDraftModified && (
                  <span className="w-2 h-2 rounded-full bg-amber-500" title="Modificado" />
                )}
              </div>

              {/* Body */}
              <div className="p-3">
                <p className="text-xs font-semibold text-slate-800 dark:text-slate-100 truncate">
                  {node.label}
                </p>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate mt-0.5">
                  {node.kind === 'llm_reasoner'
                    ? `${(node.config?.model as string) || 'gpt-4o-mini'} · t:${(node.config?.temperature as number) ?? 0.3}`
                    : node.kind === 'memory_retrieval'
                    ? `topK: ${(node.config?.topK as number) ?? 3} · min: ${(node.config?.minSimilarity as number) ?? 0.7}`
                    : node.kind === 'tool_call'
                    ? `tool: ${(node.config?.toolName as string) || 'none'}`
                    : node.kind === 'gate'
                    ? `risk: ${(node.config?.riskThreshold as string) || 'financial'}`
                    : `id: ${node.id}`}
                </p>
              </div>

              {/* Input Anchor Handle */}
              {node.inputs.length > 0 && (
                <div
                  className="absolute left-[-6px] top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-white dark:bg-slate-900 border-2 border-slate-400 dark:border-slate-500 hover:border-teal-500 hover:scale-125 transition-transform"
                  title="Entrada"
                />
              )}

              {/* Output Anchor Handle */}
              {node.outputs.length > 0 && (
                <div
                  className="absolute right-[-6px] top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-white dark:bg-slate-900 border-2 border-teal-500 hover:scale-125 transition-transform"
                  title="Salida"
                />
              )}
            </div>
          );
        })}
      </CanvasViewport>

      {/* Floating Viewport Controls Toolbar */}
      <div
        className="absolute bottom-4 left-4 z-20 flex items-center space-x-1 p-1 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg shadow-sm"
        role="toolbar"
        aria-label="Controles de zoom y vista"
      >
        <button
          type="button"
          onClick={handleZoomIn}
          disabled={viewport.zoom >= MAX_ZOOM}
          className="p-1.5 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded disabled:opacity-40"
          title="Acercar (+)"
          aria-label="Acercar"
        >
          <ZoomIn className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={handleZoomOut}
          disabled={viewport.zoom <= MIN_ZOOM}
          className="p-1.5 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded disabled:opacity-40"
          title="Alejar (-)"
          aria-label="Alejar"
        >
          <ZoomOut className="w-4 h-4" />
        </button>
        <div className="w-[1px] h-4 bg-slate-200 dark:bg-slate-800 mx-0.5" />
        <button
          type="button"
          onClick={handleResetZoom}
          className="px-2 py-1 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded"
          title="Restablecer (0)"
          aria-label="Restablecer escala al 100%"
        >
          {Math.round(viewport.zoom * 100)}%
        </button>
        <button
          type="button"
          onClick={handleFitView}
          className="p-1.5 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded"
          title="Ajustar vista"
          aria-label="Ajustar vista"
        >
          <Maximize2 className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
