import { Hand, RefreshCw } from 'lucide-react';
import type { CanonicalComposer } from '../hooks/useCanonicalComposer';

const buttonClass = 'inline-flex min-h-10 items-center gap-2 rounded-md border border-subtle px-2 text-xs font-semibold hover:bg-canvas disabled:opacity-55';

export default function CanonicalSendStatus({ composer }: { composer: CanonicalComposer }) {
  const { conversation, error, loading, phase, notice, windowOpen, owns, assignedElsewhere, unresolved } = composer;
  let message = '';
  if (phase === 'takeover') message = 'Confirmando la toma de control…';
  else if (phase === 'send') message = 'Esperando confirmación de WhatsApp…';
  else if (error) message = error;
  else if (unresolved) message = notice?.tone === 'unknown' ? notice.message : 'Hay un envío sin confirmar. Actualiza el estado para comprobar si llegó una confirmación.';
  else if (loading) message = 'Verificando la conversación…';
  else if (composer.canSendLegacyAttachment) message = 'Puedes adjuntar archivos en esta conversación.';
  else if (!conversation || conversation.channel !== 'whatsapp-cloud') message = 'El envío de texto requiere una conversación de WhatsApp Cloud verificada.';
  else if (conversation.status !== 'open') message = 'La conversación está cerrada.';
  else if (!windowOpen) message = 'Ventana de atención de 24 horas cerrada.';
  else if (assignedElsewhere) message = 'La conversación está asignada a otra persona.';
  else if (!owns) message = 'Toma el control con tu sesión para responder.';
  else message = 'Tienes el control de esta conversación.';

  return (
    <div className="space-y-1 border-t border-subtle bg-surface px-3 py-2 text-xs sm:px-4">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <p role={error || unresolved ? 'alert' : 'status'} className={error || unresolved ? 'text-amber-800 dark:text-amber-200' : 'text-secondary'}>{message}</p>
        <div className="flex flex-wrap gap-2">
          {composer.canTakeover && <button type="button" aria-label="Tomar control" onClick={() => void composer.takeover()} className={buttonClass}>
            <Hand size={14} aria-hidden="true" /> Tomar control
          </button>}
          {(conversation || error || unresolved) && (
            <button type="button" disabled={Boolean(phase || loading)} onClick={composer.refresh} className={buttonClass}>
              <RefreshCw size={14} aria-hidden="true" /> Actualizar estado
            </button>
          )}
          {composer.canRetryExact && <button type="button" onClick={() => void composer.retryExact()} className={buttonClass}>
              Reintentar el mismo envío
          </button>}
        </div>
      </div>
      {!phase && notice && notice.tone !== 'unknown' && (
        <p role={notice.tone === 'error' ? 'alert' : 'status'}
          className={notice.tone === 'error' ? 'font-medium text-red-700 dark:text-red-300' : 'font-medium text-emerald-800 dark:text-emerald-300'}>
          {notice.message}
        </p>
      )}
    </div>
  );
}
