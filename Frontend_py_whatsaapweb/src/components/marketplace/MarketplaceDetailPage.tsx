import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useAtomValue } from 'jotai';
import { ArrowLeft, CheckCircle2, Star } from 'lucide-react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { userAtom } from '../../jotai/slices/authAtoms';
import {
  extensionTypes, getMarketplaceListing, getMarketplaceReviews, marketplaceError, marketplacePath, ratingLabel, reviewLimit,
  submitMarketplaceReview, type ExtensionReview, type MarketplaceListing,
} from './marketplaceApi';

const inputClass = 'w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800';
const dateFormat = new Intl.DateTimeFormat('es', { dateStyle: 'medium' });

function CompanyReviews({ listing, onSaved }: { listing: MarketplaceListing; onSaved: (value: MarketplaceListing) => void }) {
  const user = useAtomValue(userAtom);
  const userId = user?.id == null ? null : String(user.id);
  const [reviews, setReviews] = useState<ExtensionReview[]>();
  const [loadError, setLoadError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const submitLock = useRef(false);
  const savedMessage = useRef<HTMLParagraphElement>(null);
  const own = reviews?.find((review) => review.userId === userId);

  useEffect(() => {
    const request = new AbortController();
    getMarketplaceReviews(listing.extensionId, request.signal)
      .then((items) => {
        if (request.signal.aborted) return;
        setReviews(items);
        setLoadError('');
      })
      .catch((cause) => {
        if (!request.signal.aborted) setLoadError(marketplaceError(cause, 'No pudimos cargar las reseñas de tu empresa.'));
      });
    return () => request.abort();
  }, [attempt, listing.extensionId]);

  useEffect(() => {
    if (saved) savedMessage.current?.focus();
  }, [saved]);

  async function saveReview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitLock.current) return;
    const values = new FormData(event.currentTarget);
    const score = Number(values.get('score'));
    const review = String(values.get('review') ?? '').trim();
    setSaved(false);
    setSaveError('');
    if (!Number.isInteger(score) || score < 1 || score > 5 || review.length > reviewLimit) {
      setSaveError('Selecciona una puntuación de 1 a 5 y revisa la longitud del comentario.');
      return;
    }
    submitLock.current = true;
    setBusy(true);
    try {
      const result = await submitMarketplaceReview(listing.extensionId, score, review);
      setReviews((items) => [...(items ?? []).filter((item) => item.id !== result.rating.id), result.rating]);
      onSaved(result.listing);
      setSaved(true);
    } catch (cause) {
      setSaveError(marketplaceError(cause, 'No pudimos confirmar que la valoración se guardó. Consulta las reseñas antes de volver a intentarlo.'));
    } finally {
      submitLock.current = false;
      setBusy(false);
    }
  }

  return (
    <section className="space-y-4 rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900 sm:p-5" aria-labelledby="marketplace-reviews">
      <header>
        <h2 id="marketplace-reviews" className="text-lg font-semibold">Reseñas de tu empresa</h2>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">El catálogo muestra el promedio general. Los comentarios y las puntuaciones individuales son visibles dentro de tu empresa.</p>
      </header>
      {loadError ? (
        <div role="alert" className="text-sm text-red-700 dark:text-red-300">
          <p>{loadError}</p>
          <button type="button" className="min-h-11 font-semibold underline" onClick={() => setAttempt((value) => value + 1)}>Volver a intentar</button>
        </div>
      ) : reviews === undefined ? (
        <p role="status" className="text-sm">Cargando reseñas…</p>
      ) : (
        <>
          {reviews.length === 0 ? (
            <p className="text-sm text-gray-600 dark:text-gray-300">Aún no hay reseñas de tu empresa para esta extensión.</p>
          ) : (
            <ul className="divide-y divide-gray-200 rounded-lg border border-gray-200 dark:divide-gray-700 dark:border-gray-700">
              {reviews.map((review) => (
                <li key={review.id} className="p-3">
                  <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    <Star size={15} aria-hidden="true" className="text-emerald-700 dark:text-emerald-300" />
                    <span>{review.score} de 5</span>
                    <span className="text-gray-600 dark:text-gray-300">{review.userId === userId ? 'Tu valoración' : 'Integrante de tu empresa'}</span>
                    <time dateTime={review.createdAt} className="text-xs text-gray-600 dark:text-gray-300">{dateFormat.format(new Date(review.createdAt))}</time>
                  </div>
                  {review.review && <p className="mt-2 whitespace-pre-wrap break-words text-sm">{review.review}</p>}
                </li>
              ))}
            </ul>
          )}
          <form key={own ? `${own.id}:${own.score}:${own.review}` : 'new'} onSubmit={saveReview} className="space-y-3 border-t border-gray-200 pt-4 dark:border-gray-700">
            <h3 className="font-semibold">{own ? 'Editar tu valoración' : 'Valorar esta extensión'}</h3>
            <label className="block max-w-60 space-y-1 text-sm font-medium">
              <span>Puntuación</span>
              <select name="score" required defaultValue={own?.score ?? ''} className={inputClass}>
                <option value="" disabled>Selecciona de 1 a 5</option>
                {[1, 2, 3, 4, 5].map((score) => <option key={score} value={score}>{score} de 5</option>)}
              </select>
            </label>
            <label className="block space-y-1 text-sm font-medium">
              <span>Comentario opcional</span>
              <textarea name="review" rows={3} maxLength={reviewLimit} defaultValue={own?.review} aria-describedby="review-limit" className={inputClass} />
            </label>
            <p id="review-limit" className="text-xs text-gray-600 dark:text-gray-300">Hasta 1000 caracteres</p>
            {saveError && <p role="alert" className="text-sm text-red-700 dark:text-red-300">{saveError}</p>}
            {saved && <p role="status" ref={savedMessage} tabIndex={-1} className="text-sm text-emerald-800 dark:text-emerald-200">Tu valoración se guardó.</p>}
            <button type="submit" disabled={busy}
              className="min-h-11 rounded-md bg-emerald-700 px-4 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-60">
              {busy ? 'Guardando…' : 'Guardar valoración'}
            </button>
          </form>
        </>
      )}
    </section>
  );
}

function ListingDetails({ id }: { id: string }) {
  const { search } = useLocation();
  const [listing, setListing] = useState<MarketplaceListing>();
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const title = useRef<HTMLHeadingElement>(null);
  const loaded = Boolean(listing);

  useEffect(() => {
    const request = new AbortController();
    getMarketplaceListing(id, request.signal)
      .then((item) => { if (!request.signal.aborted) setListing(item); })
      .catch((cause) => {
        if (!request.signal.aborted) setError(marketplaceError(cause, 'No pudimos cargar esta extensión.'));
      });
    return () => request.abort();
  }, [id, attempt]);

  useEffect(() => {
    if (loaded) title.current?.focus();
  }, [loaded]);

  return (
    <section className="mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
      <Link to={marketplacePath + search} className="inline-flex min-h-11 items-center gap-2 text-sm font-medium text-emerald-700 dark:text-emerald-300">
        <ArrowLeft size={16} aria-hidden="true" /> Volver al catálogo
      </Link>
      {error && (
        <div role="alert" className="rounded-lg border border-red-200 p-4 text-sm text-red-700 dark:border-red-800 dark:text-red-300">
          <p>{error}</p>
          <button type="button" onClick={() => { setError(''); setAttempt((value) => value + 1); }} className="min-h-11 font-semibold underline">Volver a intentar</button>
        </div>
      )}
      {!error && !listing && <p role="status" className="text-sm">Cargando la ficha…</p>}
      {listing && (
        <>
          <article className="space-y-4 rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900 sm:p-5" aria-labelledby="extension-title">
            <header>
              <div className="mb-2 flex flex-wrap items-center gap-2 text-xs font-medium">
                <span className="rounded-full bg-gray-100 px-2 py-1 dark:bg-gray-800">{extensionTypes[listing.type]}</span>
                {listing.verified && <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300">
                  <CheckCircle2 size={14} aria-hidden="true" /> Verificada
                </span>}
              </div>
              <h1 id="extension-title" ref={title} tabIndex={-1} className="break-words text-2xl font-semibold">{listing.displayName}</h1>
              <p className="mt-1 break-all font-mono text-xs text-gray-600 dark:text-gray-300">{listing.extensionId}</p>
            </header>
            <p className="whitespace-pre-wrap break-words text-sm">{listing.longDescription || listing.description || 'Sin descripción publicada.'}</p>
            <dl className="grid gap-3 rounded-lg bg-gray-50 p-3 text-sm dark:bg-gray-800 sm:grid-cols-2">
              <div><dt className="font-semibold">Versión</dt><dd>{listing.version}</dd></div>
              <div><dt className="font-semibold">Licencia</dt><dd className="break-words">{listing.license}</dd></div>
              {listing.author && <div><dt className="font-semibold">Autoría</dt><dd className="break-words">{typeof listing.author === 'string' ? listing.author : listing.author.name}</dd></div>}
              <div><dt className="font-semibold">Promedio general</dt><dd>{ratingLabel(listing.rating)}</dd></div>
              {listing.categories.length > 0 && <div><dt className="font-semibold">Categorías</dt><dd className="break-words">{listing.categories.join(', ')}</dd></div>}
              {listing.tags.length > 0 && <div><dt className="font-semibold">Etiquetas</dt><dd className="break-words">{listing.tags.join(', ')}</dd></div>}
            </dl>
            <section aria-labelledby="extension-permissions">
              <h2 id="extension-permissions" className="font-semibold">Permisos solicitados</h2>
              {listing.permissions.length ? (
                <ul className="mt-2 flex flex-wrap gap-2">
                  {[...new Set(listing.permissions)].map((permission) => <li key={permission}
                    className="min-w-0 break-all rounded bg-gray-100 px-2 py-1 font-mono text-xs dark:bg-gray-800">{permission}</li>)}
                </ul>
              ) : <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">La ficha no declara permisos.</p>}
            </section>
            {listing.tarballSha256 && <div className="text-sm">
              <p className="font-semibold">Huella del archivo SHA-256</p>
              <code className="break-all text-xs">{listing.tarballSha256}</code>
            </div>}
          </article>
          <CompanyReviews listing={listing} onSaved={setListing} />
        </>
      )}
    </section>
  );
}

export default function MarketplaceDetailPage() {
  const { extensionId } = useParams();
  return extensionId ? <ListingDetails key={extensionId} id={extensionId} /> : null;
}
