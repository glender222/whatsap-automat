import { useEffect, useRef, useState } from 'react';
import {
  createWorkflowWebhook, disableWorkflowWebhook, webhookUrl, workflowDate, workflowError, type WorkflowWebhook,
} from './workflowApi';

const buttonClass = 'min-h-11 rounded-md border border-gray-300 px-3 text-sm font-semibold disabled:opacity-55 dark:border-gray-600';

export default function WorkflowWebhooksPanel({ workflowId, published, webhooks, refresh }: {
  workflowId: string; published: boolean; webhooks: WorkflowWebhook[]; refresh: () => void;
}) {
  const [secret, setSecret] = useState<Awaited<ReturnType<typeof createWorkflowWebhook>>>();
  const [visible, setVisible] = useState(false);
  const [confirmation, setConfirmation] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error?: boolean }>();
  const lock = useRef(false);
  const cancelDeactivation = useRef<HTMLButtonElement>(null);
  const actionNotice = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (confirmation) cancelDeactivation.current?.focus();
  }, [confirmation]);

  useEffect(() => {
    if (notice) actionNotice.current?.focus();
  }, [notice]);

  function cancelDeactivationReview() {
    const buttonId = `disable-${confirmation}`;
    setConfirmation(undefined);
    requestAnimationFrame(() => document.getElementById(buttonId)?.focus());
  }

  async function create() {
    if (lock.current || !published) return;
    lock.current = true;
    setBusy(true);
    setNotice(undefined);
    try {
      const webhook = await createWorkflowWebhook(workflowId);
      setSecret(webhook);
      setVisible(false);
      refresh();
    } catch (cause) {
      setNotice({ error: true, text: workflowError(cause, 'No pudimos confirmar la creación. Actualiza la ficha antes de reintentar.') });
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  async function disable(triggerId: string) {
    if (lock.current || confirmation !== triggerId) return;
    lock.current = true;
    setBusy(true);
    setNotice(undefined);
    try {
      await disableWorkflowWebhook(workflowId, triggerId);
      if (secret?.id === triggerId) {
        setSecret(undefined);
        setVisible(false);
      }
      setConfirmation(undefined);
      setNotice({ text: 'Webhook desactivado.' });
      refresh();
    } catch (cause) {
      setNotice({ error: true, text: workflowError(cause, 'No pudimos confirmar la desactivación. Actualiza la ficha antes de reintentar.') });
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  async function copy(value: string, success: string) {
    try {
      await navigator.clipboard.writeText(value);
      setNotice({ text: success });
    } catch {
      setNotice({ error: true, text: 'El navegador no permitió copiar. Puedes seleccionar el valor y copiarlo manualmente.' });
    }
  }

  return (
    <section className="space-y-3 rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900" aria-labelledby="workflow-webhooks">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id="workflow-webhooks" className="text-lg font-semibold">Webhooks</h2>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">Los eventos nuevos quedan vinculados a la revisión activa al recibirlos.</p>
        </div>
        <button type="button" disabled={!published || busy || Boolean(secret)} onClick={create} className={buttonClass}>Crear webhook</button>
      </div>
      {!published && <p className="text-sm">Publica una revisión para crear un webhook.</p>}
      {secret && (
        <div className="space-y-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3 dark:border-emerald-800 dark:bg-emerald-950">
          <p role="status" className="text-sm font-medium">Webhook creado. Guarda el token antes de cerrar este panel.</p>
          <label className="block space-y-1 text-sm">
            <span>URL para solicitudes POST</span>
            <input readOnly value={webhookUrl(secret.endpointKey)} className="min-h-11 w-full rounded-md border border-gray-300 bg-white px-2 font-mono text-xs dark:border-gray-600 dark:bg-gray-900" />
          </label>
          <label className="block space-y-1 text-sm">
            <span>Token para el encabezado <code>x-webhook-token</code></span>
            <input type={visible ? 'text' : 'password'} readOnly autoComplete="off" value={secret.token}
              className="min-h-11 w-full rounded-md border border-gray-300 bg-white px-2 font-mono text-xs dark:border-gray-600 dark:bg-gray-900" />
          </label>
          <p className="text-sm">El token se muestra una sola vez. Usa <code>Idempotency-Key</code> con un valor único por evento.</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => copy(webhookUrl(secret.endpointKey), 'URL copiada.')} className={buttonClass}>Copiar URL</button>
            <button type="button" onClick={() => setVisible((value) => !value)} className={buttonClass}>{visible ? 'Ocultar token' : 'Mostrar token'}</button>
            <button type="button" onClick={() => copy(secret.token, 'Token copiado.')} className={buttonClass}>Copiar token</button>
            <button type="button" onClick={() => { setSecret(undefined); setVisible(false); }} className={buttonClass}>Cerrar token</button>
          </div>
        </div>
      )}
      {notice && <p ref={actionNotice} tabIndex={-1} role={notice.error ? 'alert' : 'status'} className="text-sm">{notice.text}</p>}
      {webhooks.length ? (
        <ul className="divide-y divide-gray-200 rounded-lg border border-gray-200 dark:divide-gray-700 dark:border-gray-700">
          {webhooks.map((webhook) => (
            <li key={webhook.id} className="min-w-0 space-y-2 p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{webhook.isActive ? 'Activo' : 'Desactivado'} · {workflowDate(webhook.createdAt)}</p>
                  <p className="mt-1 break-all font-mono text-xs text-gray-600 dark:text-gray-300">{webhookUrl(webhook.endpointKey)}</p>
                </div>
                {webhook.isActive && confirmation !== webhook.id && <button id={`disable-${webhook.id}`} type="button" disabled={busy} onClick={() => setConfirmation(webhook.id)} className={buttonClass}>Desactivar</button>}
              </div>
              {confirmation === webhook.id && (
                <div className="space-y-2 rounded-md bg-gray-50 p-3 text-sm dark:bg-gray-800">
                  <p>¿Desactivar este webhook? Las solicitudes nuevas dejarán de iniciar ejecuciones.</p>
                  <div className="flex flex-wrap gap-2">
                    <button ref={cancelDeactivation} type="button" disabled={busy} onClick={cancelDeactivationReview} className={buttonClass}>Cancelar</button>
                    <button type="button" disabled={busy} onClick={() => disable(webhook.id)} className={buttonClass}>Confirmar desactivación</button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : <p className="text-sm text-gray-600 dark:text-gray-300">Todavía no hay webhooks para este workflow.</p>}
    </section>
  );
}
