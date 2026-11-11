import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft } from 'lucide-react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import GraphProblemNotice from './GraphProblemNotice';
import {
  draftSpec, exampleGraph, getGraphDraft, graphIdPattern, graphPath, graphProblem, loadStudioTextTemplate, readVersion,
  saveGraphDraft, studioLocation, studioPath, type GraphProblem,
} from './agentGraphApi';

const inputClass = 'w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800';
const initialSpec = JSON.stringify(exampleGraph, null, 2);

function readSpec(raw: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('Revisa la sintaxis JSON de la especificación.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('La especificación debe ser un objeto JSON.');
  }
  return value as Record<string, unknown>;
}

function GraphEditor({ graphId }: { graphId?: string }) {
  const [params] = useSearchParams();
  const after = params.get('after');
  const rawFrom = params.get('from');
  const from = readVersion(rawFrom);
  const invalidSource = Boolean(graphId && rawFrom !== null && from === undefined);
  const navigate = useNavigate();
  const base = graphId ? graphPath(graphId) : studioPath;
  const back = studioLocation(base, { after, version: graphId ? from : undefined });
  const [spec, setSpec] = useState(initialSpec);
  const [loaded, setLoaded] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [sourceError, setSourceError] = useState<GraphProblem>();
  const [problem, setProblem] = useState<GraphProblem>();
  const [saving, setSaving] = useState(false);
  const [loadingTemplate, setLoadingTemplate] = useState(false);
  const [templateLoaded, setTemplateLoaded] = useState(false);
  const lock = useRef(false);
  const templateRequest = useRef<AbortController>(null);
  const waiting = Boolean(graphId && !loaded);

  useEffect(() => {
    if (!graphId || invalidSource) return;
    const request = new AbortController();
    getGraphDraft(graphId, from, request.signal)
      .then((draft) => {
        if (request.signal.aborted) return;
        setSpec(JSON.stringify(draftSpec(draft), null, 2));
        setLoaded(true);
        setSourceError(undefined);
      })
      .catch((cause) => {
        if (!request.signal.aborted) setSourceError(graphProblem(cause, 'No pudimos abrir el borrador de origen.'));
      });
    return () => request.abort();
  }, [from, graphId, invalidSource, loadAttempt]);

  useEffect(() => () => templateRequest.current?.abort(), []);

  async function loadTemplate() {
    if (lock.current || templateRequest.current) return;
    const request = new AbortController();
    templateRequest.current = request;
    setLoadingTemplate(true);
    setTemplateLoaded(false);
    setProblem(undefined);
    try {
      const template = await loadStudioTextTemplate(request.signal);
      if (request.signal.aborted) return;
      setSpec(JSON.stringify(template, null, 2));
      setTemplateLoaded(true);
    } catch (cause) {
      if (!request.signal.aborted) setProblem(graphProblem(cause, 'No pudimos cargar la plantilla de texto.'));
    } finally {
      templateRequest.current = null;
      if (!request.signal.aborted) setLoadingTemplate(false);
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (lock.current || waiting || templateRequest.current) return;
    const form = new FormData(event.currentTarget);
    const id = graphId ?? String(form.get('graphId') ?? '').trim();
    if (!new RegExp('^' + graphIdPattern + '$').test(id)) {
      setProblem({ message: 'El identificador admite letras, números, guiones y guiones bajos.', fields: [] });
      return;
    }
    lock.current = true;
    setSaving(true);
    setProblem(undefined);
    try {
      const draft = await saveGraphDraft(id, readSpec(spec), graphId ? 'revision' : 'create');
      navigate(studioLocation(graphPath(draft.graphId), { after, version: draft.version }), {
        replace: true, state: { savedVersion: draft.version },
      });
    } catch (cause) {
      setProblem(graphProblem(cause, 'No pudimos confirmar el guardado. Consulta los borradores antes de volver a intentarlo.'));
    } finally {
      lock.current = false;
      setSaving(false);
    }
  }

  return (
    <section className="mx-auto max-w-4xl space-y-4 p-4 sm:p-6" aria-labelledby="graph-editor-title">
      <Link to={back} state={graphId ? undefined : { focusNewGraph: true }}
        className="inline-flex min-h-11 items-center gap-2 text-sm font-medium text-emerald-700 dark:text-emerald-300">
        <ArrowLeft size={16} aria-hidden="true" /> {graphId ? 'Volver al grafo' : 'Volver a Agent Studio'}
      </Link>
      <header>
        <h1 id="graph-editor-title" className="text-2xl font-semibold">{graphId ? 'Nuevo borrador de revisión' : 'Nuevo grafo de agente'}</h1>
        {graphId && <p className="mt-1 break-all text-sm text-gray-600 dark:text-gray-300">{graphId}{from && ` · Origen revisión ${from}`}</p>}
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">Guarda una nueva revisión del JSON canónico. Luego podrás validar la estructura desde su ficha.</p>
      </header>
      {sourceError && <GraphProblemNotice problem={sourceError} retry={() => { setSourceError(undefined); setLoadAttempt((value) => value + 1); }} />}
      {invalidSource && <GraphProblemNotice problem={{ message: 'La revisión de origen debe ser un número entero positivo.', fields: [] }} />}
      {waiting && !sourceError && !invalidSource && <p role="status" className="text-sm">Cargando borrador de origen…</p>}
      <form onSubmit={save} className="space-y-4 rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900 sm:p-5">
        <fieldset disabled={waiting || saving || loadingTemplate} className="min-w-0 space-y-4 disabled:opacity-60">
          {!graphId && (
            <label className="block space-y-1 text-sm font-medium">
              <span>Identificador del grafo</span>
              <input name="graphId" required maxLength={128} pattern={graphIdPattern} autoComplete="off" placeholder="soporte_cliente"
                aria-describedby="graph-id-hint" className={inputClass} />
              <span id="graph-id-hint" className="block text-xs font-normal text-gray-600 dark:text-gray-300">Usa letras, números, guion o guion bajo.</span>
            </label>
          )}
          <div className="rounded-lg bg-gray-50 p-3 text-sm dark:bg-gray-800">
            <p>Define <code>entryNodeId</code>, <code>policyRef</code>, <code>nodes</code>, <code>edges</code> y <code>limits</code>. El servidor asigna la versión y la huella de cada revisión.</p>
            {!graphId && (
              <div className="mt-2 space-y-2">
                <p>La plantilla de texto incluye el modelo y los límites de la evaluación. Revisa la instrucción inicial antes de guardar.</p>
                <button type="button" className="admin-button-secondary" onClick={() => void loadTemplate()}>
                  {spec === initialSpec ? 'Usar plantilla de texto' : 'Reemplazar con plantilla de texto'}
                </button>
              </div>
            )}
          </div>
          <label className="block space-y-1 text-sm font-medium">
            <span>Especificación del grafo en JSON</span>
            <textarea value={spec} onChange={(event) => { setSpec(event.target.value); setTemplateLoaded(false); setProblem(undefined); }}
              rows={19} spellCheck={false} className={inputClass + ' resize-y font-mono'} />
          </label>
          <button type="submit" className="min-h-11 rounded-md bg-emerald-700 px-4 text-sm font-semibold text-white disabled:opacity-55">Guardar borrador</button>
        </fieldset>
        {loadingTemplate && <p role="status" className="text-sm">Cargando plantilla…</p>}
        {templateLoaded && <p role="status" className="text-sm">Plantilla de texto cargada.</p>}
        {saving && <p role="status" className="text-sm">Guardando borrador…</p>}
        {problem && <GraphProblemNotice problem={problem} />}
      </form>
    </section>
  );
}

export default function AgentGraphEditorPage() {
  const { graphId } = useParams();
  const [params] = useSearchParams();
  return <GraphEditor key={`${graphId ?? ''}/${params.get('from') ?? ''}`} graphId={graphId} />;
}
