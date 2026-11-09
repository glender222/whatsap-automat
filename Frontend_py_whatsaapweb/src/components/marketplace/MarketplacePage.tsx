import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, CheckCircle2, Puzzle, Search, Star } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  catalogPageSize, extensionTypes, isExtensionType, listMarketplace, marketplaceError,
  marketplacePath, ratingLabel, type CatalogQuery,
} from './marketplaceApi';

const inputClass = 'min-h-11 w-full rounded-md border border-gray-300 bg-white px-3 text-sm dark:border-gray-600 dark:bg-gray-800';

function parseQuery(params: URLSearchParams): CatalogQuery {
  const type = params.get('type');
  const offset = Number(params.get('offset'));
  return {
    q: params.get('q')?.trim().slice(0, 100) || undefined,
    category: params.get('category')?.trim().slice(0, 80) || undefined,
    type: isExtensionType(type) ? type : undefined,
    verified: params.get('verified') === 'true' ? true : undefined,
    offset: Number.isSafeInteger(offset) && offset > 0 ? offset : 0,
  };
}

function queryParams(query: CatalogQuery) {
  const params = new URLSearchParams();
  if (query.q) params.set('q', query.q);
  if (query.category) params.set('category', query.category);
  if (query.type) params.set('type', query.type);
  if (query.verified) params.set('verified', 'true');
  if (query.offset > 0) params.set('offset', String(query.offset));
  return params;
}

export default function MarketplacePage() {
  const [params, setParams] = useSearchParams();
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ key: string; data?: Awaited<ReturnType<typeof listMarketplace>>; error?: string }>();
  const resultsStatus = useRef<HTMLParagraphElement>(null);
  const moveFocusToResults = useRef(false);
  const search = params.toString();
  const requestKey = search + '#' + attempt;
  const query = parseQuery(params);
  const page = result?.key === requestKey ? result : undefined;

  useEffect(() => {
    const controller = new AbortController();
    listMarketplace(parseQuery(new URLSearchParams(search)), controller.signal)
      .then((data) => { if (!controller.signal.aborted) setResult({ key: requestKey, data }); })
      .catch((cause) => {
        if (!controller.signal.aborted) setResult({ key: requestKey, error: marketplaceError(cause, 'No pudimos cargar el catálogo.') });
      });
    return () => controller.abort();
  }, [requestKey, search]);

  useEffect(() => {
    if (page?.data && moveFocusToResults.current) {
      moveFocusToResults.current = false;
      resultsStatus.current?.focus();
    }
  }, [page]);

  function handleSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    moveFocusToResults.current = true;
    setAttempt((value) => value + 1);
    setParams(queryParams(parseQuery(new URLSearchParams([
      ['q', String(values.get('q') ?? '')],
      ['category', String(values.get('category') ?? '')],
      ['type', String(values.get('type') ?? '')],
      ['verified', String(values.get('verified') ?? '')],
    ]))));
  }

  const catalogSearch = queryParams(query).toString();
  const formKey = queryParams({ ...query, offset: 0 }).toString();
  const detailSearch = catalogSearch ? '?' + catalogSearch : '';

  function goToPage(offset: number) {
    moveFocusToResults.current = true;
    setParams(queryParams({ ...query, offset }));
  }

  return (
    <section className="mx-auto max-w-6xl space-y-5 p-4 sm:p-6" aria-labelledby="marketplace-title">
      <header>
        <p className="mb-1 text-sm font-semibold text-emerald-700 dark:text-emerald-300">Catálogo comunitario</p>
        <h1 id="marketplace-title" className="text-2xl font-semibold">Marketplace</h1>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">Explora extensiones, revisa los permisos que solicitan y comparte tu valoración.</p>
      </header>
      <form key={formKey} onSubmit={handleSearch} className="space-y-3 rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
        <div className="grid gap-3 md:grid-cols-[2fr_1fr_1fr]">
          <label className="block space-y-1 text-sm font-medium">
            <span>Buscar extensiones</span>
            <input name="q" type="search" defaultValue={query.q} maxLength={100} placeholder="Nombre, descripción o etiqueta" className={inputClass} />
          </label>
          <label className="block space-y-1 text-sm font-medium">
            <span>Tipo</span>
            <select name="type" defaultValue={query.type || ''} className={inputClass}>
              <option value="">Todos los tipos</option>
              {Object.entries(extensionTypes).map(([type, label]) => <option key={type} value={type}>{label}</option>)}
            </select>
          </label>
          <label className="block space-y-1 text-sm font-medium">
            <span>Categoría</span>
            <input name="category" defaultValue={query.category} maxLength={80} placeholder="Todas las categorías" className={inputClass} />
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="inline-flex min-h-11 items-center gap-2 text-sm font-medium">
            <input name="verified" type="checkbox" value="true" defaultChecked={query.verified} className="h-4 w-4 accent-emerald-700" />
            Solo verificadas
          </label>
          <button type="submit" className="inline-flex min-h-11 items-center gap-2 rounded-md bg-emerald-700 px-4 text-sm font-semibold text-white hover:bg-emerald-800">
            <Search size={16} aria-hidden="true" /> Buscar
          </button>
          {formKey && <Link to={marketplacePath} className="inline-flex min-h-11 items-center text-sm font-medium text-emerald-700 underline dark:text-emerald-300">Limpiar filtros</Link>}
        </div>
      </form>
      {!page && <p role="status" className="text-sm text-gray-600 dark:text-gray-300">Cargando extensiones…</p>}
      {page?.error && (
        <div role="alert" className="rounded-lg border border-red-200 p-4 text-sm text-red-800 dark:border-red-800 dark:text-red-200">
          <p>{page.error}</p>
          <button type="button" onClick={() => setAttempt((value) => value + 1)} className="mt-2 min-h-11 font-semibold underline">Volver a intentar</button>
        </div>
      )}
      {page?.data && (
        <>
          <p role="status" ref={resultsStatus} tabIndex={-1} className="text-sm text-gray-600 dark:text-gray-300">
            {page.data.total === 1 ? '1 extensión' : `${page.data.total} extensiones`}
          </p>
          {page.data.items.length === 0 ? (
            <div className="rounded-xl border border-dashed border-gray-300 p-5 text-sm dark:border-gray-600">
              <Puzzle className="mb-3 text-emerald-700 dark:text-emerald-300" aria-hidden="true" size={24} />
              {page.data.total ? 'Esta página ya no tiene resultados.' : 'No encontramos extensiones con estos filtros.'}
            </div>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {page.data.items.map((listing) => (
                <li key={listing.id} className="min-w-0">
                  <Link to={`${marketplacePath}/${encodeURIComponent(listing.id)}${detailSearch}`}
                    className="flex h-full flex-col gap-3 rounded-xl border border-gray-200 bg-white p-4 hover:border-emerald-700 dark:border-gray-700 dark:bg-gray-900 dark:hover:border-emerald-300">
                    <div className="flex flex-wrap items-center gap-2 text-xs font-medium text-gray-600 dark:text-gray-300">
                      <span className="rounded-full bg-gray-100 px-2 py-1 dark:bg-gray-800">{extensionTypes[listing.type]}</span>
                      {listing.verified && <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300">
                        <CheckCircle2 size={14} aria-hidden="true" /> Verificada
                      </span>}
                    </div>
                    <div>
                      <h2 className="break-words font-semibold">{listing.displayName}</h2>
                      <p className="mt-1 line-clamp-3 break-words text-sm text-gray-600 dark:text-gray-300">{listing.description || 'Sin descripción publicada.'}</p>
                    </div>
                    <div className="mt-auto flex flex-wrap items-center justify-between gap-2 text-xs text-gray-600 dark:text-gray-300">
                      <span className="inline-flex items-center gap-1">
                        <Star size={14} aria-hidden="true" />
                        {ratingLabel(listing.rating)}
                      </span>
                      <span>v{listing.version}</span>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {(query.offset > 0 || query.offset + page.data.items.length < page.data.total) && (
            <nav className="flex flex-wrap gap-2" aria-label="Páginas del Marketplace">
              <button type="button" disabled={query.offset === 0} onClick={() => goToPage(Math.max(0, query.offset - catalogPageSize))}
                className="inline-flex min-h-11 items-center gap-2 rounded-md border border-gray-300 px-3 text-sm dark:border-gray-600 disabled:opacity-50">
                <ArrowLeft size={16} aria-hidden="true" /> Anterior
              </button>
              <button type="button" disabled={query.offset + page.data.items.length >= page.data.total || page.data.items.length === 0}
                onClick={() => goToPage(query.offset + catalogPageSize)}
                className="inline-flex min-h-11 items-center gap-2 rounded-md border border-gray-300 px-3 text-sm dark:border-gray-600 disabled:opacity-50">
                Siguiente <ArrowRight size={16} aria-hidden="true" />
              </button>
            </nav>
          )}
        </>
      )}
    </section>
  );
}
