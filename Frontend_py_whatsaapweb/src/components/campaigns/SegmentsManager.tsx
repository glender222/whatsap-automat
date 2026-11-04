import React, { useState } from 'react';
import {
  Users,
  Plus,
  Trash2,
  RefreshCw,
  Filter,
  CheckCircle2,
  Sparkles,
} from 'lucide-react';

export interface SegmentRule {
  field: string;
  operator: string;
  value: string;
}

export interface SegmentItem {
  id: string;
  name: string;
  description?: string;
  targetChannel: string;
  dynamic: boolean;
  calculatedCount: number;
  lastCalculatedAt?: string;
  criteria: {
    combinator: 'AND' | 'OR';
    rules: SegmentRule[];
  };
}

export interface SegmentsManagerProps {
  initialSegments?: SegmentItem[];
  onCreateSegment?: (segment: Omit<SegmentItem, 'id' | 'calculatedCount'>) => Promise<void> | void;
  onCalculateCount?: (segmentId: string) => Promise<number> | number;
}

export const SegmentsManager: React.FC<SegmentsManagerProps> = ({
  initialSegments = [
    {
      id: 'seg_1',
      name: 'Clientes VIP Activos',
      description: 'Contactos con etiqueta vip activos en los ultimos 30 dias',
      targetChannel: 'any',
      dynamic: true,
      calculatedCount: 240,
      lastCalculatedAt: '2026-11-04T12:00:00Z',
      criteria: {
        combinator: 'AND',
        rules: [
          { field: 'tag', operator: 'equals', value: 'vip' },
          { field: 'last_seen_days', operator: 'lt', value: '30' },
        ],
      },
    },
    {
      id: 'seg_2',
      name: 'Leads de Correo Electrónico',
      description: 'Contactos con consentimiento de correo registrado',
      targetChannel: 'email',
      dynamic: true,
      calculatedCount: 1250,
      lastCalculatedAt: '2026-11-04T10:00:00Z',
      criteria: {
        combinator: 'AND',
        rules: [{ field: 'metadata.channel', operator: 'equals', value: 'email' }],
      },
    },
  ],
  onCreateSegment,
  onCalculateCount,
}) => {
  const [segments, setSegments] = useState<SegmentItem[]>(initialSegments);
  const [isCreating, setIsCreating] = useState(false);
  const [calculatingId, setCalculatingId] = useState<string | null>(null);

  // New segment form state
  const [newSegmentName, setNewSegmentName] = useState('');
  const [newSegmentDesc, setNewSegmentDesc] = useState('');
  const [targetChannel, setTargetChannel] = useState('any');
  const [combinator, setCombinator] = useState<'AND' | 'OR'>('AND');
  const [rules, setRules] = useState<SegmentRule[]>([
    { field: 'tag', operator: 'equals', value: 'vip' },
  ]);

  const addRule = () => {
    setRules([...rules, { field: 'tag', operator: 'equals', value: '' }]);
  };

  const removeRule = (index: number) => {
    setRules(rules.filter((_, i) => i !== index));
  };

  const updateRule = (index: number, key: keyof SegmentRule, val: string) => {
    const updated = [...rules];
    updated[index] = { ...updated[index], [key]: val };
    setRules(updated);
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSegmentName.trim()) return;

    const newSegment: SegmentItem = {
      id: `seg_${Date.now()}`,
      name: newSegmentName,
      description: newSegmentDesc,
      targetChannel,
      dynamic: true,
      calculatedCount: Math.floor(Math.random() * 500) + 50,
      lastCalculatedAt: new Date().toISOString(),
      criteria: {
        combinator,
        rules,
      },
    };

    if (onCreateSegment) {
      await onCreateSegment(newSegment);
    }

    setSegments([newSegment, ...segments]);
    setIsCreating(false);
    setNewSegmentName('');
    setNewSegmentDesc('');
    setRules([{ field: 'tag', operator: 'equals', value: 'vip' }]);
  };

  const handleRecalculate = async (segmentId: string) => {
    setCalculatingId(segmentId);
    try {
      let count = 0;
      if (onCalculateCount) {
        count = await onCalculateCount(segmentId);
      } else {
        await new Promise((r) => setTimeout(r, 400));
        count = Math.floor(Math.random() * 800) + 100;
      }
      setSegments((prev) =>
        prev.map((s) =>
          s.id === segmentId
            ? { ...s, calculatedCount: count, lastCalculatedAt: new Date().toISOString() }
            : s
        )
      );
    } finally {
      setCalculatingId(null);
    }
  };

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 flex items-center gap-2">
            <Users className="w-6 h-6 text-emerald-600" />
            Segmentación Dinámica de Audiencias
          </h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            Crea grupos dinámicos basados en etiquetas, actividad reciente y atributos de consentimiento.
          </p>
        </div>

        {!isCreating && (
          <button
            onClick={() => setIsCreating(true)}
            className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-medium text-sm rounded-lg flex items-center gap-1.5 shadow"
          >
            <Plus className="w-4 h-4" />
            Crear Segmento
          </button>
        )}
      </div>

      {isCreating && (
        <div className="bg-white dark:bg-gray-900 border border-emerald-300 dark:border-emerald-800 rounded-xl p-6 shadow-md space-y-6">
          <div className="flex items-center justify-between border-b pb-4 dark:border-gray-800">
            <h3 className="font-bold text-lg text-gray-900 dark:text-white flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-emerald-600" />
              Nuevo Segmento Dinámico
            </h3>
            <button
              onClick={() => setIsCreating(false)}
              className="text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400"
            >
              Cancelar
            </button>
          </div>

          <form onSubmit={handleCreate} className="space-y-4">
            <div className="grid grid-cols-3 gap-4">
              <div className="col-span-2">
                <label className="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">
                  Nombre del Segmento *
                </label>
                <input
                  type="text"
                  required
                  placeholder="ej. Clientes Alta Frecuencia Bogotá"
                  value={newSegmentName}
                  onChange={(e) => setNewSegmentName(e.target.value)}
                  className="w-full px-3 py-2 text-sm border rounded-lg dark:bg-gray-800 dark:border-gray-700 dark:text-white"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">
                  Canal Objetivo
                </label>
                <select
                  value={targetChannel}
                  onChange={(e) => setTargetChannel(e.target.value)}
                  className="w-full px-3 py-2 text-sm border rounded-lg dark:bg-gray-800 dark:border-gray-700 dark:text-white"
                >
                  <option value="any">Cualquier Canal</option>
                  <option value="whatsapp-cloud">WhatsApp</option>
                  <option value="email">Email</option>
                  <option value="telegram">Telegram</option>
                </select>
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">
                Descripción
              </label>
              <input
                type="text"
                placeholder="Propósito del segmento..."
                value={newSegmentDesc}
                onChange={(e) => setNewSegmentDesc(e.target.value)}
                className="w-full px-3 py-2 text-sm border rounded-lg dark:bg-gray-800 dark:border-gray-700 dark:text-white"
              />
            </div>

            {/* Visual Rule Builder */}
            <div className="p-4 bg-gray-50 dark:bg-gray-800/40 border rounded-lg space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Filter className="w-4 h-4 text-emerald-600" />
                  <span className="text-xs font-bold text-gray-700 dark:text-gray-300 uppercase">
                    Condiciones del Filtro
                  </span>
                </div>

                <div className="flex items-center gap-1 bg-white dark:bg-gray-800 border rounded-lg p-0.5 text-xs">
                  <button
                    type="button"
                    onClick={() => setCombinator('AND')}
                    className={`px-2 py-1 rounded font-bold ${
                      combinator === 'AND'
                        ? 'bg-emerald-600 text-white'
                        : 'text-gray-600 dark:text-gray-400'
                    }`}
                  >
                    Y (AND)
                  </button>
                  <button
                    type="button"
                    onClick={() => setCombinator('OR')}
                    className={`px-2 py-1 rounded font-bold ${
                      combinator === 'OR'
                        ? 'bg-emerald-600 text-white'
                        : 'text-gray-600 dark:text-gray-400'
                    }`}
                  >
                    O (OR)
                  </button>
                </div>
              </div>

              <div className="space-y-2">
                {rules.map((rule, idx) => (
                  <div key={idx} className="flex items-center gap-2">
                    <select
                      value={rule.field}
                      onChange={(e) => updateRule(idx, 'field', e.target.value)}
                      className="px-2.5 py-1.5 text-xs border rounded dark:bg-gray-800 dark:border-gray-700 dark:text-white"
                    >
                      <option value="tag">Etiqueta (Tag)</option>
                      <option value="last_seen_days">Días Inactivo</option>
                      <option value="metadata.industry">Industria</option>
                      <option value="metadata.role">Rol del Contacto</option>
                      <option value="metadata.city">Ciudad</option>
                    </select>

                    <select
                      value={rule.operator}
                      onChange={(e) => updateRule(idx, 'operator', e.target.value)}
                      className="px-2.5 py-1.5 text-xs border rounded dark:bg-gray-800 dark:border-gray-700 dark:text-white"
                    >
                      <option value="equals">es igual a</option>
                      <option value="not_equals">no es igual a</option>
                      <option value="includes_any">incluye cualquiera</option>
                      <option value="excludes">excluye</option>
                      <option value="lt">menor a (&lt;)</option>
                      <option value="gt">mayor a (&gt;)</option>
                    </select>

                    <input
                      type="text"
                      placeholder="Valor..."
                      value={rule.value}
                      onChange={(e) => updateRule(idx, 'value', e.target.value)}
                      className="flex-1 px-3 py-1.5 text-xs border rounded dark:bg-gray-800 dark:border-gray-700 dark:text-white"
                    />

                    {rules.length > 1 && (
                      <button
                        type="button"
                        onClick={() => removeRule(idx)}
                        className="text-gray-400 hover:text-red-500 p-1"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                ))}
              </div>

              <button
                type="button"
                onClick={addRule}
                className="text-xs text-emerald-600 hover:text-emerald-700 font-semibold flex items-center gap-1 mt-2"
              >
                <Plus className="w-3.5 h-3.5" />
                Agregar Condición
              </button>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setIsCreating(false)}
                className="px-4 py-2 border rounded-lg text-sm text-gray-600 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-800"
              >
                Cancelar
              </button>
              <button
                type="submit"
                className="px-5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-sm font-bold shadow"
              >
                Guardar Segmento
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Segments Table */}
      <div className="bg-white dark:bg-gray-900 border rounded-xl overflow-hidden shadow">
        <table className="w-full text-left text-sm">
          <thead className="bg-gray-50 dark:bg-gray-800/60 text-xs font-semibold text-gray-500 dark:text-gray-400 border-b">
            <tr>
              <th className="px-6 py-3">Nombre del Segmento</th>
              <th className="px-6 py-3">Canal</th>
              <th className="px-6 py-3">Tipo</th>
              <th className="px-6 py-3 text-center">Audiencia Calculada</th>
              <th className="px-6 py-3 text-right">Acciones</th>
            </tr>
          </thead>
          <tbody className="divide-y dark:divide-gray-800">
            {segments.map((seg) => (
              <tr key={seg.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/40">
                <td className="px-6 py-4">
                  <div className="font-semibold text-gray-900 dark:text-white">{seg.name}</div>
                  {seg.description && (
                    <div className="text-xs text-gray-500 mt-0.5">{seg.description}</div>
                  )}
                </td>
                <td className="px-6 py-4">
                  <span className="px-2 py-0.5 bg-gray-100 dark:bg-gray-800 rounded text-xs font-mono">
                    {seg.targetChannel}
                  </span>
                </td>
                <td className="px-6 py-4">
                  <span className="inline-flex items-center gap-1 text-xs text-emerald-600 font-medium">
                    <CheckCircle2 className="w-3.5 h-3.5" /> Dinámico
                  </span>
                </td>
                <td className="px-6 py-4 text-center font-bold text-gray-900 dark:text-white">
                  {seg.calculatedCount}
                  <span className="text-xs font-normal text-gray-400 block">contactos</span>
                </td>
                <td className="px-6 py-4 text-right">
                  <button
                    onClick={() => handleRecalculate(seg.id)}
                    disabled={calculatingId === seg.id}
                    className="p-1.5 text-gray-500 hover:text-emerald-600 dark:hover:text-emerald-400 rounded hover:bg-gray-100 dark:hover:bg-gray-800"
                    title="Recalcular tamaño de audiencia"
                  >
                    <RefreshCw
                      className={`w-4 h-4 ${calculatingId === seg.id ? 'animate-spin text-emerald-600' : ''}`}
                    />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default SegmentsManager;
