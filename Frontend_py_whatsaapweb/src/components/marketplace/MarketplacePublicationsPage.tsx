import { useEffect, useRef, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { Link } from 'react-router-dom';
import {
  catalogPageSize, extensionTypes, listMarketplacePublications, marketplaceError, marketplacePath,
  withdrawMarketplacePublication, type MarketplacePublication,
} from './marketplaceApi';

const dateFormat = new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short' });
const actionClass = 'min-h-11 rounded-md px-3 text-sm font-semibold underline disabled:opacity-60';

export default function MarketplacePublicationsPage() {
  const [offset, setOffset] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ offset: number; page?: Awaited<ReturnType<typeof listMarketplacePublications>>; error?: string }>();
  const [confirmation, setConfirmation] = useState<MarketplacePublication>();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const confirmButton = useRef<HTMLButtonElement>(null);
  const actionTrigger = useRef<HTMLButtonElement | null>(null);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const lock = useRef(false);
  const page = result?.offset === offset ? result.page : undefined;
  const loadError = result?.offset === offset ? result.error : undefined;

  useEffect(() => {
    const request = new AbortController();
    listMarketplacePublications(offset, request.signal)
      .then((value) => { if (!request.signal.aborted) setResult({ offset, page: value }); })
      .catch((cause) => {
        if (!request.signal.aborted) setResult({ offset, error: marketplaceError(cause, 'No pudimos cargar tus publicaciones.') });
      });
    return () => request.abort();
  }, [attempt, offset]);

  useEffect(() => { if (confirmation) confirmButton.current?.focus(); }, [confirmation]);
  useEffect(() => { if (notice) noticeRef.current?.focus(); }, [notice]);

  async function withdraw(publication: MarketplacePublication) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setActionError('');
    try {
      const updated = await withdrawMarketplacePublication(publication.id);
      setResult((previous) => previous?.page ? {
        ...previous,
        page: { ...previous.page, items: previous.page.items.map((item) => item.id === updated.id ? updated : item) },
      } : previous);
      setConfirmation(undefined);
      setNotice(`${updated.displayName} se retiró del catálogo.`);
    } catch (cause) {
      setActionError(marketplaceError(cause, 'No pudimos confirmar la retirada. Puedes repetir la solicitud.'));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  function goToPage(next: number) {
    setConfirmation(undefined);
    setNotice('');
    setOffset(next);
  }

  return (
    <section className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6" aria-labelledby="publications-title">
      <Link to={marketplacePath} className="inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-emerald-700 dark:text-emerald-300">
        <ArrowLeft size={16} aria-hidden="true" /> Volver al catálogo
      </Link>
      <header>
        <h1 id="publications-title" className="text-2xl font-semibold">Publicaciones de tu empresa</h1>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">Consulta el estado de tus publicaciones y retira del catálogo las que ya no quieras mostrar.</p>
      </header>
      {notice && <p role="status" tabIndex={-1} ref={noticeRef} className="text-sm text-emerald-800 dark:text-emerald-200">{notice}</p>}
      {loadError ? (
        <div role="alert" className="rounded-lg border border-red-200 p-4 text-sm text-red-700 dark:text-red-300">
          <p>{loadError}</p>
          <button type="button" className={actionClass} onClick={() => { setResult(undefined); setAttempt((value) => value + 1); }}>Volver a intentar</button>
        </div>
      ) : !page ? (
        <p role="status" className="text-sm">Cargando publicaciones…</p>
      ) : (
        <>
          {page.items.length === 0 ? (
            <p className="rounded-lg border border-gray-200 p-4 text-sm dark:border-gray-700">No hay publicaciones en esta página.</p>
          ) : (
            <ul className="divide-y divide-gray-200 rounded-xl border border-gray-200 bg-white dark:divide-gray-700 dark:border-gray-700 dark:bg-gray-900">
              {page.items.map((item) => (
                <li key={item.id} className="space-y-3 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h2 className="break-words font-semibold">{item.displayName}</h2>
                      <p className="break-all text-sm text-gray-600 dark:text-gray-300">{item.extensionId} · {extensionTypes[item.type]} · {item.version}</p>
                      {item.withdrawnAt && <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">Retirada el <time dateTime={item.withdrawnAt}>{dateFormat.format(new Date(item.withdrawnAt))}</time></p>}
                    </div>
                    <span className="rounded-full bg-gray-100 px-2 py-1 text-xs font-semibold dark:bg-gray-800">
                      {item.state === 'published' ? 'Publicada' : 'Retirada'}
                    </span>
                  </div>
                  {item.state === 'published' && (
                    <div className="flex flex-wrap items-center gap-2">
                      <Link to={`${marketplacePath}/${encodeURIComponent(item.id)}`} className={`inline-flex items-center ${actionClass}`}>Ver ficha pública</Link>
                      <button type="button" className={`${actionClass} text-red-700 dark:text-red-300`} disabled={busy}
                        aria-expanded={confirmation?.id === item.id}
                        onClick={(event) => {
                          actionTrigger.current = event.currentTarget;
                          setConfirmation(item);
                          setActionError('');
                          setNotice('');
                        }}>Retirar del catálogo</button>
                    </div>
                  )}
                  {confirmation?.id === item.id && (
                    <div className="space-y-2 rounded-lg border border-red-200 p-3 dark:border-red-900">
                      <p className="text-sm">La ficha dejará de ser pública. Se conservarán el identificador y las reseñas. Esta retirada es definitiva.</p>
                      {actionError && <p role="alert" className="text-sm text-red-700 dark:text-red-300">{actionError}</p>}
                      <div className="flex flex-wrap gap-2">
                        <button type="button" ref={confirmButton} disabled={busy} onClick={() => withdraw(item)}
                          className="min-h-11 rounded-md bg-red-700 px-3 text-sm font-semibold text-white disabled:opacity-60">
                          {busy ? 'Retirando…' : 'Confirmar retirada'}
                        </button>
                        <button type="button" disabled={busy} className={actionClass} onClick={() => {
                          setConfirmation(undefined);
                          actionTrigger.current?.focus();
                        }}>Cancelar</button>
                      </div>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
          {(offset > 0 || page.hasMore) && (
            <nav aria-label="Páginas de publicaciones" className="flex gap-2">
              <button type="button" className={actionClass} disabled={offset === 0 || busy} onClick={() => goToPage(offset - catalogPageSize)}>Anterior</button>
              <button type="button" className={actionClass} disabled={!page.hasMore || busy} onClick={() => goToPage(offset + catalogPageSize)}>Siguiente</button>
            </nav>
          )}
        </>
      )}
    </section>
  );
}
