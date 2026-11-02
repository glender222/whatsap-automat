import React, { useState, useRef, useCallback, useEffect } from 'react';
import type {
  StudioCanvasProps,
  WorkflowNodeDefinitionV1,
  WorkflowNodePosition,
  ViewportTransform,
} from '../types';
import { CanvasViewport } from './CanvasViewport';
import { StudioNodeCard, NODE_WIDTH, NODE_HEIGHT } from './nodes/StudioNodeCard';
import { TriggerNode } from './nodes/TriggerNode';
import { ConditionNode } from './nodes/ConditionNode';
import { DelayNode } from './nodes/DelayNode';
import { ActivityNode } from './nodes/ActivityNode';
import { ApprovalNode } from './nodes/ApprovalNode';
import { EndNode } from './nodes/EndNode';
import { StudioEdge } from './edges/StudioEdge';
import { EdgeDraft } from './edges/EdgeDraft';

export const StudioCanvas: React.FC<StudioCanvasProps> = ({
  dagGraph,
  selectedNodeId,
  onSelectNode,
  activeRun,
  validationResult,
  onUpdateNodePosition,
  onConnect,
  className = '',
  viewportTransform,
  onViewportChange,
}) => {
  // Local or controlled viewport
  const [internalViewport, setInternalViewport] = useState<ViewportTransform>({
    pan: { x: 60, y: 40 },
    zoom: 1.0,
  });

  const activeViewport = viewportTransform || internalViewport;
  const updateViewport = onViewportChange || setInternalViewport;

  // Node Drag State
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null);
  const dragStartRef = useRef<{
    clientX: number;
    clientY: number;
    startPos: WorkflowNodePosition;
  }>({ clientX: 0, clientY: 0, startPos: { x: 0, y: 0 } });

  // In-flight connection state
  const [connectingState, setConnectingState] = useState<{
    sourceId: string;
    sourceHandle?: string;
    cursorPos: { x: number; y: number };
  } | null>(null);

  // Auto-center viewport when selected node changes and is not currently in center
  const prevSelectedIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (selectedNodeId && selectedNodeId !== prevSelectedIdRef.current) {
      prevSelectedIdRef.current = selectedNodeId;
      const targetNode = dagGraph.nodes.find((n) => n.id === selectedNodeId);
      if (targetNode?.position) {
        // Auto-center on target node
        const targetX = targetNode.position.x + NODE_WIDTH / 2;
        const targetY = targetNode.position.y + NODE_HEIGHT / 2;
        // In a typical 800x600 container estimate
        const viewportCenterX = 400;
        const viewportCenterY = 300;
        updateViewport({
          zoom: activeViewport.zoom,
          pan: {
            x: Math.round(viewportCenterX - targetX * activeViewport.zoom),
            y: Math.round(viewportCenterY - targetY * activeViewport.zoom),
          },
        });
      }
    }
  }, [selectedNodeId, dagGraph.nodes, activeViewport.zoom, updateViewport]);

  // Start Node Dragging
  const handleStartDrag = useCallback(
    (nodeId: string, e: React.MouseEvent) => {
      const node = dagGraph.nodes.find((n) => n.id === nodeId);
      if (!node) return;
      const pos = node.position || { x: 0, y: 0 };
      dragStartRef.current = {
        clientX: e.clientX,
        clientY: e.clientY,
        startPos: { ...pos },
      };
      setDraggingNodeId(nodeId);
    },
    [dagGraph.nodes]
  );

  // Mouse move handler on window during drag or connect
  useEffect(() => {
    const handleWindowMouseMove = (e: MouseEvent) => {
      if (draggingNodeId) {
        const dx = (e.clientX - dragStartRef.current.clientX) / activeViewport.zoom;
        const dy = (e.clientY - dragStartRef.current.clientY) / activeViewport.zoom;
        const nextX = Math.round(dragStartRef.current.startPos.x + dx);
        const nextY = Math.round(dragStartRef.current.startPos.y + dy);

        if (onUpdateNodePosition) {
          onUpdateNodePosition(draggingNodeId, { x: nextX, y: nextY });
        }
      } else if (connectingState) {
        // Update in-flight cursor position transformed to canvas coordinate space
        const canvasX = (e.clientX - activeViewport.pan.x) / activeViewport.zoom;
        const canvasY = (e.clientY - activeViewport.pan.y) / activeViewport.zoom;
        setConnectingState((prev) => (prev ? { ...prev, cursorPos: { x: canvasX, y: canvasY } } : null));
      }
    };

    const handleWindowMouseUp = () => {
      if (draggingNodeId) {
        setDraggingNodeId(null);
      }
      if (connectingState) {
        setConnectingState(null);
      }
    };

    if (draggingNodeId || connectingState) {
      window.addEventListener('mousemove', handleWindowMouseMove);
      window.addEventListener('mouseup', handleWindowMouseUp);
      return () => {
        window.removeEventListener('mousemove', handleWindowMouseMove);
        window.removeEventListener('mouseup', handleWindowMouseUp);
      };
    }
  }, [draggingNodeId, connectingState, activeViewport, onUpdateNodePosition]);

  // Start Connection
  const handleStartConnect = useCallback(
    (nodeId: string, handleId?: string, e?: React.MouseEvent) => {
      const node = dagGraph.nodes.find((n) => n.id === nodeId);
      if (!node) return;
      const initialPos = node.position || { x: 0, y: 0 };
      const startX = initialPos.x + NODE_WIDTH;
      const startY = initialPos.y + (handleId === 'true' ? 34 : handleId === 'false' ? 66 : NODE_HEIGHT / 2);

      setConnectingState({
        sourceId: nodeId,
        sourceHandle: handleId,
        cursorPos: e
          ? {
              x: (e.clientX - activeViewport.pan.x) / activeViewport.zoom,
              y: (e.clientY - activeViewport.pan.y) / activeViewport.zoom,
            }
          : { x: startX + 40, y: startY },
      });
    },
    [dagGraph.nodes, activeViewport]
  );

  // Complete Connection
  const handleEndConnect = useCallback(
    (targetNodeId: string) => {
      if (connectingState && connectingState.sourceId !== targetNodeId) {
        if (onConnect) {
          onConnect(connectingState.sourceId, targetNodeId, connectingState.sourceHandle);
        }
      }
      setConnectingState(null);
    },
    [connectingState, onConnect]
  );

  // Map node positions for quick edge rendering
  const nodeMap = new Map<string, WorkflowNodeDefinitionV1>(dagGraph.nodes.map((n) => [n.id, n]));

  // Validation issues lookup
  const issueNodeIds = new Set(
    validationResult?.issues.map((i) => i.nodeId).filter(Boolean) as string[]
  );

  // SVG Marker definitions and edges
  const svgEdgesLayer = (
    <svg className="w-full h-full overflow-visible" style={{ width: 1, height: 1 }}>
      <defs>
        {/* Default Arrow Marker */}
        <marker
          id="studio-arrow-default"
          viewBox="0 0 10 10"
          refX={9}
          refY={5}
          markerWidth={7}
          markerHeight={7}
          orient="auto-start-reverse"
        >
          <path d="M 0 1 L 10 5 L 0 9 z" fill="#94A3B8" />
        </marker>
        {/* Selected / Active Arrow Marker */}
        <marker
          id="studio-arrow-selected"
          viewBox="0 0 10 10"
          refX={9}
          refY={5}
          markerWidth={7}
          markerHeight={7}
          orient="auto-start-reverse"
        >
          <path d="M 0 1 L 10 5 L 0 9 z" fill="#0D9488" />
        </marker>
      </defs>

      {/* Render Edges */}
      {dagGraph.edges.map((edge) => {
        const sourceNode = nodeMap.get(edge.source);
        const targetNode = nodeMap.get(edge.target);
        if (!sourceNode || !targetNode) return null;

        const sourcePos = sourceNode.position || { x: 0, y: 0 };
        const targetPos = targetNode.position || { x: 0, y: 0 };
        const isTraversed =
          activeRun?.status === 'running' && activeRun.currentStep === targetNode.id;

        return (
          <StudioEdge
            key={edge.id}
            edge={edge}
            sourcePos={sourcePos}
            targetPos={targetPos}
            sourceKind={sourceNode.kind}
            isTraversed={isTraversed}
          />
        );
      })}

      {/* In-Flight Draft Connection Line */}
      {connectingState && (
        <EdgeDraft
          sourcePos={nodeMap.get(connectingState.sourceId)?.position || { x: 0, y: 0 }}
          cursorPos={connectingState.cursorPos}
          sourceHandle={connectingState.sourceHandle}
          sourceKind={nodeMap.get(connectingState.sourceId)?.kind}
        />
      )}
    </svg>
  );

  return (
    <CanvasViewport
      viewport={activeViewport}
      onViewportChange={updateViewport}
      svgEdgesLayer={svgEdgesLayer}
      className={className}
      isInteractive={!draggingNodeId && !connectingState}
    >
      {dagGraph.nodes.map((node) => {
        const isSelected = node.id === selectedNodeId;
        const isCurrentStep = activeRun?.currentStep === node.id;
        const hasValidationError = issueNodeIds.has(node.id);

        let NodeContent: React.ReactNode = null;
        switch (node.kind) {
          case 'trigger':
            NodeContent = <TriggerNode config={node.config} />;
            break;
          case 'condition':
            NodeContent = <ConditionNode config={node.config} />;
            break;
          case 'delay':
            NodeContent = <DelayNode config={node.config} />;
            break;
          case 'activity':
            NodeContent = <ActivityNode config={node.config} />;
            break;
          case 'approval':
            NodeContent = <ApprovalNode config={node.config} />;
            break;
          case 'end':
            NodeContent = <EndNode config={node.config} />;
            break;
        }

        return (
          <StudioNodeCard
            key={node.id}
            node={node}
            isSelected={isSelected}
            isCurrentStep={isCurrentStep}
            runStatus={isCurrentStep ? activeRun?.status : undefined}
            hasValidationError={hasValidationError}
            onSelect={onSelectNode}
            onStartDrag={handleStartDrag}
            onStartConnect={handleStartConnect}
            onEndConnect={handleEndConnect}
          >
            {NodeContent}
          </StudioNodeCard>
        );
      })}
    </CanvasViewport>
  );
};
