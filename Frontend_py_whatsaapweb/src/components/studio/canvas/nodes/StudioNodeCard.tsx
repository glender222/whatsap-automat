import React, { useCallback } from 'react';
import type {
  WorkflowNodeDefinitionV1,
  WorkflowRunStatus,
} from '../../types';
import {
  GripHorizontal,
  CheckCircle2,
  Loader2,
  Hourglass,
  UserCheck,
  XCircle,
  Ban,
  Clock,
} from 'lucide-react';

export interface StudioNodeCardProps {
  node: WorkflowNodeDefinitionV1;
  isSelected: boolean;
  onSelect: (nodeId: string) => void;
  onStartDrag?: (nodeId: string, e: React.MouseEvent) => void;
  onStartConnect?: (nodeId: string, handleId?: string, e?: React.MouseEvent) => void;
  onEndConnect?: (nodeId: string) => void;
  runStatus?: WorkflowRunStatus;
  isCurrentStep?: boolean;
  hasValidationError?: boolean;
  children?: React.ReactNode;
}

export const NODE_WIDTH = 240;
export const NODE_HEIGHT = 96;

export const StudioNodeCard: React.FC<StudioNodeCardProps> = ({
  node,
  isSelected,
  onSelect,
  onStartDrag,
  onStartConnect,
  onEndConnect,
  runStatus,
  isCurrentStep,
  hasValidationError,
  children,
}) => {
  const position = node.position || { x: 0, y: 0 };

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onSelect(node.id);
    },
    [node.id, onSelect]
  );

  const handleDragHandleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onSelect(node.id);
      if (onStartDrag) {
        onStartDrag(node.id, e);
      }
    },
    [node.id, onSelect, onStartDrag]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onSelect(node.id);
      }
    },
    [node.id, onSelect]
  );

  // Status visual indicators
  let statusRingClass = 'border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700';
  let statusBadge: React.ReactNode = null;

  if (hasValidationError) {
    statusRingClass = 'ring-2 ring-red-500 border-red-500 dark:border-red-500';
  } else if (isCurrentStep) {
    statusRingClass = 'ring-2 ring-blue-500 border-blue-500 dark:border-blue-400 shadow-lg animate-pulse';
  } else if (isSelected) {
    statusRingClass = 'ring-2 ring-teal-500 border-teal-500 dark:border-teal-400 shadow-md';
  }

  if (runStatus === 'running' || (isCurrentStep && !runStatus)) {
    statusBadge = (
      <span className="flex items-center gap-1 text-[11px] font-medium text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/60 px-1.5 py-0.5 rounded border border-blue-200 dark:border-blue-800">
        <Loader2 size={12} className="animate-spin" />
        Ejecutando
      </span>
    );
  } else if (runStatus === 'waiting_timer') {
    statusBadge = (
      <span className="flex items-center gap-1 text-[11px] font-medium text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/60 px-1.5 py-0.5 rounded border border-amber-200 dark:border-amber-800">
        <Hourglass size={12} />
        Esperando
      </span>
    );
  } else if (runStatus === 'waiting_approval') {
    statusBadge = (
      <span className="flex items-center gap-1 text-[11px] font-medium text-purple-600 dark:text-purple-400 bg-purple-50 dark:bg-purple-950/60 px-1.5 py-0.5 rounded border border-purple-200 dark:border-purple-800 animate-pulse">
        <UserCheck size={12} />
        Aprobación
      </span>
    );
  } else if (runStatus === 'completed') {
    statusBadge = (
      <span className="flex items-center gap-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/60 px-1.5 py-0.5 rounded border border-emerald-200 dark:border-emerald-800">
        <CheckCircle2 size={12} />
        Completado
      </span>
    );
  } else if (runStatus === 'failed') {
    statusBadge = (
      <span className="flex items-center gap-1 text-[11px] font-medium text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/60 px-1.5 py-0.5 rounded border border-red-200 dark:border-red-800">
        <XCircle size={12} />
        Error
      </span>
    );
  } else if (runStatus === 'cancelled') {
    statusBadge = (
      <span className="flex items-center gap-1 text-[11px] font-medium text-slate-600 dark:text-slate-400 bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded border border-slate-300 dark:border-slate-700">
        <Ban size={12} />
        Cancelado
      </span>
    );
  } else if (runStatus === 'queued') {
    statusBadge = (
      <span className="flex items-center gap-1 text-[11px] font-medium text-slate-600 dark:text-slate-400 bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded border border-slate-300 dark:border-slate-700">
        <Clock size={12} />
        En cola
      </span>
    );
  }

  const isTrigger = node.kind === 'trigger';
  const isEnd = node.kind === 'end';
  const isCondition = node.kind === 'condition';

  return (
    <div
      id={`studio-node-${node.id}`}
      data-testid={`studio-node-${node.id}`}
      className={`studio-node-card absolute bg-white dark:bg-slate-900 rounded-xl border ${statusRingClass} transition-shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500`}
      style={{
        left: `${position.x}px`,
        top: `${position.y}px`,
        width: `${NODE_WIDTH}px`,
        minHeight: `${NODE_HEIGHT}px`,
        zIndex: isSelected ? 30 : 10,
      }}
      role="button"
      tabIndex={0}
      aria-selected={isSelected}
      aria-label={`Nodo ${node.label || node.id} tipo ${node.kind}`}
      onClick={handleMouseDown}
      onKeyDown={handleKeyDown}
    >
      {/* Input Port (Left) - Non-Trigger Nodes */}
      {!isTrigger && (
        <div
          data-testid={`port-input-${node.id}`}
          className="studio-port-input absolute -left-2 top-1/2 -translate-y-1/2 w-4 h-4 rounded-full bg-slate-300 dark:bg-slate-600 border-2 border-white dark:border-slate-900 hover:scale-125 hover:bg-teal-500 transition-transform cursor-pointer z-20"
          title="Puerto de entrada"
          onMouseUp={(e) => {
            e.stopPropagation();
            if (onEndConnect) onEndConnect(node.id);
          }}
        />
      )}

      {/* Header / Drag Handle */}
      <div
        className="studio-drag-handle flex items-center justify-between px-3 py-2 border-b border-slate-100 dark:border-slate-800/80 cursor-grab active:cursor-grabbing bg-slate-50/70 dark:bg-slate-800/40 rounded-t-xl"
        onMouseDown={handleDragHandleMouseDown}
      >
        <div className="flex items-center gap-1.5 overflow-hidden">
          <GripHorizontal size={14} className="text-slate-400 shrink-0" />
          <span className="text-[10px] uppercase font-bold tracking-wider text-slate-500 dark:text-slate-400">
            {node.kind}
          </span>
        </div>
        {statusBadge}
      </div>

      {/* Body Content */}
      <div className="p-3">
        <h4 className="text-xs font-semibold text-slate-900 dark:text-slate-100 truncate mb-1">
          {node.label || node.id}
        </h4>
        {children}
      </div>

      {/* Output Port(s) (Right) */}
      {!isEnd && !isCondition && (
        <div
          data-testid={`port-output-${node.id}`}
          className="studio-port-output absolute -right-2 top-1/2 -translate-y-1/2 w-4 h-4 rounded-full bg-teal-500 border-2 border-white dark:border-slate-900 hover:scale-125 transition-transform cursor-crosshair z-20"
          title="Arrastrar para conectar"
          onMouseDown={(e) => {
            e.stopPropagation();
            if (onStartConnect) onStartConnect(node.id, undefined, e);
          }}
        />
      )}

      {/* Condition Dual Output Ports */}
      {isCondition && (
        <>
          {/* True Handle */}
          <div
            data-testid={`port-output-${node.id}-true`}
            className="studio-port-output-true absolute -right-2 top-[34px] w-4 h-4 rounded-full bg-emerald-500 border-2 border-white dark:border-slate-900 hover:scale-125 transition-transform cursor-crosshair z-20"
            title="Salida: Verdadero (True)"
            onMouseDown={(e) => {
              e.stopPropagation();
              if (onStartConnect) onStartConnect(node.id, 'true', e);
            }}
          />
          {/* False Handle */}
          <div
            data-testid={`port-output-${node.id}-false`}
            className="studio-port-output-false absolute -right-2 top-[66px] w-4 h-4 rounded-full bg-rose-500 border-2 border-white dark:border-slate-900 hover:scale-125 transition-transform cursor-crosshair z-20"
            title="Salida: Falso (False)"
            onMouseDown={(e) => {
              e.stopPropagation();
              if (onStartConnect) onStartConnect(node.id, 'false', e);
            }}
          />
        </>
      )}
    </div>
  );
};
