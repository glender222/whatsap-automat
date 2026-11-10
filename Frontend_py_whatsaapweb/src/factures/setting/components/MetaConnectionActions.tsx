import { useEffect, useRef, useState } from 'react';
import { CompanyService, type ConnectionHealth, type MetaConnectionDiagnostic } from '../services/companyService';

function healthMessage(health: ConnectionHealth): string {
  if (health.authorized) return 'Acceso a la línea confirmado por Meta.';
  switch (health.lastErrorCode) {
    case 'VALIDATION_REQUIRED': return 'La credencial está guardada. Comprueba el acceso a la línea.';
    case 'CONNECTION_INACTIVE': return 'La conexión está desconectada.';
    case 'META_AUTH_ERROR': return 'La credencial de Meta venció o fue revocada. Guarda un token autorizado y vuelve a comprobar.';
    case 'META_PERMISSION_ERROR': return 'La credencial no tiene permiso para esta línea. Revisa los permisos y guarda un token autorizado.';
    case 'META_ACCOUNT_MISMATCH': return 'La credencial no corresponde a esta línea. Revisa el ID y guarda un token autorizado.';
    case 'META_PROVIDER_UNAVAILABLE': return 'Meta no está disponible. Vuelve a comprobar la conexión.';
    case 'CHECK_SUPERSEDED': return 'La conexión cambió durante la comprobación. Actualiza el diagnóstico y vuelve a comprobar.';
    default: return 'Guarda una credencial autorizada para comprobar la conexión.';
  }
}

export default function MetaConnectionActions({ companyId, sessionGeneration, connectionRevision, phoneNumberId, version, canManage, disabled, onBusyChange, onChanged }: {
  companyId: number;
  sessionGeneration: number;
  connectionRevision: number;
  phoneNumberId: string | null;
  version: string;
  canManage: boolean;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
  onChanged?: () => Promise<void> | void;
}) {
  const [attempt, setAttempt] = useState(0);
  const query = `${companyId}/${phoneNumberId}/${version}/${connectionRevision}/${attempt}`;
  const [response, setResponse] = useState<{ query: string; connection?: MetaConnectionDiagnostic | null; error?: string }>();
  const [working, setWorking] = useState<'check' | 'disconnect' | null>(null);
  const [operationNotice, setNotice] = useState<{ revision: number; error: boolean; message: string }>();
  const notice = operationNotice?.revision === connectionRevision ? operationNotice : undefined;
  const [confirming, setConfirming] = useState(false);
  const operation = useRef<AbortController | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const disconnectButton = useRef<HTMLButtonElement>(null);
  const current = response?.query === query ? response : undefined;
  const connection = current?.connection;
  const health = connection?.health;
  const blocked = disabled || working !== null;

  useEffect(() => {
    const controller = new AbortController();
    if (!phoneNumberId) {
      setResponse({ query, connection: null });
    } else {
      CompanyService.getConnectionDiagnostic(companyId, phoneNumberId, controller.signal).then((value) => {
        if (!controller.signal.aborted) setResponse({ query, connection: value });
      }).catch(() => {
        if (!controller.signal.aborted) setResponse({ query, error: 'No pudimos leer el diagnóstico. Vuelve a cargarlo.' });
      });
    }
    return () => controller.abort();
  }, [companyId, phoneNumberId, query]);

  useEffect(() => () => { operation.current?.abort(); onBusyChange(false); }, [onBusyChange]);
  useEffect(() => {
    if (!confirming || !dialog.current) return;
    dialog.current.showModal();
    cancel.current?.focus();
  }, [confirming]);

  function closeDialog() {
    dialog.current?.close();
    setConfirming(false);
    disconnectButton.current?.focus();
  }

  async function run(kind: 'check' | 'disconnect') {
    if (!canManage || blocked || operation.current || (kind === 'check' && !connection)) return;
    const controller = new AbortController();
    operation.current = controller;
    setWorking(kind);
    onBusyChange(true);
    setNotice(undefined);
    try {
      if (kind === 'check' && connection) {
        const checked = await CompanyService.checkConnection(connection.id, controller.signal);
        if (!controller.signal.aborted) setResponse({ query, connection: { ...connection, health: checked } });
      } else {
        await CompanyService.disconnectWhatsAppConnection(sessionGeneration, controller.signal);
        if (controller.signal.aborted) return;
        dialog.current?.close();
        setConfirming(false);
        requestAnimationFrame(() => heading.current?.focus());
        setNotice({ revision: connectionRevision, error: false, message: 'Conexión desconectada para esta empresa.' });
        setAttempt((value) => value + 1);
        await onChanged?.();
      }
    } catch {
      if (!controller.signal.aborted) setNotice({ revision: connectionRevision, error: true, message: kind === 'check'
        ? 'No pudimos completar el diagnóstico. Actualiza el estado y vuelve a comprobar.'
        : 'No pudimos confirmar la desconexión. Actualiza la conexión antes de volver a intentar.' });
    } finally {
      if (operation.current === controller) operation.current = null;
      if (!controller.signal.aborted) { setWorking(null); onBusyChange(false); }
    }
  }

  const healthError = health && !health.authorized && !['VALIDATION_REQUIRED', 'CONNECTION_INACTIVE',
    'META_ACCOUNT_NOT_CONNECTED', 'META_CREDENTIAL_MISSING', 'META_ACCOUNT_VERIFICATION_REQUIRED'].includes(health.lastErrorCode ?? '');

  return (
    <section aria-labelledby="whatsapp-connection-diagnostic" className="mt-4 space-y-3 rounded-lg border border-subtle p-4">
      <h3 ref={heading} tabIndex={-1} id="whatsapp-connection-diagnostic" className="text-sm font-semibold text-primary">Diagnóstico de conexión</h3>
      {!current && <p role="status" className="text-sm text-secondary">Cargando diagnóstico…</p>}
      {current?.error && <p role="alert" className="text-sm text-red-700 dark:text-red-300">{current.error}</p>}
      {current && !current.error && !connection && <p className="text-sm text-secondary">Guarda una conexión para comprobar el acceso a la línea.</p>}
      {health && <p role={healthError ? 'alert' : 'status'} className={healthError ? 'text-sm text-red-700 dark:text-red-300' : 'text-sm text-secondary'}>{healthMessage(health)}</p>}
      {health?.lastCheckedAt && <p className="text-xs text-secondary">Última comprobación: {new Date(health.lastCheckedAt).toLocaleString('es')}</p>}
      {!canManage && <p className="text-sm text-secondary">Solo un administrador puede gestionar esta conexión.</p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" className="admin-button-secondary" disabled={blocked}
          onClick={() => { setNotice(undefined); setAttempt((value) => value + 1); void onChanged?.(); }}>Actualizar diagnóstico</button>
        {canManage && <>
          <button type="button" className="admin-button-secondary" disabled={blocked || !health?.configured}
            onClick={() => void run('check')}>{working === 'check' ? 'Comprobando…' : 'Comprobar conexión'}</button>
          <button ref={disconnectButton} type="button" className="admin-button-secondary"
            disabled={blocked || !phoneNumberId || health?.lastErrorCode === 'CONNECTION_INACTIVE'}
            onClick={() => setConfirming(true)}>Desconectar WhatsApp</button>
        </>}
      </div>
      {notice && <p role={notice.error ? 'alert' : 'status'} className={notice.error ? 'text-sm text-red-700 dark:text-red-300' : 'text-sm text-secondary'}>{notice.message}</p>}
      {confirming && <dialog ref={dialog} aria-labelledby="whatsapp-disconnect-title" aria-describedby="whatsapp-disconnect-effect"
        className="w-[calc(100%-2rem)] max-w-md rounded-xl border border-subtle bg-surface p-5 text-primary shadow-xl backdrop:bg-slate-950/50"
        onCancel={(event) => { event.preventDefault(); if (!working) closeDialog(); }}>
        <h3 id="whatsapp-disconnect-title" className="font-semibold">Desconectar WhatsApp de esta empresa</h3>
        <p id="whatsapp-disconnect-effect" className="mt-2 text-sm text-secondary">Se eliminará la credencial guardada y se detendrá el acceso de esta empresa a WhatsApp. Para recuperar la conexión tendrás que guardar un token autorizado.</p>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <button ref={cancel} type="button" className="admin-button-secondary" disabled={working !== null} onClick={closeDialog}>Cancelar</button>
          <button type="button" className="admin-button-secondary" disabled={working !== null} onClick={() => void run('disconnect')}>
            {working === 'disconnect' ? 'Desconectando…' : 'Desconectar'}
          </button>
        </div>
        {notice?.error && <p role="alert" className="mt-3 text-sm text-red-700 dark:text-red-300">{notice.message}</p>}
      </dialog>}
    </section>
  );
}
