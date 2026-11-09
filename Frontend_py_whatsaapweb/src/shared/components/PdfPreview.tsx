import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronLeft, ChevronRight, Download, Minus, Plus } from 'lucide-react';
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { loadPdfBlob } from './pdfMedia';

GlobalWorkerOptions.workerSrc = workerUrl;
const assetBase = import.meta.env.BASE_URL + 'pdfjs-assets/';
const buttonClass = 'inline-flex min-h-11 items-center gap-1 rounded-md border border-gray-300 px-3 text-sm font-medium hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:hover:bg-gray-800';

function PdfPage({ pdf, pageNumber, width, zoom }: { pdf: PDFDocumentProxy; pageNumber: number; width: number; zoom: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [result, setResult] = useState<{ key: string; text?: string; error?: boolean }>();
  const key = [pageNumber, width, zoom].join('/');
  const current = result?.key === key ? result : undefined;

  useEffect(() => {
    if (!width) return;
    let canceled = false;
    let rendering: RenderTask | undefined;
    pdf.getPage(pageNumber).then(async (page) => {
      if (canceled || !canvas.current) return;
      const element = canvas.current;
      const original = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(width / original.width, 1.5) * zoom / 100 });
      const ratio = Math.min(window.devicePixelRatio || 1, 2, 8192 / Math.max(viewport.width, viewport.height),
        Math.sqrt(16_000_000 / (viewport.width * viewport.height)));
      element.width = Math.max(1, Math.floor(viewport.width * ratio));
      element.height = Math.max(1, Math.floor(viewport.height * ratio));
      element.style.width = viewport.width + 'px';
      element.style.height = viewport.height + 'px';
      rendering = page.render({ canvas: element, viewport, transform: [ratio, 0, 0, ratio, 0, 0] });
      await rendering.promise;
      if (!canceled) setResult({ key });
      try {
        const content = await page.getTextContent();
        if (!canceled) setResult({ key, text: content.items.map((item) =>
          'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('').trim() });
      } catch {
        // The rendered page remains available if text extraction fails.
      }
    }).catch(() => {
      if (!canceled) setResult({ key, error: true });
    });
    return () => { canceled = true; rendering?.cancel(); };
  }, [key, pageNumber, pdf, width, zoom]);

  return (
    <>
      <div className="min-h-20 w-max min-w-full">
        <canvas ref={canvas} role="img" aria-label={`Página ${pageNumber} del PDF`}
          className={`mx-auto block bg-white shadow ${current && !current.error ? '' : 'invisible'}`} />
        {!current && <p role="status" className="py-3 text-center text-sm">Preparando la página…</p>}
        {current?.error && <p role="alert" className="py-3 text-center text-sm">No se pudo mostrar esta página. Puedes descargar el PDF original.</p>}
      </div>
      {current?.text && <details className="mt-2 rounded-md border border-gray-200 bg-white p-2 text-sm dark:border-gray-700 dark:bg-gray-900">
        <summary className="cursor-pointer font-medium">Texto de esta página</summary>
        <p className="mt-2 whitespace-pre-wrap break-words">{current.text}</p>
      </details>}
    </>
  );
}

interface PdfState { key: string; download?: string; pdf?: PDFDocumentProxy; error?: string }

export default function PdfPreview({ url, fileName }: { url: string; fileName: string }) {
  const [state, setState] = useState<PdfState>();
  const [attempt, setAttempt] = useState(0);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(100);
  const [width, setWidth] = useState(0);
  const viewport = useRef<HTMLDivElement>(null);
  const key = url + '#' + attempt;
  const current = state?.key === key ? state : undefined;
  const pageCount = current?.pdf?.numPages ?? 0;
  const pageNumber = pageCount ? Math.min(page, pageCount) : 1;

  useEffect(() => {
    const request = new AbortController();
    let download: string | undefined;
    let documentTask: ReturnType<typeof getDocument> | undefined;
    loadPdfBlob(url, request.signal).then(async (blob) => {
      if (request.signal.aborted) return;
      download = URL.createObjectURL(blob);
      setState({ key, download });
      const data = new Uint8Array(await blob.arrayBuffer());
      if (request.signal.aborted) return;
      documentTask = getDocument({
        data, cMapUrl: assetBase + 'cmaps/', cMapPacked: true, iccUrl: assetBase + 'iccs/',
        standardFontDataUrl: assetBase + 'standard_fonts/', wasmUrl: assetBase + 'wasm/',
        enableXfa: false,
      });
      const pdf = await documentTask.promise;
      if (!request.signal.aborted) setState({ key, download, pdf });
    }).catch((cause: unknown) => {
      if (request.signal.aborted) return;
      const error = download ? 'No pudimos abrir la vista previa. Puedes descargar el PDF original.'
        : cause instanceof Error && cause.name !== 'AxiosError' ? cause.message : 'No pudimos cargar el PDF.';
      setState({ key, download, error });
    });
    return () => {
      request.abort();
      void documentTask?.destroy().catch(() => undefined);
      if (download) URL.revokeObjectURL(download);
    };
  }, [key, url]);

  useEffect(() => {
    const container = viewport.current;
    if (!container) return;
    const resize = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    resize.observe(container);
    return () => resize.disconnect();
  }, []);

  function changePage(next: number) {
    setPage(Math.min(pageCount, Math.max(1, next)));
    viewport.current?.scrollTo(0, 0);
  }

  function handleKeys(event: KeyboardEvent<HTMLDivElement>) {
    if (!pageCount || event.target !== event.currentTarget) return;
    const commands: Record<string, () => void> = {
      ArrowLeft: () => changePage(pageNumber - 1), PageUp: () => changePage(pageNumber - 1),
      ArrowRight: () => changePage(pageNumber + 1), PageDown: () => changePage(pageNumber + 1),
      Home: () => changePage(1), End: () => changePage(pageCount),
      '+': () => setZoom((value) => Math.min(200, value + 25)),
      '-': () => setZoom((value) => Math.max(50, value - 25)),
    };
    if (Object.hasOwn(commands, event.key)) {
      event.preventDefault();
      commands[event.key]();
    }
  }

  return (
    <section className="min-w-0 space-y-3" aria-label="Vista previa PDF">
      <div className="flex flex-wrap items-center gap-2">
        {current?.download && (
          <a href={current.download} download={fileName || 'documento.pdf'} className={buttonClass}>
            <Download size={16} aria-hidden="true" /> Descargar PDF
          </a>
        )}
        {pageCount > 0 && (
          <>
            <button type="button" onClick={() => changePage(pageNumber - 1)} disabled={pageNumber <= 1}
              aria-label="Página anterior" className={buttonClass}><ChevronLeft size={17} aria-hidden="true" /></button>
            <p role="status" className="text-sm">Página {pageNumber} de {pageCount}</p>
            <button type="button" onClick={() => changePage(pageNumber + 1)} disabled={pageNumber >= pageCount}
              aria-label="Página siguiente" className={buttonClass}><ChevronRight size={17} aria-hidden="true" /></button>
            <button type="button" onClick={() => setZoom((value) => value - 25)} disabled={zoom <= 50}
              aria-label="Alejar" className={buttonClass}><Minus size={17} aria-hidden="true" /></button>
            <button type="button" onClick={() => setZoom(100)} className={buttonClass}>Ajustar</button>
            <button type="button" onClick={() => setZoom((value) => value + 25)} disabled={zoom >= 200}
              aria-label="Acercar" className={buttonClass}><Plus size={17} aria-hidden="true" /></button>
          </>
        )}
      </div>
      {!current?.pdf && !current?.error && <p role="status" className="text-sm">Cargando PDF…</p>}
      {current?.error && (
        <div role="alert" className="rounded-md border border-red-200 p-3 text-sm text-red-700 dark:border-red-800 dark:text-red-300">
          <p>{current.error}</p>
          <button type="button" onClick={() => setAttempt((value) => value + 1)} className="mt-1 min-h-11 font-semibold underline">Volver a intentar</button>
        </div>
      )}
      <div ref={viewport} onKeyDown={handleKeys} tabIndex={pageCount ? 0 : -1} role="region" aria-label="Página del PDF"
        className="max-h-[58dvh] min-w-0 overflow-auto rounded-md bg-gray-100 p-2 dark:bg-gray-950">
        {current?.pdf && <PdfPage key={key} pdf={current.pdf} pageNumber={pageNumber} width={width} zoom={zoom} />}
      </div>
      {pageCount > 0 && <p className="text-xs text-gray-600 dark:text-gray-300">Enfoca la página para cambiarla con las flechas o ajustar el tamaño con + y −.</p>}
    </section>
  );
}
