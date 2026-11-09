import { useCallback, useEffect, useRef, useState } from 'react';
import { useAtomValue } from 'jotai';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { userRoleAtom } from '../../jotai/middleware/userRoleAtom';
import WorkflowRunPanel from './WorkflowRunPanel';
import WorkflowWebhooksPanel from './WorkflowWebhooksPanel';
import {
  getWorkflow, getWorkflowRevision, publishWorkflow, workflowDate, workflowError, workflowPath, workflowStatus,
  type RevisionSummary, type WorkflowRun,
} from './workflowApi';

const buttonClass = 'inline-flex min-h-11 items-center gap-2 rounded-md border border-gray-300 px-3 text-sm font-semibold disabled:opacity-55 dark:border-gray-600';

function RevisionGraph({ id, revisionId, editorPath }: { id: string; revisionId: string; editorPath?: string }) {
  const [revision, setRevision] = useState<Awaited<ReturnType<typeof getWorkflowRevision>>>();
  const [error, setError] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    heading.current?.focus();
    const request = new AbortController();
    getWorkflowRevision(id, revisionId, request.signal)
      .then((item) => { if (!request.signal.aborted) setRevision(item); })
      .catch((cause) => { if (!request.signal.aborted) setError(workflowError(cause, 'No pudimos abrir esta revisión.')); });
    return () => request.abort();
  }, [id, revisionId]);

  return (
    <div className="space-y-2 rounded-lg border border-gray-200 p-3 dark:border-gray-700">
      <h3 ref={heading} tabIndex={-1} className="font-semibold">Grafo de la revisión</h3>
      {error && <p role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</p>}
      {!revision && !error && <p role="status" className="text-sm">Cargando grafo…</p>}
      {revision && (
        <>
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-md bg-gray-50 p-3 text-xs dark:bg-gray-800">{JSON.stringify(revision.dagGraph, null, 2)}</pre>
          <p className="break-all text-xs text-gray-600 dark:text-gray-300">Huella SHA-256 {revision.specHash}</p>
          {editorPath && <Link className={buttonClass} to={editorPath + '?from=' + encodeURIComponent(revisionId)}>Crear borrador a partir de esta revisión</Link>}
        </>
      )}
    </div>
  );
}

function WorkflowDetail({ id }: { id: string }) {
  const isAdmin = useAtomValue(userRoleAtom) === 'ADMIN';
  const [params] = useSearchParams();
  const { state } = useLocation();
  const runId = params.get('run');
  const base = `${workflowPath}/${encodeURIComponent(id)}`;
  const editorPath = base + '/revisiones/nueva';
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof getWorkflow>>>();
  const [loadError, setLoadError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [graphRevisionId, setGraphRevisionId] = useState<string>();
  const [confirmation, setConfirmation] = useState<RevisionSummary>();
  const [publishing, setPublishing] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error?: boolean }>();
  const publishLock = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const cancelPublication = useRef<HTMLButtonElement>(null);
  const publicationNotice = useRef<HTMLParagraphElement>(null);
  const loaded = Boolean(detail);

  useEffect(() => {
    const request = new AbortController();
    getWorkflow(id, request.signal)
      .then((item) => {
        if (!request.signal.aborted) {
          setDetail(item);
          setLoadError('');
        }
      })
      .catch((cause) => { if (!request.signal.aborted) setLoadError(workflowError(cause, 'No pudimos actualizar la ficha del workflow.')); });
    return () => request.abort();
  }, [attempt, id]);

  useEffect(() => {
    if (loaded && !runId) heading.current?.focus();
  }, [loaded, runId]);

  useEffect(() => {
    if (confirmation) cancelPublication.current?.focus();
  }, [confirmation]);

  useEffect(() => {
    if (notice) publicationNotice.current?.focus();
  }, [notice]);

  function cancelPublicationReview() {
    const buttonId = `publish-${confirmation?.id}`;
    setConfirmation(undefined);
    requestAnimationFrame(() => document.getElementById(buttonId)?.focus());
  }

  function refresh() {
    setAttempt((value) => value + 1);
  }

  const observeRun = useCallback((run: WorkflowRun) => {
    setDetail((previous) => previous && ({
      ...previous,
      runs: previous.runs.map((item) => item.id === run.id ? {
        ...item, status: run.status, currentStep: run.currentStep, completedAt: run.completedAt,
      } : item),
    }));
  }, []);

  async function confirmPublication() {
    if (!confirmation || !isAdmin || publishLock.current) return;
    const revision = confirmation;
    publishLock.current = true;
    setPublishing(true);
    setNotice(undefined);
    try {
      await publishWorkflow(id, revision.id);
      setDetail((previous) => previous && ({
        ...previous,
        workflow: { ...previous.workflow, status: 'published', publishedRevisionId: revision.id },
        revisions: previous.revisions.map((item) => item.id === revision.id ? { ...item, status: 'published' } : item),
      }));
      setNotice({ text: `La revisión ${revision.revisionNumber} se publicó.` });
      setConfirmation(undefined);
      refresh();
    } catch (cause) {
      setNotice({ error: true, text: workflowError(cause, 'No pudimos confirmar la publicación. Actualiza la ficha antes de reintentar.') });
    } finally {
      publishLock.current = false;
      setPublishing(false);
    }
  }

  const canEdit = isAdmin && detail?.workflow.status !== 'archived';
  const activeRevision = detail?.revisions.find((revision) => revision.id === detail.workflow.publishedRevisionId);

  return (
    <section className="mx-auto max-w-5xl space-y-4 p-4 sm:p-6">
      <Link to={workflowPath} className="inline-flex min-h-11 items-center gap-2 text-sm font-medium text-emerald-700 dark:text-emerald-300">
        <ArrowLeft size={16} aria-hidden="true" /> Volver a workflows
      </Link>
      {loadError && <div role="alert" className="rounded-md border border-red-200 p-3 text-sm text-red-700 dark:border-red-800 dark:text-red-300">
        <p>{loadError}</p>
        <button type="button" onClick={refresh} className="min-h-11 font-semibold underline">Volver a intentar</button>
      </div>}
      {!detail && !loadError && <p role="status" className="text-sm">Cargando ficha…</p>}
      {detail && (
        <>
          <header className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h1 ref={heading} tabIndex={-1} className="break-words text-2xl font-semibold">{detail.workflow.name}</h1>
              {detail.workflow.description && <p className="mt-1 whitespace-pre-wrap break-words text-sm">{detail.workflow.description}</p>}
              <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">
                {workflowStatus(detail.workflow.status)}{activeRevision && ` · Revisión activa ${activeRevision.revisionNumber}`}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={refresh} className={buttonClass}><RefreshCw size={16} aria-hidden="true" /> Actualizar ficha</button>
              {canEdit && <Link to={editorPath} className={buttonClass}>Nueva revisión</Link>}
            </div>
          </header>
          {state?.draftSaved && !notice && <p role="status" className="rounded-md bg-emerald-50 p-3 text-sm text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200">El servidor guardó el borrador.</p>}
          {notice && <p ref={publicationNotice} tabIndex={-1} role={notice.error ? 'alert' : 'status'} className="rounded-md border border-gray-200 p-3 text-sm dark:border-gray-700">{notice.text}</p>}
          <section className="space-y-3 rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900" aria-labelledby="workflow-revisions">
            <div>
              <h2 id="workflow-revisions" className="text-lg font-semibold">Revisiones</h2>
              <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">Hasta 50 revisiones recientes, con la activa primero.</p>
            </div>
            <ul className="divide-y divide-gray-200 rounded-lg border border-gray-200 dark:divide-gray-700 dark:border-gray-700">
              {detail.revisions.map((revision) => (
                <li key={revision.id} className="space-y-2 p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <h3 className="text-sm font-semibold">Revisión {revision.revisionNumber}</h3>
                      <p className="text-xs text-gray-600 dark:text-gray-300">
                        {activeRevision?.id === revision.id ? 'Activa' : workflowStatus(revision.status)} · {workflowDate(revision.createdAt)}
                      </p>
                    </div>
                    {isAdmin && <div className="flex flex-wrap gap-2">
                      <button type="button" onClick={() => setGraphRevisionId((value) => value === revision.id ? undefined : revision.id)}
                        aria-expanded={graphRevisionId === revision.id} className={buttonClass}>
                        {graphRevisionId === revision.id ? 'Cerrar grafo' : 'Ver grafo'}
                      </button>
                      {canEdit && revision.status === 'draft' && confirmation?.id !== revision.id && (
                        <button id={`publish-${revision.id}`} type="button" disabled={publishing} onClick={() => setConfirmation(revision)}
                          aria-label={`Publicar revisión ${revision.revisionNumber}`} className={buttonClass}>Publicar revisión</button>
                      )}
                    </div>}
                  </div>
                  {confirmation?.id === revision.id && (
                    <div className="space-y-2 rounded-md bg-gray-50 p-3 text-sm dark:bg-gray-800">
                      <p>¿Publicar la revisión {revision.revisionNumber}? Los eventos nuevos usarán esta revisión. Las ejecuciones ya registradas conservan la suya.</p>
                      <div className="flex flex-wrap gap-2">
                        <button ref={cancelPublication} type="button" disabled={publishing} onClick={cancelPublicationReview} className={buttonClass}>Cancelar</button>
                        <button type="button" disabled={publishing} onClick={confirmPublication}
                          className="min-h-11 rounded-md bg-emerald-700 px-3 text-sm font-semibold text-white disabled:opacity-55">
                          {publishing ? 'Publicando…' : 'Confirmar publicación'}
                        </button>
                      </div>
                    </div>
                  )}
                  {isAdmin && graphRevisionId === revision.id && <RevisionGraph key={revision.id} id={id} revisionId={revision.id} editorPath={canEdit ? editorPath : undefined} />}
                </li>
              ))}
            </ul>
            {detail.revisions.length === 0 && <p className="text-sm">Todavía no hay revisiones registradas.</p>}
          </section>
          {isAdmin && detail.webhooks && <WorkflowWebhooksPanel workflowId={id} published={detail.workflow.status === 'published'} webhooks={detail.webhooks} refresh={refresh} />}
          <section className="space-y-3 rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900" aria-labelledby="workflow-runs">
            <div>
              <h2 id="workflow-runs" className="text-lg font-semibold">Ejecuciones</h2>
              <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">Hasta 50 ejecuciones recientes.</p>
            </div>
            {detail.runs.length ? (
              <ul className="divide-y divide-gray-200 rounded-lg border border-gray-200 dark:divide-gray-700 dark:border-gray-700">
                {detail.runs.map((run) => (
                  <li key={run.id}>
                    <Link to={base + '?run=' + encodeURIComponent(run.id)} aria-current={runId === run.id ? 'true' : undefined}
                      className="flex min-h-11 flex-wrap items-center justify-between gap-2 p-3 hover:bg-gray-50 dark:hover:bg-gray-800">
                      <div className="min-w-0">
                        <p className="break-all font-mono text-xs">{run.id}</p>
                        <p className="mt-1 text-xs text-gray-600 dark:text-gray-300">Revisión {run.revisionNumber} · {workflowDate(run.startedAt)}</p>
                      </div>
                      <span className="text-sm font-medium">{workflowStatus(run.status)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : <p className="text-sm text-gray-600 dark:text-gray-300">Todavía no se registraron ejecuciones.</p>}
            {runId && <WorkflowRunPanel key={runId} workflowId={id} runId={runId} onObserved={observeRun} />}
          </section>
        </>
      )}
    </section>
  );
}

export default function WorkflowDetailPage() {
  const { workflowId } = useParams();
  return workflowId ? <WorkflowDetail key={workflowId} id={workflowId} /> : null;
}
