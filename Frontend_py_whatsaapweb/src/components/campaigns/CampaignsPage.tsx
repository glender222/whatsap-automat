import { useEffect, useState } from 'react';
import { Plus, Send } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import { campaignError, channelLabel, listCampaigns } from './campaignApi';

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

export default function CampaignsPage() {
  const { state } = useLocation();
  const [campaigns, setCampaigns] = useState<Awaited<ReturnType<typeof listCampaigns>>>();
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const request = new AbortController();
    listCampaigns(request.signal)
      .then((items) => { if (!request.signal.aborted) setCampaigns(items); })
      .catch((cause) => {
        if (!request.signal.aborted) setError(campaignError(cause, 'No se pudo cargar el listado de campañas.'));
      });
    return () => request.abort();
  }, [attempt]);

  return (
    <section className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6" aria-labelledby="campaigns-title">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 id="campaigns-title" className="text-2xl font-semibold">Campañas</h1>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">Consulta campañas y prepara borradores de difusión.</p>
        </div>
        <Link to="/dashboard/campanas/nueva" className="inline-flex items-center gap-2 rounded-md bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800">
          <Plus size={16} /> Nuevo borrador
        </Link>
      </header>
      {campaigns?.some(({ id }) => id === state?.createdDraftId) && (
        <p role="status" className="rounded-md bg-emerald-50 px-4 py-3 text-sm text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200">El borrador ya aparece en el listado.</p>
      )}
      {error ? (
        <div role="alert" className="rounded-md border border-red-200 p-4 text-sm text-red-700 dark:border-red-800 dark:text-red-300">
          <p>{error}</p>
          <button type="button" className="mt-2 underline" onClick={() => { setError(''); setAttempt((value) => value + 1); }}>Volver a intentar</button>
        </div>
      ) : campaigns === undefined ? (
        <p role="status" className="text-sm text-gray-600 dark:text-gray-300">Cargando campañas…</p>
      ) : campaigns.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-300 p-6 text-sm text-gray-600 dark:border-gray-600 dark:text-gray-300">
          <Send className="mb-3 text-emerald-700 dark:text-emerald-300" size={22} />
          Todavía no hay campañas en este espacio.
        </div>
      ) : (
        <ul className="divide-y divide-gray-200 rounded-xl border border-gray-200 bg-white dark:divide-gray-700 dark:border-gray-700 dark:bg-gray-900">
          {campaigns.map((campaign) => (
            <li key={campaign.id} className="flex items-center justify-between gap-4 px-4 py-3">
              <div className="min-w-0">
                <h2 className="break-words font-medium">{campaign.name}</h2>
                <p className="text-sm text-gray-600 dark:text-gray-300">{channelLabel(campaign.channel)}</p>
              </div>
              <span className="shrink-0 rounded-full bg-gray-100 px-3 py-1 text-xs font-medium dark:bg-gray-800">{statusLabels[campaign.status] ?? campaign.status}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
