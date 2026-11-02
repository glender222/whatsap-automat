import React, { useState } from 'react';
import {
  Cpu,
  Database,
  Wrench,
  Shield,
  UserCheck,
  CheckCircle2,
  Play,
  UploadCloud,
} from 'lucide-react';
import type { AgentGuidedConfig } from '../types';

export interface AgentGuidedViewProps {
  guidedConfig: AgentGuidedConfig;
  onUpdateGuidedConfig: (next: AgentGuidedConfig) => void;
  onOpenSimulator?: () => void;
  onPublish?: () => void;
  publishBlockerCount?: number;
}

type TabKey = 'model_prompt' | 'rag_memory' | 'tools' | 'policies' | 'gates' | 'evals';

export const AgentGuidedView: React.FC<AgentGuidedViewProps> = ({
  guidedConfig,
  onUpdateGuidedConfig,
  onOpenSimulator,
  onPublish,
  publishBlockerCount = 0,
}) => {
  const [activeTab, setActiveTab] = useState<TabKey>('model_prompt');
  const [newKeyword, setNewKeyword] = useState('');

  const updateIdentity = (fields: Partial<AgentGuidedConfig['identity']>) => {
    onUpdateGuidedConfig({
      ...guidedConfig,
      identity: { ...guidedConfig.identity, ...fields },
    });
  };

  const updateReasoning = (fields: Partial<AgentGuidedConfig['reasoning']>) => {
    onUpdateGuidedConfig({
      ...guidedConfig,
      reasoning: { ...guidedConfig.reasoning, ...fields },
    });
  };

  const updateRagMemory = (fields: Partial<AgentGuidedConfig['ragMemory']>) => {
    onUpdateGuidedConfig({
      ...guidedConfig,
      ragMemory: { ...guidedConfig.ragMemory, ...fields },
    });
  };

  const updatePolicies = (fields: Partial<AgentGuidedConfig['policies']>) => {
    onUpdateGuidedConfig({
      ...guidedConfig,
      policies: { ...guidedConfig.policies, ...fields },
    });
  };

  const toggleTool = (toolName: string) => {
    const isGranted = guidedConfig.toolsGranted.includes(toolName);
    const nextTools = isGranted
      ? guidedConfig.toolsGranted.filter((t) => t !== toolName)
      : [...guidedConfig.toolsGranted, toolName];
    onUpdateGuidedConfig({
      ...guidedConfig,
      toolsGranted: nextTools,
    });
  };

  const addBlockedKeyword = () => {
    const kw = newKeyword.trim().toLowerCase();
    if (kw && !guidedConfig.policies.blockedKeywords.includes(kw)) {
      updatePolicies({
        blockedKeywords: [...guidedConfig.policies.blockedKeywords, kw],
      });
      setNewKeyword('');
    }
  };

  const removeBlockedKeyword = (kw: string) => {
    updatePolicies({
      blockedKeywords: guidedConfig.policies.blockedKeywords.filter((k) => k !== kw),
    });
  };

  return (
    <div className="flex h-full bg-slate-50 dark:bg-[#0B0F19] text-slate-900 dark:text-slate-100 overflow-hidden">
      {/* Left Vertical Step Navigator */}
      <nav
        className="w-56 shrink-0 border-r border-slate-200 dark:border-slate-800 p-4 space-y-1 bg-white dark:bg-[#0F172A]"
        aria-label="Pistas del Asistente Guiado"
      >
        <div className="px-2 pb-3 text-xs font-bold text-slate-400 uppercase tracking-wider">
          Configuración Guiada
        </div>

        {[
          { key: 'model_prompt', label: '1. Modelo y Prompt', icon: Cpu },
          { key: 'rag_memory', label: '2. Memoria RAG', icon: Database },
          { key: 'tools', label: '3. Herramientas', icon: Wrench },
          { key: 'policies', label: '4. Políticas & Horario', icon: Shield },
          { key: 'gates', label: '5. Puertas Humanas', icon: UserCheck },
          { key: 'evals', label: '6. Evaluaciones', icon: CheckCircle2 },
        ].map((item) => {
          const Icon = item.icon;
          const isActive = activeTab === item.key;
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => setActiveTab(item.key as TabKey)}
              className={`w-full flex items-center space-x-2.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors text-left ${
                isActive
                  ? 'bg-teal-50 dark:bg-teal-950/60 text-teal-700 dark:text-teal-300 font-semibold'
                  : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800/60 hover:text-slate-900 dark:hover:text-slate-100'
              }`}
            >
              <Icon className="w-4 h-4 shrink-0" />
              <span className="truncate">{item.label}</span>
            </button>
          );
        })}
      </nav>

      {/* Main Tab Content */}
      <main className="flex-1 overflow-y-auto p-6 max-w-4xl">
        {/* TAB 1: MODEL & PROMPT */}
        {activeTab === 'model_prompt' && (
          <div className="space-y-6">
            <div>
              <h2 className="text-base font-bold text-slate-900 dark:text-slate-100">
                Identidad y Razonador LLM
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                Define el propósito del agente, el proveedor de IA y el prompt del sistema que
                gobernará su comportamiento.
              </p>
            </div>

            <div className="space-y-4 bg-white dark:bg-[#131B2E] p-5 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                    Nombre del Agente
                  </label>
                  <input
                    type="text"
                    value={guidedConfig.identity.name}
                    onChange={(e) => updateIdentity({ name: e.target.value })}
                    className="w-full px-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 focus:ring-1 focus:ring-teal-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                    Propósito
                  </label>
                  <select
                    value={guidedConfig.identity.purpose}
                    onChange={(e) =>
                      updateIdentity({
                        purpose: e.target.value as AgentGuidedConfig['identity']['purpose'],
                      })
                    }
                    className="w-full px-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 focus:ring-1 focus:ring-teal-500"
                  >
                    <option value="sales">Ventas & Conversión</option>
                    <option value="support">Atención al Cliente</option>
                    <option value="router">Enrutador de Conversaciones</option>
                    <option value="operations">Operaciones</option>
                    <option value="general">Propósito General</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  Descripción
                </label>
                <input
                  type="text"
                  value={guidedConfig.identity.description}
                  onChange={(e) => updateIdentity({ description: e.target.value })}
                  className="w-full px-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 focus:ring-1 focus:ring-teal-500"
                />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-2 border-t border-slate-100 dark:border-slate-800">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                    Proveedor
                  </label>
                  <select
                    value={guidedConfig.reasoning.provider}
                    onChange={(e) =>
                      updateReasoning({
                        provider: e.target.value as AgentGuidedConfig['reasoning']['provider'],
                      })
                    }
                    className="w-full px-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 focus:ring-1 focus:ring-teal-500"
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
                  <select
                    value={guidedConfig.reasoning.model}
                    onChange={(e) => updateReasoning({ model: e.target.value })}
                    className="w-full px-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 focus:ring-1 focus:ring-teal-500"
                  >
                    <option value="gpt-4o-mini">gpt-4o-mini</option>
                    <option value="gpt-4o">gpt-4o</option>
                    <option value="claude-3-5-sonnet-20241022">claude-3-5-sonnet</option>
                    <option value="claude-3-5-haiku-20241022">claude-3-5-haiku</option>
                    <option value="meta-llama/Llama-3.1-8B-Instruct">Llama-3.1-8B-Instruct</option>
                  </select>
                </div>

                <div>
                  <div className="flex justify-between items-center mb-1">
                    <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                      Temperatura: {guidedConfig.reasoning.temperature}
                    </label>
                  </div>
                  <input
                    type="range"
                    min="0.0"
                    max="1.0"
                    step="0.05"
                    value={guidedConfig.reasoning.temperature}
                    onChange={(e) => updateReasoning({ temperature: parseFloat(e.target.value) })}
                    className="w-full accent-teal-600"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  Prompt del Sistema
                </label>
                <textarea
                  rows={6}
                  value={guidedConfig.reasoning.systemPrompt}
                  onChange={(e) => updateReasoning({ systemPrompt: e.target.value })}
                  className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 focus:ring-1 focus:ring-teal-500 leading-relaxed"
                />
              </div>
            </div>
          </div>
        )}

        {/* TAB 2: RAG MEMORY */}
        {activeTab === 'rag_memory' && (
          <div className="space-y-6">
            <div>
              <h2 className="text-base font-bold text-slate-900 dark:text-slate-100">
                Memoria Vectorial RAG (pgvector)
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                Aprovisiona colecciones vectoriales aisladas por inquilino y configura umbrales de
                similitud semántica para consultas contextuales.
              </p>
            </div>

            <div className="space-y-4 bg-white dark:bg-[#131B2E] p-5 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm">
              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  Colección de Conocimiento Asociada
                </label>
                <input
                  type="text"
                  value={guidedConfig.ragMemory.collectionId}
                  onChange={(e) => updateRagMemory({ collectionId: e.target.value })}
                  className="w-full px-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 focus:ring-1 focus:ring-teal-500 font-mono"
                />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                    Top-K Chunks Recuperados: {guidedConfig.ragMemory.topK}
                  </label>
                  <input
                    type="range"
                    min="1"
                    max="10"
                    step="1"
                    value={guidedConfig.ragMemory.topK}
                    onChange={(e) => updateRagMemory({ topK: parseInt(e.target.value, 10) })}
                    className="w-full accent-teal-600"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                    Similitud Mínima (Coseno): {guidedConfig.ragMemory.minSimilarity}
                  </label>
                  <input
                    type="range"
                    min="0.0"
                    max="1.0"
                    step="0.05"
                    value={guidedConfig.ragMemory.minSimilarity}
                    onChange={(e) =>
                      updateRagMemory({ minSimilarity: parseFloat(e.target.value) })
                    }
                    className="w-full accent-teal-600"
                  />
                </div>
              </div>

              <div className="pt-2 flex items-center space-x-2">
                <input
                  type="checkbox"
                  id="includeChatHistory"
                  checked={guidedConfig.ragMemory.includeChatHistory}
                  onChange={(e) => updateRagMemory({ includeChatHistory: e.target.checked })}
                  className="rounded text-teal-600 focus:ring-teal-500"
                />
                <label
                  htmlFor="includeChatHistory"
                  className="text-xs text-slate-700 dark:text-slate-300"
                >
                  Incluir historial reciente de la conversación como contexto
                </label>
              </div>
            </div>
          </div>
        )}

        {/* TAB 3: TOOLS */}
        {activeTab === 'tools' && (
          <div className="space-y-6">
            <div>
              <h2 className="text-base font-bold text-slate-900 dark:text-slate-100">
                Herramientas y Acciones Habilitadas
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                Taxonomía de 5 niveles de riesgo. Las acciones financieras y destructivas requieren
                puertas de aprobación humana obligatorias.
              </p>
            </div>

            <div className="space-y-3">
              {[
                {
                  name: 'search_catalog',
                  label: 'Buscar en Catálogo de Productos',
                  risk: 'read',
                  desc: 'Búsqueda de texto y SKU sobre productos activos.',
                },
                {
                  name: 'check_order_status',
                  label: 'Consultar Estado de Pedido',
                  risk: 'read',
                  desc: 'Lee el estado del pedido por ID o teléfono.',
                },
                {
                  name: 'reserve_stock',
                  label: 'Reservar Stock Temporal',
                  risk: 'write',
                  desc: 'Bloquea inventario durante 15 minutos.',
                },
                {
                  name: 'process_payment',
                  label: 'Generar Enlace de Pago',
                  risk: 'financial',
                  desc: 'Genera link de pago con tarjeta o transferencia.',
                },
                {
                  name: 'delete_customer_data',
                  label: 'Eliminar Datos de Cliente (GDPR)',
                  risk: 'destructive',
                  desc: 'Purga registros permanentes.',
                },
              ].map((tool) => {
                const isGranted = guidedConfig.toolsGranted.includes(tool.name);
                return (
                  <div
                    key={tool.name}
                    className={`flex items-start justify-between p-4 rounded-xl border transition-all ${
                      isGranted
                        ? 'bg-teal-50/40 dark:bg-teal-950/20 border-teal-300 dark:border-teal-800'
                        : 'bg-white dark:bg-[#131B2E] border-slate-200 dark:border-slate-800'
                    }`}
                  >
                    <div className="flex items-start space-x-3">
                      <input
                        type="checkbox"
                        checked={isGranted}
                        onChange={() => toggleTool(tool.name)}
                        className="mt-0.5 rounded text-teal-600 focus:ring-teal-500"
                      />
                      <div>
                        <div className="flex items-center space-x-2">
                          <span className="text-xs font-bold text-slate-800 dark:text-slate-100">
                            {tool.label}
                          </span>
                          <span className="font-mono text-[10px] text-slate-400">
                            ({tool.name})
                          </span>
                          <span
                            className={`px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase ${
                              tool.risk === 'financial' || tool.risk === 'destructive'
                                ? 'bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300'
                                : tool.risk === 'write'
                                ? 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'
                                : 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300'
                            }`}
                          >
                            {tool.risk}
                          </span>
                        </div>
                        <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                          {tool.desc}
                        </p>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* TAB 4: POLICIES */}
        {activeTab === 'policies' && (
          <div className="space-y-6">
            <div>
              <h2 className="text-base font-bold text-slate-900 dark:text-slate-100">
                Políticas de Atención y Restricciones
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                Filtros previos a la inferencia: horarios de atención y palabras prohibidas.
              </p>
            </div>

            <div className="space-y-4 bg-white dark:bg-[#131B2E] p-5 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm">
              <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800">
                <div>
                  <span className="text-xs font-bold text-slate-800 dark:text-slate-100">
                    Restricción por Horario de Atención
                  </span>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    Responde automáticamente fuera de horario sin llamar al modelo LLM.
                  </p>
                </div>
                <input
                  type="checkbox"
                  checked={guidedConfig.policies.businessHoursEnabled}
                  onChange={(e) =>
                    updatePolicies({ businessHoursEnabled: e.target.checked })
                  }
                  className="rounded text-teal-600 focus:ring-teal-500"
                />
              </div>

              {guidedConfig.policies.businessHoursEnabled && (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-2">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                      Zona Horaria
                    </label>
                    <input
                      type="text"
                      value={guidedConfig.policies.timezone}
                      onChange={(e) => updatePolicies({ timezone: e.target.value })}
                      className="w-full px-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                      Hora Inicio
                    </label>
                    <input
                      type="time"
                      value={guidedConfig.policies.startTime}
                      onChange={(e) => updatePolicies({ startTime: e.target.value })}
                      className="w-full px-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                      Hora Cierre
                    </label>
                    <input
                      type="time"
                      value={guidedConfig.policies.endTime}
                      onChange={(e) => updatePolicies({ endTime: e.target.value })}
                      className="w-full px-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
                    />
                  </div>
                </div>
              )}

              <div className="pt-3 border-t border-slate-100 dark:border-slate-800">
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-2">
                  Palabras Clave Prohibidas (Guardián de Contenido)
                </label>
                <div className="flex flex-wrap gap-2 mb-3">
                  {guidedConfig.policies.blockedKeywords.map((kw) => (
                    <span
                      key={kw}
                      className="inline-flex items-center space-x-1 px-2.5 py-1 rounded-full text-xs font-medium bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300 border border-rose-200 dark:border-rose-800"
                    >
                      <span>{kw}</span>
                      <button
                        type="button"
                        onClick={() => removeBlockedKeyword(kw)}
                        className="hover:text-rose-900 dark:hover:text-rose-100"
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>

                <div className="flex items-center space-x-2">
                  <input
                    type="text"
                    placeholder="Agregar término prohibido..."
                    value={newKeyword}
                    onChange={(e) => setNewKeyword(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addBlockedKeyword())}
                    className="flex-1 px-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
                  />
                  <button
                    type="button"
                    onClick={addBlockedKeyword}
                    className="px-3 py-1.5 text-xs font-medium rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200"
                  >
                    Agregar
                  </button>
                </div>
              </div>

              <div className="pt-3 border-t border-slate-100 dark:border-slate-800">
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  Mensaje Enlatado Fuera de Horario
                </label>
                <textarea
                  rows={2}
                  value={guidedConfig.policies.fallbackCannedText}
                  onChange={(e) => updatePolicies({ fallbackCannedText: e.target.value })}
                  className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
                />
              </div>
            </div>
          </div>
        )}

        {/* TAB 5: GATES */}
        {activeTab === 'gates' && (
          <div className="space-y-6">
            <div>
              <h2 className="text-base font-bold text-slate-900 dark:text-slate-100">
                Puertas de Aprobación Humana (HITL)
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                Pausa la ejecución del agente y requiere confirmación de un supervisor antes de
                ejecutar acciones de riesgo elevado.
              </p>
            </div>

            <div className="space-y-3">
              {guidedConfig.approvalGates.map((gate, idx) => (
                <div
                  key={idx}
                  className="p-4 bg-white dark:bg-[#131B2E] rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm flex items-start justify-between"
                >
                  <div className="space-y-1">
                    <div className="flex items-center space-x-2">
                      <span className="text-xs font-bold text-slate-800 dark:text-slate-100">
                        {gate.actionType}
                      </span>
                      <span className="px-2 py-0.5 rounded text-[10px] font-semibold uppercase bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300">
                        Riesgo: {gate.riskThreshold}
                      </span>
                    </div>
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      Tiempo límite (TTL): {gate.ttlMinutes} minutos · Roles requeridos:{' '}
                      {gate.requiredRoles.join(', ')}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* TAB 6: EVALS */}
        {activeTab === 'evals' && (
          <div className="space-y-6">
            <div>
              <h2 className="text-base font-bold text-slate-900 dark:text-slate-100">
                Evaluaciones de Calidad y Puerta de Publicación
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                Para desplegar a producción se requiere un pass rate ≥ 95%, 0 fugas de seguridad y
                validación de integridad de hash.
              </p>
            </div>

            <div className="p-5 bg-white dark:bg-[#131B2E] rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-bold text-slate-800 dark:text-slate-100">
                    Suite de Regresión
                  </h3>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    Simulación determinista en sandbox con métricas P50/P95.
                  </p>
                </div>
                {onOpenSimulator && (
                  <button
                    type="button"
                    onClick={onOpenSimulator}
                    className="flex items-center space-x-1.5 px-3 py-1.5 text-xs font-medium rounded-lg text-white bg-blue-600 hover:bg-blue-700"
                  >
                    <Play className="w-3.5 h-3.5" />
                    <span>Lanzar Simulación Sandbox</span>
                  </button>
                )}
              </div>

              <div className="pt-3 border-t border-slate-100 dark:border-slate-800 space-y-2">
                <div className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                  Criterios de Publicación:
                </div>
                <ul className="text-xs text-slate-600 dark:text-slate-400 space-y-1.5">
                  <li className="flex items-center space-x-2">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                    <span>Tasa de éxito en suite ≥ 95.0%</span>
                  </li>
                  <li className="flex items-center space-x-2">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                    <span>0 fugas de herramientas de seguridad</span>
                  </li>
                  <li className="flex items-center space-x-2">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                    <span>Topología sin ciclos infinitos</span>
                  </li>
                  <li className="flex items-center space-x-2">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                    <span>Firma criptográfica SHA-256 válida</span>
                  </li>
                </ul>
              </div>

              {onPublish && (
                <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex justify-end">
                  <button
                    type="button"
                    onClick={onPublish}
                    disabled={publishBlockerCount > 0}
                    className={`flex items-center space-x-1.5 px-4 py-2 text-xs font-semibold rounded-lg text-white ${
                      publishBlockerCount > 0
                        ? 'bg-slate-400 cursor-not-allowed opacity-60'
                        : 'bg-teal-600 hover:bg-teal-700'
                    }`}
                  >
                    <UploadCloud className="w-4 h-4" />
                    <span>Publicar Versión a Producción</span>
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
};
