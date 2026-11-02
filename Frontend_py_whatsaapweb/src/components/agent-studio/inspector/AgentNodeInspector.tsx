import React from 'react';
import {
  X,
  Trash2,
  Copy,
  Bot,
} from 'lucide-react';
import type { AgentStudioNode } from '../types';

export interface AgentNodeInspectorProps {
  node: AgentStudioNode | null;
  onClose: () => void;
  onUpdateNode: (nodeId: string, updates: Partial<AgentStudioNode>) => void;
  onDeleteNode: (nodeId: string) => void;
  onDuplicateNode?: (nodeId: string) => void;
}

export const AgentNodeInspector: React.FC<AgentNodeInspectorProps> = ({
  node,
  onClose,
  onUpdateNode,
  onDeleteNode,
  onDuplicateNode,
}) => {
  if (!node) {
    return (
      <aside
        className="w-80 md:w-96 shrink-0 border-l border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131B2E] p-6 flex flex-col items-center justify-center text-center select-none"
        aria-label="Inspector de nodo vacío"
      >
        <div className="p-3 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-400 mb-3">
          <Bot className="w-6 h-6" />
        </div>
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300">
          Ningún nodo seleccionado
        </h3>
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 max-w-[200px]">
          Haz clic en cualquier nodo del lienzo o presiona Enter para ver y modificar su configuración.
        </p>
      </aside>
    );
  }

  const updateConfig = (key: string, value: unknown) => {
    onUpdateNode(node.id, {
      config: {
        ...node.config,
        [key]: value,
      },
    });
  };

  return (
    <aside
      className="w-80 md:w-96 shrink-0 border-l border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131B2E] flex flex-col h-full overflow-hidden"
      role="complementary"
      aria-label={`Inspector de nodo ${node.label}`}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50">
        <div className="flex items-center space-x-2 min-w-0">
          <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-teal-100 text-teal-800 dark:bg-teal-950 dark:text-teal-300 border border-teal-200 dark:border-teal-800">
            {node.kind}
          </span>
          <span className="text-xs font-mono text-slate-400 truncate">#{node.id}</span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="p-1 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
          aria-label="Cerrar inspector"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Form Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-5">
        {/* Label */}
        <div>
          <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
            Etiqueta del Nodo
          </label>
          <input
            type="text"
            value={node.label}
            onChange={(e) => onUpdateNode(node.id, { label: e.target.value })}
            className="w-full px-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 focus:ring-1 focus:ring-teal-500 font-medium"
          />
        </div>

        {/* Dynamic Sub-forms by Node Kind */}
        {node.kind === 'llm_reasoner' && (
          <div className="space-y-4 pt-2 border-t border-slate-100 dark:border-slate-800">
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                Proveedor
              </label>
              <select
                value={(node.config?.provider as string) || 'openai'}
                onChange={(e) => updateConfig('provider', e.target.value)}
                className="w-full px-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
              >
                <option value="openai">OpenAI</option>
                <option value="anthropic">Anthropic</option>
                <option value="local_vllm">vLLM Local</option>
                <option value="gemini">Google Gemini</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                Modelo
              </label>
              <input
                type="text"
                value={(node.config?.model as string) || 'gpt-4o-mini'}
                onChange={(e) => updateConfig('model', e.target.value)}
                className="w-full px-3 py-1.5 text-xs font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
              />
            </div>

            <div>
              <div className="flex justify-between items-center mb-1">
                <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                  Temperatura: {((node.config?.temperature as number) ?? 0.3).toFixed(2)}
                </label>
              </div>
              <input
                type="range"
                min="0.0"
                max="1.0"
                step="0.05"
                value={(node.config?.temperature as number) ?? 0.3}
                onChange={(e) => updateConfig('temperature', parseFloat(e.target.value))}
                className="w-full accent-teal-600"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                System Prompt
              </label>
              <textarea
                rows={6}
                value={(node.config?.systemPrompt as string) || ''}
                onChange={(e) => updateConfig('systemPrompt', e.target.value)}
                className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 leading-relaxed"
              />
            </div>
          </div>
        )}

        {node.kind === 'memory_retrieval' && (
          <div className="space-y-4 pt-2 border-t border-slate-100 dark:border-slate-800">
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                ID Colección pgvector
              </label>
              <input
                type="text"
                value={(node.config?.collectionId as string) || ''}
                onChange={(e) => updateConfig('collectionId', e.target.value)}
                className="w-full px-3 py-1.5 text-xs font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
              />
            </div>

            <div>
              <div className="flex justify-between items-center mb-1">
                <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                  Top-K Chunks: {(node.config?.topK as number) ?? 3}
                </label>
              </div>
              <input
                type="range"
                min="1"
                max="10"
                step="1"
                value={(node.config?.topK as number) ?? 3}
                onChange={(e) => updateConfig('topK', parseInt(e.target.value, 10))}
                className="w-full accent-teal-600"
              />
            </div>

            <div>
              <div className="flex justify-between items-center mb-1">
                <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                  Similitud Mínima: {((node.config?.minSimilarity as number) ?? 0.7).toFixed(2)}
                </label>
              </div>
              <input
                type="range"
                min="0.0"
                max="1.0"
                step="0.05"
                value={(node.config?.minSimilarity as number) ?? 0.7}
                onChange={(e) => updateConfig('minSimilarity', parseFloat(e.target.value))}
                className="w-full accent-teal-600"
              />
            </div>
          </div>
        )}

        {node.kind === 'tool_call' && (
          <div className="space-y-4 pt-2 border-t border-slate-100 dark:border-slate-800">
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                Nombre de Herramienta
              </label>
              <input
                type="text"
                value={(node.config?.toolName as string) || ''}
                onChange={(e) => updateConfig('toolName', e.target.value)}
                className="w-full px-3 py-1.5 text-xs font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                Nivel de Riesgo
              </label>
              <select
                value={(node.config?.riskLevel as string) || 'read'}
                onChange={(e) => updateConfig('riskLevel', e.target.value)}
                className="w-full px-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
              >
                <option value="read">read (Seguro)</option>
                <option value="write">write (Modificación)</option>
                <option value="send">send (Mensaje Externo)</option>
                <option value="financial">financial (Transacción Financiera)</option>
                <option value="destructive">destructive (Eliminación)</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                Timeout (ms)
              </label>
              <input
                type="number"
                value={(node.config?.timeoutMs as number) ?? 5000}
                onChange={(e) => updateConfig('timeoutMs', parseInt(e.target.value, 10))}
                className="w-full px-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 font-mono"
              />
            </div>
          </div>
        )}

        {node.kind === 'policy_guard' && (
          <div className="space-y-4 pt-2 border-t border-slate-100 dark:border-slate-800">
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                Zona Horaria
              </label>
              <input
                type="text"
                value={(node.config?.timezone as string) || 'America/Lima'}
                onChange={(e) => updateConfig('timezone', e.target.value)}
                className="w-full px-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  Hora Inicio
                </label>
                <input
                  type="time"
                  value={(node.config?.startTime as string) || '09:00'}
                  onChange={(e) => updateConfig('startTime', e.target.value)}
                  className="w-full px-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  Hora Cierre
                </label>
                <input
                  type="time"
                  value={(node.config?.endTime as string) || '18:00'}
                  onChange={(e) => updateConfig('endTime', e.target.value)}
                  className="w-full px-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
                />
              </div>
            </div>
          </div>
        )}

        {node.kind === 'gate' && (
          <div className="space-y-4 pt-2 border-t border-slate-100 dark:border-slate-800">
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                Acción Requiere Aprobación
              </label>
              <input
                type="text"
                value={(node.config?.actionType as string) || ''}
                onChange={(e) => updateConfig('actionType', e.target.value)}
                className="w-full px-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 font-mono"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                TTL de Aprobación (minutos)
              </label>
              <input
                type="number"
                value={(node.config?.ttlMinutes as number) ?? 30}
                onChange={(e) => updateConfig('ttlMinutes', parseInt(e.target.value, 10))}
                className="w-full px-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
              />
            </div>
          </div>
        )}
      </div>

      {/* Action Footer */}
      <div className="p-4 border-t border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50 flex items-center justify-between gap-2">
        {onDuplicateNode && (
          <button
            type="button"
            onClick={() => onDuplicateNode(node.id)}
            className="flex items-center space-x-1.5 px-3 py-1.5 text-xs font-medium rounded-lg text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-700"
          >
            <Copy className="w-3.5 h-3.5" />
            <span>Duplicar</span>
          </button>
        )}

        <button
          type="button"
          onClick={() => onDeleteNode(node.id)}
          className="flex items-center space-x-1.5 px-3 py-1.5 text-xs font-medium rounded-lg text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 hover:bg-rose-100 dark:hover:bg-rose-900/60 ml-auto"
        >
          <Trash2 className="w-3.5 h-3.5" />
          <span>Eliminar Nodo</span>
        </button>
      </div>
    </aside>
  );
};
