// src/factures/estadisticos/components/SimplePieChart.tsx

import React from 'react';

interface SimplePieChartProps {
  data: Array<{ label: string; value: number; color: string }>;
}

const SimplePieChart: React.FC<SimplePieChartProps> = ({ data }) => {
  const total = data.reduce((sum, item) => sum + item.value, 0);

  if (total === 0 || data.length === 0) {
    return (
      <p className="text-center text-gray-500 dark:text-gray-400 py-8">
        No hay datos disponibles
      </p>
    );
  }

  return (
    <div className="flex flex-col md:flex-row items-center gap-6">
      {/* Gráfico circular usando conic-gradient */}
      <div className="relative w-48 h-48 flex-shrink-0">
        <div
          className="w-full h-full rounded-full"
          style={{
            background: `conic-gradient(
              ${data.map((item, index) => {
                const startPercent = data.slice(0, index).reduce((sum, d) => sum + d.value, 0) / total * 100;
                const endPercent = startPercent + (item.value / total * 100);
                return `${item.color} ${startPercent}% ${endPercent}%`;
              }).join(', ')}
            )`
          }}
        />
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="w-32 h-32 bg-white dark:bg-gray-800 rounded-full flex items-center justify-center">
            <div className="text-center">
              <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">{total}</p>
              <p className="text-xs text-gray-600 dark:text-gray-400">Total</p>
            </div>
          </div>
        </div>
      </div>

      {/* Leyenda */}
      <div className="flex-1 space-y-2">
        {data.map((item, index) => (
          <div key={index} className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <div
                className="w-4 h-4 rounded"
                style={{ backgroundColor: item.color }}
              />
              <span className="text-sm text-gray-700 dark:text-gray-300">
                {item.label}
              </span>
            </div>
            <div className="text-right">
              <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                {item.value}
              </span>
              <span className="text-xs text-gray-500 dark:text-gray-400 ml-2">
                ({((item.value / total) * 100).toFixed(1)}%)
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default SimplePieChart;
