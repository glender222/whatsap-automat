import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Plus, RefreshCw } from 'lucide-react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import OrderDraftForm from './OrderDraftForm';
import {
  changeOrderStatus, itemAvailability, listOrders, orderActions, orderError, orderPageSize,
  ordersPath, orderStatus, readOrder, type Order, type OrderAction,
} from './ordersApi';

const secondary = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-gray-300 px-3 text-sm font-semibold hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:hover:bg-gray-800';
const primary = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-emerald-700 px-3 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-50';
const card = 'min-w-0 rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900';
const subtext = 'text-sm text-gray-600 dark:text-gray-300';
const actions: Record<OrderAction, { label: string; consequence: string }> = {
  confirmed: { label: 'Confirmar pedido', consequence: 'El servidor comprobará la disponibilidad y reservará stock o capacidad cuando corresponda.' },
  completed: { label: 'Completar pedido', consequence: 'Al completar, el servidor consumirá las reservas vigentes de este pedido.' },
  cancelled: { label: 'Cancelar pedido', consequence: 'Al cancelar, el servidor liberará las reservas vigentes de este pedido.' },
};

function orderDate(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString('es', { dateStyle: 'medium', timeStyle: 'short' }) : 'Sin fecha';
}
function OrderStatus({ order }: { order: Order }) {
  return <span className="rounded-full bg-gray-100 px-2.5 py-1 text-xs font-semibold dark:bg-gray-800">{orderStatus(order.status)}</span>;
}
function OrderProblem({ message }: { message: string }) {
  return <p role="alert" className="rounded-lg border border-red-200 p-3 text-sm text-red-800 dark:border-red-800 dark:text-red-300">{message}</p>;
}

function OrderList({ page }: { page: number }) {
  const [creating, setCreating] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [response, setResponse] = useState<{ key: string; page?: Awaited<ReturnType<typeof listOrders>>; error?: string }>();
  const navigate = useNavigate();
  const createButton = useRef<HTMLButtonElement>(null);
  const restoreCreateFocus = useRef(false);
  const offset = (page - 1) * orderPageSize;
  const key = offset + '/' + attempt;
  const current = response?.key === key ? response : undefined;
  const rows = current?.page?.rows ?? [];
  const total = current?.page?.total ?? 0;

  useEffect(() => {
    const request = new AbortController();
    listOrders(offset, request.signal).then((result) => {
      if (!request.signal.aborted) setResponse({ key, page: result });
    }).catch((cause) => {
      if (!request.signal.aborted) setResponse({ key, error: orderError(cause, 'No pudimos cargar los pedidos.') });
    });
    return () => request.abort();
  }, [key, offset]);

  useEffect(() => {
    if (!creating && restoreCreateFocus.current) {
      createButton.current?.focus();
      restoreCreateFocus.current = false;
    }
  }, [creating]);

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold">Pedidos</h2>
          <p className={subtext + ' mt-1'}>Consulta los pedidos comerciales y registra cambios de estado.</p>
        </div>
        {!creating && <button ref={createButton} type="button" className={primary} onClick={() => setCreating(true)}>
          <Plus size={16} aria-hidden="true" /> Nuevo prepedido
        </button>}
      </header>
      {creating && <OrderDraftForm onClose={() => { restoreCreateFocus.current = true; setCreating(false); }} onSave={(order) => {
        navigate(ordersPath + '?pedido=' + order.id, { state: { savedOrder: order.id } });
      }} />}
      {!current && <p role="status" className={subtext}>Cargando pedidos…</p>}
      {current?.error && <div className="space-y-2">
        <OrderProblem message={current.error} />
        <button type="button" className={secondary} onClick={() => setAttempt((value) => value + 1)}>Volver a cargar</button>
      </div>}
      {current?.page && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className={subtext} role="status">Página {page} · {total} {total === 1 ? 'pedido' : 'pedidos'} registrados</p>
            <button type="button" className={secondary} onClick={() => setAttempt((value) => value + 1)}>
              <RefreshCw size={16} aria-hidden="true" /> Actualizar listado
            </button>
          </div>
          {rows.length > 0 ? (
            <ul className="divide-y divide-gray-200 rounded-xl border border-gray-200 bg-white dark:divide-gray-700 dark:border-gray-700 dark:bg-gray-900">
              {rows.map((order) => (
                <li key={order.id}>
                  <Link to={ordersPath + '?pedido=' + order.id} className="flex flex-wrap items-start justify-between gap-2 px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-800">
                    <div className="min-w-0">
                      <h3 className="break-words text-sm font-semibold">#{order.id} · {order.title}</h3>
                      <time dateTime={order.occurredAt} className={subtext}>{orderDate(order.occurredAt)}</time>
                    </div>
                    <OrderStatus order={order} />
                  </Link>
                </li>
              ))}
            </ul>
          ) : <p className={card + ' ' + subtext}>{total ? 'No hay pedidos en esta página.' : 'Todavía no hay pedidos registrados en esta empresa.'}</p>}
          {(page > 1 || offset + rows.length < total) && (
            <nav aria-label="Páginas de pedidos" className="flex flex-wrap gap-2">
              {page > 1 && <Link to={ordersPath + '?pagina=' + (page - 1)} className={secondary}>Anterior</Link>}
              {offset + rows.length < total && <Link to={ordersPath + '?pagina=' + (page + 1)} className={secondary}>Siguiente</Link>}
            </nav>
          )}
        </div>
      )}
    </div>
  );
}

function OrderActionDialog({ order, action, onCancel, onConfirm }: { order: Order; action: OrderAction; onCancel: () => void; onConfirm: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const element = dialog.current;
    const previous = document.activeElement;
    element?.showModal();
    cancel.current?.focus();
    return () => {
      element?.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  return (
    <dialog ref={dialog} aria-labelledby="order-action-title" aria-describedby="order-action-description"
      onCancel={(event) => { event.preventDefault(); onCancel(); }}
      className="fixed left-1/2 top-1/2 m-0 w-[calc(100%_-_2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-gray-200 bg-white p-4 text-gray-900 backdrop:bg-gray-950/55 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100">
      <h3 id="order-action-title" className="text-lg font-semibold">{actions[action].label} #{order.id}</h3>
      <p id="order-action-description" className={subtext + ' my-3'}>{actions[action].consequence}</p>
      <div className="flex flex-wrap justify-end gap-2">
        <button ref={cancel} type="button" className={secondary} onClick={onCancel}>Volver</button>
        <button type="button" className={primary} onClick={onConfirm}>{actions[action].label}</button>
      </div>
    </dialog>
  );
}

function OrderDetail({ id }: { id: number }) {
  const { state } = useLocation();
  const [order, setOrder] = useState<Order>();
  const [loadError, setLoadError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [action, setAction] = useState<OrderAction>();
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState<{ message: string; error?: boolean }>();
  const lock = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const request = new AbortController();
    readOrder(id, request.signal).then((result) => {
      if (!request.signal.aborted) setOrder(result);
    }).catch((cause) => {
      if (!request.signal.aborted) setLoadError(orderError(cause, 'No pudimos cargar el pedido.'));
    });
    return () => request.abort();
  }, [attempt, id]);
  useEffect(() => {
    if (order) heading.current?.focus();
  }, [order]);

  function reload() {
    setOrder(undefined);
    setLoadError('');
    setAttempt((value) => value + 1);
  }

  async function update() {
    if (!order || !action || lock.current || !orderActions(order).includes(action)) return;
    lock.current = true;
    setAction(undefined);
    setWorking(true);
    setNotice(undefined);
    try {
      const saved = await changeOrderStatus(order, action);
      setOrder(saved);
      setNotice({ message: 'Estado confirmado por el servidor · ' + orderStatus(saved.status) });
    } catch (cause) {
      setNotice({ message: orderError(cause, 'No pudimos confirmar la operación. Consulta el estado antes de repetirla.'), error: true });
      reload();
    } finally {
      lock.current = false;
      setWorking(false);
    }
  }

  return (
    <div className="space-y-4">
      <Link className={secondary} to={ordersPath}><ArrowLeft size={16} aria-hidden="true" /> Volver a pedidos</Link>
      {loadError && <div className="space-y-2"><OrderProblem message={loadError} />
        <button type="button" className={secondary} onClick={reload}>Volver a cargar</button></div>}
      {!order && !loadError && <p role="status" className={subtext}>Cargando pedido…</p>}
      {notice?.error && <OrderProblem message={notice.message} />}
      {notice && !notice.error && <p role="status" className="text-sm font-medium text-emerald-800 dark:text-emerald-300">{notice.message}</p>}
      {order && (
        <>
          <header className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <h2 ref={heading} tabIndex={-1} className="break-words text-2xl font-semibold">#{order.id} · {order.title}</h2>
              <time dateTime={order.occurredAt} className={subtext}>{orderDate(order.occurredAt)}</time>
              {order.metadata?.chatId && <p className={subtext + ' break-all'}>Chat {order.metadata.chatId}</p>}
            </div>
            <OrderStatus order={order} />
          </header>
          {state?.savedOrder === order.id && !notice && <p role="status" className="text-sm font-medium text-emerald-800 dark:text-emerald-300">Prepedido guardado.</p>}
          <section className={card + ' space-y-3'} aria-labelledby="order-items-title">
            <h3 id="order-items-title" className="font-semibold">Artículos</h3>
            {order.items.length ? <ul className="divide-y divide-gray-200 dark:divide-gray-700">
              {order.items.map((item) => (
                <li key={item.id} className="flex flex-wrap justify-between gap-2 py-3 text-sm">
                  <div className="min-w-0">
                    <p className="break-words font-semibold">{item.itemNameSnapshot}</p>
                    <p className={subtext}>Cantidad {item.quantity}{item.unitPrice !== null ? ` · ${item.currency} ${item.unitPrice} por unidad` : ''}</p>
                  </div>
                  <span className={subtext}>{itemAvailability(item.availabilityStatus)}</span>
                </li>
              ))}
            </ul> : <p className={subtext}>Este pedido todavía no tiene artículos.</p>}
            {order.notes && <p className={subtext + ' whitespace-pre-wrap break-words'}>{order.notes}</p>}
          </section>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={secondary} onClick={reload} disabled={working}>
              <RefreshCw size={16} aria-hidden="true" /> Actualizar pedido
            </button>
            {orderActions(order).map((next) => (
              <button key={next} type="button" className={next === 'cancelled' ? secondary : primary} disabled={working}
                onClick={() => setAction(next)}>{actions[next].label}</button>
            ))}
          </div>
          {working && <p role="status" className={subtext}>Guardando el estado…</p>}
          {action && <OrderActionDialog order={order} action={action} onCancel={() => setAction(undefined)} onConfirm={() => void update()} />}
        </>
      )}
    </div>
  );
}

function positiveInt(value: string | null) {
  const number = Number(value);
  return value && /^\d+$/.test(value) && Number.isSafeInteger(number) && number > 0 ? number : null;
}

export default function OrdersPage() {
  const [params] = useSearchParams();
  const rawId = params.get('pedido');
  const id = positiveInt(rawId);
  const page = Math.min(Math.floor(Number.MAX_SAFE_INTEGER / orderPageSize), positiveInt(params.get('pagina')) ?? 1);
  return (
    <section className="mx-auto max-w-5xl p-4 sm:p-6" aria-label="Pedidos comerciales">
      {id ? <OrderDetail key={id} id={id} />
        : rawId !== null ? <div className="space-y-3"><OrderProblem message="El identificador de pedido no es válido." />
          <Link className={secondary} to={ordersPath}>Volver a pedidos</Link></div>
          : <OrderList page={page} />}
    </section>
  );
}
