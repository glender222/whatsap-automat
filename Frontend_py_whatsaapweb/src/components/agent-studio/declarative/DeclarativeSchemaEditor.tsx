import React, { useState, useEffect } from 'react';
import { AlertCircle, Check, Copy, FileCode } from 'lucide-react';
import type { AgentStudioDocument } from '../types';
import { toDeclarativeYaml, fromDeclarativeYaml } from '../sync/AgentStudioSyncEngine';

export interface DeclarativeSchemaEditorProps {
  document: AgentStudioDocument;
  onUpdateDocument: (nextDoc: AgentStudioDocument) => void;
}

export const DeclarativeSchemaEditor: React.FC<DeclarativeSchemaEditorProps> = ({
  document,
  onUpdateDocument,
}) => {
  const [yamlText, setYamlText] = useState(() => toDeclarativeYaml(document));
  const [syntaxError, setSyntaxError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Sync incoming document when modified externally (e.g. from canvas or guided view)
  useEffect(() => {
    // Only update text if document differs from current valid parsed state
    try {
      const generated = toDeclarativeYaml(document);
      setYamlText(generated);
      setSyntaxError(null);
    } catch {
      // Keep existing text
    }
  }, [document.specHash]);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const nextText = e.target.value;
    setYamlText(nextText);

    const { doc, error } = fromDeclarativeYaml(nextText, document);
    if (error) {
      setSyntaxError(error);
    } else if (doc) {
      setSyntaxError(null);
      onUpdateDocument(doc);
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(yamlText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard fallback
    }
  };

  return (
    <div className="flex flex-col h-full bg-slate-900 text-slate-100 font-mono text-xs overflow-hidden">
      {/* Editor Sub-header */}
      <div className="flex items-center justify-between px-4 py-2 bg-slate-950 border-b border-slate-800">
        <div className="flex items-center space-x-2">
          <FileCode className="w-4 h-4 text-teal-400" />
          <span className="font-semibold text-slate-300">schema.agent.yaml</span>
          <span className="px-1.5 py-0.5 rounded text-[10px] bg-slate-800 text-slate-400">
            v1.0 (read/write)
          </span>
        </div>

        <button
          type="button"
          onClick={handleCopy}
          className="flex items-center space-x-1.5 px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors"
          title="Copiar especificación YAML"
        >
          {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
          <span className="text-[11px]">{copied ? 'Copiado' : 'Copiar'}</span>
        </button>
      </div>

      {/* Syntax Error Alert Banner */}
      {syntaxError && (
        <div
          role="alert"
          className="flex items-start space-x-2 px-4 py-2 bg-rose-950/80 border-b border-rose-800 text-rose-200"
        >
          <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
          <div className="text-xs">
            <span className="font-bold">Error de validación de sintaxis:</span>{' '}
            <span className="font-mono text-rose-300">{syntaxError}</span>
          </div>
        </div>
      )}

      {/* Editor Textarea */}
      <div className="flex-1 relative p-2">
        <textarea
          aria-label="Editor declarativo YAML de especificación del agente"
          value={yamlText}
          onChange={handleChange}
          spellCheck={false}
          className="w-full h-full p-3 font-mono text-xs text-slate-200 bg-transparent resize-none focus:outline-none leading-relaxed selection:bg-teal-900 selection:text-white"
        />
      </div>
    </div>
  );
};
