import React, { useState } from 'react';
import type { StudioToolbarProps } from '../types';
import {
  Play,
  CheckCircle,
  RotateCcw,
  Upload,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Split,
  Layout,
  ListTree,
  Loader2,
  History,
} from 'lucide-react';

export const StudioToolbar: React.FC<StudioToolbarProps> = ({
  workflowName,
  status,
  revisions,
  activeRevisionNumber,
  onSelectRevision,
  viewMode,
  onChangeViewMode,
  onValidate,
  onSimulate,
  onPublish,
  onRollback,
  onResetZoom,
  onZoomIn,
  onZoomOut,
  zoomLevel,
  isSimulating = false,
  isValidating = false,
}) => {
  const [showRollbackModal, setShowRollbackModal] = useState(false);
  const [rollbackReason, setRollbackReason] = useState('');
  const [targetRevisionNumber, setTargetRevisionNumber] = useState<number>(activeRevisionNumber);

  const handleOpenRollback = () => {
    // Select previous revision by default
    const previous = revisions.find((r) => r.revisionNumber !== activeRevisionNumber);
    if (previous) {
      setTargetRevisionNumber(previous.revisionNumber);
    }
    setRollbackReason('');
    setShowRollbackModal(true);
  };

  const handleConfirmRollback = () => {
    if (!rollbackReason || rollbackReason.length < 5) return;
    onRollback(targetRevisionNumber, rollbackReason);
    setShowRollbackModal(false);
  };

  return (
    <header
      role="toolbar"
      aria-label="Barra de herramientas de Automation Studio"
      className="studio-toolbar flex items-center justify-between px-4 py-2 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 z-sticky gap-2 shrink-0 select-none"
    >
      {/* Left: Workflow identity, status badge, revision picker */}
      <div className="flex items-center gap-3">
        <h2 className="text-sm font-bold text-slate-800 dark:text-slate-100 truncate max-w-xs">
          {workflowName}
        </h2>

        {/* Status Badge */}
        <span
          className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${
            status === 'published'
              ? 'bg-emerald-100 dark:bg-emerald-950 text-emerald-800 dark:text-emerald-300'
              : status === 'draft'
              ? 'bg-amber-100 dark:bg-amber-950 text-amber-800 dark:text-amber-300'
              : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400'
          }`}
        >
          {status}
        </span>

        {/* Revision Selector */}
        {revisions.length > 0 && (
          <div className="flex items-center gap-1 text-xs">
            <span className="text-slate-400 text-[11px]">Rev:</span>
            <select
              aria-label="Selector de revisión"
              value={activeRevisionNumber}
              onChange={(e) => onSelectRevision(Number(e.target.value))}
              className="py-0.5 px-2 rounded bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 text-xs focus:outline-none focus:ring-1 focus:ring-teal-500 font-mono"
            >
              {revisions.map((rev) => (
                <option key={rev.id} value={rev.revisionNumber}>
                  v{rev.revisionNumber} ({rev.status})
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* Center: View Mode Segmented Controls */}
      <div className="flex items-center bg-slate-100 dark:bg-slate-800 p-0.5 rounded-lg border border-slate-200 dark:border-slate-700">
        <button
          type="button"
          onClick={() => onChangeViewMode('split')}
          aria-pressed={viewMode === 'split'}
          title="Vista dividida (Lienzo + Esquema)"
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-colors ${
            viewMode === 'split'
              ? 'bg-white dark:bg-slate-900 text-teal-600 dark:text-teal-400 shadow-sm'
              : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
          }`}
        >
          <Split size={13} />
          <span>Dividida</span>
        </button>

        <button
          type="button"
          onClick={() => onChangeViewMode('canvas')}
          aria-pressed={viewMode === 'canvas'}
          title="Vista Lienzo visual"
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-colors ${
            viewMode === 'canvas'
              ? 'bg-white dark:bg-slate-900 text-teal-600 dark:text-teal-400 shadow-sm'
              : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
          }`}
        >
          <Layout size={13} />
          <span>Lienzo</span>
        </button>

        <button
          type="button"
          onClick={() => onChangeViewMode('outline')}
          aria-pressed={viewMode === 'outline'}
          title="Vista Esquema accesible"
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-colors ${
            viewMode === 'outline'
              ? 'bg-white dark:bg-slate-900 text-teal-600 dark:text-teal-400 shadow-sm'
              : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
          }`}
        >
          <ListTree size={13} />
          <span>Esquema</span>
        </button>
      </div>

      {/* Right: Actions & Zoom Controls */}
      <div className="flex items-center gap-2">
        {/* Zoom Controls */}
        <div className="flex items-center border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden bg-slate-50 dark:bg-slate-800">
          <button
            type="button"
            onClick={onZoomOut}
            title="Reducir zoom (-)"
            className="p-1.5 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700"
          >
            <ZoomOut size={13} />
          </button>
          <span className="px-1.5 text-[10px] font-mono font-medium text-slate-600 dark:text-slate-300 min-w-[36px] text-center">
            {Math.round(zoomLevel * 100)}%
          </span>
          <button
            type="button"
            onClick={onZoomIn}
            title="Aumentar zoom (+)"
            className="p-1.5 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700"
          >
            <ZoomIn size={13} />
          </button>
          <button
            type="button"
            onClick={onResetZoom}
            title="Reajustar vista (100%)"
            className="p-1.5 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700 border-l border-slate-200 dark:border-slate-700"
          >
            <Maximize2 size={13} />
          </button>
        </div>

        {/* Validate Button */}
        <button
          type="button"
          onClick={onValidate}
          disabled={isValidating}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 font-medium text-xs transition-colors"
        >
          {isValidating ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle size={13} />}
          <span>Validar</span>
        </button>

        {/* Simulate Button */}
        <button
          type="button"
          onClick={onSimulate}
          disabled={isSimulating}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 font-medium text-xs hover:bg-blue-100 dark:hover:bg-blue-900/60 transition-colors"
        >
          {isSimulating ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
          <span>Simular</span>
        </button>

        {/* Rollback Button */}
        {revisions.length > 1 && (
          <button
            type="button"
            onClick={handleOpenRollback}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 font-medium text-xs hover:bg-amber-100 transition-colors"
          >
            <RotateCcw size={13} />
            <span>Rollback</span>
          </button>
        )}

        {/* Publish Button */}
        <button
          type="button"
          onClick={onPublish}
          className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-teal-600 hover:bg-teal-700 text-white font-semibold text-xs shadow-sm transition-colors"
        >
          <Upload size={13} />
          <span>Publicar</span>
        </button>
      </div>

      {/* Rollback Revision Modal */}
      {showRollbackModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="rollback-dialog-title"
          className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center z-modal p-4"
        >
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 max-w-md w-full shadow-2xl flex flex-col gap-3">
            <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400 font-bold text-base">
              <History size={18} />
              <h3 id="rollback-dialog-title">Rollback Atómico de Revisión</h3>
            </div>
            <p className="text-xs text-slate-600 dark:text-slate-400">
              Esta operación cambiará el puntero activo de la versión publicada de forma atómica. Las ejecuciones en vuelo continuarán en su revisión actual.
            </p>

            <div className="flex flex-col gap-1">
              <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                Seleccionar versión de destino:
              </label>
              <select
                value={targetRevisionNumber}
                onChange={(e) => setTargetRevisionNumber(Number(e.target.value))}
                className="p-2 rounded bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-xs font-mono"
              >
                {revisions
                  .filter((r) => r.revisionNumber !== activeRevisionNumber)
                  .map((r) => (
                    <option key={r.id} value={r.revisionNumber}>
                      Revisión v{r.revisionNumber} ({new Date(r.createdAt).toLocaleDateString()})
                    </option>
                  ))}
              </select>
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                Motivo de auditoría (mínimo 5 caracteres):
              </label>
              <input
                type="text"
                placeholder="Ej. Incidente de regresión en cálculo de impuestos"
                value={rollbackReason}
                onChange={(e) => setRollbackReason(e.target.value)}
                className="p-2 rounded bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-xs text-slate-800 dark:text-slate-100"
              />
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowRollbackModal(false)}
                className="px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={handleConfirmRollback}
                disabled={rollbackReason.length < 5}
                className="px-4 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-xs font-semibold disabled:opacity-50 transition-colors"
              >
                Confirmar Rollback
              </button>
            </div>
          </div>
        </div>
      )}
    </header>
  );
};
