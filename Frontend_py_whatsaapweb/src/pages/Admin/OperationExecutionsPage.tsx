import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, RefreshCw } from 'lucide-react';
import { Link } from 'react-router-dom';
import { workflowDate, workflowError, workflowPath, workflowStatus } from '../../components/workflows/workflowApi';
import {
  dispatchLabel, executionStatuses, failureLabels, listExecutions, validWorkflowFilter,
  type ExecutionFilters, type ExecutionPage, type ExecutionRecord,
} from './operationExecutionsApi';

const defaultFilters: ExecutionFilters = { workflowId: '', status: '' };
const buttonClass = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-gray-300 px-3 text-sm font-semibold hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:hover:bg-gray-800';
const inputClass = 'mt-1 block min-h-11 w-full rounded-md border border-gray-300 bg-white px-3 text-sm dark:border-gray-600 dark:bg-gray-900';
const secondaryClass = 'text-sm text-gray-600 dark:text-gray-300';

interface Query {
  filters: ExecutionFilters;
  cursors: (string | null)[];
}
type Result = { query: Query; page: ExecutionPage } | { query: Query; error: string };

function ExecutionRow({ item }: { item: ExecutionRecord }) {
  const dispatch = item.dispatch;
  const warn = item.dispatchEvidence === 'ambiguous' || dispatch?.status === 'delivery_unknown' ||
    dispatch?.status === 'failed' || dispatch?.status === 'dead_letter';
  const runPath = workflowPath + '/' + encodeURIComponent(item.workflowId) + '?run=' + encodeURIComponent(item.workflowRunId);

  return (
    <li className="min-w-0 px-4 py-3">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)_minmax(0,1fr)]">
        <div className="min-w-0">
          <p className="text-xs text-gray-600 dark:text-gray-300">Ejecución</p>
          <h3 className="break-all text-sm font-semibold">{item.id}</h3>
          <time className="text-xs text-gray-600 dark:text-gray-300" dateTime={item.recordedAt}>{workflowDate(item.recordedAt)}</time>
        </div>
        <div>
          <p className="text-xs text-gray-600 dark:text-gray-300">Workflow</p>
          <p className="text-sm font-medium">{workflowStatus(item.status)}</p>
          {item.failureCode && <p className="mt-1 text-xs text-red-700 dark:text-red-300">{failureLabels[item.failureCode] ?? item.failureCode}</p>}
        </div>
        <div>
          <p className="text-xs text-gray-600 dark:text-gray-300">Despacho</p>
          <p className={warn ? 'text-sm font-medium text-amber-800 dark:text-amber-300' : 'text-sm font-medium'}>{dispatchLabel(item)}</p>
          {dispatch && <p className="text-xs text-gray-600 dark:text-gray-300">{dispatch.retryCount} de {dispatch.maxRetries} reintentos registrados</p>}
        </div>
      </div>

      <details className="mt-3">
        <summary className="w-fit cursor-pointer rounded px-1 py-2 text-sm font-semibold text-emerald-800 hover:underline dark:text-emerald-300">Ver datos de ejecución</summary>
        <div className="mt-1 rounded-lg bg-gray-50 p-3 dark:bg-gray-800">
          <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
            <div><dt className={secondaryClass}>ID del workflow</dt><dd className="break-all">{item.workflowId}</dd></div>
            <div><dt className={secondaryClass}>Revisión</dt><dd className="break-all">{item.revisionId}</dd></div>
            <div><dt className={secondaryClass}>Origen</dt><dd className="break-all">{item.triggerType === 'webhook' ? 'Webhook' : item.triggerType}</dd></div>
            <div><dt className={secondaryClass}>Pasos registrados</dt><dd>{item.stepCount}</dd></div>
            {item.completedAt && <div><dt className={secondaryClass}>Finalización registrada</dt><dd><time dateTime={item.completedAt}>{workflowDate(item.completedAt)}</time></dd></div>}
            {dispatch && <div><dt className={secondaryClass}>Última actualización del despacho</dt><dd><time dateTime={dispatch.updatedAt}>{workflowDate(dispatch.updatedAt)}</time></dd></div>}
            {dispatch?.nextRetryAt && <div><dt className={secondaryClass}>Próximo intento registrado</dt><dd><time dateTime={dispatch.nextRetryAt}>{workflowDate(dispatch.nextRetryAt)}</time></dd></div>}
            {dispatch?.leaseExpiresAt && <div><dt className={secondaryClass}>Reserva del despacho hasta</dt><dd><time dateTime={dispatch.leaseExpiresAt}>{workflowDate(dispatch.leaseExpiresAt)}</time></dd></div>}
          </dl>
          <Link className={buttonClass + ' mt-3'} to={runPath}>Abrir ficha del workflow</Link>
        </div>
      </details>
    </li>
  );
}

export default function OperationExecutionsPage() {
  const [draft, setDraft] = useState(defaultFilters);
  const [query, setQuery] = useState<Query>({ filters: defaultFilters, cursors: [null] });
  const [result, setResult] = useState<Result>();
  const [filterError, setFilterError] = useState('');
  const resultsHeading = useRef<HTMLHeadingElement>(null);
  const moveFocus = useRef(false);
  const current = result?.query === query ? result : undefined;
  const page = current && 'page' in current ? current.page : undefined;
  const cursor = query.cursors[query.cursors.length - 1];
  const hasFilters = Boolean(query.filters.status || query.filters.workflowId);
  const pending = page?.items.filter((item) => item.dispatch?.status === 'pending').length;

  useEffect(() => {
    const request = new AbortController();
    listExecutions(query.filters, cursor, request.signal).then((page) => {
      if (!request.signal.aborted) setResult({ query, page });
    }).catch((cause) => {
      if (!request.signal.aborted) setResult({ query, error: workflowError(cause, 'No pudimos cargar las ejecuciones.') });
    });
    return () => request.abort();
  }, [cursor, query]);

  useEffect(() => {
    if (current && moveFocus.current) {
      resultsHeading.current?.focus();
      moveFocus.current = false;
    }
  }, [current]);

  function navigate(next: Query) {
    moveFocus.current = true;
    setQuery(next);
  }

  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const workflowId = draft.workflowId.trim();
    if (!validWorkflowFilter(workflowId)) {
      setFilterError('Usa letras sin acento, números, guiones o guiones bajos en el ID del workflow.');
      return;
    }
    setFilterError('');
    navigate({ filters: { ...draft, workflowId }, cursors: [null] });
  }

  return (
    <section className="mx-auto max-w-5xl space-y-4 p-4 sm:p-6" aria-labelledby="executions-title">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 id="executions-title" className="text-2xl font-semibold">Ejecuciones</h1>
          <p className="mt-1 max-w-xl text-sm text-gray-600 dark:text-gray-300">Consulta el avance de los workflows y la evidencia registrada de su despacho.</p>
        </div>
        <button type="button" className={buttonClass} disabled={!current} onClick={() => navigate({ ...query, cursors: [null] })}>
          <RefreshCw size={16} aria-hidden="true" /> Actualizar listado
        </button>
      </header>

      <form onSubmit={apply} className="grid gap-3 rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]" aria-label="Filtrar ejecuciones">
        <label className="text-sm font-semibold">
          ID del workflow
          <input value={draft.workflowId} onChange={(event) => { setDraft({ ...draft, workflowId: event.target.value }); setFilterError(''); }}
            maxLength={255} autoComplete="off" className={inputClass}
            aria-invalid={Boolean(filterError)} aria-describedby={filterError ? 'execution-filter-error' : undefined} />
        </label>
        <label className="text-sm font-semibold">
          Estado del workflow
          <select value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value as ExecutionFilters['status'] })} className={inputClass}>
            <option value="">Todos los estados</option>
            {executionStatuses.map((status) => <option key={status} value={status}>{workflowStatus(status)}</option>)}
          </select>
        </label>
        <div className="flex flex-wrap items-end gap-2">
          <button type="submit" className="min-h-11 rounded-md bg-emerald-700 px-3 text-sm font-semibold text-white hover:bg-emerald-800">Aplicar filtros</button>
          {(draft.workflowId || draft.status || hasFilters) && <button type="button" className={buttonClass} onClick={() => {
            setDraft(defaultFilters);
            setFilterError('');
            navigate({ filters: defaultFilters, cursors: [null] });
          }}>Limpiar</button>}
        </div>
        {filterError && <p id="execution-filter-error" role="alert" className="text-sm text-red-700 dark:text-red-300 sm:col-span-3">{filterError}</p>}
      </form>

      <section aria-labelledby="execution-results" className="space-y-3">
        <h2 id="execution-results" tabIndex={-1} ref={resultsHeading} className="text-base font-semibold">Página {query.cursors.length}</h2>
        {!current && <p role="status" className={secondaryClass}>Cargando ejecuciones…</p>}
        {current && 'error' in current && (
          <div role="alert" className="rounded-lg border border-red-200 p-4 text-sm text-red-700 dark:border-red-800 dark:text-red-300">
            <p>{current.error}</p>
            <button type="button" className="min-h-11 font-semibold underline" onClick={() => navigate({ ...query })}>Volver a cargar listado</button>
          </div>
        )}
        {page && page.items.length > 0 && (
          <>
            <dl aria-label="Resumen de esta página" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {([
                ['Ejecuciones en esta página', page.items.length], ['Despachos pendientes', pending],
                ['Despachos sin confirmar', page.pageSummary.deliveryUnknownCount], ['Reintentos registrados', page.pageSummary.retryCount],
              ] as const).map(([label, count]) => (
                <div key={label} className="min-w-0 rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900">
                  <dt className="text-xs text-gray-600 dark:text-gray-300">{label}</dt><dd className="text-xl font-semibold">{count}</dd>
                </div>
              ))}
            </dl>
            <ul className="divide-y divide-gray-200 rounded-xl border border-gray-200 bg-white dark:divide-gray-700 dark:border-gray-700 dark:bg-gray-900">
              {page.items.map((item) => <ExecutionRow key={item.id} item={item} />)}
            </ul>
          </>
        )}
        {page && page.items.length === 0 && <p className="rounded-lg border border-dashed border-gray-300 p-4 text-sm dark:border-gray-700">
          {hasFilters ? 'No hay ejecuciones que coincidan con estos filtros.' : 'No hay ejecuciones registradas en esta página.'}
        </p>}
        {(query.cursors.length > 1 || page?.nextCursor) && (
          <nav aria-label="Páginas de ejecuciones" className="flex flex-wrap gap-2">
            <button type="button" className={buttonClass} disabled={!current || query.cursors.length <= 1}
              onClick={() => navigate({ ...query, cursors: query.cursors.slice(0, -1) })}><ArrowLeft size={16} aria-hidden="true" /> Anterior</button>
            <button type="button" className={buttonClass} disabled={!page?.nextCursor} onClick={() => {
              if (page?.nextCursor) navigate({ ...query, cursors: [...query.cursors, page.nextCursor] });
            }}>Siguiente <ArrowRight size={16} aria-hidden="true" /></button>
          </nav>
        )}
      </section>
    </section>
  );
}
