import { useEffect, useRef, useState } from 'react';
import {
  campaignError, isDispatchableStatus, reviewCampaignDispatch, type CampaignSummary, type DispatchReview,
} from './campaignApi';

interface Props {
  campaign: CampaignSummary;
  onCancel: () => void;
  onConfirm: (review: DispatchReview) => void;
}

export default function CampaignDispatchDialog({ campaign, onCancel, onConfirm }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const [review, setReview] = useState<DispatchReview>();
  const [error, setError] = useState('');

  useEffect(() => {
    const element = dialog.current;
    const previousFocus = document.activeElement;
    element?.showModal();
    cancelButton.current?.focus();
    return () => {
      element?.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);

  useEffect(() => {
    const request = new AbortController();
    reviewCampaignDispatch(campaign.id, request.signal)
      .then((result) => { if (!request.signal.aborted) setReview(result); })
      .catch((cause) => {
        if (!request.signal.aborted) setError(campaignError(cause, 'No pudimos comprobar la audiencia.'));
      });
    return () => request.abort();
  }, [campaign.id]);

  const dispatchable = Boolean(review && isDispatchableStatus(review.campaignStatus) &&
    !review.limitExceeded && review.unattemptedCount > 0 && (review.templateName || review.contentBody?.trim()));

  return (
    <dialog
      ref={dialog}
      aria-labelledby="dispatch-title"
      aria-describedby="dispatch-description"
      onCancel={(event) => { event.preventDefault(); onCancel(); }}
      className="fixed left-1/2 top-1/2 m-0 max-h-[85dvh] w-[calc(100%_-_2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-gray-200 bg-white p-0 text-gray-900 shadow-xl backdrop:bg-gray-950/50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
    >
      <div className="space-y-4 p-4 sm:p-6">
        <header>
          <h2 id="dispatch-title" className="text-xl font-semibold">Revisar envío por WhatsApp</h2>
          <p id="dispatch-description" className="mt-1 break-words text-sm text-gray-600 dark:text-gray-300">{campaign.name}</p>
        </header>
        {error ? (
          <p role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</p>
        ) : review ? (
          <div className="space-y-3 text-sm">
            <dl className="grid gap-3 rounded-lg bg-gray-50 p-3 dark:bg-gray-800">
              <div>
                <dt className="font-semibold">Audiencia</dt>
                <dd className="break-words">{review.segmentName ?? 'Sin segmento'}</dd>
                <dd>{review.limitExceeded
                  ? `Más de ${review.audienceLimit} números. Reduce el segmento antes de enviar.`
                  : `${review.unattemptedCount} números de WhatsApp por procesar`}</dd>
              </div>
              <div className="min-w-0">
                <dt className="font-semibold">{review.templateName ? 'Plantilla aprobada requerida' : 'Mensaje'}</dt>
                <dd className="whitespace-pre-wrap break-words">{review.templateName
                  ? `${review.templateName}${review.templateLanguage ? ` · ${review.templateLanguage}` : ''}`
                  : review.contentBody || 'Sin contenido'}</dd>
              </div>
            </dl>
            <p>El sistema vuelve a comprobar la audiencia y el consentimiento al enviar. El proveedor puede aceptar menos mensajes que el total revisado.</p>
            {!isDispatchableStatus(review.campaignStatus) && <p role="status">La campaña cambió de estado. Actualiza el listado.</p>}
            {!review.limitExceeded && review.unattemptedCount === 0 && <p role="status">No hay números pendientes de procesar.</p>}
          </div>
        ) : <p role="status" className="text-sm">Comprobando la audiencia…</p>}
        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <button ref={cancelButton} type="button" onClick={onCancel}
            className="min-h-11 rounded-md border border-gray-300 px-4 text-sm font-semibold hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-800">
            Cancelar
          </button>
          <button type="button" disabled={!dispatchable} onClick={() => { if (review && dispatchable) onConfirm(review); }}
            className="min-h-11 rounded-md bg-emerald-700 px-4 text-sm font-semibold text-white hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-50">
            Confirmar envío
          </button>
        </div>
      </div>
    </dialog>
  );
}
