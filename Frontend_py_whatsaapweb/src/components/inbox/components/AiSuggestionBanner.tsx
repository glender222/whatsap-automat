import React, { useEffect } from 'react';
import type { AiSuggestionPayload } from '../types';
import { Sparkles, Check, X, BookOpen } from 'lucide-react';

export interface AiSuggestionBannerProps {
  suggestion: AiSuggestionPayload;
  onAccept: () => void;
  onEdit: () => void;
  onDismiss: () => void;
  className?: string;
}

export const AiSuggestionBanner: React.FC<AiSuggestionBannerProps> = ({
  suggestion,
  onAccept,
  onEdit,
  onDismiss,
  className = '',
}) => {
  // Global shortcut: Ctrl+Enter or Cmd+Enter to accept suggestion
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        onAccept();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [onAccept]);

  const confidencePercent = Math.round(suggestion.confidenceScore * 100);

  return (
    <div
      role="region"
      aria-label="Sugerencia de respuesta generada por IA"
      aria-live="polite"
      className={`border-t border-teal-200 bg-teal-50/80 p-3.5 dark:border-teal-900/60 dark:bg-teal-950/40 shadow-sm ${className}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1 text-xs font-bold text-teal-800 dark:text-teal-300">
              <Sparkles size={14} className="text-teal-600 dark:text-teal-400 shrink-0" aria-hidden="true" />
              <span>Sugerencia IA ({confidencePercent}% confianza)</span>
            </span>
            {suggestion.suggestedAction && (
              <span className="rounded bg-teal-100 dark:bg-teal-900/60 px-1.5 py-0.5 text-[10px] font-medium text-teal-700 dark:text-teal-300">
                {suggestion.suggestedAction}
              </span>
            )}
          </div>

          <p className="mt-1.5 text-xs text-slate-800 dark:text-slate-200 leading-relaxed font-medium">
            {suggestion.replyText}
          </p>

          {suggestion.reasoningNotes && (
            <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400 italic">
              <strong>Motivo:</strong> {suggestion.reasoningNotes}
            </p>
          )}

          {suggestion.knowledgeSourcesUsed && suggestion.knowledgeSourcesUsed.length > 0 && (
            <div className="mt-1.5 flex items-center gap-1.5 text-[10px] text-slate-500 dark:text-slate-400">
              <BookOpen size={11} className="shrink-0" aria-hidden="true" />
              <span>
                Fuentes:{' '}
                {suggestion.knowledgeSourcesUsed.map((k) => k.title).join(', ')}
              </span>
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={onDismiss}
          className="rounded p-1 text-slate-400 hover:text-slate-600 hover:bg-teal-100/60 dark:hover:bg-teal-900/40 dark:hover:text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
          aria-label="Descartar sugerencia de IA"
        >
          <X size={15} />
        </button>
      </div>

      <div className="mt-2.5 flex items-center gap-2">
        <button
          type="button"
          onClick={onAccept}
          className="flex items-center gap-1 rounded-md bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-teal-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 focus-visible:ring-offset-1"
          aria-label="Aceptar y enviar sugerencia"
          aria-keyshortcuts="Control+Enter"
        >
          <Check size={13} aria-hidden="true" />
          <span>Aceptar y Enviar</span>
          <kbd className="ml-1 text-[10px] opacity-80 font-mono bg-teal-700/60 px-1 rounded">Ctrl+Enter</kbd>
        </button>
        <button
          type="button"
          onClick={onEdit}
          className="rounded-md border border-teal-300 dark:border-teal-700 bg-white dark:bg-slate-800 px-2.5 py-1.5 text-xs font-medium text-teal-700 dark:text-teal-300 hover:bg-teal-50 dark:hover:bg-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
          aria-label="Copiar sugerencia al compositor para edición"
        >
          Editar en composer
        </button>
      </div>
    </div>
  );
};
