import React, { useState, useEffect } from 'react';
import type { WorkflowNodeDefinitionV1 } from '../types';
import { Save, Settings, Hash, Tag, Type } from 'lucide-react';

export interface NodeConfigPanelProps {
  node: WorkflowNodeDefinitionV1;
  onUpdateConfig?: (nodeId: string, updatedConfig: Record<string, unknown>, label?: string) => void;
  className?: string;
}

export const NodeConfigPanel: React.FC<NodeConfigPanelProps> = ({
  node,
  onUpdateConfig,
  className = '',
}) => {
  const [label, setLabel] = useState(node.label || '');
  const [configJson, setConfigJson] = useState(() => JSON.stringify(node.config, null, 2));
  const [parseError, setParseError] = useState<string | null>(null);
  const [savedSuccess, setSavedSuccess] = useState(false);

  useEffect(() => {
    setLabel(node.label || '');
    setConfigJson(JSON.stringify(node.config, null, 2));
    setParseError(null);
  }, [node]);

  const handleSave = () => {
    try {
      const parsed = JSON.parse(configJson);
      setParseError(null);
      if (onUpdateConfig) {
        onUpdateConfig(node.id, parsed, label);
      }
      setSavedSuccess(true);
      setTimeout(() => setSavedSuccess(false), 2000);
    } catch (err) {
      setParseError((err as Error).message);
    }
  };

  return (
    <div className={`node-config-panel flex flex-col gap-3 p-3 bg-white dark:bg-slate-900 border-l border-slate-200 dark:border-slate-800 text-xs ${className}`}>
      {/* Header */}
      <div className="flex items-center justify-between pb-2 border-b border-slate-100 dark:border-slate-800">
        <div className="flex items-center gap-1.5 font-bold text-slate-800 dark:text-slate-100">
          <Settings size={14} className="text-teal-600 dark:text-teal-400" />
          <span>Configuración del Nodo</span>
        </div>
        <span className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300">
          {node.kind}
        </span>
      </div>

      {/* ID info */}
      <div className="flex items-center gap-2 text-slate-500">
        <Hash size={13} className="shrink-0" />
        <span className="font-mono text-[11px] truncate">{node.id}</span>
      </div>

      {/* Label Edit */}
      <div className="flex flex-col gap-1">
        <label className="flex items-center gap-1 text-[11px] font-semibold text-slate-700 dark:text-slate-300">
          <Tag size={12} />
          Etiqueta descriptiva
        </label>
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Nombre del paso..."
          className="px-2 py-1.5 rounded bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-teal-500"
        />
      </div>

      {/* JSON Config Editor */}
      <div className="flex flex-col gap-1 flex-1">
        <label className="flex items-center gap-1 text-[11px] font-semibold text-slate-700 dark:text-slate-300">
          <Type size={12} />
          Parámetros de configuración (JSON)
        </label>
        <textarea
          value={configJson}
          onChange={(e) => {
            setConfigJson(e.target.value);
            setParseError(null);
          }}
          rows={10}
          className="p-2 font-mono text-[11px] rounded bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-teal-500 resize-none"
        />
        {parseError && (
          <span className="text-[10px] text-red-500 font-semibold">{parseError}</span>
        )}
      </div>

      {/* Save Button */}
      <button
        type="button"
        onClick={handleSave}
        className="flex items-center justify-center gap-1.5 py-1.5 px-3 rounded-lg bg-teal-600 hover:bg-teal-700 text-white font-semibold transition-colors"
      >
        <Save size={13} />
        <span>{savedSuccess ? '¡Guardado!' : 'Guardar Cambios'}</span>
      </button>
    </div>
  );
};
