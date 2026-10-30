import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock, Hand, Loader2 } from 'lucide-react';
import { iaService, type HandoffOutcome, type HandoffTicketSummary } from '../services/iaService';

type Props = {
  limit?: number;
  status?: HandoffTicketSummary['status'] | 'all';
  allowClose?: boolean;
};

const OUTCOME_LABELS: Record<HandoffOutcome, string> = {
  sale_confirmed: 'Venta confirmada',
  no_sale: 'Sin venta',
  follow_up_required: 'Seguimiento requerido',
  support_resolved: 'Soporte resuelto',
  duplicate: 'Duplicado',
  cancelled: 'Cancelado',
};

const PRIORITY_LABELS: Record<HandoffTicketSummary['priority'], string> = {
  low: 'Baja',
  medium: 'Media',
  high: 'Alta',
};

const PRIORITY_STYLES: Record<HandoffTicketSummary['priority'], string> = {
  low: 'border-[#D9E5DF] bg-[#EEF4F1] text-[#5B6F66]',
  medium: 'border-[#D9E5DF] bg-[#DDF4EF] text-[#0E766A]',
  high: 'border-red-200 bg-red-50 text-red-700',
};

const STATUS_LABELS: Record<HandoffTicketSummary['status'], string> = {
  open: 'Abierto',
  taken: 'En atencion',
  closed: 'Cerrado',
  cancelled: 'Cancelado',
};

function formatWaiting(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  const hours = Math.floor(seconds / 3600);
  const remaining = seconds % 3600;
  return remaining === 0 ? `${hours}h` : `${hours}h ${Math.floor(remaining / 60)}m`;
}

export default function HandoffWidget({ limit = 10, status = 'open', allowClose = false }: Props) {
  const [tickets, setTickets] = useState<HandoffTicketSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionInProgress, setActionInProgress] = useState<number | null>(null);
  const [closeOutcome, setCloseOutcome] = useState<HandoffOutcome>('follow_up_required');
  const [closeNotes, setCloseNotes] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await iaService.listHandoffTickets({ status: status === 'all' ? undefined : status, limit });
      setTickets(data.rows);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'No se pudieron cargar los tickets');
    } finally {
      setLoading(false);
    }
  }, [limit, status]);

  useEffect(() => {
    load();
    const interval = setInterval(load, 30000);
    return () => clearInterval(interval);
  }, [load]);

  const handleTake = async (ticketId: number) => {
    setActionInProgress(ticketId);
    try {
      await iaService.takeHandoffTicket(ticketId);
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'No se pudo tomar el ticket');
    } finally {
      setActionInProgress(null);
    }
  };

  const handleClose = async (ticketId: number) => {
    setActionInProgress(ticketId);
    try {
      await iaService.closeHandoffTicket(ticketId, {
        outcome: closeOutcome,
        notes: closeNotes.trim() || undefined,
      });
      setCloseNotes('');
      setCloseOutcome('follow_up_required');
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'No se pudo cerrar el ticket');
    } finally {
      setActionInProgress(null);
    }
  };

  const activeCount = tickets.filter((t) => t.status === 'open' || t.status === 'taken').length;

  return (
    <section className="rounded-2xl border border-[#D9E5DF] bg-white p-6 shadow-sm">
      <header className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Hand className="h-5 w-5 text-[#128C7E]" />
          <h3 className="text-base font-bold text-[#10231C]">Cola Handoff IA</h3>
        </div>
        <span className="rounded-full bg-[#EEF4F1] px-3 py-1 text-xs font-bold text-[#0E766A]">
          {activeCount} {activeCount === 1 ? 'activo' : 'activos'}
        </span>
      </header>

      {loading && tickets.length === 0 ? (
        <div className="flex h-24 items-center justify-center text-[#5B6F66]">
          <Loader2 className="h-5 w-5 animate-spin text-[#128C7E]" />
        </div>
      ) : error ? (
        <div className="flex h-24 flex-col items-center justify-center text-center text-sm text-red-600">
          <AlertTriangle className="mb-2 h-5 w-5" />
          {error}
        </div>
      ) : tickets.length === 0 ? (
        <div className="flex h-24 flex-col items-center justify-center text-center text-sm text-[#5B6F66]">
          <Hand className="mb-2 h-5 w-5 text-[#128C7E]/60" />
          Sin tickets pendientes.
        </div>
      ) : (
        <ul className="divide-y divide-[#D9E5DF]">
          {tickets.map((ticket) => (
            <li key={ticket.id} className="py-3 first:pt-0 last:pb-0">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-[#10231C]">{ticket.customerName}</div>
                  <div className="truncate text-xs text-[#5B6F66]">{ticket.reason}</div>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[#5B6F66]">
                    <span className="inline-flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      {formatWaiting(ticket.waitingSeconds)}
                    </span>
                    <span className={`rounded-full border px-2 py-0.5 font-semibold ${PRIORITY_STYLES[ticket.priority]}`}>
                      {PRIORITY_LABELS[ticket.priority]}
                    </span>
                    <span className="rounded-full border border-[#D9E5DF] bg-white px-2 py-0.5 font-semibold text-[#5B6F66]">
                      {STATUS_LABELS[ticket.status]}
                    </span>
                    {ticket.orderId ? (
                      <span className="rounded-full border border-[#D9E5DF] bg-[#EEF4F1] px-2 py-0.5 font-semibold text-[#0E766A]">
                        Pedido #{ticket.orderId}
                      </span>
                    ) : null}
                    {ticket.agentId ? (
                      <span className="rounded-full border border-[#D9E5DF] bg-white px-2 py-0.5 font-semibold text-[#5B6F66]">
                        Agente #{ticket.agentId}
                      </span>
                    ) : null}
                    {ticket.chatId ? (
                      <span className="rounded-full border border-[#D9E5DF] bg-white px-2 py-0.5 font-mono text-[10px] text-[#5B6F66]">
                        {ticket.chatId}
                      </span>
                    ) : null}
                  </div>
                  {ticket.status === 'closed' && (ticket.outcome || ticket.notes) ? (
                    <div className="mt-2 rounded-md border border-[#D9E5DF] bg-[#F7FAF8] px-2.5 py-1.5 text-xs text-[#5B6F66]">
                      <span className="font-semibold text-[#10231C]">Resultado:</span>{' '}
                      {ticket.outcome ? OUTCOME_LABELS[ticket.outcome] : '—'}
                      {ticket.notes ? <span className="block text-[#5B6F66]">Notas: {ticket.notes}</span> : null}
                    </div>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {ticket.status === 'open' && (
                    <button
                      type="button"
                      onClick={() => handleTake(ticket.id)}
                      disabled={actionInProgress === ticket.id}
                      className="inline-flex items-center gap-1.5 rounded-md bg-[#128C7E] px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-[#0E766A] disabled:opacity-60"
                    >
                      {actionInProgress === ticket.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Hand className="h-3.5 w-3.5" />
                      )}
                      Tomar
                    </button>
                  )}
                </div>
              </div>
              {allowClose && (ticket.status === 'open' || ticket.status === 'taken') && (
                <div className="mt-3 grid gap-2 rounded-xl border border-[#D9E5DF] bg-[#F7FAF8] p-3 md:grid-cols-[180px_1fr_auto]">
                  <select
                    className="admin-select h-10 text-xs"
                    value={closeOutcome}
                    onChange={(event) => setCloseOutcome(event.target.value as HandoffOutcome)}
                  >
                    {Object.entries(OUTCOME_LABELS).map(([value, label]) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>
                  <input
                    className="admin-control h-10 text-xs"
                    value={closeNotes}
                    onChange={(event) => setCloseNotes(event.target.value)}
                    placeholder="Nota opcional de cierre"
                  />
                  <button
                    type="button"
                    onClick={() => handleClose(ticket.id)}
                    disabled={actionInProgress === ticket.id}
                    className="inline-flex h-10 items-center justify-center gap-1.5 rounded-md border border-[#128C7E] bg-white px-3 text-xs font-semibold text-[#0E766A] transition hover:bg-[#DDF4EF] disabled:opacity-60"
                  >
                    {actionInProgress === ticket.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <CheckCircle2 className="h-3.5 w-3.5" />
                    )}
                    Cerrar
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
