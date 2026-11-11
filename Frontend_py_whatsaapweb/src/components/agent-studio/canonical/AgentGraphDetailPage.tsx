import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, CheckCircle2, CircleAlert, GitBranch } from 'lucide-react';
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom';
import AgentGraphComparisonPanel from './AgentGraphComparisonPanel';
import AgentGraphFixturePanel from './AgentGraphFixturePanel';
import AgentGraphExecutionPanel from './AgentGraphExecutionPanel';
import GraphProblemNotice from './GraphProblemNotice';
import {
  draftSpec, getGraphDraft, graphPath, graphProblem, nodeKinds, readVersion, studioLocation, studioPath,
  validateGraphDraft, type GraphDraft, type GraphProblem, type GraphValidation,
} from './agentGraphApi';

const secondary = 'inline-flex min-h-11 items-center gap-2 rounded-md border border-gray-300 px-3 text-sm font-semibold disabled:opacity-55 dark:border-gray-600';

function GraphMap({ draft }: { draft: GraphDraft }) {
  return (
    <section className="min-w-0 space-y-4 rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900" aria-labelledby="graph-map-title">
      <div>
        <h2 id="graph-map-title" className="text-lg font-semibold">Mapa del grafo</h2>
        <p className="mt-1 break-all text-sm text-gray-600 dark:text-gray-300">Entrada declarada <code>{draft.entryNodeId}</code></p>
      </div>
      <ul className="grid gap-2 sm:grid-cols-2">
        {draft.nodes.map((node, index) => (
          <li key={`${node.id}-${index}`} id={`graph-node-${index}`} tabIndex={-1}
            className="min-w-0 rounded-lg border border-gray-200 p-3 dark:border-gray-700">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="break-all font-mono text-sm font-semibold">{node.id}</h3>
              {node.id === draft.entryNodeId && <span className="rounded-full bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">Entrada</span>}
            </div>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">{nodeKinds[node.kind] ?? node.kind}</p>
          </li>
        ))}
      </ul>
      <div>
        <h3 className="text-sm font-semibold">Conexiones</h3>
        {draft.edges.length ? (
          <ul className="mt-2 divide-y divide-gray-200 rounded-lg border border-gray-200 dark:divide-gray-700 dark:border-gray-700">
            {draft.edges.map((edge, index) => (
              <li key={`${edge.id}-${index}`} className="space-y-1 p-3">
                <p className="flex flex-wrap items-center gap-2 break-all font-mono text-xs">
                  <span>{edge.from}</span><ArrowRight size={14} aria-label="a" role="img" /><span>{edge.to}</span>
                </p>
                <p className="break-all text-xs text-gray-600 dark:text-gray-300">
                  {edge.id}{edge.condition && ` · Condición ${edge.condition}`}
                </p>
              </li>
            ))}
          </ul>
        ) : <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">Esta revisión no declara conexiones.</p>}
      </div>
      <details>
        <summary className="min-h-11 cursor-pointer text-sm font-semibold">Ver especificación JSON guardada</summary>
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-gray-50 p-3 text-xs dark:bg-gray-800">{JSON.stringify(draftSpec(draft), null, 2)}</pre>
      </details>
    </section>
  );
}

function RevisionChecks({ draft }: { draft: GraphDraft }) {
  const [report, setReport] = useState<GraphValidation>();
  const [problem, setProblem] = useState<GraphProblem>();
  const [checking, setChecking] = useState(false);
  const requestRef = useRef<AbortController>(null);
  const reportHeading = useRef<HTMLHeadingElement>(null);

  useEffect(() => () => requestRef.current?.abort(), []);
  useEffect(() => {
    if (report) reportHeading.current?.focus();
  }, [report]);

  async function validate() {
    if (requestRef.current) return;
    const request = new AbortController();
    requestRef.current = request;
    setChecking(true);
    setProblem(undefined);
    setReport(undefined);
    try {
      const checked = await validateGraphDraft(draft, request.signal);
      if (!request.signal.aborted) setReport(checked);
    } catch (cause) {
      if (!request.signal.aborted) setProblem(graphProblem(cause, 'No pudimos confirmar la validación de esta revisión.'));
    } finally {
      if (!request.signal.aborted) setChecking(false);
      requestRef.current = null;
    }
  }

  return (
    <div className="min-w-0 space-y-4">
      <section className="space-y-3 rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900" aria-labelledby="graph-validation-title">
        <h2 id="graph-validation-title" className="text-lg font-semibold">Validación estructural</h2>
        <p className="text-sm text-gray-600 dark:text-gray-300">Comprueba la entrada, las conexiones y los ciclos en la revisión {draft.version} guardada.</p>
        <button type="button" onClick={validate} disabled={checking}
          className="min-h-11 rounded-md bg-emerald-700 px-4 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-55">
          Validar esta revisión
        </button>
        {checking && <p role="status" className="text-sm">Comprobando estructura…</p>}
        {problem && <GraphProblemNotice problem={problem} />}
        {report && (
          <div className={report.valid
            ? 'space-y-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm dark:border-emerald-900 dark:bg-emerald-950'
            : 'space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm dark:border-amber-900 dark:bg-amber-950'}>
            <h3 ref={reportHeading} tabIndex={-1} className="flex items-center gap-2 font-semibold">
              {report.valid ? <CheckCircle2 size={17} aria-hidden="true" /> : <CircleAlert size={17} aria-hidden="true" />}
              {report.valid ? 'Estructura válida' : 'La estructura tiene problemas'}
            </h3>
            <p>Resultado del servidor para la revisión {report.version}.</p>
            {report.issues.length > 0 && (
              <ul className="space-y-2">
                {report.issues.map((issue, index) => {
                  const nodeIndex = draft.nodes.findIndex((node) => node.id === issue.nodeId);
                  return (
                    <li key={`${issue.code}-${index}`} className="min-w-0 border-t border-current/15 pt-2">
                      <code className="break-all text-xs font-semibold">{issue.code}</code>
                      <p className="break-words">{issue.message}</p>
                      {nodeIndex >= 0 && <a className="break-all text-xs font-medium underline" href={`#graph-node-${nodeIndex}`}>Ir al nodo {issue.nodeId}</a>}
                      {nodeIndex < 0 && issue.nodeId && <p className="break-all text-xs">Nodo {issue.nodeId}</p>}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </section>
      <AgentGraphExecutionPanel draft={draft} />
    </div>
  );
}

function GraphDetails({ graphId }: { graphId: string }) {
  const [params] = useSearchParams();
  const { state } = useLocation();
  const after = params.get('after');
  const rawVersion = params.get('version');
  const version = readVersion(rawVersion);
  const invalidVersion = rawVersion !== null && version === undefined;
  const path = graphPath(graphId);
  const latestPath = studioLocation(path, { after });
  const [attempt, setAttempt] = useState(0);
  const [response, setResponse] = useState<{ key: string; draft?: GraphDraft; latest?: number; error?: GraphProblem }>();
  const title = useRef<HTMLHeadingElement>(null);
  const key = (rawVersion ?? '') + '/' + attempt;
  const current = response?.key === key ? response : undefined;

  useEffect(() => {
    if (invalidVersion) return;
    const request = new AbortController();
    getGraphDraft(graphId, undefined, request.signal).then(async (latest) => {
      const draft = version && version !== latest.version ? await getGraphDraft(graphId, version, request.signal) : latest;
      if (!request.signal.aborted) setResponse({ key, draft, latest: latest.version });
    }).catch((cause) => {
      if (!request.signal.aborted) setResponse({ key, error: graphProblem(cause, 'No pudimos cargar la revisión de este grafo.') });
    });
    return () => request.abort();
  }, [graphId, invalidVersion, key, version]);

  useEffect(() => {
    if (current?.draft) title.current?.focus();
  }, [current]);

  const draft = current?.draft;
  const latest = current?.latest ?? 0;
  const shownVersion = draft?.version;

  return (
    <section className="mx-auto max-w-6xl space-y-4 p-4 sm:p-6">
      <Link to={studioLocation(studioPath, { after })} state={{ focusGraphId: graphId }}
        className="inline-flex min-h-11 items-center gap-2 text-sm font-medium text-emerald-700 dark:text-emerald-300">
        <ArrowLeft size={16} aria-hidden="true" /> Volver a Agent Studio
      </Link>
      {invalidVersion && <GraphProblemNotice problem={{ message: 'La versión debe ser un número entero positivo.', fields: [] }} />}
      {current?.error && <GraphProblemNotice problem={current.error} retry={() => setAttempt((value) => value + 1)} />}
      {(invalidVersion || current?.error) && rawVersion !== null && <Link to={latestPath} className={secondary}>Abrir última revisión</Link>}
      {!current && !invalidVersion && <p role="status" className="text-sm">Cargando revisión…</p>}
      {draft && (
        <>
          <header className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="mb-1 flex items-center gap-2 text-sm font-semibold text-emerald-800 dark:text-emerald-300"><GitBranch size={18} aria-hidden="true" /> Borrador guardado · Revisión {draft.version}</p>
              <h1 ref={title} tabIndex={-1} className="break-all text-2xl font-semibold">{draft.graphId}</h1>
              <p className="mt-1 break-all text-sm text-gray-600 dark:text-gray-300">Política {draft.policyRef}</p>
            </div>
            <Link to={studioLocation(`${path}/revisiones/nueva`, { after, from: draft.version })}
              className="inline-flex min-h-11 items-center rounded-md bg-emerald-700 px-4 text-sm font-semibold text-white hover:bg-emerald-800">
              Crear revisión desde este borrador
            </Link>
          </header>
          {state?.savedVersion === shownVersion && <p role="status" className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200">El servidor guardó esta revisión.</p>}
          <section className="space-y-2 rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900" aria-labelledby="graph-history-title">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 id="graph-history-title" className="font-semibold">Historial de revisiones</h2>
                <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">Revisión {draft.version} de {latest}</p>
              </div>
              <nav aria-label="Revisiones del grafo" className="flex flex-wrap gap-2">
                {draft.version > 1 && <Link to={studioLocation(path, { after, version: draft.version - 1 })} className={secondary}>Anterior</Link>}
                {draft.version < latest && <Link to={studioLocation(path, { after, version: draft.version + 1 })} className={secondary}>Siguiente</Link>}
                {draft.version < latest && <Link to={latestPath} className={secondary}>Última revisión</Link>}
              </nav>
            </div>
            <p className="break-all text-xs text-gray-600 dark:text-gray-300">Huella de la revisión <code>{draft.specHash}</code></p>
          </section>
          {draft.version > 1 && <AgentGraphComparisonPanel key={draft.specHash + '/' + draft.version} draft={draft} />}
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
            <RevisionChecks key={draft.specHash + '/' + draft.version} draft={draft} />
            <div className="min-w-0 space-y-4">
              <AgentGraphFixturePanel key={draft.specHash + '/' + draft.version} draft={draft} />
              <GraphMap draft={draft} />
            </div>
          </div>
        </>
      )}
    </section>
  );
}

export default function AgentGraphDetailPage() {
  const { graphId } = useParams();
  return graphId ? <GraphDetails key={graphId} graphId={graphId} /> : null;
}
