import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ClipboardCheck, RefreshCw } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import ApprovalDetail from './ApprovalDetail';
import {
  approvalDate, approvalIdPattern, approvalPageSize, approvalProblem, approvalsPath, currentApprovalSession,
  listApprovals, readApprovalWorkspace, riskLabels, type Approval, type ApprovalWorkspace, type Risk,
} from './approvalApi';

const panel = 'min-w-0 rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900';
const button = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-gray-300 px-3 text-sm font-semibold hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:hover:bg-gray-800';
const subtext = 'text-sm text-gray-600 dark:text-gray-300';

function ApprovalsQueue({ workspace }: { workspace: ApprovalWorkspace }) {
  const [query, setQuery] = useState<{ risk: Risk | ''; page: number }>({ risk: '', page: 1 });
  const [draftRisk, setDraftRisk] = useState<Risk | ''>('');
  const [result, setResult] = useState<{ query: typeof query; items?: Approval[]; error?: string }>();
  const heading = useRef<HTMLHeadingElement>(null);
  const focusResults = useRef(false);
  const offset = (query.page - 1) * approvalPageSize;
  const current = result?.query === query ? result : undefined;

  useEffect(() => {
    const request = new AbortController();
    listApprovals(workspace.tenantId, offset, query.risk, request.signal).then((items) => {
      if (!request.signal.aborted) setResult({ query, items });
    }).catch((cause) => {
      if (!request.signal.aborted) setResult({ query, error: approvalProblem(cause, 'No pudimos cargar las aprobaciones pendientes.') });
    });
    return () => request.abort();
  }, [offset, query, workspace.tenantId]);

  useEffect(() => {
    if (current && focusResults.current) {
      heading.current?.focus();
      focusResults.current = false;
    }
  }, [current]);

  function navigate(next: typeof query) {
    focusResults.current = true;
    setQuery(next);
  }

  function filter(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    navigate({ risk: draftRisk, page: 1 });
  }

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold">Aprobaciones pendientes</h2>
          <p className={subtext + ' mt-1 break-words'}>Espacio de trabajo {workspace.workspaceName}</p>
        </div>
        <button type="button" className={button} disabled={!current} onClick={() => navigate({ ...query, page: 1 })}>
          <RefreshCw size={16} aria-hidden="true" /> Actualizar cola
        </button>
      </header>
      <form onSubmit={filter} className={panel + ' flex flex-wrap items-end gap-3'} aria-label="Filtrar aprobaciones">
        <label className="min-w-0 text-sm font-semibold">
          Nivel de riesgo
          <select value={draftRisk} onChange={(event) => setDraftRisk(event.target.value as Risk | '')}
            className="mt-1 block min-h-11 rounded-md border border-gray-300 bg-white px-3 text-sm dark:border-gray-600 dark:bg-gray-900">
            <option value="">Todos los riesgos</option>
            {(Object.keys(riskLabels) as Risk[]).map((risk) => <option key={risk} value={risk}>{riskLabels[risk]}</option>)}
          </select>
        </label>
        <button type="submit" className={button}>Aplicar filtro</button>
      </form>
      <section className="space-y-3" aria-labelledby="approval-results-title">
        <h3 ref={heading} id="approval-results-title" tabIndex={-1} className="text-base font-semibold">Página {query.page}</h3>
        {!current && <p role="status" className={subtext}>Cargando aprobaciones…</p>}
        {current?.error && <div role="alert" className={panel + ' text-sm text-red-800 dark:text-red-300'}>
          <p>{current.error}</p>
          <button type="button" className="min-h-11 font-semibold underline" onClick={() => navigate({ ...query })}>Volver a cargar</button>
        </div>}
        {current?.items?.length === 0 && <p className={panel + ' ' + subtext}>
          {query.risk ? 'No hay solicitudes pendientes para este riesgo.' : 'No hay solicitudes pendientes.'}
        </p>}
        {current?.items && current.items.length > 0 && (
          <ul className="divide-y divide-gray-200 rounded-xl border border-gray-200 bg-white dark:divide-gray-700 dark:border-gray-700 dark:bg-gray-900">
            {current.items.map((item) => (
              <li key={item.id}>
                <Link to={`${approvalsPath}/${encodeURIComponent(item.id)}`}
                  className="flex min-h-11 flex-wrap items-start justify-between gap-2 px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-800">
                  <div className="min-w-0 space-y-1">
                    <h4 className="flex items-center gap-2 break-all text-sm font-semibold">
                      <ClipboardCheck size={16} aria-hidden="true" className="shrink-0 text-emerald-700 dark:text-emerald-300" />
                      {item.details?.toolName || 'Solicitud de aprobación'}
                    </h4>
                    <p className={subtext}>Versión {item.policyVersion} · Vence <time dateTime={item.expiresAt}>{approvalDate(item.expiresAt)}</time></p>
                  </div>
                  <span className="rounded-full bg-gray-100 px-2.5 py-1 text-xs font-semibold dark:bg-gray-800">Riesgo {riskLabels[item.risk]}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {(query.page > 1 || current?.items?.length === approvalPageSize) && (
          <nav aria-label="Páginas de aprobaciones" className="flex flex-wrap gap-2">
            <button type="button" className={button} disabled={!current || query.page <= 1}
              onClick={() => navigate({ ...query, page: query.page - 1 })}>Anterior</button>
            <button type="button" className={button} disabled={current?.items?.length !== approvalPageSize || offset + approvalPageSize > 10000}
              onClick={() => navigate({ ...query, page: query.page + 1 })}>Siguiente</button>
          </nav>
        )}
      </section>
    </div>
  );
}

export default function ApprovalsPage() {
  const { approvalId } = useParams();
  const [session, setSession] = useState(currentApprovalSession);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ session: string; attempt: number; workspace?: ApprovalWorkspace; error?: string }>();
  const current = result && result.session === session && result.attempt === attempt ? result : undefined;

  useEffect(() => {
    const update = () => setSession(currentApprovalSession());
    window.addEventListener('storage', update);
    return () => window.removeEventListener('storage', update);
  }, []);

  useEffect(() => {
    if (!session) return;
    const request = new AbortController();
    readApprovalWorkspace(request.signal).then((workspace) => {
      if (request.signal.aborted || currentApprovalSession() !== session) return;
      if (workspace.capabilities.includes('approvals.review')) setResult({ session, attempt, workspace });
      else setResult({ session, attempt, error: 'Tu espacio de trabajo no tiene permiso para revisar aprobaciones.' });
    }).catch((cause) => {
      if (!request.signal.aborted && currentApprovalSession() === session) {
        setResult({ session, attempt, error: approvalProblem(cause, 'No pudimos comprobar el permiso de Aprobaciones.') });
      }
    });
    return () => request.abort();
  }, [attempt, session]);

  return (
    <section className="mx-auto max-w-5xl space-y-4 p-4 sm:p-6" aria-label="Aprobaciones">
      {!session && <Link to="/auth/login" className={button}>Iniciar sesión para revisar aprobaciones</Link>}
      {session && !current && <p role="status" className={subtext}>Comprobando el acceso a Aprobaciones…</p>}
      {current?.error && <div role="alert" className={panel + ' text-sm text-red-800 dark:text-red-300'}>
        <p>{current.error}</p>
        <button type="button" className="min-h-11 font-semibold underline" onClick={() => setAttempt((value) => value + 1)}>Comprobar acceso de nuevo</button>
      </div>}
      {current?.workspace && session && (!approvalId ? <ApprovalsQueue workspace={current.workspace} />
        : approvalIdPattern.test(approvalId) ? (
          <ApprovalDetail key={approvalId} id={approvalId} tenantId={current.workspace.tenantId} session={session} />
        ) : <p role="alert" className={panel + ' text-sm'}>El identificador de solicitud no es válido.</p>)}
    </section>
  );
}
