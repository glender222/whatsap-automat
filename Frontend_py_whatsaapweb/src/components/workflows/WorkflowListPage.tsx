import { useEffect, useState } from 'react';
import { useAtomValue } from 'jotai';
import { Plus, Workflow } from 'lucide-react';
import { Link } from 'react-router-dom';
import { userRoleAtom } from '../../jotai/middleware/userRoleAtom';
import { listWorkflows, workflowDate, workflowError, workflowPageSize, workflowPath, workflowStatus } from './workflowApi';

export default function WorkflowListPage() {
  const isAdmin = useAtomValue(userRoleAtom) === 'ADMIN';
  const [offset, setOffset] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [response, setResponse] = useState<{ key: string; page?: Awaited<ReturnType<typeof listWorkflows>>; error?: string }>();
  const key = offset + '/' + attempt;
  const current = response?.key === key ? response : undefined;

  useEffect(() => {
    const request = new AbortController();
    listWorkflows(offset, request.signal).then((page) => {
      if (!request.signal.aborted) setResponse({ key, page });
    }).catch((cause) => {
      if (!request.signal.aborted) setResponse({ key, error: workflowError(cause, 'No pudimos cargar los workflows.') });
    });
    return () => request.abort();
  }, [key, offset]);

  return (
    <section className="mx-auto max-w-5xl space-y-4 p-4 sm:p-6" aria-labelledby="workflow-title">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 id="workflow-title" className="text-2xl font-semibold">Workflows</h1>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">Consulta revisiones y sigue las ejecuciones registradas.</p>
        </div>
        {isAdmin && <Link to={workflowPath + '/nuevo'} className="inline-flex min-h-11 items-center gap-2 rounded-md bg-emerald-700 px-4 text-sm font-semibold text-white hover:bg-emerald-800">
          <Plus size={16} aria-hidden="true" /> Nuevo workflow
        </Link>}
      </header>
      {!current && <p role="status" className="text-sm">Cargando workflows…</p>}
      {current?.error && <div role="alert" className="rounded-lg border border-red-200 p-4 text-sm text-red-700 dark:border-red-800 dark:text-red-300">
        <p>{current.error}</p>
        <button type="button" className="min-h-11 font-semibold underline" onClick={() => setAttempt((value) => value + 1)}>Volver a intentar</button>
      </div>}
      {current?.page && (
        <>
          {current.page.items.length ? (
            <ul className="divide-y divide-gray-200 rounded-xl border border-gray-200 bg-white dark:divide-gray-700 dark:border-gray-700 dark:bg-gray-900">
              {current.page.items.map((item) => (
                <li key={item.id}>
                  <Link to={`${workflowPath}/${encodeURIComponent(item.id)}`} className="flex flex-wrap justify-between gap-3 px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-800">
                    <div className="min-w-0">
                      <h2 className="break-words font-semibold">{item.name}</h2>
                      {item.description && <p className="mt-1 line-clamp-2 break-words text-sm text-gray-600 dark:text-gray-300">{item.description}</p>}
                    </div>
                    <div className="text-right text-xs text-gray-600 dark:text-gray-300">
                      <span className="rounded-full bg-gray-100 px-2 py-1 dark:bg-gray-800">{workflowStatus(item.status)}</span>
                      <p className="mt-2">{workflowDate(item.updatedAt)}</p>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          ) : <div className="rounded-xl border border-dashed border-gray-300 p-5 text-sm dark:border-gray-600">
            <Workflow size={24} aria-hidden="true" className="mb-3 text-emerald-700 dark:text-emerald-300" />
            {offset ? 'No hay workflows en esta página.' : 'Todavía no hay workflows en esta empresa.'}
          </div>}
          {(offset > 0 || current.page.hasMore) && (
            <nav aria-label="Páginas de workflows" className="flex gap-2">
              <button type="button" disabled={!offset} onClick={() => setOffset((value) => Math.max(0, value - workflowPageSize))}
                className="min-h-11 rounded-md border border-gray-300 px-3 text-sm disabled:opacity-50 dark:border-gray-600">Anterior</button>
              <button type="button" disabled={!current.page.hasMore} onClick={() => setOffset((value) => value + workflowPageSize)}
                className="min-h-11 rounded-md border border-gray-300 px-3 text-sm disabled:opacity-50 dark:border-gray-600">Siguiente</button>
            </nav>
          )}
        </>
      )}
    </section>
  );
}
