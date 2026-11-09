import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft } from 'lucide-react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { getWorkflowRevision, saveWorkflow, validateWorkflow, workflowError, workflowPath } from './workflowApi';

const inputClass = 'w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800';
const exampleNodes = [{ id: 'start', kind: 'trigger' }, { id: 'done', kind: 'end' }];
const examples = {
  basic: {
    nodes: exampleNodes,
    edges: [{ id: 'finish', source: 'start', target: 'done' }],
  },
  wait: {
    nodes: [...exampleNodes, { id: 'wait', kind: 'delay', config: { durationMs: 1000 } }],
    edges: [{ id: 'begin', source: 'start', target: 'wait' }, { id: 'finish', source: 'wait', target: 'done' }],
  },
  condition: {
    nodes: [
      ...exampleNodes,
      { id: 'check', kind: 'condition', config: { expression: 'amount > 100' } },
      { id: 'otherwise', kind: 'end' },
    ],
    edges: [
      { id: 'begin', source: 'start', target: 'check' },
      { id: 'yes', source: 'check', target: 'done', sourceHandle: 'true' },
      { id: 'no', source: 'check', target: 'otherwise', sourceHandle: 'false' },
    ],
  },
};

export default function WorkflowEditorPage() {
  const { workflowId } = useParams();
  const [params] = useSearchParams();
  const from = params.get('from');
  const back = workflowId ? `${workflowPath}/${encodeURIComponent(workflowId)}` : workflowPath;
  const navigate = useNavigate();
  const [graph, setGraph] = useState(() => JSON.stringify(examples.basic, null, 2));
  const [limits, setLimits] = useState('{}');
  const [validation, setValidation] = useState<{ key: string; nodeCount: number; edgeCount: number }>();
  const [loadedSource, setLoadedSource] = useState<string>();
  const [sourceError, setSourceError] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState<'validation' | 'save'>();
  const lock = useRef(false);
  const key = graph + '\n' + limits;
  const verified = validation?.key === key;
  const loadingSource = Boolean(workflowId && from && loadedSource !== from);

  useEffect(() => {
    if (!workflowId || !from) return;
    const request = new AbortController();
    getWorkflowRevision(workflowId, from, request.signal).then((item) => {
      if (request.signal.aborted) return;
      setGraph(JSON.stringify(item.dagGraph, null, 2));
      setLimits(JSON.stringify(item.limits ?? {}, null, 2));
      setLoadedSource(from);
    }).catch((cause) => {
      if (!request.signal.aborted) setSourceError(workflowError(cause, 'No pudimos abrir la revisión de origen.'));
    });
    return () => request.abort();
  }, [from, workflowId]);

  function spec() {
    try {
      return { dagGraph: JSON.parse(graph) as unknown, limits: JSON.parse(limits) as unknown };
    } catch {
      throw new Error('Revisa la sintaxis JSON del grafo y de los límites.');
    }
  }

  async function validate() {
    if (lock.current) return;
    lock.current = true;
    setPending('validation');
    setError('');
    setValidation(undefined);
    try {
      const counts = await validateWorkflow(spec());
      setValidation({ key, ...counts });
    } catch (cause) {
      setError(workflowError(cause, 'No pudimos confirmar la validación del grafo.'));
    } finally {
      lock.current = false;
      setPending(undefined);
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (lock.current || !verified) return;
    const values = new FormData(event.currentTarget);
    const name = String(values.get('name') ?? '').trim();
    const description = String(values.get('description') ?? '').trim();
    if (!workflowId && !name) {
      setError('Introduce un nombre para el workflow.');
      return;
    }
    lock.current = true;
    setPending('save');
    setError('');
    try {
      const id = await saveWorkflow(spec(), workflowId ? { id: workflowId } : { name, description: description || undefined });
      navigate(`${workflowPath}/${encodeURIComponent(id)}`, { replace: true, state: { draftSaved: true } });
    } catch (cause) {
      setError(workflowError(cause, 'No pudimos confirmar el borrador. Consulta el listado antes de reintentar.'));
    } finally {
      lock.current = false;
      setPending(undefined);
    }
  }

  return (
    <section className="mx-auto max-w-4xl space-y-4 p-4 sm:p-6" aria-labelledby="workflow-editor-title">
      <Link to={back} className="inline-flex min-h-11 items-center gap-2 text-sm font-medium text-emerald-700 dark:text-emerald-300">
        <ArrowLeft size={16} aria-hidden="true" /> {workflowId ? 'Volver al workflow' : 'Volver a workflows'}
      </Link>
      <header>
        <h1 id="workflow-editor-title" className="text-2xl font-semibold">{workflowId ? 'Nuevo borrador de revisión' : 'Nuevo workflow'}</h1>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">Edita el grafo en JSON, valídalo y guarda un borrador. La publicación se confirma desde la ficha.</p>
      </header>
      {sourceError && <p role="alert" className="text-sm text-red-700 dark:text-red-300">{sourceError}</p>}
      {loadingSource && !sourceError && <p role="status" className="text-sm">Cargando revisión de origen…</p>}
      <form onSubmit={save} className="space-y-4 rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900 sm:p-5">
        <fieldset disabled={Boolean(pending || loadingSource)} className="space-y-4 disabled:opacity-65">
          {!workflowId && (
            <>
              <label className="block space-y-1 text-sm font-medium">
                <span>Nombre</span>
                <input name="name" required maxLength={255} className={inputClass} />
              </label>
              <label className="block space-y-1 text-sm font-medium">
                <span>Descripción opcional</span>
                <textarea name="description" rows={2} maxLength={2000} className={inputClass} />
              </label>
            </>
          )}
          <div className="rounded-lg bg-gray-50 p-3 text-sm dark:bg-gray-800">
            <p>Los workflows por webhook admiten inicio, espera, condición y fin. Cada condición necesita una rama verdadera y otra falsa.</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {([['basic', 'Ejemplo básico'], ['wait', 'Ejemplo con espera'], ['condition', 'Ejemplo con condición']] as const).map(([sample, label]) => (
                <button type="button" key={sample} onClick={() => { setGraph(JSON.stringify(examples[sample], null, 2)); setError(''); }}
                  className="min-h-11 rounded-md border border-gray-300 px-3 font-medium dark:border-gray-600">
                  {label}
                </button>
              ))}
            </div>
          </div>
          <label className="block space-y-1 text-sm font-medium">
            <span>Grafo JSON</span>
            <textarea value={graph} onChange={(event) => { setGraph(event.target.value); setError(''); }}
              spellCheck={false} maxLength={150000} rows={15} className={inputClass + ' min-w-0 resize-y font-mono'} />
          </label>
          <details>
            <summary className="min-h-11 cursor-pointer text-sm font-semibold">Límites de ejecución</summary>
            <label className="block space-y-1 text-sm">
              <span>Límites JSON</span>
              <textarea value={limits} onChange={(event) => { setLimits(event.target.value); setError(''); }}
                spellCheck={false} maxLength={5000} rows={4} className={inputClass + ' font-mono'} />
            </label>
          </details>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={validate} className="min-h-11 rounded-md border border-emerald-700 px-4 text-sm font-semibold text-emerald-700 dark:text-emerald-300">Validar grafo</button>
            <button type="submit" disabled={!verified} className="min-h-11 rounded-md bg-emerald-700 px-4 text-sm font-semibold text-white disabled:opacity-55">Guardar borrador</button>
          </div>
        </fieldset>
        {pending && <p role="status" className="text-sm">{pending === 'save' ? 'Guardando borrador…' : 'Validando grafo…'}</p>}
        {error && <p role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</p>}
        {verified && !pending && <p role="status" className="text-sm text-emerald-800 dark:text-emerald-300">
          Grafo validado. Nodos {validation.nodeCount} · Conexiones {validation.edgeCount}
        </p>}
      </form>
    </section>
  );
}
