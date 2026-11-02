import React, { useState } from 'react';
import {
  X,
  Play,
  CheckCircle2,
  FileText,
  Sparkles,
} from 'lucide-react';
import type {
  AgentStudioDocument,
  EvaluationScenario,
  SimulationStepTrace,
} from '../types';
import { initialEvaluationScenarios } from '../mockData';

export interface EvaluationDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  document: AgentStudioDocument;
  onStepActive: (nodeId: string | null) => void;
  onOpenScorecard: () => void;
}

export const EvaluationDrawer: React.FC<EvaluationDrawerProps> = ({
  isOpen,
  onClose,
  document,
  onStepActive,
  onOpenScorecard,
}) => {
  const [scenarios] = useState<EvaluationScenario[]>(initialEvaluationScenarios);
  const [selectedScenarioId, setSelectedScenarioId] = useState<string>(
    initialEvaluationScenarios[0]?.id || ''
  );
  const [customPrompt, setCustomPrompt] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [traces, setTraces] = useState<SimulationStepTrace[]>([]);
  const [activeStepIndex, setActiveStepIndex] = useState<number | null>(null);

  if (!isOpen) return null;

  const currentScenario = scenarios.find((s) => s.id === selectedScenarioId);

  const handleRunSimulation = async () => {
    setIsRunning(true);
    setTraces([]);
    setActiveStepIndex(null);
    onStepActive(null);

    // Build synthetic simulated trace steps based on document topology
    const simulationSteps: SimulationStepTrace[] = [];

    // Trigger step
    const triggerNode = document.nodes.find((n) => n.kind === 'trigger');
    if (triggerNode) {
      simulationSteps.push({
        step: 1,
        nodeId: triggerNode.id,
        nodeKind: 'trigger',
        status: 'completed',
        durationMs: 4,
        tokensUsed: 0,
        costMicroUsd: 0,
        outputPayload: { channel: 'whatsapp', message: currentScenario?.mockInput || customPrompt },
      });
    }

    // Policy Guard step
    const policyNode = document.nodes.find((n) => n.kind === 'policy_guard');
    if (policyNode) {
      simulationSteps.push({
        step: 2,
        nodeId: policyNode.id,
        nodeKind: 'policy_guard',
        status: 'completed',
        durationMs: 6,
        tokensUsed: 0,
        costMicroUsd: 0,
        outputPayload: { withinHours: true, contentFiltered: false },
      });
    }

    // Memory Retrieval step
    const memNode = document.nodes.find((n) => n.kind === 'memory_retrieval');
    if (memNode) {
      simulationSteps.push({
        step: 3,
        nodeId: memNode.id,
        nodeKind: 'memory_retrieval',
        status: 'completed',
        durationMs: 22,
        tokensUsed: 45,
        costMicroUsd: 1,
        outputPayload: { retrievedChunksCount: 2, topSimilarity: 0.88 },
      });
    }

    // LLM Reasoner step
    const llmNode = document.nodes.find((n) => n.kind === 'llm_reasoner');
    if (llmNode) {
      const isSalesQuery = (currentScenario?.mockInput || customPrompt).toLowerCase().includes('camisas') || (currentScenario?.mockInput || customPrompt).toLowerCase().includes('stock');
      simulationSteps.push({
        step: 4,
        nodeId: llmNode.id,
        nodeKind: 'llm_reasoner',
        status: 'completed',
        durationMs: 310,
        tokensUsed: 220,
        costMicroUsd: 12,
        outputPayload: { rationale: 'Identificada intención de catálogo. Consultando inventario.' },
        toolCallsProposed: isSalesQuery ? ['search_catalog'] : [],
      });
    }

    // Tool Call step
    const toolNode = document.nodes.find((n) => n.kind === 'tool_call');
    if (toolNode) {
      simulationSteps.push({
        step: 5,
        nodeId: toolNode.id,
        nodeKind: 'tool_call',
        status: 'completed',
        durationMs: 48,
        tokensUsed: 0,
        costMicroUsd: 0,
        outputPayload: { result: '3 productos encontrados en stock.' },
      });
    }

    // Dispatch step
    const dispatchNode = document.nodes.find((n) => n.kind === 'dispatch');
    if (dispatchNode) {
      simulationSteps.push({
        step: 6,
        nodeId: dispatchNode.id,
        nodeKind: 'dispatch',
        status: 'completed',
        durationMs: 15,
        tokensUsed: 0,
        costMicroUsd: 0,
        outputPayload: { messageSent: true, casVersion: 1 },
      });
    }

    // Playback steps with animated canvas lighting
    for (let i = 0; i < simulationSteps.length; i++) {
      const step = simulationSteps[i];
      setActiveStepIndex(i);
      onStepActive(step.nodeId);
      setTraces((prev) => [...prev, step]);
      await new Promise((r) => setTimeout(r, 400));
    }

    setIsRunning(false);
    setActiveStepIndex(null);
    onStepActive(null);
  };

  return (
    <aside
      className="fixed inset-y-0 right-0 z-40 w-96 bg-white dark:bg-[#131B2E] border-l border-slate-200 dark:border-slate-800 shadow-2xl flex flex-col overflow-hidden text-slate-900 dark:text-slate-100 select-none animate-in slide-in-from-right duration-200"
      role="dialog"
      aria-labelledby="eval-drawer-title"
    >
      {/* Drawer Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-slate-50 dark:bg-slate-900/60 border-b border-slate-200 dark:border-slate-800">
        <div className="flex items-center space-x-2">
          <Sparkles className="w-4 h-4 text-teal-600 dark:text-teal-400" />
          <h2 id="eval-drawer-title" className="text-xs font-bold text-slate-800 dark:text-slate-100">
            Simulador de Evaluación en Sandbox
          </h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="p-1 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
          aria-label="Cerrar simulador"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Drawer Body */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4 text-xs">
        {/* Scenario Selector */}
        <div>
          <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1">
            Escenario de Benchmark
          </label>
          <select
            value={selectedScenarioId}
            onChange={(e) => setSelectedScenarioId(e.target.value)}
            className="w-full px-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
          >
            {scenarios.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>

        {/* Input Text Prompt */}
        <div>
          <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1">
            Mensaje Mock del Cliente
          </label>
          <textarea
            rows={3}
            value={currentScenario ? currentScenario.mockInput : customPrompt}
            onChange={(e) => setCustomPrompt(e.target.value)}
            className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 leading-relaxed font-mono"
          />
        </div>

        {/* Action Controls */}
        <div className="flex items-center space-x-2 pt-1">
          <button
            type="button"
            onClick={handleRunSimulation}
            disabled={isRunning}
            className="flex-1 flex items-center justify-center space-x-1.5 px-3 py-2 text-xs font-semibold rounded-lg text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 transition-all shadow-sm"
          >
            <Play className="w-3.5 h-3.5 fill-current" />
            <span>{isRunning ? 'Ejecutando Simulación...' : 'Simular Flujo'}</span>
          </button>

          <button
            type="button"
            onClick={onOpenScorecard}
            className="flex items-center space-x-1 px-3 py-2 text-xs font-medium rounded-lg text-slate-700 dark:text-slate-300 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700"
            title="Ver métricas completas de regresión"
          >
            <FileText className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400" />
            <span>Scorecard</span>
          </button>
        </div>

        {/* Execution Trace Timeline */}
        <div className="pt-2 border-t border-slate-100 dark:border-slate-800 space-y-2">
          <div className="flex items-center justify-between font-semibold text-slate-700 dark:text-slate-300">
            <span>Traza de Ejecución en Vivo ({traces.length} pasos)</span>
            {isRunning && (
              <span className="flex items-center space-x-1 text-teal-600 dark:text-teal-400 text-[11px] animate-pulse">
                <span className="w-2 h-2 rounded-full bg-teal-500" />
                <span>Simulando...</span>
              </span>
            )}
          </div>

          <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
            {traces.map((trace, idx) => {
              const isCurrent = activeStepIndex === idx;
              return (
                <div
                  key={idx}
                  className={`p-2.5 rounded-lg border text-xs transition-all ${
                    isCurrent
                      ? 'bg-teal-50 dark:bg-teal-950/60 border-teal-400 dark:border-teal-600 shadow-sm'
                      : 'bg-white dark:bg-[#131B2E] border-slate-200 dark:border-slate-800'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-1.5">
                      <span className="w-4 h-4 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 flex items-center justify-center font-bold text-[10px]">
                        {trace.step}
                      </span>
                      <span className="font-semibold text-slate-800 dark:text-slate-200">
                        {trace.nodeKind}
                      </span>
                      <span className="font-mono text-[10px] text-slate-400">
                        ({trace.nodeId})
                      </span>
                    </div>

                    <div className="flex items-center space-x-2 text-[10px] text-slate-400">
                      <span>{trace.durationMs}ms</span>
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                    </div>
                  </div>

                  {trace.toolCallsProposed && trace.toolCallsProposed.length > 0 && (
                    <div className="mt-1 text-[11px] text-purple-600 dark:text-purple-400 font-mono">
                      Herramienta propuesta: {trace.toolCallsProposed.join(', ')}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </aside>
  );
};
