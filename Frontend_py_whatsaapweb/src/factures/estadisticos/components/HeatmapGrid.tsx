import React from 'react';
import type { HeatmapMatrix } from '../services/reportsService';

interface HeatmapGridProps {
  data: HeatmapMatrix;
}

const HeatmapGrid: React.FC<HeatmapGridProps> = ({ data }) => {
  const colorFor = (count: number) => {
    if (!count || !data.maxCount) return 'rgba(148, 163, 184, 0.14)';
    const intensity = 0.18 + (count / data.maxCount) * 0.72;
    return `rgba(16, 185, 129, ${intensity})`;
  };

  return (
    <div className="overflow-x-auto">
      <div className="min-w-[780px]">
        <div className="grid grid-cols-[48px_repeat(24,minmax(24px,1fr))_52px] gap-1 text-[11px] text-gray-500 dark:text-gray-400">
          <div />
          {Array.from({ length: 24 }, (_, hour) => (
            <div key={hour} className="text-center">{hour}</div>
          ))}
          <div className="text-right">Total</div>

          {data.days.map((day) => (
            <React.Fragment key={day.day}>
              <div className="flex items-center font-semibold text-gray-600 dark:text-gray-300">{day.label}</div>
              {day.hours.map((count, hour) => (
                <div
                  key={`${day.day}-${hour}`}
                  className="flex h-7 items-center justify-center rounded-sm border border-gray-200/70 text-[10px] font-semibold text-gray-700 dark:border-gray-700 dark:text-gray-100"
                  style={{ backgroundColor: colorFor(count) }}
                  title={`${day.label} ${hour}:00 - ${count} mensajes entrantes`}
                >
                  {count || ''}
                </div>
              ))}
              <div className="flex items-center justify-end font-semibold text-gray-700 dark:text-gray-200">{day.total}</div>
            </React.Fragment>
          ))}
        </div>
      </div>
    </div>
  );
};

export default HeatmapGrid;
