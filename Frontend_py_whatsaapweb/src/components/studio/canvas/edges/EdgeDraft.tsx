import React from 'react';
import type { WorkflowNodePosition } from '../../types';
import { NODE_WIDTH, NODE_HEIGHT } from '../nodes/StudioNodeCard';
import { computeBezierCurve } from './StudioEdge';

export interface EdgeDraftProps {
  sourcePos: WorkflowNodePosition;
  cursorPos: { x: number; y: number };
  sourceHandle?: string;
  sourceKind?: string;
}

export const EdgeDraft: React.FC<EdgeDraftProps> = ({
  sourcePos,
  cursorPos,
  sourceHandle,
  sourceKind,
}) => {
  let sourceY = sourcePos.y + NODE_HEIGHT / 2;
  if (sourceKind === 'condition') {
    if (sourceHandle === 'true') {
      sourceY = sourcePos.y + 34;
    } else if (sourceHandle === 'false') {
      sourceY = sourcePos.y + 66;
    }
  }

  const sourceX = sourcePos.x + NODE_WIDTH;
  const { pathData } = computeBezierCurve(sourceX, sourceY, cursorPos.x, cursorPos.y);

  return (
    <path
      d={pathData}
      fill="none"
      stroke="#14B8A6"
      strokeWidth={2}
      strokeDasharray="4 4"
      markerEnd="url(#studio-arrow-selected)"
      className="pointer-events-none"
    />
  );
};
