import { Clock, Loader2, MessageSquareText, ShoppingBag } from 'lucide-react';
import type { QuickStats } from '../services/dashboardService';

type StatItem = {
  id: 'response' | 'active' | 'orders';
  label: string;
  value: string;
  unit?: string;
  icon: typeof Clock;
  tone: string;
  iconTone: string;
};

type Props = {
  stats: QuickStats | null;
  loadState: 'loading' | 'ready' | 'error';
};

function formatNumber(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString('es-PE') : '0';
}

export default function QuickStatsRow({ stats, loadState }: Props) {
  const items: StatItem[] = [
    {
      id: 'response',
      label: 'Tiempo de respuesta',
      value:
        loadState === 'error'
          ? 'N/D'
          : stats
            ? formatNumber(Number(stats.averageResponseTimeMin.toFixed(2)))
            : '—',
      unit: stats ? 'min' : undefined,
      icon: Clock,
      tone: 'text-[#128C7E]',
      iconTone: 'bg-[#128C7E]/10 border-[#128C7E]/10 text-[#128C7E]',
    },
    {
      id: 'active',
      label: 'Chats Activos',
      value:
        loadState === 'error'
          ? 'N/D'
          : stats
            ? formatNumber(stats.activeChatsCount)
            : '—',
      icon: MessageSquareText,
      tone: 'text-blue-600',
      iconTone: 'bg-blue-50 border-blue-100 text-blue-600',
    },
    {
      id: 'orders',
      label: 'Pedidos Hoy',
      value:
        loadState === 'error'
          ? 'N/D'
          : stats
            ? formatNumber(stats.ordersTodayCount)
            : '—',
      icon: ShoppingBag,
      tone: 'text-[#006d2f]',
      iconTone: 'bg-[#006d2f]/10 border-[#006d2f]/10 text-[#006d2f]',
    },
  ];

  return (
    <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
      {items.map((item) => {
        const Icon = item.icon;
        const isLoading = loadState === 'loading' && !stats;
        return (
          <div
            key={item.id}
            className="flex items-center justify-between rounded-2xl border border-[#D9E5DF] bg-white p-6 shadow-sm transition-shadow hover:shadow-md"
          >
            <div>
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-[#5B6F66]">
                {item.label}
              </p>
              <h3 className="flex items-baseline gap-2 text-3xl font-bold text-[#10231C]">
                {isLoading ? (
                  <Loader2 className="h-6 w-6 animate-spin text-[#128C7E]" />
                ) : (
                  <>
                    <span>{item.value}</span>
                    {item.unit && (
                      <span className="text-base font-medium text-[#5B6F66]">{item.unit}</span>
                    )}
                  </>
                )}
              </h3>
            </div>
            <div
              className={`flex h-14 w-14 items-center justify-center rounded-2xl border ${item.iconTone}`}
            >
              <Icon className="h-7 w-7" />
            </div>
          </div>
        );
      })}
    </div>
  );
}
