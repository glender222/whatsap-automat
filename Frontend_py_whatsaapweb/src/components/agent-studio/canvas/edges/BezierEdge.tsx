import React from 'react';
import type { AgentStudioEdge, NodePosition } from '../../types';

export const NODE_WIDTH = 240;
export const NODE_HEIGHT = 100;

export interface BezierEdgeProps {
  edge: AgentStudioEdge;
  sourcePos: NodePosition;
  targetPos: NodePosition;
  sourceKind?: string;
  isSelected?: boolean;
  isTraversed?: boolean;
  onClick?: () => void;
}

export function computeBezierCurve(
  x1: number,
  y1: number,
  x2: number,
  y2: number
): { pathData: string; midX: number; midY: number } {
  const dx = Math.abs(x2 - x1);
  const curvature = Math.max(0.5 * dx, 48);

  const cp1x = x1 + curvature;
  const cp1y = y1;
  const cp2x = x2 - curvature;
  const cp2y = y2;

  const pathData = `M ${x1} ${y1} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${x2} ${y2}`;
  const midX = (x1 + x2) / 2;
  const midY = (y1 + y2) / 2;

  return { pathData, midX, midY };
}

export const BezierEdge: React.FC<BezierEdgeProps> = ({
  edge,
  sourcePos,
  targetPos,
  sourceKind,
  isSelected,
  isTraversed,
  onClick,
}) => {
  // Source anchor at right middle of source node
  let sourceY = sourcePos.y + NODE_HEIGHT / 2;
  if (sourceKind === 'policy_guard' || sourceKind === 'gate') {
    if (edge.sourceHandle === 'outside_hours' || edge.sourceHandle === 'rejected') {
      sourceY = sourcePos.y + NODE_HEIGHT * 0.75;
    } else if (edge.sourceHandle === 'within_hours' || edge.sourceHandle === 'approved') {
      sourceY = sourcePos.y + NODE_HEIGHT * 0.25;
    }
  }

  const sourceX = sourcePos.x + NODE_WIDTH;
  const targetX = targetPos.x;
  const targetY = targetPos.y + NODE_HEIGHT / 2;

  const { pathData, midX, midY } = computeBezierCurve(sourceX, sourceY, targetX, targetY);
  const label = edge.conditionLabel;

  return (
    <g
      id={`agent-edge-${edge.id}`}
      data-testid={`agent-edge-${edge.id}`}
      className="agent-edge-group cursor-pointer select-none"
      onClick={onClick}
    >
      {/* Invisible wider hit-area for clicking */}
      <path
        d={pathData}
        fill="none"
        stroke="transparent"
        strokeWidth={20}
        className="pointer-events-auto"
      />

      {/* Visible Path */}
      <path
        d={pathData}
        fill="none"
        stroke={
          isSelected
            ? '#0D9488' // Teal
            : isTraversed
            ? '#3B82F6' // Blue
            : '#94A3B8' // Slate-400
        }
        strokeWidth={isSelected || isTraversed ? 2.5 : 2}
        strokeDasharray={isTraversed ? '6 4' : undefined}
        className={isTraversed ? 'animate-[dash_1s_linear_infinite]' : ''}
        markerEnd={isSelected ? 'url(#agent-arrow-selected)' : 'url(#agent-arrow-default)'}
      />

      {/* Optional Condition/Edge Label Badge */}
      {Boolean(label) && (
        <foreignObject
          x={midX - 50}
          y={midY - 12}
          width={100}
          height={24}
          className="overflow-visible pointer-events-none"
        >
          <div className="flex items-center justify-center h-full">
            <span
              className={`px-2 py-0.5 rounded text-[10px] font-medium tracking-tight shadow-sm border ${
                isSelected
                  ? 'bg-teal-50 text-teal-800 border-teal-300 dark:bg-teal-950 dark:text-teal-200 dark:border-teal-800'
                  : 'bg-white text-slate-700 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700'
              }`}
            >
              {label}
            </span>
          </div>
        </foreignObject>
      )}
    </g>
  );
};
