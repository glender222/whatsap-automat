import { useEffect, useRef, useState, type FormEvent } from 'react';
import { isAxiosError } from 'axios';
import { ChevronDown, RefreshCw } from 'lucide-react';
import {
  paymentsService, type MercadoPagoObservation, type MercadoPagoReconciliation, type MercadoPagoReconciliationPage,
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

const providerIdPattern = 'ORD(TST)?[0-9A-HJKMNP-TV-Z]{26}';
const lookupErrors: Record<string, string> = {
  CHECKOUT_PROVIDER_ORDER_UNRESOLVED: 'La búsqueda no identificó una orden única. Ingresa el ID que aparece en Mercado Pago.',
  CHECKOUT_PROVIDER_ORDER_CONFLICT: 'El ID ingresado difiere de la orden registrada.',
  CHECKOUT_DISPATCH_NOT_RECONCILABLE: 'El despacho todavía no está disponible para conciliar.',
  CHECKOUT_OBSERVATION_SUPERSEDED: 'Otra consulta actualizó el pedido. Actualiza los registros antes de volver a consultar.',
  PAYMENT_RECONCILIATION_UNAVAILABLE: 'El servidor deshabilitó la conciliación. Puedes seguir consultando los registros.',
  CHECKOUT_INPUT_INVALID: 'Verifica el ID de la orden de Mercado Pago.',
};

type LookupNotice = { kind: 'error'; message: string; observedAt: string | null } | { kind: 'success'; message: string };

function LedgerLookup({ orderId, intentId, observedAt, onObserved }: {
  orderId: string; intentId: string; observedAt: string | null; onObserved: (observation: MercadoPagoObservation) => void;
}) {
  const [checking, setChecking] = useState(false);
  const [notice, setNotice] = useState<LookupNotice>();
  const [showCandidate, setShowCandidate] = useState(false);
  const [candidate, setCandidate] = useState('');
  const request = useRef<AbortController | null>(null);
  const candidateInput = useRef<HTMLInputElement>(null);
  const lookupButton = useRef<HTMLButtonElement>(null);
  const wasCandidateVisible = useRef(false);

  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    if (showCandidate) candidateInput.current?.focus();
    else if (wasCandidateVisible.current) lookupButton.current?.focus();
    wasCandidateVisible.current = showCandidate;
  }, [showCandidate]);

  const reconcile = async (providerOrderId?: string) => {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setChecking(true);
    setNotice(undefined);
    try {
      const observation = await paymentsService.reconcileMercadoPago(intentId, providerOrderId, controller.signal);
      if (controller.signal.aborted) return;
      setNotice({ kind: 'success', message: `Consulta registrada. ${labels[observation.state]}.` });
      setShowCandidate(false);
      setCandidate('');
      onObserved(observation);
    } catch (cause: unknown) {
      if (controller.signal.aborted) return;
      const response = isAxiosError<{ error?: string }>(cause) ? cause.response : undefined;
      const code = response?.data?.error;
      if (code === 'CHECKOUT_PROVIDER_ORDER_UNRESOLVED') setShowCandidate(true);
      const message = (code && lookupErrors[code]) || (response?.status === 403
        ? 'Solo administradores activos pueden conciliar el pedido.'
        : 'No se pudo conciliar el pedido. Actualiza los registros antes de volver a consultar.');
      setNotice({ kind: 'error', message, observedAt });
    } finally {
      request.current = null;
      if (!controller.signal.aborted) setChecking(false);
    }
  };

  return (
    <div className="space-y-2 sm:col-span-2 lg:col-span-3">
      {!showCandidate ? (
        <button ref={lookupButton} type="button" className="admin-button-secondary" disabled={checking}
          aria-label={`Consultar y conciliar el pedido #${orderId}`}
          aria-describedby="mercadopago-reconciliation-effect" onClick={() => void reconcile()}>
          Consultar y conciliar
        </button>
      ) : (
        <form className="flex min-w-0 flex-wrap items-end gap-2" onSubmit={(event) => {
          event.preventDefault();
          void reconcile(candidate.trim());
        }}>
          <label className="flex min-w-0 flex-col gap-1 text-sm font-semibold text-primary">
            ID de la orden de Mercado Pago
            <input ref={candidateInput} className="admin-control" type="text" value={candidate} onChange={(event) => setCandidate(event.target.value)}
              required maxLength={32} pattern={providerIdPattern} disabled={checking} spellCheck={false} />
          </label>
          <button type="submit" className="admin-button-secondary" disabled={checking}
            aria-describedby="mercadopago-reconciliation-effect">Verificar ID y conciliar</button>
          <button type="button" className="admin-button-secondary" disabled={checking} onClick={() => {
            setShowCandidate(false);
            setCandidate('');
            setNotice(undefined);
          }}>Cancelar</button>
        </form>
      )}
      {checking && <p role="status" className="text-sm text-secondary">Consultando a Mercado Pago…</p>}
      {notice?.kind === 'success' && <p role="status" className="text-sm font-medium text-emerald-800 dark:text-emerald-300">{notice.message}</p>}
      {notice?.kind === 'error' && notice.observedAt === observedAt && <p role="alert" className="text-sm font-medium text-red-700 dark:text-red-300">{notice.message}</p>}
    </div>
  );
}

function LedgerRow({ row, canReconcile, onObserved }: {
  row: MercadoPagoReconciliation;
  canReconcile: boolean;
  onObserved: (observation: MercadoPagoObservation) => void;
}) {
  const review = row.state === 'review_required';
  const tone = review ? 'bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-200' : row.state === 'settled'
    ? 'bg-emerald-50 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200' : 'bg-canvas text-secondary';
  return (
    <li className="grid gap-x-5 gap-y-3 py-4 sm:grid-cols-2 lg:grid-cols-[1fr_1.3fr_1fr]">
      <div>
        <p className="font-semibold text-primary">Pedido #{row.orderId}</p>
        {row.providerOrderId && <dl className="mt-1 text-xs text-secondary">
          <dt>Orden del proveedor</dt>
          <dd className="break-all font-mono">{row.providerOrderId}</dd>
        </dl>}
      </div>
      <div>
        <span className={`inline-flex rounded-md px-2 py-1 text-xs font-semibold ${tone}`}>{labels[row.state]}</span>
        {review && <p className="mt-1 text-xs text-amber-900 dark:text-amber-200">
          {(row.reviewCode && reviewReasons[row.reviewCode]) || 'Revisa la orden en la cuenta del proveedor.'}
        </p>}
        <dl className="mt-2 space-y-1 text-xs text-secondary">
          <div className="flex flex-wrap gap-x-1"><dt>Observado</dt><dd><LedgerDate value={row.observedAt} /></dd></div>
          {row.settledAt && <div className="flex flex-wrap gap-x-1">
            <dt>Liquidado</dt><dd><LedgerDate value={row.settledAt} /></dd>
          </div>}
        </dl>
      </div>
      <dl className="space-y-1 text-sm text-primary">
        <div className="flex flex-wrap gap-x-2"><dt className="text-secondary">Esperado</dt>
          <dd className="font-semibold tabular-nums">{amountFormat.format(Number(row.expectedAmount))}</dd>
        </div>
        <div className="flex flex-wrap gap-x-2"><dt className="text-secondary">Pagado observado</dt>
          <dd className="font-semibold tabular-nums">{row.amountPaid === null ? 'Sin importe' : amountFormat.format(Number(row.amountPaid))}</dd>
        </div>
      </dl>
      {canReconcile && row.intentId && <LedgerLookup key={row.intentId} orderId={row.orderId} intentId={row.intentId}
        observedAt={row.observedAt} onObserved={onObserved} />}
    </li>
  );
}

type LoadResult = { query: string; attempt: number; page?: MercadoPagoReconciliationPage; error?: string };

type ReconciliationProps = { onPaymentSettled: () => void; orderId?: string };

function LedgerList({ onPaymentSettled, orderId: scopedOrderId }: ReconciliationProps) {
  const [search, setSearch] = useState('');
  const [filteredOrderId, setFilteredOrderId] = useState('');
  const orderId = scopedOrderId ?? filteredOrderId;
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const [attempt, setAttempt] = useState(0);
  const [response, setResponse] = useState<LoadResult>();
  const beforeOrderId = cursors[cursors.length - 1];
  const query = `${orderId}/${beforeOrderId ?? ''}`;
  const current = response?.query === query ? response : undefined;
  const loading = current?.attempt !== attempt;
  const ledgerPage = current?.page;

  useEffect(() => {
    const controller = new AbortController();
    paymentsService.listMercadoPagoReconciliations({ orderId, beforeOrderId }, controller.signal).then((page) => {
      if (!controller.signal.aborted) setResponse({ query, attempt, page });
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      const status = isAxiosError(error) ? error.response?.status : undefined;
      const message = status === 403
        ? 'Solo administradores activos pueden consultar la conciliación.'
        : status === 400
          ? 'Verifica el número de pedido.'
          : 'No se pudo cargar la conciliación. Vuelve a intentar.';
      setResponse((previous) => ({
        query, attempt, error: message,
        page: status !== 401 && status !== 403 && previous?.query === query ? previous.page : undefined,
      }));
    });
    return () => controller.abort();
  }, [orderId, beforeOrderId, query, attempt]);

  const refresh = () => setAttempt((value) => value + 1);
  const refreshObservation = (previousRow: MercadoPagoReconciliation, observation: MercadoPagoObservation) => {
    setResponse((previous) => previous?.query === query && previous.page ? {
      ...previous,
      page: { ...previous.page, rows: previous.page.rows.map((row) => row.orderId === previousRow.orderId ? { ...row, ...observation } : row) },
    } : previous);
    refresh();
    if (observation.settledAt && !previousRow.settledAt) onPaymentSettled();
  };
  const filter = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFilteredOrderId(search.trim());
    setCursors([null]);
    refresh();
  };

  return (
    <div className="space-y-4 border-t border-subtle px-4 py-4 sm:px-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        {scopedOrderId ? <p className="text-sm font-semibold text-primary">Conciliación del pedido #{scopedOrderId}</p> : <form onSubmit={filter} className="flex min-w-0 flex-wrap items-end gap-2">
          <label className="flex min-w-0 flex-col gap-1 text-sm font-semibold text-primary">
            Número de pedido
            <input className="admin-control max-w-44" type="text" inputMode="numeric" pattern="[1-9][0-9]{0,18}"
              maxLength={19} placeholder="Todos los pedidos" value={search} onChange={(event) => setSearch(event.target.value)} />
          </label>
          <button type="submit" className="admin-button-secondary">Filtrar</button>
          {orderId && <button type="button" className="admin-button-secondary" onClick={() => {
            setSearch('');
            setFilteredOrderId('');
            setCursors([null]);
          }}>Quitar filtro</button>}
        </form>}
        <button type="button" className="admin-button-secondary" onClick={refresh} disabled={loading}>
          <RefreshCw className="h-4 w-4" aria-hidden="true" /> Actualizar conciliación
        </button>
      </div>

      {loading && <p role="status" className="text-sm text-secondary">Cargando conciliación…</p>}
      {!loading && current?.error && <p role="alert" className="text-sm font-medium text-red-700 dark:text-red-300">{current.error}</p>}
      {ledgerPage && (
        <>
          <p id="mercadopago-reconciliation-effect" className="text-sm text-secondary">
            {ledgerPage.canReconcile
              ? 'Si Mercado Pago acredita el importe total y el pedido sigue vigente, la consulta puede confirmarlo y registrar el pago.'
              : 'Solo lectura. La consulta directa a Mercado Pago está deshabilitada.'}
          </p>
          {ledgerPage.rows.length === 0 ? <p role="status" className="text-sm text-secondary">
            {orderId ? 'Este pedido no tiene observaciones de conciliación.' : 'Todavía no hay registros de Mercado Pago.'}
          </p> : (
            <>
              <p role="status" className="sr-only">{ledgerPage.rows.length === 1 ? '1 registro' : `${ledgerPage.rows.length} registros`} en esta página.</p>
              <ul aria-label="Registros de conciliación" className="divide-y divide-subtle border-y border-subtle">
                {ledgerPage.rows.map((row) => <LedgerRow key={row.orderId} row={row} canReconcile={ledgerPage.canReconcile}
                  onObserved={(observation) => refreshObservation(row, observation)} />)}
              </ul>
            </>
          )}
          {(cursors.length > 1 || ledgerPage.nextBeforeOrderId) && (
            <nav aria-label="Páginas de conciliación" className="flex flex-wrap items-center gap-2">
              <button type="button" className="admin-button-secondary" disabled={loading || cursors.length === 1}
                onClick={() => setCursors((values) => values.slice(0, -1))}>Anterior</button>
              <span className="px-2 text-sm text-secondary" role="status">Página {cursors.length}</span>
              <button type="button" className="admin-button-secondary" disabled={loading || !ledgerPage.nextBeforeOrderId}
                onClick={() => setCursors((values) => [...values, ledgerPage.nextBeforeOrderId])}>Siguiente</button>
            </nav>
          )}
        </>
      )}
    </div>
  );
}

export default function MercadoPagoReconciliationPanel({ onPaymentSettled, orderId }: ReconciliationProps) {
  const [expanded, setExpanded] = useState(false);
  return (
    <section aria-labelledby="mercadopago-reconciliation-title" className="rounded-xl border border-subtle bg-surface shadow-sm">
      <header className="flex flex-wrap items-center justify-between gap-3 p-4 sm:px-5">
        <div>
          <h3 id="mercadopago-reconciliation-title" className="font-semibold text-primary">Conciliación Mercado Pago</h3>
          <p className="mt-1 text-sm text-secondary">Consulta los pagos en línea y los casos que requieren revisión.</p>
        </div>
        <button type="button" aria-expanded={expanded} aria-controls="mercadopago-reconciliation-list"
          className="admin-button-secondary" onClick={() => setExpanded((value) => !value)}>
          {expanded ? 'Ocultar registros' : 'Ver registros'}
          <ChevronDown className={`h-4 w-4 ${expanded ? 'rotate-180' : ''}`} aria-hidden="true" />
        </button>
      </header>
      <div id="mercadopago-reconciliation-list" hidden={!expanded}>
        {expanded && <LedgerList key={orderId ?? 'all'} onPaymentSettled={onPaymentSettled} orderId={orderId} />}
      </div>
    </section>
  );
}
