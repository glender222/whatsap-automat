import { useMemo } from 'react';
import { Loader2, RefreshCw, Wifi, WifiOff } from 'lucide-react';
import { useDashboardStats } from '../hooks/useDashboardStats';
import QuickStatsRow from '../components/QuickStatsRow';
import ActionCards from '../components/ActionCards';
import MessageHeatmap from '../components/MessageHeatmap';
import SlaAlertsList from '../components/SlaAlertsList';
import HandoffWidget from '../components/HandoffWidget';

function formatLastUpdated(date: Date | null): string {
  if (!date) return 'Sin datos aún';
  return new Intl.DateTimeFormat('es-PE', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
}

export default function DashboardPage() {
  const {
    quickStats,
    actionCards,
    heatmap,
    slaAlerts,
    whatsappStatus,
    quickStatsState,
    actionCardsState,
    heatmapState,
    slaAlertsState,
    whatsappState,
    lastUpdated,
    reloadAll,
  } = useDashboardStats(7, 20);

  const isOnline = whatsappState === 'ready' && Boolean(whatsappStatus?.connected);
  const isLoadingAll = useMemo(
    () =>
      quickStatsState === 'loading' &&
      actionCardsState === 'loading' &&
      heatmapState === 'loading' &&
      slaAlertsState === 'loading',
    [quickStatsState, actionCardsState, heatmapState, slaAlertsState]
  );

  return (
    <div className="min-h-full bg-[#F7FAF8] p-6 lg:p-10">
      <div className="mx-auto w-full max-w-7xl space-y-8 pb-20">
        <section className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-4">
            <div>
              <h2 className="text-2xl font-bold tracking-tight text-[#10231C]">Centro de Operaciones</h2>
              <p className="mt-1 text-sm text-[#5B6F66]">
                Panel operativo en tiempo real · última actualización {formatLastUpdated(lastUpdated)}
              </p>
            </div>
            <div
              className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold shadow-sm ${
                isOnline
                  ? 'border-[#006d2f]/20 bg-[#006d2f]/5 text-[#006d2f]'
                  : 'border-[#D9E5DF] bg-white text-[#5B6F66]'
              }`}
            >
              {whatsappState === 'loading' ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : isOnline ? (
                <>
                  <span className="h-2 w-2 animate-pulse rounded-full bg-[#006d2f]" />
                  En línea
                </>
              ) : (
                <>
                  <WifiOff className="h-3.5 w-3.5" />
                  Desconectado
                </>
              )}
            </div>
          </div>

          <button
            type="button"
            onClick={() => reloadAll()}
            className="inline-flex items-center gap-2 rounded-[10px] border border-[#D9E5DF] bg-white px-4 py-2 text-sm font-semibold text-[#10231C] transition hover:bg-[#EEF4F1]"
          >
            {isLoadingAll ? (
              <Loader2 className="h-4 w-4 animate-spin text-[#128C7E]" />
            ) : (
              <RefreshCw className="h-4 w-4 text-[#128C7E]" />
            )}
            Actualizar
          </button>
        </section>

        <QuickStatsRow stats={quickStats} loadState={quickStatsState} />

        <div className="grid grid-cols-1 gap-8 lg:grid-cols-3">
          <div className="space-y-8 lg:col-span-2">
            <ActionCards stats={actionCards} loadState={actionCardsState} />
            <MessageHeatmap data={heatmap} loadState={heatmapState} />
          </div>

          <SlaAlertsList data={slaAlerts} loadState={slaAlertsState} />
        </div>

        <HandoffWidget limit={5} />

        {whatsappStatus && !whatsappStatus.connected && whatsappState === 'ready' && (
          <div className="flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
            <Wifi className="h-5 w-5 shrink-0" />
            <span>
              La sesión de WhatsApp no está conectada. Las métricas en tiempo real podrían no reflejarse.
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
