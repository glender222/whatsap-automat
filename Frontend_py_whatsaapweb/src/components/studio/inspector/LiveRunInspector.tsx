import React, { useState, useEffect, useCallback } from 'react';
import type {
  LiveRunInspectorProps,
  ApprovalDecisionPayload,
  WorkflowRunStatus,
} from '../types';
import { JsonViewer } from './JsonViewer';
import {
  Clock,
  Loader2,
  Hourglass,
  UserCheck,
  CheckCircle2,
  XCircle,
  Ban,
  AlertTriangle,
  Target,
  ShieldAlert,
  ChevronDown,
  X,
} from 'lucide-react';

export const LiveRunInspector: React.FC<LiveRunInspectorProps> = ({
  run,
  nodes,
  selectedNodeId: _selectedNodeId,
  onSelectNode,
  onApprovalDecision,
  isApprovalSubmitting = false,
  onClose,
  className = '',
}) => {
  const [decisionReason, setDecisionReason] = useState('');
  const [activeTab, setActiveTab] = useState<'variables' | 'history' | 'error'>('variables');

  // Find node corresponding to current step
  const activeNode = run?.currentStep
    ? nodes.find((n) => n.id === run.currentStep)
    : null;

  // Format latency duration
  const formattedLatency = (() => {
    if (!run?.startedAt) return '—';
    const start = new Date(run.startedAt).getTime();
    const end = run.completedAt ? new Date(run.completedAt).getTime() : Date.now();
    const diffMs = Math.max(0, end - start);
    return diffMs >= 1000 ? `${(diffMs / 1000).toFixed(2)}s` : `${diffMs}ms`;
  })();

  // Handle Human Approval Decisions
  const handleApprove = useCallback(() => {
    if (!run || !onApprovalDecision) return;
    const approvalId = `app_${run.id}_${run.currentStep || 'approval'}`;
    const payload: ApprovalDecisionPayload = {
      approvalId,
      decision: 'approved',
      actor: {
        userId: 'current_operator',
        roles: ['operator', 'admin'],
      },
      reason: decisionReason || undefined,
      timestamp: new Date().toISOString(),
    };
    onApprovalDecision(payload);
  }, [run, decisionReason, onApprovalDecision]);

  const handleReject = useCallback(() => {
    if (!run || !onApprovalDecision) return;
    const approvalId = `app_${run.id}_${run.currentStep || 'approval'}`;
    const payload: ApprovalDecisionPayload = {
      approvalId,
      decision: 'rejected',
      actor: {
        userId: 'current_operator',
        roles: ['operator', 'admin'],
      },
      reason: decisionReason || 'Rechazado por operador en Automation Studio',
      timestamp: new Date().toISOString(),
    };
    onApprovalDecision(payload);
  }, [run, decisionReason, onApprovalDecision]);

  // Keyboard shortcut listener: Alt+A (Approve) & Alt+R (Reject)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (run?.status === 'waiting_approval' && !isApprovalSubmitting) {
        if (e.altKey && (e.key === 'a' || e.key === 'A')) {
          e.preventDefault();
          handleApprove();
        } else if (e.altKey && (e.key === 'r' || e.key === 'R')) {
          e.preventDefault();
          handleReject();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [run?.status, isApprovalSubmitting, handleApprove, handleReject]);

  // Render Status Badge
  const renderStatusBadge = (status?: WorkflowRunStatus) => {
    switch (status) {
      case 'queued':
        return (
          <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300 border border-slate-300 dark:border-slate-700">
            <Clock size={13} />
            En cola
          </span>
        );
      case 'running':
        return (
          <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-blue-50 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300 border border-blue-200 dark:border-blue-800 animate-pulse">
            <Loader2 size={13} className="animate-spin" />
            Ejecución activa
          </span>
        );
      case 'waiting_timer':
        return (
          <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300 border border-amber-200 dark:border-amber-800">
            <Hourglass size={13} />
            Pausa temporizada
          </span>
        );
      case 'waiting_approval':
        return (
          <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-purple-50 text-purple-700 dark:bg-purple-950/60 dark:text-purple-300 border border-purple-200 dark:border-purple-800 animate-pulse">
            <UserCheck size={13} />
            Aprobación requerida
          </span>
        );
      case 'completed':
        return (
          <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800">
            <CheckCircle2 size={13} />
            Completado
          </span>
        );
      case 'failed':
        return (
          <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-red-50 text-red-700 dark:bg-red-950/60 dark:text-red-300 border border-red-200 dark:border-red-800">
            <XCircle size={13} />
            Fallido
          </span>
        );
      case 'cancelled':
        return (
          <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-slate-200 text-slate-800 dark:bg-slate-700 dark:text-slate-200 border border-slate-400">
            <Ban size={13} />
            Cancelado
          </span>
        );
      case 'timed_out':
        return (
          <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-orange-50 text-orange-700 dark:bg-orange-950/60 dark:text-orange-300 border border-orange-200 dark:border-orange-800">
            <AlertTriangle size={13} />
            Tiempo agotado
          </span>
        );
      default:
        return (
          <span className="text-xs text-slate-400 italic">Sin ejecución activa</span>
        );
    }
  };

  if (!run) {
    return (
      <aside
        role="complementary"
        aria-label="Inspector de ejecución en vivo"
        className={`live-run-inspector flex flex-col w-80 bg-white dark:bg-slate-900 border-l border-slate-200 dark:border-slate-800 p-4 text-xs ${className}`}
      >
        <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800">
          <h3 className="font-bold uppercase tracking-wider text-slate-500">
            Inspector en Vivo
          </h3>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
            >
              <X size={14} />
            </button>
          )}
        </div>
        <div className="flex-1 flex flex-col items-center justify-center text-center text-slate-400 gap-2 p-4">
          <Clock size={28} className="opacity-40" />
          <p>No hay ninguna ejecución activa seleccionada.</p>
          <p className="text-[11px] text-slate-500">
            Simule o inicie un workflow para inspeccionar trazas, variables y compuertas en tiempo real.
          </p>
        </div>
      </aside>
    );
  }

  return (
    <aside
      role="complementary"
      aria-label="Inspector de ejecución en vivo"
      className={`live-run-inspector flex flex-col w-80 bg-white dark:bg-slate-900 border-l border-slate-200 dark:border-slate-800 h-full overflow-y-auto text-xs ${className}`}
    >
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b border-slate-100 dark:border-slate-800 shrink-0">
        <div className="flex flex-col">
          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
            Inspector de Ejecución
          </span>
          <span className="font-mono text-slate-800 dark:text-slate-100 font-semibold truncate max-w-[190px]">
            {run.id}
          </span>
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded"
          >
            <X size={14} />
          </button>
        )}
      </div>

      <div className="p-3 flex flex-col gap-3.5 flex-1">
        {/* Status Pill & Latency */}
        <div className="flex items-center justify-between">
          {renderStatusBadge(run.status)}
          <div className="flex items-center gap-1 font-mono text-[11px] text-slate-500">
            <Clock size={12} />
            <span>{formattedLatency}</span>
          </div>
        </div>

        {/* Active Node Metric */}
        {activeNode && (
          <div className="flex flex-col gap-1 p-2.5 rounded-lg bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700">
            <div className="flex items-center justify-between">
              <span className="text-[10px] uppercase font-bold text-slate-400">
                Paso #{run.stepCount}
              </span>
              <button
                type="button"
                onClick={() => onSelectNode(activeNode.id)}
                className="flex items-center gap-1 text-[10px] text-teal-600 dark:text-teal-400 hover:underline"
              >
                <Target size={11} />
                <span>Centrar</span>
              </button>
            </div>
            <span className="font-semibold text-slate-800 dark:text-slate-100 truncate">
              {activeNode.label || activeNode.id}
            </span>
            <span className="text-[10px] text-slate-500 uppercase font-mono">
              Tipo: {activeNode.kind}
            </span>
          </div>
        )}

        {/* Human Approval Gate (HITL) Alert & Controls */}
        {run.status === 'waiting_approval' && (
          <div
            role="alert"
            data-testid="approval-gate-panel"
            className="flex flex-col gap-2 p-3 rounded-lg bg-purple-50 dark:bg-purple-950/50 border border-purple-200 dark:border-purple-800"
          >
            <div className="flex items-center gap-1.5 text-purple-800 dark:text-purple-200 font-bold">
              <ShieldAlert size={15} className="text-purple-600 dark:text-purple-400 shrink-0" />
              <span>Aprobación Requerida (Gate HITL)</span>
            </div>
            <p className="text-[11px] text-purple-700 dark:text-purple-300">
              Este paso requiere autorización manual de operador para continuar la ejecución del workflow.
            </p>

            {/* Decision Reason Textarea */}
            <textarea
              value={decisionReason}
              onChange={(e) => setDecisionReason(e.target.value)}
              placeholder="Motivo o comentarios de la decisión (opcional)..."
              aria-label="Motivo de la decisión de aprobación"
              rows={2}
              disabled={isApprovalSubmitting}
              className="p-1.5 text-xs rounded bg-white dark:bg-slate-900 border border-purple-300 dark:border-purple-700 text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-purple-500 resize-none disabled:opacity-50"
            />

            {/* Action Buttons */}
            <div className="flex items-center gap-2 pt-1">
              <button
                type="button"
                onClick={handleApprove}
                disabled={isApprovalSubmitting}
                aria-busy={isApprovalSubmitting}
                className="flex-1 flex items-center justify-center gap-1.5 py-1.5 px-3 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-semibold shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-50 transition-colors"
              >
                {isApprovalSubmitting ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <CheckCircle2 size={13} />
                )}
                <span>Aprobar Flujo</span>
              </button>

              <button
                type="button"
                onClick={handleReject}
                disabled={isApprovalSubmitting}
                aria-busy={isApprovalSubmitting}
                className="flex-1 flex items-center justify-center gap-1.5 py-1.5 px-3 rounded-lg bg-red-600 hover:bg-red-700 text-white font-semibold shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 disabled:opacity-50 transition-colors"
              >
                {isApprovalSubmitting ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <XCircle size={13} />
                )}
                <span>Rechazar Flujo</span>
              </button>
            </div>
            <span className="text-[9px] text-purple-600 dark:text-purple-400 text-center font-mono">
              Atajos: Alt+A (Aprobar) | Alt+R (Rechazar)
            </span>
          </div>
        )}

        {/* Error Details Diagnostics */}
        {(run.status === 'failed' || Boolean(run.errorDetails)) && run.errorDetails && (
          <div
            role="alert"
            data-testid="error-diagnostics-panel"
            className="flex flex-col gap-2 p-3 rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800"
          >
            <div className="flex items-center justify-between">
              <span className="font-bold text-red-800 dark:text-red-200 flex items-center gap-1">
                <AlertTriangle size={14} />
                Diagnóstico de Error
              </span>
              <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-red-200 dark:bg-red-900 text-red-800 dark:text-red-200">
                {run.errorDetails.code}
              </span>
            </div>

            <p className="text-[11px] text-red-700 dark:text-red-300 font-medium">
              {run.errorDetails.message}
            </p>

            <div className="flex items-center justify-between text-[10px] text-slate-500">
              <span>Reintentable: {run.errorDetails.retryable ? 'Sí' : 'No'}</span>
              {run.errorDetails.nodeId && (
                <button
                  type="button"
                  onClick={() => onSelectNode(run.errorDetails!.nodeId!)}
                  className="text-red-600 dark:text-red-400 hover:underline"
                >
                  Ir al paso fallido
                </button>
              )}
            </div>

            {/* Collapsible Stack Trace */}
            {Boolean(run.errorDetails.stack) && (
              <details className="mt-1">
                <summary className="text-[10px] text-red-600 dark:text-red-400 cursor-pointer hover:underline flex items-center gap-1">
                  <ChevronDown size={12} />
                  Ver traza de error (Stack)
                </summary>
                <pre className="mt-1 p-2 rounded bg-slate-900 text-red-200 text-[10px] font-mono overflow-x-auto max-h-32">
                  {run.errorDetails.stack}
                </pre>
              </details>
            )}
          </div>
        )}

        {/* Tab Navigation: Variables / Payloads */}
        <div className="flex items-center gap-1 border-b border-slate-200 dark:border-slate-800 pb-1">
          <button
            type="button"
            onClick={() => setActiveTab('variables')}
            className={`px-2 py-1 rounded text-[11px] font-semibold transition-colors ${
              activeTab === 'variables'
                ? 'bg-slate-100 dark:bg-slate-800 text-teal-600 dark:text-teal-400'
                : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
            }`}
          >
            Payloads & Variables
          </button>
        </div>

        {/* JSON Variable Viewer */}
        <div className="flex flex-col gap-2">
          <JsonViewer
            title="Variables de Estado"
            data={
              Object.keys(run.outputPayload || {}).length > 0
                ? run.outputPayload
                : run.inputPayload
            }
          />
        </div>
      </div>
    </aside>
  );
};
