import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, LockKeyhole, RefreshCw } from 'lucide-react';
import { Link } from 'react-router-dom';
import {
  approvalDate, approvalHttpStatus, approvalProblem, approvalStatuses, currentApprovalSession,
  decideApproval, isSensitiveApproval, readApproval, riskLabels, type Approval, type Decision, type DecisionIntent,
} from './approvalApi';

const panel = 'min-w-0 rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900';
const secondary = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-gray-300 px-3 text-sm font-semibold hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:hover:bg-gray-800';
const primary = 'inline-flex min-h-11 items-center justify-center rounded-md bg-emerald-700 px-3 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-50';
const subtext = 'text-sm text-gray-600 dark:text-gray-300';
const decisions: Record<Decision, { label: string; confirm: string }> = {
  approved: { label: 'Aprobar solicitud', confirm: 'Confirmar aprobación' },
  rejected: { label: 'Rechazar solicitud', confirm: 'Confirmar rechazo' },
};
type Notice = { tone: 'success' | 'error' | 'uncertain'; message: string };
type Confirmation = { decision: Decision; expectedVersion: number; retry?: DecisionIntent };

let attemptSession: string | null = null;
const attempts = new Map<string, DecisionIntent>();

function scopedAttempts(session: string) {
  if (currentApprovalSession() !== session) return undefined;
  if (attemptSession !== session) {
    attempts.clear();
    attemptSession = session;
  }
  return attempts;
}

function DecisionDialog({ approval, confirmation, onCancel, onConfirm }: {
  approval: Approval;
  confirmation: Confirmation;
  onCancel: () => void;
  onConfirm: (reason?: string, password?: string) => void;
}) {
  const [reason, setReason] = useState(confirmation.retry?.reason ?? '');
  const [password, setPassword] = useState('');
  const [reviewed, setReviewed] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const sensitive = isSensitiveApproval(approval.risk);
  const requiresReason = sensitive || confirmation.decision === 'rejected';

  useEffect(() => {
    const element = dialog.current;
    const previous = document.activeElement;
    element?.showModal();
    cancel.current?.focus();
    return () => {
      element?.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = reason.trim();
    if ((requiresReason && !message) || (sensitive && (!reviewed || !password))) return;
    onConfirm(message || undefined, sensitive ? password : undefined);
    setPassword('');
  }

  return (
    <dialog ref={dialog} aria-labelledby="approval-confirm-title" aria-describedby="approval-confirm-description"
      onCancel={(event) => { event.preventDefault(); onCancel(); }}
      className="fixed left-1/2 top-1/2 m-0 max-h-[90dvh] w-[calc(100%_-_2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-gray-200 bg-white p-4 text-gray-900 backdrop:bg-gray-950/55 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100">
      <form className="space-y-4" onSubmit={submit}>
        <div>
          <h3 id="approval-confirm-title" className="text-lg font-semibold">{decisions[confirmation.decision].confirm}</h3>
          <p id="approval-confirm-description" className={subtext + ' mt-1 break-words'}>
            {approval.details?.toolName || 'Solicitud de aprobación'} · Riesgo {riskLabels[approval.risk]} · Versión {confirmation.expectedVersion}
          </p>
        </div>
        {sensitive && <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
          Revisa el alcance de la solicitud y confirma la decisión con tu contraseña actual.
        </p>}
        <label className="block text-sm font-semibold">
          {requiresReason ? 'Motivo de la decisión' : 'Motivo de la decisión (opcional)'}
          <textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={1000} rows={3} required={requiresReason} readOnly={Boolean(confirmation.retry)}
            className="mt-1 w-full rounded-md border border-gray-300 bg-white p-2 text-base dark:border-gray-600 dark:bg-gray-800" />
        </label>
        {sensitive && <label className="flex min-h-11 items-start gap-2 text-sm">
          <input type="checkbox" checked={reviewed} onChange={(event) => setReviewed(event.target.checked)} required className="mt-1 h-4 w-4" />
          Revisé el alcance y el riesgo de esta solicitud.
        </label>}
        {sensitive && <label className="block text-sm font-semibold">
          Contraseña actual
          <input type="password" autoComplete="current-password" value={password} maxLength={1024} required
            onChange={(event) => setPassword(event.target.value)}
            className="mt-1 min-h-11 w-full rounded-md border border-gray-300 bg-white p-2 text-base dark:border-gray-600 dark:bg-gray-800" />
        </label>}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" ref={cancel} className={secondary} onClick={onCancel}>Volver</button>
          <button type="submit" className={primary} disabled={(requiresReason && !reason.trim()) || (sensitive && (!reviewed || !password))}>
            {decisions[confirmation.decision].confirm}
          </button>
        </div>
      </form>
    </dialog>
  );
}

export default function ApprovalDetail({ id, tenantId, session, canReauthenticate, queueLocation }: {
  id: string; tenantId: string; session: string; canReauthenticate: boolean; queueLocation: string;
}) {
  const [approval, setApproval] = useState<Approval>();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState<Notice>();
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const [attempt, setAttempt] = useState(() => scopedAttempts(session)?.get(id));
  const [working, setWorking] = useState(false);
  const [deadlineReached, setDeadlineReached] = useState(false);
  const request = useRef<AbortController>(null);
  const lock = useRef(false);
  const mounted = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const sensitive = approval ? isSensitiveApproval(approval.risk) : false;
  const canReview = approval?.status === 'pending' && !deadlineReached && !loading && !loadError && !working && (!sensitive || canReauthenticate);

  const forget = useCallback((intent: DecisionIntent) => {
    const scope = scopedAttempts(session);
    if (scope?.get(id)?.key === intent.key) scope.delete(id);
    setAttempt((current) => current?.key === intent.key ? undefined : current);
  }, [id, session]);

  const refresh = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setLoadError('');
    try {
      const current = await readApproval(id, tenantId, controller.signal);
      if (controller.signal.aborted || currentApprovalSession() !== session) return;
      setApproval((previous) => previous && previous.policyVersion > current.policyVersion ? previous : current);
      const unresolved = scopedAttempts(session)?.get(id);
      if (!unresolved) return;
      if (current.status !== 'pending') {
        forget(unresolved);
        setNotice({ tone: 'success', message: 'Estado consultado en el servidor · ' + approvalStatuses[current.status] });
      } else if (current.policyVersion > unresolved.expectedVersion) {
        forget(unresolved);
        setNotice({ tone: 'error', message: 'La solicitud tiene una versión más reciente. Revisa el detalle antes de tomar una decisión.' });
      } else if (current.policyVersion === unresolved.expectedVersion) {
        setNotice({ tone: 'uncertain', message: 'El servidor sigue mostrando la solicitud pendiente. Puedes reintentar la misma decisión.' });
      }
    } catch (cause) {
      if (!controller.signal.aborted && currentApprovalSession() === session) {
        const status = approvalHttpStatus(cause);
        if (status === 403 || status === 404) setApproval(undefined);
        setLoadError(approvalProblem(cause, 'No pudimos cargar el estado de esta solicitud.'));
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [forget, id, session, tenantId]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
      request.current?.abort();
    };
  }, [refresh]);

  useEffect(() => {
    if (approval) heading.current?.focus();
  }, [approval]);

  const expiresAt = approval?.expiresAt;
  const status = approval?.status;
  useEffect(() => {
    if (!expiresAt || status !== 'pending') {
      setDeadlineReached(false);
      return;
    }
    const deadline = Date.parse(expiresAt);
    let timer: ReturnType<typeof setTimeout> | undefined;
    function checkDeadline() {
      const remaining = deadline - Date.now();
      if (remaining > 0) {
        setDeadlineReached(false);
        timer = setTimeout(checkDeadline, Math.min(remaining, 2_147_483_647));
        return;
      }
      setDeadlineReached(true);
      setConfirmation(undefined);
      if (!lock.current) void refresh();
    }
    checkDeadline();
    return () => clearTimeout(timer);
  }, [expiresAt, status, refresh]);

  useEffect(() => {
    if (deadlineReached) heading.current?.focus();
  }, [deadlineReached]);

  async function submit(intent: DecisionIntent, password?: string) {
    if (!canReview || !approval || lock.current || currentApprovalSession() !== session ||
        intent.expectedVersion !== approval.policyVersion || (sensitive && !password)) return;
    if (Date.parse(approval.expiresAt) <= Date.now()) {
      setDeadlineReached(true);
      setConfirmation(undefined);
      void refresh();
      return;
    }
    lock.current = true;
    setConfirmation(undefined);
    setWorking(true);
    setNotice(undefined);
    scopedAttempts(session)?.set(id, intent);
    setAttempt(intent);
    try {
      const result = await decideApproval(intent, session, password);
      if (currentApprovalSession() !== session) return;
      forget(intent);
      setApproval((current) => current && { ...current, status: result.status, decidedAt: result.decidedAt, policyVersion: intent.expectedVersion + 1 });
      setNotice({ tone: 'success', message: result.status === 'approved' ? 'La aprobación se registró.' : 'El rechazo se registró.' });
    } catch (cause) {
      if (currentApprovalSession() !== session) return;
      const status = approvalHttpStatus(cause);
      if (status && status >= 400 && status < 500) {
        forget(intent);
        setNotice({ tone: 'error', message: approvalProblem(cause, 'El servidor rechazó la decisión.') });
      } else {
        setNotice({ tone: 'uncertain', message: 'No pudimos confirmar la decisión. Estamos consultando el estado registrado.' });
      }
    } finally {
      if (mounted.current && currentApprovalSession() === session) await refresh();
      lock.current = false;
      setWorking(false);
    }
  }

  function confirm(reason?: string, password?: string) {
    if (!confirmation || !approval || confirmation.expectedVersion !== approval.policyVersion) return;
    if (confirmation.retry) {
      if (attempt === confirmation.retry) void submit(attempt, password);
      return;
    }
    if (attempt) return;
    const key = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
    void submit({ approvalId: id, decision: confirmation.decision, expectedVersion: confirmation.expectedVersion, key, reason }, password);
  }

  return (
    <div className="space-y-4">
      <Link to={queueLocation} state={{ focusApprovalId: id }} className={secondary}><ArrowLeft size={16} aria-hidden="true" /> Volver a la cola</Link>
      {loadError && <p role="alert" className={panel + ' text-sm text-red-800 dark:text-red-300'}>{loadError}</p>}
      {notice && <p role={notice.tone === 'success' ? 'status' : 'alert'}
        className={panel + (notice.tone === 'success' ? ' text-sm text-emerald-800 dark:text-emerald-300' : ' text-sm text-amber-900 dark:text-amber-200')}>{notice.message}</p>}
      {loading && !approval && <p role="status" className={subtext}>Cargando solicitud…</p>}
      {deadlineReached && approval?.status === 'pending' && <p role="status" className={subtext}>
        Se alcanzó el vencimiento. Consulta el estado del servidor antes de continuar.
      </p>}
      {approval && (
        <>
          <header className="space-y-1">
            <h2 ref={heading} tabIndex={-1} className="break-words text-2xl font-semibold">{approval.details?.toolName || 'Solicitud de aprobación'}</h2>
            <p className={subtext + ' break-all'}>Solicitud {approval.id}</p>
          </header>
          <dl className={panel + ' grid grid-cols-2 gap-3 text-sm sm:grid-cols-4'}>
            <div><dt className={subtext}>Estado</dt><dd className="font-semibold">{approvalStatuses[approval.status]}</dd></div>
            <div><dt className={subtext}>Riesgo</dt><dd className="font-semibold">{riskLabels[approval.risk]}</dd></div>
            <div><dt className={subtext}>Versión</dt><dd className="font-semibold">{approval.policyVersion}</dd></div>
            <div><dt className={subtext}>Vencimiento</dt><dd><time dateTime={approval.expiresAt}>{approvalDate(approval.expiresAt)}</time></dd></div>
            {approval.decidedAt && <div><dt className={subtext}>Fecha de decisión</dt><dd><time dateTime={approval.decidedAt}>{approvalDate(approval.decidedAt)}</time></dd></div>}
            {approval.runId && <div className="min-w-0"><dt className={subtext}>Ejecución</dt><dd className="break-all">{approval.runId}</dd></div>}
            {approval.nodeId && <div className="min-w-0"><dt className={subtext}>Nodo</dt><dd className="break-all">{approval.nodeId}</dd></div>}
          </dl>
          {approval.details && <section className={panel + ' space-y-2'} aria-labelledby="approval-parameters">
            <h3 id="approval-parameters" className="flex items-center gap-2 font-semibold"><LockKeyhole size={16} aria-hidden="true" /> Parámetros redactados</h3>
            <p className={subtext + ' break-words'}>{approval.details.summary}</p>
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-md bg-gray-50 p-3 text-xs dark:bg-gray-800">{JSON.stringify(approval.details.parametersRedacted, null, 2)}</pre>
          </section>}
        </>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => { setNotice(undefined); void refresh(); }} disabled={loading || working} className={secondary}>
          <RefreshCw size={16} aria-hidden="true" /> Actualizar estado
        </button>
        {approval && canReview && !attempt && (['approved', 'rejected'] as const).map((decision) => (
          <button key={decision} type="button" onClick={() => setConfirmation({ decision, expectedVersion: approval.policyVersion })}
            className={decision === 'approved' ? primary : secondary}>{decisions[decision].label}</button>
        ))}
        {canReview && attempt && attempt.expectedVersion === approval?.policyVersion && (
          <button type="button" onClick={() => sensitive
            ? setConfirmation({ decision: attempt.decision, expectedVersion: attempt.expectedVersion, retry: attempt })
            : void submit(attempt)} className={primary}>Reintentar la misma decisión</button>
        )}
      </div>
      {approval?.status === 'pending' && sensitive && !canReauthenticate && (
        <p role="status" className={subtext}>Este servidor todavía no ofrece verificación para decisiones sensibles.</p>
      )}
      {attempt && canReview && <p className={subtext}>El reintento conserva la decisión, el motivo y la versión revisada.</p>}
      {working && <p role="status" className={subtext}>Comprobando la decisión en el servidor…</p>}
      {approval && confirmation && canReview && <DecisionDialog approval={approval} confirmation={confirmation}
        onCancel={() => setConfirmation(undefined)} onConfirm={confirm} />}
    </div>
  );
}
