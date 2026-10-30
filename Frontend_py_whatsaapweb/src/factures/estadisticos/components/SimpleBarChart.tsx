// src/factures/estadisticos/components/SimpleBarChart.tsx

import React from 'react';

interface SimpleBarChartProps {
  data: Array<{ label: string; value: number; color?: string }>;
  maxValue?: number;
}

const SimpleBarChart: React.FC<SimpleBarChartProps> = ({ data, maxValue }) => {
  const max = Math.max(maxValue || 0, ...data.map(d => d.value), 1);

  return (
    <div className="space-y-3">
      {data.map((item, index) => (
        <div key={index} className="flex items-center gap-3">
          <div className="w-24 text-sm text-gray-700 dark:text-gray-300 truncate">
            {item.label}
          </div>
          <div className="flex-1 bg-gray-200 dark:bg-gray-700 rounded-full h-8 relative overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 flex items-center justify-end pr-3`}
              style={{
                width: `${(item.value / max) * 100}%`,
                backgroundColor: item.color || '#3b82f6'
              }}
            >
              <span className="text-xs font-semibold text-white">
                {item.value}
              </span>
            </div>
          </div>
        </div>
      ))}
      {data.length === 0 && (
        <p className="text-center text-gray-500 dark:text-gray-400 py-8">
          No hay datos disponibles
        </p>
      )}
    </div>
  );
};

export default SimpleBarChart;
