// src/factures/estadisticos/hooks/useReports.ts

import { useCallback, useEffect, useState } from 'react';
import { getHeatmap, getMetrics, type HeatmapMatrix, type ReportFilters, type ReportMetrics } from '../services/reportsService';

export function useReports(filters: ReportFilters) {
  const [metrics, setMetrics] = useState<ReportMetrics | null>(null);
  const [heatmap, setHeatmap] = useState<HeatmapMatrix | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadMetrics = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const [metricsData, heatmapData] = await Promise.all([
        getMetrics(filters),
        getHeatmap(filters),
      ]);
      setMetrics(metricsData);
      setHeatmap(heatmapData);
    } catch (err: any) {
      setError(err?.response?.data?.message || err.message || 'Error al cargar métricas');
      console.error('Error cargando reportes:', err);
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    loadMetrics();
  }, [loadMetrics]);

  return {
    metrics,
    heatmap,
    loading,
    error,
    reload: loadMetrics
  };
}
