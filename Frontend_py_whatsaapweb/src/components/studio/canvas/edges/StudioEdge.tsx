import React from 'react';
import type { WorkflowEdgeDefinitionV1, WorkflowNodePosition } from '../../types';
import { NODE_WIDTH, NODE_HEIGHT } from '../nodes/StudioNodeCard';

export interface StudioEdgeProps {
  edge: WorkflowEdgeDefinitionV1;
  sourcePos: WorkflowNodePosition;
  targetPos: WorkflowNodePosition;
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

export const StudioEdge: React.FC<StudioEdgeProps> = ({
  edge,
  sourcePos,
  targetPos,
  sourceKind,
  isSelected,
  isTraversed,
  onClick,
}) => {
  // Compute handle coordinates
  let sourceY = sourcePos.y + NODE_HEIGHT / 2;
  if (sourceKind === 'condition') {
    if (edge.sourceHandle === 'true' || edge.condition === 'true') {
      sourceY = sourcePos.y + 34;
    } else if (edge.sourceHandle === 'false' || edge.condition === 'false') {
      sourceY = sourcePos.y + 66;
    }
  }

  const sourceX = sourcePos.x + NODE_WIDTH;
  const targetX = targetPos.x;
  const targetY = targetPos.y + NODE_HEIGHT / 2;

  const { pathData, midX, midY } = computeBezierCurve(sourceX, sourceY, targetX, targetY);

  const label = edge.label || edge.condition;

  return (
    <g
      id={`studio-edge-${edge.id}`}
      data-testid={`studio-edge-${edge.id}`}
      className="studio-edge-group cursor-pointer"
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
        markerEnd={isSelected ? 'url(#studio-arrow-selected)' : 'url(#studio-arrow-default)'}
      />

      {/* Optional Condition/Edge Label Badge */}
      {Boolean(label) && (
        <foreignObject
          x={midX - 60}
          y={midY - 12}
          width={120}
          height={24}
          className="overflow-visible pointer-events-none"
        >
          <div className="flex items-center justify-center">
            <span
              className={`px-2 py-0.5 text-[10px] font-semibold rounded-full border shadow-sm backdrop-blur-sm whitespace-nowrap ${
                edge.sourceHandle === 'true' || edge.condition === 'true'
                  ? 'bg-emerald-50 dark:bg-emerald-950/80 text-emerald-700 dark:text-emerald-300 border-emerald-300 dark:border-emerald-700'
                  : edge.sourceHandle === 'false' || edge.condition === 'false'
                  ? 'bg-rose-50 dark:bg-rose-950/80 text-rose-700 dark:text-rose-300 border-rose-300 dark:border-rose-700'
                  : 'bg-white/90 dark:bg-slate-900/90 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-800'
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
