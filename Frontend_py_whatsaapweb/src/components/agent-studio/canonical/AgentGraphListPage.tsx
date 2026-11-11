import { useEffect, useRef, useState } from 'react';
import { GitBranch, Plus, Settings2 } from 'lucide-react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import GraphProblemNotice from './GraphProblemNotice';
import { graphPath, graphProblem, legacyAgentsPath, listGraphDrafts, studioLocation, studioPath, type GraphProblem } from './agentGraphApi';

export default function AgentGraphListPage() {
  const [params, setParams] = useSearchParams();
  const after = params.get('after');
  const { state } = useLocation();
  const returnGraphId = typeof state?.focusGraphId === 'string' ? state.focusGraphId : null;
  const returnToNewGraph = state?.focusNewGraph === true;
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ key: string; page?: Awaited<ReturnType<typeof listGraphDrafts>>; error?: GraphProblem }>();
  const key = (after ?? '') + '/' + attempt;
  const current = result?.key === key ? result : undefined;
  const nextPage = useRef<HTMLParagraphElement>(null);
  const returnLink = useRef<HTMLAnchorElement>(null);
  const focusResults = useRef(false);

  useEffect(() => {
    const request = new AbortController();
    listGraphDrafts(after, request.signal)
      .then((page) => { if (!request.signal.aborted) setResult({ key, page }); })
      .catch((cause) => {
        if (!request.signal.aborted) setResult({ key, error: graphProblem(cause, 'No pudimos cargar los borradores de Agent Studio.') });
      });
    return () => request.abort();
  }, [after, key]);

  useEffect(() => {
    if (current?.page && (focusResults.current || returnGraphId || returnToNewGraph)) {
      focusResults.current = false;
      (returnLink.current ?? nextPage.current)?.focus();
    }
  }, [current, returnGraphId, returnToNewGraph]);

  function go(afterId?: string) {
    focusResults.current = true;
    setParams(afterId ? { after: afterId } : {});
  }

  return (
    <section className="mx-auto max-w-6xl space-y-5 p-4 sm:p-6" aria-labelledby="agent-studio-title">
      <header className="space-y-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4 dark:border-emerald-900 dark:bg-emerald-950 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="max-w-xl">
            <p className="mb-1 text-sm font-semibold text-emerald-800 dark:text-emerald-300">Diseño de agentes</p>
            <h1 id="agent-studio-title" className="text-2xl font-semibold">Agent Studio</h1>
            <p className="mt-1 text-sm text-gray-700 dark:text-gray-200">Guarda grafos por revisión, consulta el historial y comprueba su estructura.</p>
          </div>
          <Link ref={returnToNewGraph ? returnLink : undefined} to={studioLocation(studioPath + '/nuevo', { after })}
            className="inline-flex min-h-11 items-center gap-2 rounded-md bg-emerald-700 px-4 text-sm font-semibold text-white hover:bg-emerald-800">
            <Plus size={16} aria-hidden="true" /> Nuevo grafo
          </Link>
        </div>
        <Link to={legacyAgentsPath} className="inline-flex min-h-11 items-center gap-2 text-sm font-medium text-emerald-800 underline dark:text-emerald-300">
          <Settings2 size={16} aria-hidden="true" /> Abrir configuración de agentes
        </Link>
      </header>
      {!current && <p role="status" className="text-sm">Cargando borradores…</p>}
      {current?.error && <GraphProblemNotice problem={current.error} retry={() => setAttempt((value) => value + 1)} />}
      {current?.error && after && <Link to={studioPath} className="text-sm font-medium text-emerald-700 underline dark:text-emerald-300">Volver a la primera página</Link>}
      {current?.page && (
        <>
          <p role="status" ref={nextPage} tabIndex={-1} className="text-sm text-gray-600 dark:text-gray-300">
            {current.page.items.length === 1 ? '1 borrador en esta página' : `${current.page.items.length} borradores en esta página`}
          </p>
          {current.page.items.length ? (
            <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {current.page.items.map((draft) => (
                <li key={draft.graphId} className="min-w-0">
                  <Link ref={draft.graphId === returnGraphId ? returnLink : undefined} to={studioLocation(graphPath(draft.graphId), { after })}
                    className="flex h-full flex-col gap-3 rounded-xl border border-gray-200 bg-white p-4 hover:border-emerald-700 dark:border-gray-700 dark:bg-gray-900 dark:hover:border-emerald-300">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <GitBranch size={20} className="text-emerald-700 dark:text-emerald-300" aria-hidden="true" />
                      <span className="rounded-full bg-gray-100 px-2 py-1 text-xs font-medium dark:bg-gray-800">Borrador · Revisión {draft.version}</span>
                    </div>
                    <h2 className="break-all font-semibold">{draft.graphId}</h2>
                    <p className="text-sm text-gray-600 dark:text-gray-300">Nodos {draft.nodes.length} · Conexiones {draft.edges.length}</p>
                    <p className="mt-auto break-all text-xs text-gray-600 dark:text-gray-300">Política {draft.policyRef}</p>
                  </Link>
                </li>
              ))}
            </ul>
          ) : <div className="rounded-xl border border-dashed border-gray-300 p-5 text-sm dark:border-gray-600">
            <GitBranch size={24} className="mb-3 text-emerald-700 dark:text-emerald-300" aria-hidden="true" />
            {after ? 'No hay más borradores en esta página.' : 'Todavía no hay grafos guardados en esta empresa.'}
          </div>}
          {(after || current.page.nextAfter) && (
            <nav aria-label="Páginas de Agent Studio" className="flex flex-wrap gap-2">
              {after && <button type="button" onClick={() => go()} className="min-h-11 rounded-md border border-gray-300 px-3 text-sm font-medium dark:border-gray-600">Primera página</button>}
              {current.page.nextAfter && (
                <button type="button" onClick={() => go(current.page?.nextAfter ?? undefined)}
                  className="min-h-11 rounded-md border border-gray-300 px-3 text-sm font-medium dark:border-gray-600">Siguiente página</button>
              )}
            </nav>
          )}
        </>
      )}
    </section>
  );
}
