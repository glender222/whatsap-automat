import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { isAxiosError } from 'axios';
import { Link } from 'react-router-dom';
import { CheckCircle2, ExternalLink, FileText, Image as ImageIcon, Loader2, XCircle } from 'lucide-react';
import {
  type PaymentMethod,
  type PaymentProcessStatus,
  type PaymentProcessSummary,
  type PaymentVoucherStatus,
  paymentsService,
} from '../services/paymentsService';

type LoadState = 'loading' | 'ready' | 'error';
type StatusFilter = 'all' | 'collect_payment' | PaymentVoucherStatus;

const STATUS_TONE: Record<PaymentProcessStatus, string> = {
  collect_payment: 'bg-blue-50 text-blue-700 border-blue-200',
  voucher_pending: 'bg-amber-50 text-amber-700 border-amber-200',
  validated: 'bg-[#006d2f]/10 text-[#006d2f] border-[#006d2f]/20',
  rejected: 'bg-red-50 text-red-700 border-red-200',
};

const STATUS_LABEL: Record<PaymentProcessStatus, string> = {
  collect_payment: 'Por cobrar',
  voucher_pending: 'Comprobante pendiente',
  validated: 'Validado',
  rejected: 'Rechazado',
};

const METHOD_LABEL: Record<PaymentMethod, string> = {
  yape: 'Yape',
  plin: 'Plin',
  bank_transfer: 'Transferencia',
  cash: 'Efectivo',
  other: 'Otro',
};

const ORDER_STATUS_LABEL: Record<string, string> = {
  draft: 'Borrador',
  quoted: 'Cotizado',
  pending_handoff: 'Requiere humano',
  pending_approval: 'Requiere aprobación',
  confirmed: 'Confirmado',
  reserved: 'Reservado',
  cancelled: 'Cancelado',
  completed: 'Completado',
};

function formatAmount(amount: number | null, currency: string): string {
  if (amount === null || amount === undefined) return '-';
  return new Intl.NumberFormat('es-PE', { style: 'currency', currency }).format(amount);
}

function formatDate(value: string | null): string {
  if (!value) return '-';
  return new Intl.DateTimeFormat('es-PE', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(value));
}

function PaymentDialog({ titleId, onClose, wide, children }: {
  titleId: string;
  onClose: () => void;
  wide?: boolean;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const trigger = document.activeElement;
    dialog.showModal();
    dialog.querySelector<HTMLElement>('[data-payment-initial-focus]')?.focus();
    return () => {
      dialog.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
      className={`fixed inset-0 m-auto max-h-[calc(100dvh_-_2rem)] w-[calc(100%_-_2rem)] overflow-y-auto rounded-2xl border-0 bg-white p-0 shadow-xl backdrop:bg-black/40 ${wide ? 'max-w-2xl' : 'max-w-md'}`}
    >
      <div className="p-6">{children}</div>
    </dialog>
  );
}

function VoucherPreview({ fileUrl }: { fileUrl: string }) {
  const [preview, setPreview] = useState<{ url: string; isImage: boolean } | 'error'>();
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | undefined;
    paymentsService.getVoucherFile(fileUrl, controller.signal)
      .then((blob) => {
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setPreview({ url: objectUrl, isImage: blob.type.startsWith('image/') });
      })
      .catch(() => {
        if (!controller.signal.aborted) setPreview('error');
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attempt, fileUrl]);

  return (
    <section aria-label="Comprobante de pago" className="mt-4 space-y-2 rounded-xl border border-[#D9E5DF] p-4">
      {!preview ? <p role="status" className="text-sm text-[#5B6F66]">Cargando comprobante…</p> :
        preview === 'error' ? (
          <div className="space-y-2">
            <p role="alert" className="text-sm text-red-700">No se pudo abrir el comprobante.</p>
            <button type="button" className="admin-button-secondary" onClick={() => {
              setPreview(undefined);
              setAttempt((value) => value + 1);
            }}>Volver a intentar</button>
          </div>
        ) : (
          <>
            {preview.isImage && <img src={preview.url} alt="Comprobante de pago" className="mx-auto max-h-52 max-w-full rounded-lg object-contain" />}
            <a href={preview.url} target="_blank" rel="noopener noreferrer" className="admin-button-secondary">
              <ExternalLink className="h-4 w-4" aria-hidden="true" />
              Abrir comprobante en otra pestaña
            </a>
          </>
        )}
    </section>
  );
}

function productSummary(row: PaymentProcessSummary): string {
  if (!row.items.length) return 'Sin items asociados';
  const [first, ...rest] = row.items;
  return `${first.quantity} x ${first.productName}${rest.length ? ` +${rest.length}` : ''}`;
}

export default function PaymentsPage() {
  const [rows, setRows] = useState<PaymentProcessSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [actionInProgress, setActionInProgress] = useState<number | null>(null);
  const [validationError, setValidationError] = useState<{ voucherId: number; message: string } | null>(null);
  const [rejecting, setRejecting] = useState<{ id: number; reason: string } | null>(null);
  const [selectedRow, setSelectedRow] = useState<PaymentProcessSummary | null>(null);

  const load = useCallback(async () => {
    setLoadState('loading');
    try {
      const data = await paymentsService.list({
        status: statusFilter === 'all' || statusFilter === 'collect_payment' ? undefined : statusFilter,
        limit: 100,
      });
      const filteredRows = statusFilter === 'collect_payment'
        ? data.rows.filter((row) => row.processStatus === 'collect_payment')
        : data.rows;
      setRows(filteredRows);
      setTotal(statusFilter === 'collect_payment' ? filteredRows.length : data.total);
      setLoadState('ready');
    } catch (error) {
      console.error('Error cargando proceso de pagos:', error);
      setLoadState('error');
    }
  }, [statusFilter]);

  useEffect(() => {
    load();
  }, [load]);

  const handleValidate = async (id: number) => {
    setActionInProgress(id);
    setValidationError(null);
    try {
      await paymentsService.validate(id);
      await load();
    } catch (error) {
      const message = isAxiosError<{ message?: unknown }>(error) && error.response?.status === 409
        ? error.response.data?.message
        : undefined;
      setValidationError({
        voucherId: id,
        message: typeof message === 'string' && message.trim()
          ? message
          : 'No se pudo validar el comprobante. Actualiza los pagos antes de reintentar.',
      });
    } finally {
      setActionInProgress(null);
    }
  };

  const handleReject = async () => {
    if (!rejecting || !rejecting.reason.trim()) return;
    setActionInProgress(rejecting.id);
    try {
      await paymentsService.reject(rejecting.id, rejecting.reason.trim());
      setRejecting(null);
      await load();
    } catch (error) {
      console.error('Error rechazando comprobante:', error);
    } finally {
      setActionInProgress(null);
    }
  };

  const handleCancelOrder = async (orderId: number) => {
    setActionInProgress(orderId);
    try {
      await paymentsService.cancelOrder(orderId);
      if (selectedRow?.orderId === orderId) setSelectedRow(null);
      await load();
    } catch (error) {
      console.error('Error cancelando pedido:', error);
    } finally {
      setActionInProgress(null);
    }
  };

  return (
    <div className="min-h-full bg-[#F7FAF8] p-6 lg:p-10">
      <div className="mx-auto w-full max-w-7xl space-y-6 pb-20">
        <section className="flex flex-col gap-3 border-b border-[#D9E5DF] pb-5 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase text-[#128C7E]">Operaciones</p>
            <h2 className="mt-1 text-3xl font-bold text-[#10231C]">Validar Pagos</h2>
            <p className="mt-2 text-sm text-[#5B6F66]">
              Proceso de cobro IA y comprobantes · {total} {total === 1 ? 'caso' : 'casos'}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {([
              ['all', 'Todos'],
              ['collect_payment', 'Por cobrar'],
              ['pending', 'Con voucher'],
              ['validated', 'Validados'],
              ['rejected', 'Rechazados'],
            ] as Array<[StatusFilter, string]>).map(([option, label]) => {
              const isActive = statusFilter === option;
              return (
                <button
                  key={option}
                  type="button"
                  onClick={() => setStatusFilter(option)}
                  className={`rounded-full border px-4 py-2 text-xs font-semibold transition ${
                    isActive
                      ? 'border-[#128C7E] bg-[#DDF4EF] text-[#128C7E]'
                      : 'border-[#D9E5DF] bg-white text-[#5B6F66] hover:bg-[#EEF4F1]'
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </section>

        <section className="overflow-hidden rounded-2xl border border-[#D9E5DF] bg-white shadow-sm">
          {loadState === 'loading' && rows.length === 0 ? (
            <div className="flex h-48 items-center justify-center text-[#5B6F66]">
              <Loader2 className="h-6 w-6 animate-spin text-[#128C7E]" />
            </div>
          ) : loadState === 'error' ? (
            <div className="flex h-48 items-center justify-center text-sm text-[#5B6F66]">
              No se pudo cargar el proceso de pagos.
            </div>
          ) : rows.length === 0 ? (
            <div className="flex h-48 flex-col items-center justify-center text-center text-sm text-[#5B6F66]">
              <FileText className="mb-2 h-6 w-6 text-[#128C7E]/60" />
              No hay casos para este filtro.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-[#D9E5DF] bg-[#F7FAF8] text-xs uppercase tracking-wide text-[#5B6F66]">
                  <tr>
                    <th className="px-4 py-3 font-semibold">Cliente / Chat</th>
                    <th className="px-4 py-3 font-semibold">Pedido</th>
                    <th className="px-4 py-3 font-semibold">Total</th>
                    <th className="px-4 py-3 font-semibold">Pago</th>
                    <th className="px-4 py-3 font-semibold">Comprobante</th>
                    <th className="px-4 py-3 font-semibold">Fecha</th>
                    <th className="px-4 py-3 text-right font-semibold">Acciones</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#D9E5DF]">
                  {rows.map((row) => (
                    <tr key={row.rowId} className="transition-colors hover:bg-[#F7FAF8]">
                      <td className="px-4 py-3">
                        <div className="font-semibold text-[#10231C]">{row.customerName}</div>
                        {row.chatId && (
                          <div className="flex items-center gap-1 text-xs text-[#5B6F66]">
                            {row.chatId}
                            <Link to={`/gestion-web/inicio?chat=${encodeURIComponent(row.chatId)}`} className="text-[#128C7E]" aria-label="Abrir conversación">
                              <ExternalLink className="h-3 w-3" aria-hidden="true" />
                            </Link>
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-semibold text-[#10231C]">
                          {row.orderId ? `#${row.orderId}` : 'Sin pedido'}
                        </div>
                        <div className="text-xs text-[#5B6F66]">{productSummary(row)}</div>
                        {row.orderStatus && (
                          <div className="mt-1 text-[11px] font-semibold uppercase text-[#128C7E]">
                            {ORDER_STATUS_LABEL[row.orderStatus] || row.orderStatus}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-[#10231C]">
                        {formatAmount(row.orderTotal ?? row.amount, row.currency)}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${STATUS_TONE[row.processStatus]}`}
                        >
                          {STATUS_LABEL[row.processStatus]}
                        </span>
                        <div className="mt-1 text-xs text-[#5B6F66]">
                          {row.paymentMethod ? METHOD_LABEL[row.paymentMethod] : 'Metodo por definir'}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        {row.fileUrl ? (
                          <button type="button" onClick={() => setSelectedRow(row)} className="admin-button-secondary whitespace-nowrap text-xs">
                            {row.mimeType?.startsWith('image/') ? <ImageIcon className="h-4 w-4" aria-hidden="true" /> : <FileText className="h-4 w-4" aria-hidden="true" />}
                            Ver comprobante
                          </button>
                        ) : <span className="text-xs text-[#5B6F66]">Sin voucher</span>}
                      </td>
                      <td className="px-4 py-3 text-xs text-[#5B6F66]">
                        {formatDate(row.uploadedAt || row.orderCreatedAt)}
                      </td>
                      <td className="px-4 py-3">
                        {row.voucherStatus === 'pending' && row.voucherId ? (
                          <div className="flex flex-wrap justify-end gap-2">
                            <button
                              type="button"
                              onClick={() => setSelectedRow(row)}
                              className="inline-flex items-center gap-1.5 rounded-lg border border-[#D9E5DF] bg-white px-3 py-1.5 text-xs font-semibold text-[#5B6F66] transition hover:bg-[#EEF4F1]"
                            >
                              Detalle
                            </button>
                            <button
                              type="button"
                              onClick={() => handleValidate(row.voucherId!)}
                              disabled={actionInProgress === row.voucherId}
                              className="inline-flex items-center gap-1.5 rounded-lg bg-[#128C7E] px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-[#0E766A] disabled:opacity-60"
                            >
                              {actionInProgress === row.voucherId ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <CheckCircle2 className="h-3.5 w-3.5" />
                              )}
                              Validar
                            </button>
                            <button
                              type="button"
                              onClick={() => setRejecting({ id: row.voucherId!, reason: '' })}
                              disabled={actionInProgress === row.voucherId}
                              className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-semibold text-red-600 transition hover:bg-red-50 disabled:opacity-60"
                            >
                              <XCircle className="h-3.5 w-3.5" />
                              Rechazar
                            </button>
                          </div>
                        ) : row.processStatus === 'collect_payment' ? (
                          <div className="flex flex-wrap justify-end gap-2">
                            <button
                              type="button"
                              onClick={() => setSelectedRow(row)}
                              className="inline-flex items-center gap-1.5 rounded-lg border border-[#D9E5DF] bg-white px-3 py-1.5 text-xs font-semibold text-[#5B6F66] transition hover:bg-[#EEF4F1]"
                            >
                              Detalle
                            </button>
                            {row.orderId && (
                              <button
                                type="button"
                                onClick={() => handleCancelOrder(row.orderId!)}
                                disabled={actionInProgress === row.orderId}
                                className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-semibold text-red-600 transition hover:bg-red-50 disabled:opacity-60"
                              >
                                {actionInProgress === row.orderId ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <XCircle className="h-3.5 w-3.5" />}
                                Cancelar
                              </button>
                            )}
                          </div>
                        ) : (
                          <div className="flex flex-col items-end gap-1">
                            <button
                              type="button"
                              onClick={() => setSelectedRow(row)}
                              className="inline-flex items-center gap-1.5 rounded-lg border border-[#D9E5DF] bg-white px-3 py-1.5 text-xs font-semibold text-[#5B6F66] transition hover:bg-[#EEF4F1]"
                            >
                              Detalle
                            </button>
                            <span className="text-xs text-[#5B6F66]">
                              {row.validatedAt ? formatDate(row.validatedAt) : '-'}
                            </span>
                          </div>
                        )}
                        {validationError && validationError.voucherId === row.voucherId && (
                          <p role="alert" className="mt-2 max-w-56 text-right text-xs text-red-700">
                            {validationError.message}
                          </p>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      {rejecting && (
        <PaymentDialog titleId="reject-payment-title" onClose={() => setRejecting(null)}>
            <h3 id="reject-payment-title" className="mb-2 text-lg font-bold text-[#10231C]">Rechazar comprobante</h3>
            <p className="mb-4 text-sm text-[#5B6F66]">
              Indica el motivo del rechazo. El pedido seguira pendiente para coordinar otro comprobante o cancelarlo.
            </p>
            <textarea
              value={rejecting.reason}
              onChange={(event) => setRejecting({ ...rejecting, reason: event.target.value })}
              rows={3}
              aria-label="Motivo del rechazo"
              placeholder="Ej: Monto no coincide con el total del pedido."
              className="admin-textarea"
              data-payment-initial-focus=""
            />
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setRejecting(null)}
                className="admin-button-secondary"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={handleReject}
                disabled={!rejecting.reason.trim() || actionInProgress === rejecting.id}
                className="inline-flex h-11 items-center justify-center gap-2 rounded-[10px] bg-red-600 px-4 text-sm font-semibold text-white transition hover:bg-red-700 disabled:opacity-60"
              >
                {actionInProgress === rejecting.id && (
                  <Loader2 className="h-4 w-4 animate-spin" />
                )}
                Confirmar rechazo
              </button>
            </div>
        </PaymentDialog>
      )}

      {selectedRow && (
        <PaymentDialog titleId="payment-detail-title" onClose={() => setSelectedRow(null)} wide>
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h3 id="payment-detail-title" tabIndex={-1} data-payment-initial-focus="" className="text-lg font-bold text-[#10231C]">
                  {selectedRow.orderId ? `Pedido #${selectedRow.orderId}` : 'Comprobante sin pedido'}
                </h3>
                <p className="text-sm text-[#5B6F66]">
                  {selectedRow.customerName} · {selectedRow.chatId || 'sin chat'}
                </p>
              </div>
              <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${STATUS_TONE[selectedRow.processStatus]}`}>
                {STATUS_LABEL[selectedRow.processStatus]}
              </span>
            </div>

            {selectedRow.fileUrl && <VoucherPreview key={selectedRow.fileUrl} fileUrl={selectedRow.fileUrl} />}

            <div className="mt-4 overflow-x-auto rounded-xl border border-[#D9E5DF]">
              <table className="w-full text-left text-sm">
                <thead className="bg-[#F7FAF8] text-xs uppercase text-[#5B6F66]">
                  <tr>
                    <th className="px-3 py-2">Producto</th>
                    <th className="px-3 py-2">Cantidad</th>
                    <th className="px-3 py-2">Precio</th>
                    <th className="px-3 py-2">Subtotal</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#D9E5DF]">
                  {selectedRow.items.length ? selectedRow.items.map((item) => (
                    <tr key={item.id}>
                      <td className="px-3 py-2 font-semibold text-[#10231C]">{item.productName}</td>
                      <td className="px-3 py-2 text-[#5B6F66]">{item.quantity}</td>
                      <td className="px-3 py-2 text-[#5B6F66]">{formatAmount(item.unitPrice, item.currency)}</td>
                      <td className="px-3 py-2 text-[#10231C]">{formatAmount(item.unitPrice === null ? null : item.unitPrice * item.quantity, item.currency)}</td>
                    </tr>
                  )) : (
                    <tr>
                      <td colSpan={4} className="px-3 py-6 text-center text-[#5B6F66]">Sin items asociados.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="mt-4 grid gap-3 rounded-xl bg-[#F7FAF8] p-4 text-sm md:grid-cols-3">
              <div>
                <p className="text-xs font-bold uppercase text-[#5B6F66]">Total pedido</p>
                <p className="mt-1 font-bold text-[#10231C]">{formatAmount(selectedRow.orderTotal, selectedRow.currency)}</p>
              </div>
              <div>
                <p className="text-xs font-bold uppercase text-[#5B6F66]">Metodo</p>
                <p className="mt-1 font-bold text-[#10231C]">{selectedRow.paymentMethod ? METHOD_LABEL[selectedRow.paymentMethod] : 'Por definir'}</p>
              </div>
              <div>
                <p className="text-xs font-bold uppercase text-[#5B6F66]">Estado pedido</p>
                <p className="mt-1 font-bold text-[#10231C]">{selectedRow.orderStatus ? ORDER_STATUS_LABEL[selectedRow.orderStatus] || selectedRow.orderStatus : '-'}</p>
              </div>
            </div>

            <div className="mt-5 flex flex-wrap justify-end gap-2">
              {selectedRow.orderId && selectedRow.processStatus === 'collect_payment' && (
                <button
                  type="button"
                  onClick={() => handleCancelOrder(selectedRow.orderId!)}
                  disabled={actionInProgress === selectedRow.orderId}
                  className="inline-flex h-10 items-center justify-center gap-2 rounded-[10px] border border-red-200 bg-white px-4 text-sm font-semibold text-red-600 transition hover:bg-red-50 disabled:opacity-60"
                >
                  {actionInProgress === selectedRow.orderId && <Loader2 className="h-4 w-4 animate-spin" />}
                  Cancelar pedido
                </button>
              )}
              <button
                type="button"
                onClick={() => setSelectedRow(null)}
                className="admin-button-secondary"
              >
                Cerrar
              </button>
            </div>
        </PaymentDialog>
      )}
    </div>
  );
}
