import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Clock, Sparkles, Timer } from 'lucide-react';
import type { SlaAlert, SlaAlertsResult, SlaStatusTag } from '../services/dashboardService';

type Props = {
  data: SlaAlertsResult | null;
  loadState: 'loading' | 'ready' | 'error';
};

const STATUS_LABEL: Record<SlaStatusTag, string> = {
  unassigned: 'Sin asignar',
  payment_pending: 'Pago pendiente',
  ai_ready: 'IA Lista',
  attention: 'Requiere atención',
};

const STATUS_TONE: Record<SlaStatusTag, string> = {
  unassigned: 'bg-[#EEF4F1] text-[#5B6F66]',
  payment_pending: 'bg-[#006d2f]/10 text-[#006d2f]',
  ai_ready: 'bg-blue-50 text-blue-600',
  attention: 'bg-amber-50 text-amber-700',
};

function formatWaiting(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  return remaining === 0 ? `${hours}h` : `${hours}h ${remaining}m`;
}

function getInitial(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  return trimmed.charAt(0).toUpperCase();
}

function AlertRow({ alert }: { alert: SlaAlert }) {
  const isCritical = alert.waitingMin >= 10;
  const waitingTone = isCritical ? 'text-red-600 bg-red-50' : 'text-amber-600 bg-amber-50';

  return (
    <div className="group cursor-pointer rounded-xl border border-transparent p-4 transition-all hover:border-[#D9E5DF] hover:bg-[#F7FAF8]">
      <div className="mb-2 flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#128C7E]/10 text-sm font-bold text-[#128C7E]">
            {getInitial(alert.displayName)}
          </div>
          <span className="text-sm font-bold text-[#10231C]">{alert.displayName}</span>
        </div>
        <span className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-bold ${waitingTone}`}>
          <Timer className="h-3.5 w-3.5" />
          {formatWaiting(alert.waitingMin)}
        </span>
      </div>
      <p className="mb-3 truncate text-sm text-[#5B6F66]">{alert.lastPreview || 'Sin mensaje previo'}</p>
      <div className="flex gap-2">
        <span className={`rounded-lg px-2.5 py-1 text-[11px] font-semibold ${STATUS_TONE[alert.statusTag]}`}>
          {STATUS_LABEL[alert.statusTag]}
        </span>
      </div>
    </div>
  );
}

export default function SlaAlertsList({ data, loadState }: Props) {
  const navigate = useNavigate();
  const alerts = data?.alerts || [];
  const total = data?.total || 0;
  const threshold = data?.thresholdMinutes || 5;

  return (
    <section className="flex h-[600px] flex-col overflow-hidden rounded-2xl border border-[#D9E5DF] bg-white shadow-sm lg:h-auto">
      <header className="flex items-center justify-between border-b border-[#D9E5DF] bg-[#F7FAF8] p-6">
        <div>
          <h3 className="mb-1 flex items-center gap-2 text-base font-bold text-[#10231C]">
            <span className="h-2 w-2 animate-pulse rounded-full bg-red-600" />
            Alertas SLA
          </h3>
          <p className="text-[13px] font-medium text-[#5B6F66]">
            Conversaciones críticas · umbral {threshold} min
          </p>
        </div>
        <span className="rounded-md border border-red-100 bg-red-50/60 px-2.5 py-1 text-xs font-bold text-red-600">
          {total} {total === 1 ? 'Crítica' : 'Críticas'}
        </span>
      </header>

      <div className="flex-1 space-y-1 overflow-y-auto p-3">
        {loadState === 'loading' && alerts.length === 0 ? (
          <div className="flex h-32 items-center justify-center text-sm text-[#5B6F66]">
            <Clock className="mr-2 h-4 w-4 animate-spin text-[#128C7E]" />
            Cargando alertas...
          </div>
        ) : loadState === 'error' && alerts.length === 0 ? (
          <div className="flex h-32 flex-col items-center justify-center text-center text-sm text-[#5B6F66]">
            <AlertTriangle className="mb-2 h-6 w-6 text-amber-500" />
            No se pudieron cargar las alertas.
          </div>
        ) : alerts.length === 0 ? (
          <div className="flex h-32 flex-col items-center justify-center text-center text-sm text-[#5B6F66]">
            <Sparkles className="mb-2 h-6 w-6 text-[#128C7E]" />
            Sin conversaciones críticas.
          </div>
        ) : (
          alerts.map((alert) => <AlertRow key={alert.chatId} alert={alert} />)
        )}
      </div>

      <footer className="mt-auto border-t border-[#D9E5DF] bg-[#F7FAF8] p-5 text-center">
        <button
          type="button"
          onClick={() => navigate('/gestion-web/inicio')}
          className="text-[13px] font-semibold text-[#128C7E] transition-colors hover:text-[#0E766A]"
        >
          Ver todas las conversaciones
        </button>
      </footer>
    </section>
  );
}
