import { useEffect, useState, type FormEvent } from 'react';
import { Plus, RefreshCw, Trash2, Users } from 'lucide-react';
import {
  calculateSegment,
  campaignError,
  channelLabel,
  channelLabels,
  createSegment,
  listSegments,
  type SegmentDraft,
  type SegmentSummary,
} from './campaignApi';

const fields = {
  tag: 'Etiqueta',
  last_seen_days: 'Días desde la última actividad',
  'metadata.industry': 'Industria',
  'metadata.role': 'Rol del contacto',
  'metadata.city': 'Ciudad',
};

const operators = {
  equals: 'es igual a',
  not_equals: 'no es igual a',
  includes_any: 'incluye alguna',
  excludes: 'excluye',
  lt: 'menor que',
  gt: 'mayor que',
};

type RuleField = keyof typeof fields;
type RuleOperator = keyof typeof operators;
type RuleInput = { id: string; field: RuleField; operator: RuleOperator; value: string };

const operatorsByField: Record<RuleField, RuleOperator[]> = {
  tag: ['equals', 'not_equals', 'includes_any', 'excludes'],
  last_seen_days: ['equals', 'lt', 'gt'],
  'metadata.industry': ['equals', 'not_equals'],
  'metadata.role': ['equals', 'not_equals'],
  'metadata.city': ['equals', 'not_equals'],
};

const inputClass = 'w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100';

function ruleValue(rule: RuleInput) {
  const value = rule.value.trim();
  if (rule.field === 'last_seen_days') return Number(value);
  if (rule.operator === 'includes_any' || rule.operator === 'excludes') {
    return value.split(',').map((tag) => tag.trim()).filter(Boolean);
  }
  return value;
}

export default function SegmentsManager() {
  const [segments, setSegments] = useState<SegmentSummary[]>();
  const [attempt, setAttempt] = useState(0);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [rules, setRules] = useState<RuleInput[]>([]);

  useEffect(() => {
    const request = new AbortController();
    listSegments(request.signal)
      .then((items) => { if (!request.signal.aborted) setSegments(items); })
      .catch((cause) => {
        if (!request.signal.aborted) setLoadError(campaignError(cause, 'No se pudo cargar el listado de segmentos.'));
      });
    return () => request.abort();
  }, [attempt]);

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const name = String(values.get('name') ?? '').trim();
    const description = String(values.get('description') ?? '').trim();
    const criteria = rules.map((rule) => ({ field: rule.field, operator: rule.operator, value: ruleValue(rule) }));
    if (!name || rules.some((rule) => !rule.value.trim()) || criteria.some(({ value }) => value === '' || (Array.isArray(value) && value.length === 0))) {
      setActionError('Completa el nombre y los valores de todas las reglas.');
      return;
    }

    setBusy('create');
    setActionError('');
    try {
      const segment = await createSegment({
        name,
        description: description || undefined,
        targetChannel: values.get('targetChannel') as SegmentDraft['targetChannel'],
        criteria: { combinator: values.get('combinator') as 'AND' | 'OR', rules: criteria },
      });
      setSegments((items) => [segment, ...(items ?? [])]);
      setCreating(false);
      setRules([]);
    } catch (cause) {
      setActionError(campaignError(cause, 'No se pudo crear el segmento. Revisa la conexión y vuelve a intentar.'));
    } finally {
      setBusy(null);
    }
  }

  async function handleRecalculate(segmentId: string) {
    setBusy(segmentId);
    setActionError('');
    try {
      const count = await calculateSegment(segmentId);
      setSegments((items) => items?.map((item) => item.id === segmentId
        ? { ...item, calculatedCount: count, lastCalculatedAt: new Date().toISOString() }
        : item));
    } catch (cause) {
      setActionError(campaignError(cause, 'No se pudo calcular el segmento. Vuelve a intentar.'));
    } finally {
      setBusy(null);
    }
  }

  function updateRule(id: string, update: Partial<RuleInput>) {
    setRules((items) => items.map((item) => item.id === id ? { ...item, ...update } : item));
  }

  return (
    <section className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6" aria-labelledby="segments-title">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 id="segments-title" className="text-2xl font-semibold">Segmentos</h1>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">Organiza audiencias con reglas y consulta su tamaño.</p>
        </div>
        <button type="button" aria-expanded={creating} disabled={busy !== null || !segments} onClick={() => { setCreating(!creating); setActionError(''); }} className="inline-flex items-center gap-2 rounded-md bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-60">
          <Plus size={16} /> {creating ? 'Cerrar formulario' : 'Nuevo segmento'}
        </button>
      </header>
      {actionError && <p role="alert" className="rounded-md border border-red-200 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:text-red-300">{actionError}</p>}
      {creating && (
        <form onSubmit={handleCreate} className="space-y-4 rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900 sm:p-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block space-y-1 text-sm font-medium"><span>Nombre del segmento</span><input className={inputClass} name="name" required maxLength={255} /></label>
            <label className="block space-y-1 text-sm font-medium"><span>Canal</span>
              <select className={inputClass} name="targetChannel" defaultValue="any">
                <option value="any">Cualquier canal</option>
                {Object.entries(channelLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
          </div>
          <label className="block space-y-1 text-sm font-medium"><span>Descripción (opcional)</span><input className={inputClass} name="description" /></label>
          <fieldset className="space-y-3 border-t border-gray-200 pt-3 dark:border-gray-700">
            <legend className="text-sm font-semibold">Reglas de audiencia</legend>
            <label className="block max-w-xs space-y-1 text-sm"><span>Combinar reglas</span>
              <select className={inputClass} name="combinator" defaultValue="AND">
                <option value="AND">Deben coincidir todas</option>
                <option value="OR">Debe coincidir alguna</option>
              </select>
            </label>
            {rules.length === 0 && <p className="text-sm text-gray-600 dark:text-gray-300">Sin reglas, el segmento incluye todos los contactos que devuelve el servidor.</p>}
            {rules.map((rule, index) => (
              <div key={rule.id} className="grid grid-cols-[1fr_auto] items-center gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
                <select aria-label={`Campo de la regla ${index + 1}`} className={`${inputClass} col-span-2 sm:col-span-1`} value={rule.field} onChange={(event) => updateRule(rule.id, { field: event.target.value as RuleField, operator: 'equals', value: '' })}>
                  {Object.entries(fields).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
                <select aria-label={`Operador de la regla ${index + 1}`} className={`${inputClass} col-span-2 sm:col-span-1`} value={rule.operator} onChange={(event) => updateRule(rule.id, { operator: event.target.value as RuleOperator })}>
                  {operatorsByField[rule.field].map((operator) => <option key={operator} value={operator}>{operators[operator]}</option>)}
                </select>
                <input aria-label={`Valor de la regla ${index + 1}`} className={inputClass} required type={rule.field === 'last_seen_days' ? 'number' : 'text'} min={0} value={rule.value} onChange={(event) => updateRule(rule.id, { value: event.target.value })} />
                <button aria-label={`Quitar regla ${index + 1}`} type="button" className="rounded-md p-2 text-red-700 hover:bg-red-50 dark:text-red-300 dark:hover:bg-red-950" onClick={() => setRules((items) => items.filter(({ id }) => id !== rule.id))}><Trash2 size={17} /></button>
              </div>
            ))}
            <button type="button" className="text-sm font-medium text-emerald-700 underline dark:text-emerald-300" onClick={() => setRules((items) => [...items, { id: crypto.randomUUID(), field: 'tag', operator: 'equals', value: '' }])}>Agregar regla</button>
          </fieldset>
          <button type="submit" disabled={busy !== null} className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-60">{busy === 'create' ? 'Creando…' : 'Crear segmento'}</button>
        </form>
      )}
      {loadError ? (
        <div role="alert" className="rounded-md border border-red-200 p-4 text-sm text-red-700 dark:border-red-800 dark:text-red-300">
          <p>{loadError}</p>
          <button type="button" className="mt-2 underline" onClick={() => { setLoadError(''); setAttempt((value) => value + 1); }}>Volver a intentar</button>
        </div>
      ) : segments === undefined ? (
        <p role="status" className="text-sm text-gray-600 dark:text-gray-300">Cargando segmentos…</p>
      ) : segments.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-300 p-6 text-sm text-gray-600 dark:border-gray-600 dark:text-gray-300">
          <Users className="mb-3 text-emerald-700 dark:text-emerald-300" size={22} />
          Todavía no hay segmentos en este espacio.
        </div>
      ) : (
        <ul className="divide-y divide-gray-200 rounded-xl border border-gray-200 bg-white dark:divide-gray-700 dark:border-gray-700 dark:bg-gray-900">
          {segments.map((segment) => (
            <li key={segment.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <h2 className="break-words font-medium">{segment.name}</h2>
                {segment.description && <p className="break-words text-sm text-gray-600 dark:text-gray-300">{segment.description}</p>}
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  {segment.targetChannel === 'any' ? 'Cualquier canal' : channelLabel(segment.targetChannel)} · {segment.lastCalculatedAt ? `${segment.calculatedCount} contactos` : 'Sin recuento'}
                </p>
              </div>
              <button type="button" disabled={busy !== null} onClick={() => void handleRecalculate(segment.id)} className="inline-flex items-center gap-2 rounded-md border border-gray-300 px-3 py-2 text-sm font-medium hover:bg-gray-50 disabled:opacity-60 dark:border-gray-600 dark:hover:bg-gray-800">
                <RefreshCw size={15} className={busy === segment.id ? 'animate-spin' : ''} /> {busy === segment.id ? 'Calculando…' : 'Calcular contactos'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
