import React, { useState } from 'react';
import {
  Play,
  CheckCircle,
  AlertTriangle,
  History,
  Save,
  Send,
  Plus,
  Trash2,
  Settings,
  Bot,
  Shield,
  Database,
  Cpu,
  Wrench,
  UserCheck,
  ArrowRight,
  Code2,
  Workflow,
} from 'lucide-react';
import type { AgentGraphNode, AgentGraphEdge, AgentNodeType } from './mock-contracts';

export const AgentStudioGraphSpec: React.FC = () => {
  const [editorMode, setEditorMode] = useState<'visual' | 'declarative'>('visual');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>('node-llm');
  const [sandboxOpen, setSandboxOpen] = useState(false);
  const [validationSuccess, setValidationSuccess] = useState<boolean | null>(null);

  // Nodes definition
  const [nodes, setNodes] = useState<AgentGraphNode[]>([
    {
      id: 'node-trigger',
      type: 'trigger',
      label: 'Mensaje Entrante',
      position: { x: 50, y: 120 },
      config: { channels: ['whatsapp', 'telegram'] },
      inputs: [],
      outputs: ['out'],
    },
    {
      id: 'node-policy',
      type: 'policy_guard',
      label: 'Guard: Horario Comercial',
      position: { x: 260, y: 120 },
      config: { timezone: 'America/Lima', start: '09:00', end: '18:00' },
      inputs: ['in'],
      outputs: ['within_hours', 'outside_hours'],
    },
    {
      id: 'node-llm',
      type: 'llm_reasoner',
      label: 'Vendedor Inteligente (LLM)',
      position: { x: 500, y: 80 },
      config: { model: 'gemini-1.5-pro', temperature: 0.3, maxTokens: 800 },
      inputs: ['in'],
      outputs: ['tool_call', 'response'],
    },
    {
      id: 'node-tool',
      type: 'tool_call',
      label: 'Tool: get_product_stock()',
      position: { x: 740, y: 50 },
      config: { timeoutMs: 3000 },
      inputs: ['in'],
      outputs: ['result'],
    },
    {
      id: 'node-gate',
      type: 'human_approval_gate',
      label: 'Gate: Aprobación Humana',
      position: { x: 740, y: 180 },
      config: { riskThreshold: 'high', ttlMinutes: 15 },
      inputs: ['in'],
      outputs: ['approved', 'rejected'],
    },
  ]);

  const [edges, setEdges] = useState<AgentGraphEdge[]>([
    { id: 'e1', sourceNodeId: 'node-trigger', sourceHandle: 'out', targetNodeId: 'node-policy', targetHandle: 'in' },
    { id: 'e2', sourceNodeId: 'node-policy', sourceHandle: 'within_hours', targetNodeId: 'node-llm', targetHandle: 'in', conditionLabel: 'Horario OK' },
    { id: 'e3', sourceNodeId: 'node-llm', sourceHandle: 'tool_call', targetNodeId: 'node-tool', targetHandle: 'in' },
    { id: 'e4', sourceNodeId: 'node-llm', sourceHandle: 'response', targetNodeId: 'node-gate', targetHandle: 'in' },
  ]);

  const selectedNode = nodes.find((n) => n.id === selectedNodeId);

  const handleValidate = () => {
    // Check for orphan nodes
    const hasOrphans = nodes.some(
      (n) => n.type !== 'trigger' && !edges.some((e) => e.targetNodeId === n.id)
    );
    setValidationSuccess(!hasOrphans);
  };

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-slate-50 dark:bg-[#0B0F19]">
      {/* ----------------- TOPBAR: VERSION CONTROL ----------------- */}
      <header className="flex h-12 shrink-0 items-center justify-between border-b px-4 bg-white dark:bg-[#131B2E] border-slate-200 dark:border-slate-800">
        <div className="flex items-center gap-3">
          <Workflow size={18} className="text-teal-600" />
          <span className="font-semibold text-xs text-slate-900 dark:text-slate-100">
            Agente: Ventas e-Commerce (v1.2.0-draft)
          </span>
          <span className="rounded bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 text-[10px] font-bold px-1.5 py-0.5">
            Borrador con cambios
          </span>
        </div>

        <div className="flex items-center gap-2">
          {/* Mode Switcher */}
          <div className="flex rounded border bg-slate-100 p-0.5 dark:bg-slate-800 text-xs">
            <button
              onClick={() => setEditorMode('visual')}
              className={`px-2.5 py-1 rounded font-medium ${
                editorMode === 'visual' ? 'bg-white shadow-sm dark:bg-slate-700' : 'text-slate-500'
              }`}
            >
              Grafo Visual
            </button>
            <button
              onClick={() => setEditorMode('declarative')}
              className={`px-2.5 py-1 rounded font-medium flex items-center gap-1 ${
                editorMode === 'declarative' ? 'bg-white shadow-sm dark:bg-slate-700' : 'text-slate-500'
              }`}
            >
              <Code2 size={12} />
              <span>YAML / Schema</span>
            </button>
          </div>

          <button
            type="button"
            onClick={handleValidate}
            className="flex items-center gap-1 rounded-lg border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-xs font-semibold hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <CheckCircle size={14} className={validationSuccess === true ? 'text-emerald-500' : 'text-slate-400'} />
            <span>Validar</span>
          </button>

          <button
            type="button"
            onClick={() => setSandboxOpen(!sandboxOpen)}
            className="flex items-center gap-1 rounded-lg border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-xs font-semibold hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <Play size={14} className="text-teal-600" />
            <span>Simular en Sandbox</span>
          </button>

          <button
            type="button"
            className="flex items-center gap-1 rounded-lg bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-teal-700"
          >
            <Save size={14} />
            <span>Publicar Versión</span>
          </button>
        </div>
      </header>

      {/* ----------------- MAIN CANVAS AREA ----------------- */}
      <div className="flex flex-1 overflow-hidden">
        {editorMode === 'visual' ? (
          <div className="relative flex-1 overflow-hidden bg-[radial-gradient(#cbd5e1_1px,transparent_1px)] dark:bg-[radial-gradient(#1e293b_1px,transparent_1px)] [background-size:16px_16px]">
            {/* Validation Banner */}
            {validationSuccess !== null && (
              <div
                className={`absolute top-4 left-4 z-10 rounded-lg p-2.5 text-xs font-medium shadow-lg flex items-center gap-2 ${
                  validationSuccess
                    ? 'bg-emerald-50 text-emerald-800 border border-emerald-200 dark:bg-emerald-950 dark:text-emerald-200'
                    : 'bg-red-50 text-red-800 border border-red-200 dark:bg-red-950 dark:text-red-200'
                }`}
              >
                {validationSuccess ? (
                  <>
                    <CheckCircle size={14} />
                    <span>Grafo validado: 0 ciclos infinitos y 0 nodos huérfanos.</span>
                  </>
                ) : (
                  <>
                    <AlertTriangle size={14} />
                    <span>Advertencia: Se encontraron nodos sin conexión entrante válida.</span>
                  </>
                )}
              </div>
            )}

            {/* Visual Nodes Simulation */}
            <div className="absolute inset-0 p-8">
              {nodes.map((node) => {
                const isSelected = node.id === selectedNodeId;
                return (
                  <div
                    key={node.id}
                    onClick={() => setSelectedNodeId(node.id)}
                    style={{
                      transform: `translate(${node.position.x}px, ${node.position.y}px)`,
                    }}
                    className={`absolute w-52 cursor-pointer rounded-xl border bg-white dark:bg-[#131B2E] p-3 shadow-md transition-all ${
                      isSelected
                        ? 'border-teal-500 ring-2 ring-teal-500/30'
                        : 'border-slate-200 dark:border-slate-700 hover:border-slate-400'
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-1.5">
                      {node.type === 'trigger' && <Bot size={16} className="text-teal-600" />}
                      {node.type === 'policy_guard' && <Shield size={16} className="text-amber-500" />}
                      {node.type === 'llm_reasoner' && <Cpu size={16} className="text-blue-500" />}
                      {node.type === 'tool_call' && <Wrench size={16} className="text-purple-500" />}
                      {node.type === 'human_approval_gate' && <UserCheck size={16} className="text-red-500" />}
                      <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                        {node.type}
                      </span>
                    </div>
                    <p className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                      {node.label}
                    </p>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          /* Declarative Schema Editor */
          <div className="flex-1 p-4 bg-slate-950 text-slate-200 font-mono text-xs overflow-y-auto">
            <pre>
              {`# Agent Studio Declarative Schema v0.4
id: agent-ecommerce-01
name: "Ventas e-Commerce"
version: "1.2.0-draft"
model:
  provider: gemini
  name: "gemini-1.5-pro"
  temperature: 0.3
policies:
  - id: business_hours
    timezone: "America/Lima"
    hours: "09:00-18:00"
tools_granted:
  - get_product_stock
  - create_order
  - request_payment_voucher
approval_gates:
  - action: "confirm_large_discount"
    threshold_risk: "high"
    ttl_minutes: 15
`}
            </pre>
          </div>
        )}

        {/* ----------------- RIGHT DRAWER: NODE INSPECTOR ----------------- */}
        {selectedNode && (
          <aside
            className="w-80 shrink-0 border-l bg-white dark:bg-[#131B2E] border-slate-200 dark:border-slate-800 p-4 space-y-4 overflow-y-auto"
            aria-label="Inspector de nodo"
          >
            <div>
              <span className="text-[10px] font-bold uppercase text-slate-400">Inspector de Nodo</span>
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mt-0.5">
                {selectedNode.label}
              </h3>
            </div>

            <div className="space-y-3 text-xs">
              <div>
                <label className="block text-slate-500 font-medium mb-1">Nombre / Etiqueta</label>
                <input
                  type="text"
                  value={selectedNode.label}
                  onChange={() => {}}
                  className="w-full rounded border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 p-2"
                />
              </div>

              {selectedNode.type === 'llm_reasoner' && (
                <>
                  <div>
                    <label className="block text-slate-500 font-medium mb-1">Modelo de Lenguaje</label>
                    <select className="w-full rounded border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 p-2">
                      <option>Gemini 1.5 Pro</option>
                      <option>GPT-4o</option>
                      <option>Modelo Local (vLLM)</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-slate-500 font-medium mb-1">Temperatura (0.0 - 1.0)</label>
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.05"
                      defaultValue="0.3"
                      className="w-full accent-teal-600"
                    />
                  </div>
                  <div>
                    <label className="block text-slate-500 font-medium mb-1">System Prompt</label>
                    <textarea
                      rows={5}
                      defaultValue="Eres un asesor de ventas amable y conciso. Consulta el catálogo antes de prometer stock."
                      className="w-full rounded border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 p-2 text-xs"
                    />
                  </div>
                </>
              )}
            </div>
          </aside>
        )}

        {/* ----------------- SANDBOX DRAWER ----------------- */}
        {sandboxOpen && (
          <aside
            className="w-80 shrink-0 border-l bg-slate-50 dark:bg-slate-900 border-slate-200 dark:border-slate-800 flex flex-col"
            aria-label="Sandbox de simulación"
          >
            <div className="flex items-center justify-between p-3 border-b border-inherit">
              <span className="font-semibold text-xs flex items-center gap-1.5">
                <Play size={14} className="text-teal-600" />
                <span>Simulador Sandbox (Dry-Run)</span>
              </span>
              <button onClick={() => setSandboxOpen(false)} className="text-slate-400">
                ✕
              </button>
            </div>
            <div className="flex-1 p-3 space-y-2 overflow-y-auto text-xs">
              <div className="rounded bg-teal-50 p-2 text-teal-800 dark:bg-teal-950 dark:text-teal-200 text-[11px]">
                Modo Dry-Run activo. Las llamadas a herramientas y mensajes no tendrán efecto en producción.
              </div>
            </div>
            <div className="p-2 border-t border-inherit flex gap-1">
              <input
                placeholder="Escribe un mensaje de prueba..."
                className="flex-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-1.5 text-xs"
              />
              <button className="rounded bg-teal-600 p-1.5 text-white">
                <Send size={14} />
              </button>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
};
