import { useEffect, useRef, useState, type FormEvent } from 'react';
import { orderChats, orderChoices, orderError, savePreorder, type DraftItem, type Order } from './ordersApi';

const control = 'mt-1 min-h-11 w-full min-w-0 rounded-md border border-gray-300 bg-white px-2 text-base dark:border-gray-600 dark:bg-gray-900';
const button = 'min-h-11 rounded-md border border-gray-300 px-3 text-sm font-semibold disabled:opacity-50 dark:border-gray-600';
type Choices = Awaited<ReturnType<typeof orderChoices>>;
type Line = { key: number; product: string; quantity: string };

export default function OrderDraftForm({ onSave, onClose }: { onSave: (order: Order) => void; onClose: () => void }) {
  const [choices, setChoices] = useState<Choices>();
  const [loadError, setLoadError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [chatId, setChatId] = useState('');
  const [lines, setLines] = useState<Line[]>([{ key: 1, product: '', quantity: '1' }]);
  const [saving, setSaving] = useState(false);
  const [loadingChats, setLoadingChats] = useState(false);
  const [chatError, setChatError] = useState('');
  const lock = useRef(false);
  const nextLine = useRef(2);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => { heading.current?.focus(); }, []);

  useEffect(() => {
    const request = new AbortController();
    orderChoices(request.signal).then((result) => {
      if (!request.signal.aborted) setChoices(result);
    }).catch((cause) => {
      if (!request.signal.aborted) setLoadError(orderError(cause, 'No pudimos cargar los chats y artículos.'));
    });
    return () => request.abort();
  }, [attempt]);

  function updateLine(key: number, value: Partial<Line>) {
    setSaveError('');
    setLines((previous) => previous.map((line) => line.key === key ? { ...line, ...value } : line));
  }

  async function loadMoreChats() {
    if (loadingChats || choices?.nextChatOffset == null) return;
    setLoadingChats(true);
    setChatError('');
    try {
      const result = await orderChats(choices.nextChatOffset);
      setChoices((current) => current && {
        ...current,
        chats: [...new Map([...current.chats, ...result.chats].map((chat) => [chat.id, chat])).values()],
        nextChatOffset: result.nextChatOffset,
      });
    } catch (cause) {
      setChatError(orderError(cause, 'No pudimos cargar más chats.'));
    } finally {
      setLoadingChats(false);
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (lock.current || !choices?.chats.some((chat) => chat.id === chatId)) return;
    const items: DraftItem[] = lines.map((line) => ({ commercialItemId: Number(line.product), quantity: Number(line.quantity) }));
    if (items.some((item) => !choices.products.some((product) => product.id === item.commercialItemId) ||
        !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 2_147_483_647)) {
      setSaveError('Selecciona artículos del catálogo e indica cantidades enteras positivas.');
      return;
    }
    lock.current = true;
    setSaving(true);
    setSaveError('');
    try {
      onSave(await savePreorder(chatId, items));
    } catch (cause) {
      setSaveError(orderError(cause, 'No pudimos confirmar el guardado. Consulta el listado antes de intentarlo de nuevo.'));
    } finally {
      lock.current = false;
      setSaving(false);
    }
  }

  return (
    <section className="space-y-3 rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900" aria-labelledby="preorder-title">
      <h2 id="preorder-title" ref={heading} tabIndex={-1} className="text-lg font-semibold">Guardar prepedido</h2>
      <p className="text-sm text-gray-600 dark:text-gray-300">
        Selecciona un chat y artículos activos. Si el chat ya tiene un prepedido abierto, el servidor actualiza las cantidades de los artículos seleccionados y conserva los demás.
      </p>
      {!choices && !loadError && <p role="status" className="text-sm">Cargando chats y artículos…</p>}
      {loadError && <div role="alert" className="space-y-2 text-sm text-red-800 dark:text-red-300">
        <p>{loadError}</p>
        <button type="button" className={button} onClick={() => { setLoadError(''); setAttempt((value) => value + 1); }}>Volver a cargar</button>
      </div>}
      {choices && !choices.chats.length && choices.nextChatOffset === null && <p className="text-sm">La empresa todavía no tiene chats registrados para crear un prepedido.</p>}
      {choices?.nextChatOffset != null && <button type="button" className={button} disabled={loadingChats || saving} onClick={loadMoreChats}>
        {loadingChats ? 'Cargando chats…' : 'Cargar más chats'}
      </button>}
      {chatError && <p role="alert" className="text-sm text-red-800 dark:text-red-300">{chatError}</p>}
      {choices && !choices.products.length && <p className="text-sm">La empresa todavía no tiene artículos activos en el catálogo.</p>}
      {choices && choices.chats.length > 0 && choices.products.length > 0 && (
        <form onSubmit={save} className="space-y-3">
          <label className="block text-sm font-semibold">
            Chat del cliente
            <select className={control} value={chatId} required disabled={saving}
              onChange={(event) => { setChatId(event.target.value); setSaveError(''); }}>
              <option value="">Selecciona un chat</option>
              {choices.chats.map((chat) => <option key={chat.id} value={chat.id}>{chat.name ? chat.name + ' · ' : ''}{chat.id}</option>)}
            </select>
          </label>
          {lines.map((line, index) => (
            <fieldset key={line.key} disabled={saving} className="grid min-w-0 gap-2 rounded-lg border border-gray-200 p-3 sm:grid-cols-[minmax(0,1fr)_8rem_auto] dark:border-gray-700">
              <legend className="px-1 text-sm font-semibold">Artículo {index + 1}</legend>
              <label className="min-w-0 text-sm">
                Artículo
                <select className={control} value={line.product} required onChange={(event) => updateLine(line.key, { product: event.target.value })}>
                  <option value="">Selecciona un artículo</option>
                  {choices.products.filter((product) => String(product.id) === line.product ||
                    !lines.some((candidate) => candidate.product === String(product.id))).map((product) => (
                    <option key={product.id} value={product.id}>{product.name}{product.sku ? ' · ' + product.sku : ''}</option>
                  ))}
                </select>
              </label>
              <label className="text-sm">
                Cantidad
                <input className={control} type="number" min={1} max={2_147_483_647} step={1} required
                  value={line.quantity} onChange={(event) => updateLine(line.key, { quantity: event.target.value })} />
              </label>
              {lines.length > 1 && <button type="button" className={button + ' self-end'} aria-label={`Quitar artículo ${index + 1}`}
                onClick={() => setLines((previous) => previous.filter((candidate) => candidate.key !== line.key))}>Quitar</button>}
            </fieldset>
          ))}
          {saveError && <p role="alert" className="text-sm text-red-800 dark:text-red-300">{saveError}</p>}
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={saving} className="min-h-11 rounded-md bg-emerald-700 px-3 text-sm font-semibold text-white disabled:opacity-50">
              {saving ? 'Guardando…' : 'Guardar prepedido'}
            </button>
            <button type="button" className={button} disabled={saving || lines.length >= Math.min(choices.products.length, 100)} onClick={() => {
              const key = nextLine.current++;
              setLines((previous) => [...previous, { key, product: '', quantity: '1' }]);
            }}>Añadir artículo</button>
            <button type="button" className={button} disabled={saving} onClick={onClose}>Volver al listado</button>
          </div>
        </form>
      )}
      {(!choices?.chats.length || !choices?.products.length) && <button type="button" className={button} onClick={onClose}>Volver al listado</button>}
    </section>
  );
}
