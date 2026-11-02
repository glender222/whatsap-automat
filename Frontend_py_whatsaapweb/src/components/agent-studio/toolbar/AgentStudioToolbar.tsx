import React from 'react';
import {
  CheckCircle2,
  Play,
  GitCompare,
  UploadCloud,
  FileCode,
  LayoutGrid,
  Sparkles,
  Columns,
  Trash2,
  AlertTriangle,
} from 'lucide-react';
import type { AgentStudioDocument, AgentStudioViewMode } from '../types';

export interface AgentStudioToolbarProps {
  document: AgentStudioDocument;
  viewMode: AgentStudioViewMode;
  onChangeViewMode: (mode: AgentStudioViewMode) => void;
  onValidate: () => void;
  onOpenSimulator: () => void;
  onOpenDiff: () => void;
  onPublish: () => void;
  onOpenRtbfModal: () => void;
  isValidating?: boolean;
  publishBlockerCount?: number;
}

export const AgentStudioToolbar: React.FC<AgentStudioToolbarProps> = ({
  document,
  viewMode,
  onChangeViewMode,
  onValidate,
  onOpenSimulator,
  onOpenDiff,
  onPublish,
  onOpenRtbfModal,
  isValidating = false,
  publishBlockerCount = 0,
}) => {
  return (
    <header
      className="flex flex-wrap items-center justify-between px-4 py-2.5 bg-white dark:bg-[#0F172A] border-b border-slate-200 dark:border-slate-800 gap-3 select-none"
      role="banner"
      aria-label="Barra de herramientas de Agent Studio"
    >
      {/* Left: Agent Info & Status */}
      <div className="flex items-center space-x-3 min-w-0">
        <div className="flex items-center space-x-2 min-w-0">
          <span className="p-1.5 rounded-lg bg-teal-50 dark:bg-teal-950/60 text-teal-600 dark:text-teal-400 border border-teal-200 dark:border-teal-800">
            <Sparkles className="w-4 h-4" />
          </span>
          <div className="min-w-0">
            <div className="flex items-center space-x-2">
              <h1 className="text-sm font-bold text-slate-900 dark:text-slate-100 truncate">
                {document.name}
              </h1>
              <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                v{document.version}
              </span>
              <span
                className={`px-2 py-0.5 rounded-full text-[11px] font-medium inline-flex items-center space-x-1 ${
                  document.status === 'published'
                    ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300'
                    : 'bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300'
                }`}
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full mr-1 ${
                    document.status === 'published' ? 'bg-emerald-500' : 'bg-amber-500'
                  }`}
                />
                {document.status === 'published' ? 'Publicado' : 'Borrador'}
              </span>
              {document.isDirty && (
                <span className="text-[11px] font-medium text-amber-600 dark:text-amber-400">
                  (cambios sin guardar)
                </span>
              )}
            </div>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
              Hash: <span className="font-mono">{document.specHash.slice(0, 10)}…</span> · {document.nodes.length} nodos · {document.edges.length} conexiones
            </p>
          </div>
        </div>
      </div>

      {/* Center: Segmented View Mode Switcher */}
      <div
        className="flex items-center p-0.5 bg-slate-100 dark:bg-slate-800/80 rounded-lg border border-slate-200 dark:border-slate-700"
        role="tablist"
        aria-label="Selector de vistas"
      >
        <button
          type="button"
          role="tab"
          aria-selected={viewMode === 'guided'}
          onClick={() => onChangeViewMode('guided')}
          className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
            viewMode === 'guided'
              ? 'bg-white dark:bg-slate-900 text-teal-600 dark:text-teal-400 shadow-sm font-semibold'
              : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
          }`}
        >
          <Sparkles className="w-3.5 h-3.5" />
          <span>Guiada</span>
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={viewMode === 'canvas'}
          onClick={() => onChangeViewMode('canvas')}
          className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
            viewMode === 'canvas'
              ? 'bg-white dark:bg-slate-900 text-teal-600 dark:text-teal-400 shadow-sm font-semibold'
              : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
          }`}
        >
          <LayoutGrid className="w-3.5 h-3.5" />
          <span>Grafo</span>
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={viewMode === 'declarative'}
          onClick={() => onChangeViewMode('declarative')}
          className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
            viewMode === 'declarative'
              ? 'bg-white dark:bg-slate-900 text-teal-600 dark:text-teal-400 shadow-sm font-semibold'
              : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
          }`}
        >
          <FileCode className="w-3.5 h-3.5" />
          <span>YAML</span>
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={viewMode === 'split'}
          onClick={() => onChangeViewMode('split')}
          className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
            viewMode === 'split'
              ? 'bg-white dark:bg-slate-900 text-teal-600 dark:text-teal-400 shadow-sm font-semibold'
              : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
          }`}
        >
          <Columns className="w-3.5 h-3.5" />
          <span>Dividida</span>
        </button>
      </div>

      {/* Right: Actions */}
      <div className="flex items-center space-x-2">
        <button
          type="button"
          onClick={onOpenRtbfModal}
          className="p-1.5 text-slate-600 dark:text-slate-300 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 rounded-lg transition-colors border border-transparent hover:border-rose-200 dark:hover:border-rose-800"
          title="GDPR: Purgar datos de cliente (Derecho al Olvido)"
          aria-label="Derecho al olvido RAG"
        >
          <Trash2 className="w-4 h-4" />
        </button>

        <button
          type="button"
          onClick={onValidate}
          disabled={isValidating}
          className="flex items-center space-x-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
          title="Validar topología del grafo (Alt+V)"
        >
          <CheckCircle2 className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400" />
          <span>Validar</span>
        </button>

        <button
          type="button"
          onClick={onOpenSimulator}
          className="flex items-center space-x-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
          title="Simular en Sandbox sin afectar producción"
        >
          <Play className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
          <span>Simular</span>
        </button>

        <button
          type="button"
          onClick={onOpenDiff}
          className="flex items-center space-x-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
          title="Ver diferencias con la versión publicada"
        >
          <GitCompare className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400" />
          <span>Diff</span>
        </button>

        <button
          type="button"
          onClick={onPublish}
          disabled={publishBlockerCount > 0}
          className={`flex items-center space-x-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg text-white transition-all shadow-sm ${
            publishBlockerCount > 0
              ? 'bg-slate-400 dark:bg-slate-700 cursor-not-allowed opacity-60'
              : 'bg-teal-600 hover:bg-teal-700 active:scale-95'
          }`}
          title={
            publishBlockerCount > 0
              ? `Publicación bloqueada (${publishBlockerCount} requerimientos pendientes)`
              : 'Publicar esta versión a producción'
          }
        >
          {publishBlockerCount > 0 ? (
            <AlertTriangle className="w-3.5 h-3.5 text-amber-200" />
          ) : (
            <UploadCloud className="w-3.5 h-3.5" />
          )}
          <span>Publicar</span>
        </button>
      </div>
    </header>
  );
};
