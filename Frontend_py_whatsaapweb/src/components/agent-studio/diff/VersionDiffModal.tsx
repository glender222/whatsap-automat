import React, { useState } from 'react';
import { X, GitCompare } from 'lucide-react';
import type { AgentStudioDocument } from '../types';

export interface VersionDiffModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentDocument: AgentStudioDocument;
  baselineDocument?: AgentStudioDocument;
}

export const VersionDiffModal: React.FC<VersionDiffModalProps> = ({
  isOpen,
  onClose,
  currentDocument,
  baselineDocument,
}) => {
  const [activeDiffTab, setActiveDiffTab] = useState<'prompt' | 'tools' | 'topology'>('prompt');

  if (!isOpen) return null;

  const draftPrompt = currentDocument.guidedConfig.reasoning.systemPrompt;
  const baselinePrompt =
    baselineDocument?.guidedConfig.reasoning.systemPrompt ||
    'Eres un asistente de ventas de WhatsApp. Responde con amabilidad e identifica si el cliente busca catálogo o estado de pedido.';

  const draftTools = currentDocument.guidedConfig.toolsGranted;
  const baselineTools = baselineDocument?.guidedConfig.toolsGranted || [
    'search_catalog',
    'check_order_status',
  ];

  const addedTools = draftTools.filter((t) => !baselineTools.includes(t));
  const removedTools = baselineTools.filter((t) => !draftTools.includes(t));

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="diff-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
    >
      <div className="w-full max-w-3xl bg-white dark:bg-[#131B2E] rounded-2xl shadow-xl border border-slate-200 dark:border-slate-800 overflow-hidden text-slate-900 dark:text-slate-100 animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 bg-slate-50 dark:bg-slate-900/60 border-b border-slate-200 dark:border-slate-800">
          <div className="flex items-center space-x-2.5">
            <div className="p-2 rounded-xl bg-indigo-50 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-400">
              <GitCompare className="w-5 h-5" />
            </div>
            <div>
              <h2 id="diff-modal-title" className="text-sm font-bold text-slate-900 dark:text-slate-100">
                Comparador de Versiones (Diff)
              </h2>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                Borrador v{currentDocument.version} vs Versión Publicada v
                {baselineDocument?.version || 1}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
            aria-label="Cerrar modal de diferencias"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tab Navigator */}
        <div className="flex items-center px-6 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131B2E]">
          {[
            { id: 'prompt', label: 'System Prompt' },
            { id: 'tools', label: 'Herramientas Habilitadas' },
            { id: 'topology', label: 'Topología de Nodos' },
          ].map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveDiffTab(tab.id as 'prompt' | 'tools' | 'topology')}
              className={`px-4 py-3 text-xs font-medium border-b-2 transition-colors ${
                activeDiffTab === tab.id
                  ? 'border-indigo-600 text-indigo-600 dark:text-indigo-400 font-semibold'
                  : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="p-6 max-h-[60vh] overflow-y-auto text-xs space-y-4">
          {activeDiffTab === 'prompt' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 font-mono">
              <div className="space-y-1.5">
                <span className="font-sans font-semibold text-slate-500">
                  Versión Publicada Anterior (v1)
                </span>
                <div className="p-3 bg-slate-50 dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-800 leading-relaxed text-slate-700 dark:text-slate-300 min-h-[140px]">
                  {baselinePrompt}
                </div>
              </div>

              <div className="space-y-1.5">
                <span className="font-sans font-semibold text-teal-600 dark:text-teal-400">
                  Borrador Actual (v{currentDocument.version})
                </span>
                <div className="p-3 bg-teal-50/40 dark:bg-teal-950/20 rounded-lg border border-teal-200 dark:border-teal-800 leading-relaxed text-slate-800 dark:text-slate-200 min-h-[140px]">
                  {draftPrompt}
                </div>
              </div>
            </div>
          )}

          {activeDiffTab === 'tools' && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-4">
                <div className="p-4 bg-slate-50 dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 space-y-2">
                  <span className="font-semibold text-slate-700 dark:text-slate-300">
                    Herramientas Agregadas (+{addedTools.length})
                  </span>
                  {addedTools.length === 0 ? (
                    <p className="text-slate-400 text-[11px]">Sin nuevas herramientas</p>
                  ) : (
                    <ul className="space-y-1">
                      {addedTools.map((t) => (
                        <li key={t} className="text-emerald-600 dark:text-emerald-400 font-mono">
                          + {t}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div className="p-4 bg-slate-50 dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 space-y-2">
                  <span className="font-semibold text-slate-700 dark:text-slate-300">
                    Herramientas Removidas (-{removedTools.length})
                  </span>
                  {removedTools.length === 0 ? (
                    <p className="text-slate-400 text-[11px]">Sin herramientas removidas</p>
                  ) : (
                    <ul className="space-y-1">
                      {removedTools.map((t) => (
                        <li key={t} className="text-rose-600 dark:text-rose-400 font-mono">
                          - {t}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </div>
          )}

          {activeDiffTab === 'topology' && (
            <div className="space-y-3">
              <div className="p-4 bg-slate-50 dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <span className="text-slate-400">Total de Nodos:</span>{' '}
                    <strong className="text-slate-800 dark:text-slate-100">
                      {currentDocument.nodes.length}
                    </strong>
                  </div>
                  <div>
                    <span className="text-slate-400">Total de Conexiones:</span>{' '}
                    <strong className="text-slate-800 dark:text-slate-100">
                      {currentDocument.edges.length}
                    </strong>
                  </div>
                  <div>
                    <span className="text-slate-400">Hash de Borrador:</span>{' '}
                    <span className="font-mono text-slate-700 dark:text-slate-300">
                      {currentDocument.specHash.slice(0, 16)}…
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-400">Límites de Ejecución:</span>{' '}
                    <span className="text-slate-700 dark:text-slate-300">
                      {currentDocument.limits.maxSteps} pasos máx
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end px-6 py-4 bg-slate-50 dark:bg-slate-900/60 border-t border-slate-200 dark:border-slate-800">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-xs font-semibold rounded-lg bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-200"
          >
            Cerrar Comparador
          </button>
        </div>
      </div>
    </div>
  );
};
