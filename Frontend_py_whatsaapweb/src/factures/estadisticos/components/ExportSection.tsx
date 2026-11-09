import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, FileSpreadsheet, Loader2, RefreshCw } from 'lucide-react';
import {
  downloadOperationalReport,
  getOperationalReport,
  type OperationalReportPage,
  type ReportFilters,
} from '../services/reportsService';

interface ExportSectionProps {
  filters: ReportFilters;
}

const statusLabels: Record<string, string> = {
  draft: 'Borrador',
  quoted: 'Cotizado',
  pending_handoff: 'Requiere atención humana',
  pending_approval: 'Pendiente de aprobación',
  confirmed: 'Confirmado',
  reserved: 'Reservado',
  completed: 'Completado',
  cancelled: 'Cancelado',
  out_of_stock: 'Agotado',
  unavailable: 'No disponible',
  registered: 'Registrado',
};

const ExportSection: React.FC<ExportSectionProps> = ({ filters }) => {
  const [status, setStatus] = useState('');
  const [report, setReport] = useState<OperationalReportPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState<'csv' | 'xls' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reportFilters = useMemo(() => ({ ...filters, status: status || undefined }), [filters, status]);

  const loadPreview = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      setReport(await getOperationalReport({ ...reportFilters, limit: 20, offset: 0 }));
    } catch (err: any) {
      setError(err?.response?.data?.message || err?.message || 'No se pudo cargar el reporte operativo.');
    } finally {
      setLoading(false);
    }
  }, [reportFilters]);

  useEffect(() => {
    loadPreview();
  }, [loadPreview]);

  const handleExport = async (format: 'csv' | 'xls') => {
    try {
      setExporting(format);
      setError(null);
      await downloadOperationalReport(reportFilters, format);
    } catch (err: any) {
      setError(err?.response?.data?.message || err?.message || 'No se pudo exportar el reporte.');
    } finally {
      setExporting(null);
    }
  };

  return (
    <section className="border-y border-gray-200 bg-white py-5 dark:border-gray-700 dark:bg-gray-800">
      <div className="flex flex-col gap-4 px-5 md:flex-row md:items-center md:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Download className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
            <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">Reporte operativo</h3>
          </div>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Pedidos y servicios registrados en el periodo. Vista previa de hasta 20 filas.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Estado del pedido"
            value={status}
            onChange={(event) => setStatus(event.target.value)}
            className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-800 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
          >
            <option value="">Todos los estados</option>
            {Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <button
            type="button"
            onClick={loadPreview}
            disabled={loading}
            className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-gray-300 text-gray-600 hover:bg-gray-100 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
            title="Actualizar vista previa"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button
            type="button"
            onClick={() => handleExport('csv')}
            disabled={Boolean(exporting)}
            className="inline-flex items-center gap-2 rounded-md bg-emerald-600 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {exporting === 'csv' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            CSV
          </button>
          <button
            type="button"
            onClick={() => handleExport('xls')}
            disabled={Boolean(exporting)}
            className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {exporting === 'xls' ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSpreadsheet className="h-4 w-4" />}
            Excel
          </button>
        </div>
      </div>

      {error && <p className="px-5 pt-4 text-sm text-red-600 dark:text-red-400">{error}</p>}

      <div className="mt-4 overflow-x-auto border-t border-gray-200 dark:border-gray-700">
        <table className="min-w-full divide-y divide-gray-200 text-sm dark:divide-gray-700">
          <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500 dark:bg-gray-900/40 dark:text-gray-400">
            <tr>
              <th className="px-5 py-3">Fecha</th>
              <th className="px-5 py-3">Cliente</th>
              <th className="px-5 py-3">Servicio</th>
              <th className="px-5 py-3">Items</th>
              <th className="px-5 py-3">Estado</th>
              <th className="px-5 py-3">Empleado</th>
              <th className="px-5 py-3 text-right">Acciones</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
            {report?.rows.map((row) => (
              <tr key={row.orderId} className="text-gray-700 dark:text-gray-200">
                <td className="whitespace-nowrap px-5 py-3">{new Date(row.occurredAt).toLocaleString('es-PE')}</td>
                <td className="px-5 py-3">
                  <p className="font-medium">{row.customerName}</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">{row.phone || row.chatId || '-'}</p>
                </td>
                <td className="px-5 py-3">{row.title}</td>
                <td className="px-5 py-3">
                  <p className="max-w-xs truncate">{row.products || '-'}</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">{row.itemTypes || '-'}</p>
                </td>
                <td className="px-5 py-3">{Object.hasOwn(statusLabels, row.status) ? statusLabels[row.status] : row.status}</td>
                <td className="px-5 py-3">{row.employeeName || 'Sistema'}</td>
                <td className="px-5 py-3 text-right">{row.actionCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && report?.rows.length === 0 && (
          <p className="px-5 py-8 text-center text-sm text-gray-500 dark:text-gray-400">
            No hay servicios registrados en este rango.
          </p>
        )}
        {loading && (
          <div className="flex items-center justify-center gap-2 px-5 py-8 text-sm text-gray-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            Cargando reporte...
          </div>
        )}
      </div>
      <p className="px-5 pt-3 text-xs text-gray-500 dark:text-gray-400">
        {report?.total || 0} servicios encontrados. La descarga incluye hasta 5,000 filas.
      </p>
    </section>
  );
};

export default ExportSection;
