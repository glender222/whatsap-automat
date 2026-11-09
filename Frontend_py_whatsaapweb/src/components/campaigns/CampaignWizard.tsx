import { useEffect, useState, type FormEvent } from 'react';
import { ArrowLeft, Save } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import {
  campaignError,
  channelLabels,
  createCampaignDraft,
  listSegments,
  type CampaignChannel,
  type CampaignPurpose,
  type SegmentSummary,
} from './campaignApi';

const inputClass = 'w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100';

export default function CampaignWizard() {
  const navigate = useNavigate();
  const [channel, setChannel] = useState<CampaignChannel>('whatsapp-cloud');
  const [segmentId, setSegmentId] = useState('');
  const [segments, setSegments] = useState<SegmentSummary[]>([]);
  const [segmentStatus, setSegmentStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const request = new AbortController();
    listSegments(request.signal)
      .then((items) => {
        if (request.signal.aborted) return;
        setSegments(items);
        setSegmentStatus('ready');
      })
      .catch(() => { if (!request.signal.aborted) setSegmentStatus('error'); });
    return () => request.abort();
  }, []);

  const availableSegments = segments.filter((segment) => segment.targetChannel === channel || segment.targetChannel === 'any');

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const name = String(values.get('name') ?? '').trim();
    const contentBody = String(values.get('contentBody') ?? '').trim();
    const contentSubject = String(values.get('contentSubject') ?? '').trim();
    const templateId = String(values.get('templateId') ?? '').trim();
    const languageCode = String(values.get('templateLanguage') ?? '').trim() || 'es_CO';
    if (!name || (!contentBody && !templateId) || (channel === 'email' && !contentSubject)) {
      setError('Completa el nombre y el mensaje o la plantilla. El correo también requiere un asunto.');
      return;
    }

    setError('');
    setSubmitting(true);
    try {
      const campaign = await createCampaignDraft({
        name,
        channel,
        purpose: values.get('purpose') as CampaignPurpose,
        segmentId: segmentId || undefined,
        contentBody: contentBody || undefined,
        contentSubject: contentSubject || undefined,
        templateId: templateId || undefined,
        templateVariables: templateId ? { languageCode } : undefined,
        rateLimitPerMinute: Number(values.get('rateLimitPerMinute')),
        failurePauseThresholdPercent: Number(values.get('failurePauseThresholdPercent')),
      });
      navigate('/dashboard/campanas', { replace: true, state: { createdDraftId: campaign.id } });
    } catch (cause) {
      setError(campaignError(cause, 'No se pudo crear el borrador. Revisa la conexión y vuelve a intentar.'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="mx-auto max-w-3xl space-y-5 p-4 sm:p-6" aria-labelledby="campaign-title">
      <Link to="/dashboard/campanas" className="inline-flex items-center gap-2 text-sm font-medium text-emerald-700 dark:text-emerald-300">
        <ArrowLeft size={16} /> Campañas
      </Link>
      <header>
        <h1 id="campaign-title" className="text-2xl font-semibold">Nuevo borrador de campaña</h1>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">Prepara el contenido y la audiencia. El envío se gestiona por separado.</p>
      </header>
      <form onSubmit={handleSubmit} className="space-y-4 rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900 sm:p-6">
        <label className="block space-y-1 text-sm font-medium">
          <span>Nombre de la campaña</span>
          <input name="name" required maxLength={255} className={inputClass} autoComplete="off" />
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block space-y-1 text-sm font-medium">
            <span>Canal</span>
            <select className={inputClass} value={channel} onChange={(event) => {
              setChannel(event.target.value as CampaignChannel);
              setSegmentId('');
            }}>
              {Object.entries(channelLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label className="block space-y-1 text-sm font-medium">
            <span>Propósito</span>
            <select name="purpose" className={inputClass} defaultValue="marketing">
              <option value="marketing">Marketing</option>
              <option value="broadcast">Difusión informativa</option>
              <option value="transactional">Transaccional</option>
              <option value="support">Soporte</option>
            </select>
          </label>
        </div>
        <label className="block space-y-1 text-sm font-medium">
          <span>Segmento de audiencia</span>
          <select className={inputClass} value={segmentId} onChange={(event) => setSegmentId(event.target.value)}>
            <option value="">Sin segmento</option>
            {availableSegments.map((segment) => <option key={segment.id} value={segment.id}>{segment.name}</option>)}
          </select>
        </label>
        {segmentStatus !== 'ready' && (
          <p role="status" className="text-sm text-gray-600 dark:text-gray-300">
            {segmentStatus === 'loading' ? 'Cargando segmentos…' : 'No pudimos cargar los segmentos.'}
          </p>
        )}
        {channel === 'email' && (
          <label className="block space-y-1 text-sm font-medium">
            <span>Asunto</span>
            <input name="contentSubject" required maxLength={255} className={inputClass} />
          </label>
        )}
        {channel === 'whatsapp-cloud' && (
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block space-y-1 text-sm font-medium">
              <span>Nombre de la plantilla de WhatsApp (opcional)</span>
              <input name="templateId" maxLength={255} className={inputClass} />
            </label>
            <label className="block space-y-1 text-sm font-medium">
              <span>Idioma de la plantilla</span>
              <input name="templateLanguage" defaultValue="es_CO" maxLength={20} className={inputClass} />
            </label>
          </div>
        )}
        <label className="block space-y-1 text-sm font-medium">
          <span>Mensaje</span>
          <textarea name="contentBody" required={channel !== 'whatsapp-cloud'} rows={4} className={inputClass} />
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block space-y-1 text-sm font-medium">
            <span>Mensajes por minuto</span>
            <input name="rateLimitPerMinute" required type="number" min={1} max={1000} defaultValue={50} className={inputClass} />
          </label>
          <label className="block space-y-1 text-sm font-medium">
            <span>Umbral de pausa por fallos (%)</span>
            <input name="failurePauseThresholdPercent" required type="number" min={0} max={100} step={0.01} defaultValue={5} className={inputClass} />
          </label>
        </div>
        {error && <p role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</p>}
        <button type="submit" disabled={submitting} className="inline-flex items-center gap-2 rounded-md bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-60">
          <Save size={16} /> {submitting ? 'Creando…' : 'Crear borrador'}
        </button>
      </form>
    </section>
  );
}
