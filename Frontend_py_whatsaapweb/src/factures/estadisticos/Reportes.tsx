import React, { useEffect, useMemo, useState } from 'react';
import { Activity, BarChart3, CalendarDays, Clock, MessageSquare, RefreshCw, Users } from 'lucide-react';
import { getTags } from '../mensajeria/services/tagsService';
import type { Tag } from '../mensajeria/types/tagTypes';
import { useReports } from './hooks/useReports';
import type { ReportFilters } from './services/reportsService';
import MetricCard from './components/MetricCard';
import ChartCard from './components/ChartCard';
import SimpleBarChart from './components/SimpleBarChart';
import SimplePieChart from './components/SimplePieChart';
import TopChatsList from './components/TopChatsList';
import ExportSection from './components/ExportSection';
import HeatmapGrid from './components/HeatmapGrid';

function isoDateDaysAgo(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString().slice(0, 10);
}

const TAG_COLORS: Record<string, string> = {
  'text-green-500': '#10b981',
  'text-purple-500': '#a855f7',
  'text-red-500': '#ef4444',
  'text-yellow-500': '#eab308',
  'text-blue-500': '#3b82f6',
  'text-pink-500': '#ec4899',
  'text-indigo-500': '#6366f1',
  'text-cyan-500': '#06b6d4',
};

const Reportes: React.FC = () => {
  const [startDate, setStartDate] = useState(isoDateDaysAgo(29));
  const [endDate, setEndDate] = useState(isoDateDaysAgo(0));
  const [tagId, setTagId] = useState('');
  const [tags, setTags] = useState<Tag[]>([]);
  const filters = useMemo<ReportFilters>(() => ({
    startDate,
    endDate,
    timezone: 'America/Lima',
    tagId: tagId || undefined,
  }), [endDate, startDate, tagId]);
  const { metrics, heatmap, loading, error, reload } = useReports(filters);

  useEffect(() => {
    getTags().then(setTags).catch((err) => console.warn('No se pudieron cargar etiquetas para reportes:', err));
  }, []);

  if (loading && !metrics) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <RefreshCw className="mx-auto mb-4 h-10 w-10 animate-spin text-blue-500" />
          <p className="text-gray-600 dark:text-gray-400">Cargando métricas...</p>
        </div>
      </div>
    );
  }

  if (error && !metrics) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-red-100 dark:bg-red-900/20">
            <Activity className="h-8 w-8 text-red-500" />
          </div>
          <h3 className="mb-2 text-lg font-semibold text-gray-900 dark:text-gray-100">Error al cargar reportes</h3>
          <p className="mb-4 text-gray-600 dark:text-gray-400">{error}</p>
          <button onClick={reload} className="rounded-md bg-blue-600 px-4 py-2 text-white hover:bg-blue-700">Reintentar</button>
        </div>
      </div>
    );
  }

  if (!metrics || !heatmap) return null;

  return (
    <div className="h-full space-y-5 overflow-y-auto bg-gray-50 p-4 dark:bg-gray-900 md:p-6">
      <div className="flex flex-col gap-4 border-b border-gray-200 pb-4 dark:border-gray-700 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Reportes operativos</h1>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
            Mensajería, servicios registrados y horas pico de atención.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs font-semibold text-gray-600 dark:text-gray-300">
            <span className="mb-1 block">Desde</span>
            <input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800" />
          </label>
          <label className="text-xs font-semibold text-gray-600 dark:text-gray-300">
            <span className="mb-1 block">Hasta</span>
            <input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800" />
          </label>
          <label className="text-xs font-semibold text-gray-600 dark:text-gray-300">
            <span className="mb-1 block">Etiqueta</span>
            <select value={tagId} onChange={(event) => setTagId(event.target.value)} className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800">
              <option value="">Todas</option>
              {tags.filter((tag) => !tag.is_default).map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}
            </select>
          </label>
          <button type="button" onClick={reload} disabled={loading} className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60">
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            Actualizar
          </button>
        </div>
      </div>

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        <MetricCard title="Chats atendidos" value={metrics.totalChats} icon={MessageSquare} color="blue" />
        <MetricCard title="Mensajes" value={metrics.totalMessages.toLocaleString()} icon={BarChart3} color="green" />
        <MetricCard title="Pendientes de lectura" value={metrics.totalUnread} icon={Users} color="orange" />
        <MetricCard title="Respuesta promedio" value={`${metrics.averageResponseTime} min`} icon={Clock} color="purple" />
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <ChartCard title="Chats por etiqueta">
          <SimpleBarChart data={metrics.chatsByTag.map((item) => ({
            label: item.tagName,
            value: item.count,
            color: item.color?.startsWith('#') ? item.color : TAG_COLORS[item.color || ''] || '#3b82f6',
          }))} />
        </ChartCard>
        <ChartCard title="Mensajes por tipo">
          <SimplePieChart data={metrics.messagesByType.map((item, index) => ({
            label: item.type,
            value: item.count,
            color: ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'][index % 5],
          }))} />
        </ChartCard>
      </div>

      <ChartCard title="Horas pico de mensajes entrantes">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 text-sm text-gray-500 dark:text-gray-400">
          <span className="inline-flex items-center gap-2"><CalendarDays className="h-4 w-4" /> Horario de Lima · días x horas</span>
          <span>{heatmap.totalMessages} mensajes entrantes en el rango</span>
        </div>
        <HeatmapGrid data={heatmap} />
      </ChartCard>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <ChartCard title="Chats más activos">
          <TopChatsList chats={metrics.topChats.slice(0, 10)} />
        </ChartCard>
        <ChartCard title="Mensajes por día">
          <SimpleBarChart data={metrics.messagesByDay.map((item) => ({
            label: new Date(`${item.date}T00:00:00`).toLocaleDateString('es-PE', { day: '2-digit', month: 'short' }),
            value: item.count,
            color: '#6366f1',
          }))} />
        </ChartCard>
      </div>

      <ExportSection filters={filters} />
    </div>
  );
};

export default Reportes;
