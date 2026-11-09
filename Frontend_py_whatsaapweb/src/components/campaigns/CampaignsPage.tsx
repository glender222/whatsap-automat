import { useEffect, useRef, useState } from 'react';
import { useAtomValue } from 'jotai';
import { Plus, RefreshCw, Send } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import { userRoleAtom } from '../../jotai/middleware/userRoleAtom';
import CampaignDispatchDialog from './CampaignDispatchDialog';
import {
  campaignError, channelLabel, dispatchCampaign, isDispatchableStatus, listCampaigns,
  type CampaignSummary, type DispatchReview,
} from './campaignApi';

const statusLabels: Record<string, string> = {
  draft: 'Borrador',
  scheduled: 'Programada',
  queued: 'En cola',
  dispatching: 'En curso',
  paused: 'Pausada',
  completed: 'Completada',
  cancelled: 'Cancelada',
  failed: 'Con errores',
};

function dispatchResult(campaign: CampaignSummary) {
  if (campaign.status === 'queued' || campaign.status === 'dispatching') {
    return 'El servidor registró el despacho. La aceptación de WhatsApp se confirma al finalizar.';
  }
  if (campaign.status === 'paused') return 'El despacho quedó pausado. Consulta el resultado en el listado.';
  if (campaign.status === 'failed') return 'El despacho terminó con errores. Consulta el resultado en el listado.';
  return 'El despacho terminó. Consulta los mensajes aceptados, excluidos y fallidos en el listado.';
}

export default function CampaignsPage() {
  const { state } = useLocation();
  const isAdmin = useAtomValue(userRoleAtom) === 'ADMIN';
  const [campaigns, setCampaigns] = useState<Awaited<ReturnType<typeof listCampaigns>>>();
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [reviewing, setReviewing] = useState<CampaignSummary>();
  const [dispatching, setDispatching] = useState<string>();
  const dispatchLock = useRef(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean }>();
  const hasActiveDispatch = Boolean(dispatching || campaigns?.some(({ status }) => status === 'dispatching'));

  useEffect(() => {
    const request = new AbortController();
    listCampaigns(request.signal)
      .then((items) => {
        if (!request.signal.aborted) {
          setCampaigns(items);
          setError('');
        }
      })
      .catch((cause) => {
        if (!request.signal.aborted) setError(campaignError(cause, 'No se pudo cargar el listado de campañas.'));
      });
    return () => request.abort();
  }, [attempt]);

  useEffect(() => {
    if (!hasActiveDispatch) return;
    const refresh = window.setInterval(() => setAttempt((value) => value + 1), 4000);
    return () => window.clearInterval(refresh);
  }, [hasActiveDispatch]);

  async function confirmDispatch(review: DispatchReview) {
    if (!isAdmin || dispatchLock.current) return;
    dispatchLock.current = true;
    setReviewing(undefined);
    setDispatching(review.campaignId);
    setNotice({ text: 'Esperando el resultado del despacho…', error: false });
    try {
      const campaign = await dispatchCampaign(review.campaignId, review.reviewKey);
      setCampaigns((items) => items?.map((item) => item.id === campaign.id ? campaign : item));
      setNotice({ text: dispatchResult(campaign), error: campaign.status === 'failed' });
    } catch (cause) {
      setNotice({ text: campaignError(cause, 'No pudimos confirmar el resultado. Actualiza el listado antes de reintentar.'), error: true });
    } finally {
      dispatchLock.current = false;
      setDispatching(undefined);
      setAttempt((value) => value + 1);
    }
  }

  return (
    <section className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6" aria-labelledby="campaigns-title">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 id="campaigns-title" className="text-2xl font-semibold">Campañas</h1>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">Prepara campañas y consulta el resultado de los envíos por WhatsApp.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="inline-flex min-h-11 items-center gap-2 rounded-md border border-gray-300 px-3 text-sm font-semibold dark:border-gray-600"
            onClick={() => setAttempt((value) => value + 1)}>
            <RefreshCw size={16} /> Actualizar
          </button>
          <Link to="/dashboard/campanas/nueva" className="inline-flex min-h-11 items-center gap-2 rounded-md bg-emerald-700 px-4 text-sm font-semibold text-white hover:bg-emerald-800">
            <Plus size={16} /> Nuevo borrador
          </Link>
        </div>
      </header>
      {campaigns?.some(({ id }) => id === state?.createdDraftId) && (
        <p role="status" className="rounded-md bg-emerald-50 px-4 py-3 text-sm text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200">El borrador ya aparece en el listado.</p>
      )}
      {notice && <p role={notice.error ? 'alert' : 'status'} className="rounded-lg border border-gray-200 p-3 text-sm dark:border-gray-700">{notice.text}</p>}
      {error && (
        <div role="alert" className="rounded-md border border-red-200 p-4 text-sm text-red-700 dark:border-red-800 dark:text-red-300">
          <p>{error}</p>
          <button type="button" className="mt-2 underline" onClick={() => setAttempt((value) => value + 1)}>Volver a intentar</button>
        </div>
      )}
      {campaigns === undefined ? (
        !error && <p role="status" className="text-sm text-gray-600 dark:text-gray-300">Cargando campañas…</p>
      ) : campaigns.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-300 p-6 text-sm text-gray-600 dark:border-gray-600 dark:text-gray-300">
          <Send className="mb-3 text-emerald-700 dark:text-emerald-300" size={22} />
          Todavía no hay campañas en este espacio.
        </div>
      ) : (
        <ul className="divide-y divide-gray-200 rounded-xl border border-gray-200 bg-white dark:divide-gray-700 dark:border-gray-700 dark:bg-gray-900">
          {campaigns.map((campaign) => (
            <li key={campaign.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <h2 className="break-words font-medium">{campaign.name}</h2>
                <p className="text-sm text-gray-600 dark:text-gray-300">{channelLabel(campaign.channel)}</p>
                {['completed', 'paused', 'failed'].includes(campaign.status) &&
                  typeof campaign.statsDispatched === 'number' && typeof campaign.statsSuppressed === 'number' && typeof campaign.statsFailed === 'number' && (
                    <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
                      El proveedor aceptó {campaign.statsDispatched} · Excluidos {campaign.statsSuppressed} · Fallidos {campaign.statsFailed}
                    </p>
                )}
                {campaign.status === 'paused' && campaign.pauseReason && <p className="mt-1 break-words text-sm">{campaign.pauseReason}</p>}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="shrink-0 rounded-full bg-gray-100 px-3 py-1 text-xs font-medium dark:bg-gray-800">{statusLabels[campaign.status] ?? campaign.status}</span>
                {isAdmin && campaign.channel === 'whatsapp-cloud' && isDispatchableStatus(campaign.status) && (
                  <button type="button" aria-label={`Revisar envío de ${campaign.name}`} aria-haspopup="dialog"
                    aria-disabled={Boolean(dispatching)}
                    onClick={() => { if (!dispatching) setReviewing(campaign); }}
                    className="min-h-11 rounded-md border border-emerald-700 px-3 text-sm font-semibold text-emerald-700 aria-disabled:opacity-50 dark:text-emerald-300">
                    {dispatching === campaign.id ? 'Consultando resultado…' : 'Revisar envío'}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {reviewing && isAdmin && <CampaignDispatchDialog campaign={reviewing} onCancel={() => setReviewing(undefined)} onConfirm={confirmDispatch} />}
    </section>
  );
}
