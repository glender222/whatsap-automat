import { useEffect, useState, type FormEvent } from 'react';
import { isAxiosError } from 'axios';
import { ChevronDown, RefreshCw } from 'lucide-react';
import {
  paymentsService, type MercadoPagoReconciliation, type MercadoPagoReconciliationPage,
} from '../services/paymentsService';

const labels: Record<MercadoPagoReconciliation['state'], string> = {
  awaiting_observation: 'Sin observación',
  unpaid: 'Sin pago',
  pending: 'En proceso',
  failed: 'Fallido',
  partial: 'Pago parcial',
  settled: 'Liquidado',
  review_required: 'Requiere revisión',
};

const reviewReasons: Record<string, string> = {
  provider_inconsistent: 'La evidencia del proveedor es incompatible.',
  provider_credit_decreased: 'Disminuyó el importe acreditado.',
  settled_payment_changed: 'Cambió un pago que ya se había liquidado.',
  intent_changed: 'La intención de cobro cambió.',
  order_changed: 'El pedido o las condiciones de cobro cambiaron.',
  gateway_changed: 'La pasarela ya no coincide con la configuración original.',
  voucher_pending: 'Hay un comprobante manual pendiente.',
  voucher_validated: 'Ya existe un comprobante validado.',
  checkout_expired: 'Venció el plazo de cobro o la reserva.',
};

const amountFormat = new Intl.NumberFormat('es-PE', { style: 'currency', currency: 'PEN' });
const dateFormat = new Intl.DateTimeFormat('es-PE', { dateStyle: 'short', timeStyle: 'short' });

function LedgerDate({ value }: { value: string | null }) {
  return value ? <time dateTime={value}>{dateFormat.format(new Date(value))}</time> : 'Sin registro';
}

function LedgerRow({ row }: { row: MercadoPagoReconciliation }) {
  const review = row.state === 'review_required';
  const tone = review ? 'bg-amber-50 text-amber-900' : row.state === 'settled'
    ? 'bg-emerald-50 text-emerald-900' : 'bg-gray-100 text-gray-800';
  return (
    <li className="grid gap-x-5 gap-y-3 py-4 sm:grid-cols-2 lg:grid-cols-[1fr_1.3fr_1fr]">
      <div>
        <p className="font-semibold text-[#10231C]">Pedido #{row.orderId}</p>
        {row.providerOrderId && <dl className="mt-1 text-xs text-[#5B6F66]">
          <dt>Orden del proveedor</dt>
          <dd className="break-all font-mono">{row.providerOrderId}</dd>
        </dl>}
      </div>
      <div>
        <span className={`inline-flex rounded-md px-2 py-1 text-xs font-semibold ${tone}`}>{labels[row.state]}</span>
        {review && <p className="mt-1 text-xs text-amber-900">
          {(row.reviewCode && reviewReasons[row.reviewCode]) || 'Revisa la orden en la cuenta del proveedor.'}
        </p>}
        <dl className="mt-2 space-y-1 text-xs text-[#5B6F66]">
          <div className="flex flex-wrap gap-x-1"><dt>Observado</dt><dd><LedgerDate value={row.observedAt} /></dd></div>
          {row.settledAt && <div className="flex flex-wrap gap-x-1">
            <dt>Liquidado</dt><dd><LedgerDate value={row.settledAt} /></dd>
          </div>}
        </dl>
      </div>
      <dl className="space-y-1 text-sm text-[#10231C]">
        <div className="flex flex-wrap gap-x-2"><dt className="text-[#5B6F66]">Esperado</dt>
          <dd className="font-semibold tabular-nums">{amountFormat.format(Number(row.expectedAmount))}</dd>
        </div>
        <div className="flex flex-wrap gap-x-2"><dt className="text-[#5B6F66]">Pagado observado</dt>
          <dd className="font-semibold tabular-nums">{row.amountPaid === null ? 'Sin importe' : amountFormat.format(Number(row.amountPaid))}</dd>
        </div>
      </dl>
    </li>
  );
}

type LoadResult = { key: string } & ({ page: MercadoPagoReconciliationPage } | { error: string });

function LedgerList() {
  const [search, setSearch] = useState('');
  const [orderId, setOrderId] = useState('');
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const [attempt, setAttempt] = useState(0);
  const [response, setResponse] = useState<LoadResult>();
  const beforeOrderId = cursors[cursors.length - 1];
  const key = `${orderId}/${beforeOrderId ?? ''}/${attempt}`;
  const current = response?.key === key ? response : undefined;

  useEffect(() => {
    const controller = new AbortController();
    paymentsService.listMercadoPagoReconciliations({ orderId, beforeOrderId }, controller.signal).then((page) => {
      if (!controller.signal.aborted) setResponse({ key, page });
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      const status = isAxiosError(error) ? error.response?.status : undefined;
      const message = status === 403
        ? 'Solo administradores activos pueden consultar la conciliación.'
        : status === 400
          ? 'Verifica el número de pedido.'
          : 'No se pudo cargar la conciliación. Vuelve a intentar.';
      setResponse({ key, error: message });
    });
    return () => controller.abort();
  }, [orderId, beforeOrderId, key]);

  const refresh = () => setAttempt((value) => value + 1);
  const filter = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setOrderId(search.trim());
    setCursors([null]);
    refresh();
  };

  return (
    <div className="space-y-4 border-t border-[#D9E5DF] px-4 py-4 sm:px-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <form onSubmit={filter} className="flex min-w-0 flex-wrap items-end gap-2">
          <label className="flex min-w-0 flex-col gap-1 text-sm font-semibold text-[#10231C]">
            Número de pedido
            <input className="admin-control max-w-44" type="text" inputMode="numeric" pattern="[1-9][0-9]{0,18}"
              maxLength={19} placeholder="Todos los pedidos" value={search} onChange={(event) => setSearch(event.target.value)} />
          </label>
          <button type="submit" className="admin-button-secondary">Filtrar</button>
          {orderId && <button type="button" className="admin-button-secondary" onClick={() => {
            setSearch('');
            setOrderId('');
            setCursors([null]);
          }}>Quitar filtro</button>}
        </form>
        <button type="button" className="admin-button-secondary" onClick={refresh} disabled={!current}>
          <RefreshCw className="h-4 w-4" aria-hidden="true" /> Actualizar conciliación
        </button>
      </div>

      {!current ? <p role="status" className="text-sm text-[#5B6F66]">Cargando conciliación…</p> :
        'error' in current ? <p role="alert" className="text-sm font-medium text-red-700">{current.error}</p> : (
          <>
            {current.page.rows.length === 0 ? <p role="status" className="text-sm text-[#5B6F66]">
              {orderId ? 'Este pedido no tiene observaciones de conciliación.' : 'Todavía no hay observaciones de Mercado Pago.'}
            </p> : (
              <>
                <p role="status" className="sr-only">{current.page.rows.length === 1 ? '1 registro' : `${current.page.rows.length} registros`} en esta página.</p>
                <ul aria-label="Registros de conciliación" className="divide-y divide-[#D9E5DF] border-y border-[#D9E5DF]">
                  {current.page.rows.map((row) => <LedgerRow key={row.orderId} row={row} />)}
                </ul>
              </>
            )}
            {(cursors.length > 1 || current.page.nextBeforeOrderId) && (
              <nav aria-label="Páginas de conciliación" className="flex flex-wrap items-center gap-2">
                <button type="button" className="admin-button-secondary" disabled={cursors.length === 1}
                  onClick={() => setCursors((values) => values.slice(0, -1))}>Anterior</button>
                <span className="px-2 text-sm text-[#5B6F66]" role="status">Página {cursors.length}</span>
                <button type="button" className="admin-button-secondary" disabled={!current.page.nextBeforeOrderId}
                  onClick={() => setCursors((values) => [...values, current.page.nextBeforeOrderId])}>Siguiente</button>
              </nav>
            )}
          </>
        )}
    </div>
  );
}

export default function MercadoPagoReconciliationPanel() {
  const [expanded, setExpanded] = useState(false);
  return (
    <section aria-labelledby="mercadopago-reconciliation-title" className="rounded-xl border border-[#D9E5DF] bg-white shadow-sm">
      <header className="flex flex-wrap items-center justify-between gap-3 p-4 sm:px-5">
        <div>
          <h3 id="mercadopago-reconciliation-title" className="font-semibold text-[#10231C]">Conciliación Mercado Pago</h3>
          <p className="mt-1 text-sm text-[#5B6F66]">Consulta los pagos en línea y los casos que requieren revisión.</p>
        </div>
        <button type="button" aria-expanded={expanded} aria-controls="mercadopago-reconciliation-list"
          className="admin-button-secondary" onClick={() => setExpanded((value) => !value)}>
          {expanded ? 'Ocultar registros' : 'Ver registros'}
          <ChevronDown className={`h-4 w-4 ${expanded ? 'rotate-180' : ''}`} aria-hidden="true" />
        </button>
      </header>
      <div id="mercadopago-reconciliation-list" hidden={!expanded}>
        {expanded && <LedgerList />}
      </div>
    </section>
  );
}
