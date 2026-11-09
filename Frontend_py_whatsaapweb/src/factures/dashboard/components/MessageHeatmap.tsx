import { type ReactNode, useMemo } from 'react';
import { Loader2 } from 'lucide-react';
import type { HeatmapByDateMatrix } from '../services/dashboardService';

type Props = {
  data: HeatmapByDateMatrix | null;
  loadState: 'loading' | 'ready' | 'error';
  footer?: ReactNode;
};

const HOUR_LABELS = Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, '0')}:00`);

function colorFor(count: number, maxCount: number): string {
  if (!count || !maxCount) return 'rgba(148, 163, 184, 0.14)';
  const intensity = 0.15 + (count / maxCount) * 0.75;
  return `rgba(18, 140, 126, ${intensity})`;
}

export default function MessageHeatmap({ data, loadState, footer }: Props) {
  const visibleDays = useMemo(() => {
    if (!data) return [];
    return data.days.slice(-7);
  }, [data]);

  const maxCount = data?.maxCount || 0;
  const total = data?.totalMessages ?? 0;

  return (
    <div className="rounded-2xl border border-[#D9E5DF] bg-white p-6 shadow-sm sm:p-8">
      <div className="mb-6 flex items-center justify-between">
        <h3 className="text-lg font-bold text-[#10231C]">Actividad de Mensajes</h3>
        <span className="text-xs font-medium text-[#5B6F66]">
          {loadState === 'loading'
            ? 'Cargando...'
            : loadState === 'error'
              ? 'No disponible'
              : `${total} ${total === 1 ? 'mensaje' : 'mensajes'} · 7 días`}
        </span>
      </div>

      {loadState === 'loading' && !data ? (
        <div className="flex h-48 items-center justify-center text-[#5B6F66]">
          <Loader2 className="h-6 w-6 animate-spin text-[#128C7E]" />
        </div>
      ) : loadState === 'error' ? (
        <div className="flex h-48 items-center justify-center text-sm text-[#5B6F66]">
          No se pudo cargar la actividad.
        </div>
      ) : !total ? (
        <p className="py-3 text-sm text-[#5B6F66]">Todavía no hay mensajes registrados en este período.</p>
      ) : (
        <div tabIndex={0} role="region" aria-label="Actividad por fecha y hora" className="w-full overflow-x-auto pb-2">
          <div className="min-w-[720px]" role="table" aria-label="Mensajes por hora">
            <div role="row" className="mb-3 grid grid-cols-[56px_repeat(24,minmax(18px,1fr))] gap-1 text-[10px] font-semibold text-[#5B6F66]">
              <div role="columnheader">Día</div>
              {HOUR_LABELS.map((label) => (
                <div key={label} role="columnheader" className="text-center">
                  {label}
                </div>
              ))}
            </div>

            <div className="space-y-2">
              {visibleDays.map((day) => (
                <div
                  key={day.date}
                  role="row"
                  className="grid grid-cols-[56px_repeat(24,minmax(18px,1fr))] items-center gap-1"
                >
                  <div role="rowheader" className="text-xs font-semibold text-[#10231C]">{day.label}</div>
                  {day.hours.map((count, hour) => (
                    <div
                      key={`${day.date}-${hour}`}
                      role="cell"
                      className="group relative h-7 cursor-pointer rounded-sm border border-[#D9E5DF]/60 transition-all hover:ring-2 hover:ring-[#128C7E]/30"
                      style={{ backgroundColor: colorFor(count, maxCount) }}
                      title={`${day.label} ${HOUR_LABELS[hour]} - ${count} mensajes`}
                    >
                      <span className="sr-only">{count} mensajes</span>
                      {count > 0 && (
                        <span aria-hidden="true" className="pointer-events-none absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-[140%] whitespace-nowrap rounded-md bg-[#2c3130] px-2 py-1 text-[10px] font-medium text-white opacity-0 transition-opacity group-hover:opacity-100">
                          {count} msjs
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              ))}
            </div>

            <div className="mt-6 flex items-center justify-end gap-2 text-[11px] font-medium text-[#5B6F66]">
              <span>Bajo</span>
              <div className="flex gap-1">
                <div className="h-3 w-3 rounded-sm" style={{ backgroundColor: colorFor(0, 1) }} />
                <div className="h-3 w-3 rounded-sm" style={{ backgroundColor: colorFor(maxCount * 0.3, maxCount) }} />
                <div className="h-3 w-3 rounded-sm" style={{ backgroundColor: colorFor(maxCount * 0.6, maxCount) }} />
                <div className="h-3 w-3 rounded-sm" style={{ backgroundColor: colorFor(maxCount, maxCount) }} />
              </div>
              <span>Alto</span>
            </div>
          </div>
        </div>
      )}
      {footer ? <div className="mt-6 border-t border-[#D9E5DF] pt-5">{footer}</div> : null}
    </div>
  );
}
