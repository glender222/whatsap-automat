import { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw, ScrollText } from 'lucide-react';
import {
  iaService,
  RUNTIME_LOG_TOOL_NAMES,
  RUNTIME_LOG_TOOL_RESULT_STATUSES,
  type RuntimeLogEntry,
} from '../../dashboard/services/iaService';

const STATUS_TONE: Record<string, string> = {
  ok: 'bg-emerald-50 text-emerald-700',
  skipped: 'bg-gray-100 text-gray-600',
  failed: 'bg-red-50 text-red-700',
};

const TOOL_RESULT_TONE: Record<string, string> = {
  ok: 'bg-emerald-50 text-emerald-700',
  skipped: 'bg-gray-100 text-gray-600',
  failed: 'bg-red-50 text-red-700',
  forbidden: 'bg-red-100 text-red-800',
  disabled_future_tool: 'bg-amber-50 text-amber-700',
  not_found: 'bg-gray-100 text-gray-600',
  invalid_input: 'bg-amber-50 text-amber-700',
  scope_empty: 'bg-amber-50 text-amber-700',
  permission_denied: 'bg-red-100 text-red-800',
};

const LEVEL_TONE: Record<string, string> = {
  info: 'text-gray-500',
  debug: 'text-gray-400',
  warn: 'text-amber-600',
  error: 'text-red-600',
};

function formatTimestamp(value: string): string {
  try {
    return new Intl.DateTimeFormat('es-PE', {
      dateStyle: 'short',
      timeStyle: 'medium',
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function toolResultBadge(status: string | null): string {
  if (!status) return '—';
  if (status === 'forbidden' || status === 'permission_denied') return 'Prohibida';
  if (status === 'disabled_future_tool') return 'Futura desact.';
  if (status === 'not_found') return 'No encontrada';
  if (status === 'scope_empty') return 'Scope vacío';
  if (status === 'invalid_input') return 'Input inválido';
  if (status === 'failed') return 'Error';
  if (status === 'skipped') return 'Omitida';
  if (status === 'ok') return 'Real';
  return status;
}

export default function RuntimeLogsViewer() {
  const [logs, setLogs] = useState<RuntimeLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [chatIdFilter, setChatIdFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [actionFilter, setActionFilter] = useState<string>('');
  const [toolNameFilter, setToolNameFilter] = useState<string>('');
  const [toolResultStatusFilter, setToolResultStatusFilter] = useState<string>('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await iaService.listRuntimeLogs({
        chatId: chatIdFilter || undefined,
        status: statusFilter || undefined,
        action: actionFilter || undefined,
        toolName: toolNameFilter || undefined,
        toolResultStatus: toolResultStatusFilter || undefined,
        limit: 100,
      });
      setLogs(data);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'No se pudieron cargar los logs');
    } finally {
      setLoading(false);
    }
  }, [chatIdFilter, statusFilter, actionFilter, toolNameFilter, toolResultStatusFilter]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex-1 min-w-[180px]">
          <label className="mb-1 block text-xs font-semibold uppercase text-[#5B6F66]">Chat ID</label>
          <input
            type="text"
            value={chatIdFilter}
            onChange={(e) => setChatIdFilter(e.target.value)}
            placeholder="Ej: 5491122334455"
            className="admin-control"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold uppercase text-[#5B6F66]">Estado</label>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="admin-select"
          >
            <option value="">Todos</option>
            <option value="ok">OK</option>
            <option value="skipped">Skipped</option>
            <option value="failed">Failed</option>
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold uppercase text-[#5B6F66]">Acción</label>
          <select
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value)}
            className="admin-select"
          >
            <option value="">Todas</option>
            <option value="suggest">Sugerir</option>
            <option value="auto_reply">Auto-responder</option>
            <option value="handoff">Derivar</option>
            <option value="block">Bloquear</option>
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold uppercase text-[#5B6F66]">Tool</label>
          <select
            value={toolNameFilter}
            onChange={(e) => setToolNameFilter(e.target.value)}
            className="admin-select"
          >
            <option value="">Todas</option>
            {RUNTIME_LOG_TOOL_NAMES.map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold uppercase text-[#5B6F66]">Resultado tool</label>
          <select
            value={toolResultStatusFilter}
            onChange={(e) => setToolResultStatusFilter(e.target.value)}
            className="admin-select"
          >
            <option value="">Todos</option>
            {RUNTIME_LOG_TOOL_RESULT_STATUSES.map((status) => (
              <option key={status} value={status}>{toolResultBadge(status)}</option>
            ))}
          </select>
        </div>
        <button
          type="button"
          onClick={load}
          className="admin-button-secondary"
        >
          <RefreshCw className="h-4 w-4" />
          Actualizar
        </button>
      </div>

      <div className="overflow-hidden rounded-2xl border border-[#D9E5DF] bg-white shadow-sm">
        {loading && logs.length === 0 ? (
          <div className="flex h-32 items-center justify-center text-[#5B6F66]">
            <Loader2 className="h-5 w-5 animate-spin text-[#128C7E]" />
          </div>
        ) : error ? (
          <div className="flex h-32 items-center justify-center text-sm text-red-600">{error}</div>
        ) : logs.length === 0 ? (
          <div className="flex h-32 flex-col items-center justify-center text-center text-sm text-[#5B6F66]">
            <ScrollText className="mb-2 h-6 w-6 text-[#128C7E]/60" />
            Sin registros de actividad IA.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-[#D9E5DF] bg-[#F7FAF8] text-xs uppercase tracking-wide text-[#5B6F66]">
                <tr>
                  <th className="px-4 py-3 font-semibold">Fecha</th>
                  <th className="px-4 py-3 font-semibold">Agente</th>
                  <th className="px-4 py-3 font-semibold">Chat</th>
                  <th className="px-4 py-3 font-semibold">Etapa</th>
                  <th className="px-4 py-3 font-semibold">Tool</th>
                  <th className="px-4 py-3 font-semibold">Resultado</th>
                  <th className="px-4 py-3 font-semibold">Estado</th>
                  <th className="px-4 py-3 font-semibold">Acción</th>
                  <th className="px-4 py-3 font-semibold">Confianza</th>
                  <th className="px-4 py-3 font-semibold">Resumen</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#D9E5DF]">
                {logs.map((log) => (
                  <tr key={log.id} className="align-top hover:bg-[#F7FAF8]">
                    <td className="px-4 py-3 text-xs text-[#5B6F66]">{formatTimestamp(log.createdAt)}</td>
                    <td className="px-4 py-3 text-xs text-[#10231C]">{log.agentName || '—'}</td>
                    <td className="px-4 py-3 text-xs text-[#5B6F66]">{log.chatId || '—'}</td>
                    <td className="px-4 py-3 text-xs font-semibold text-[#10231C]">{log.stage}</td>
                    <td className="px-4 py-3 text-xs text-[#10231C]">{log.toolName || '—'}</td>
                    <td className="px-4 py-3">
                      {log.toolResultStatus ? (
                        <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${TOOL_RESULT_TONE[log.toolResultStatus] || 'bg-gray-100 text-gray-600'}`}>
                          {toolResultBadge(log.toolResultStatus)}
                        </span>
                      ) : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_TONE[log.status] || 'bg-gray-100 text-gray-600'}`}>
                        {log.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-[#5B6F66]">{log.action || '—'}</td>
                    <td className="px-4 py-3 text-xs text-[#5B6F66]">
                      {log.confidence !== null ? `${Math.round(log.confidence * 100)}%` : '—'}
                    </td>
                    <td className={`px-4 py-3 text-xs ${LEVEL_TONE[log.level] || 'text-gray-500'}`}>{log.summary}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
