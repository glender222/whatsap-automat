import { useEffect, useId, useRef } from 'react';
import { X } from 'lucide-react';
import FilePreview from './FilePreview';

export default function PdfDocumentDialog({ url, fileName, onClose }: { url: string; fileName: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const title = useId();

  useEffect(() => {
    const element = dialog.current;
    const previouslyFocused = document.activeElement;
    element?.showModal();
    closeButton.current?.focus();
    return () => {
      element?.close();
      if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected) previouslyFocused.focus();
    };
  }, []);

  return (
    <dialog ref={dialog} aria-labelledby={title}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      className="fixed left-1/2 top-1/2 m-0 max-h-[90dvh] w-[calc(100%_-_1rem)] max-w-4xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-gray-200 bg-white p-3 text-gray-900 shadow-xl backdrop:bg-gray-950/55 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 sm:p-4">
      <div className="mb-3 flex items-start justify-between gap-2">
        <h2 id={title} className="min-w-0 break-words text-lg font-semibold">{fileName || 'Documento PDF'}</h2>
        <button ref={closeButton} type="button" aria-label="Cerrar vista previa" onClick={onClose}
          className="grid h-11 w-11 shrink-0 place-items-center rounded-md border border-gray-300 hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-800">
          <X size={18} aria-hidden="true" />
        </button>
      </div>
      <FilePreview url={url} fileName={fileName} mimeType="application/pdf" />
    </dialog>
  );
}
