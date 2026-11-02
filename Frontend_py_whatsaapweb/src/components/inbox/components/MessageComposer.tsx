import React, { useRef, useEffect } from 'react';
import { Send, Paperclip } from 'lucide-react';

export interface MessageComposerProps {
  value: string;
  onChange: (text: string) => void;
  onSend: () => void;
  disabled?: boolean;
  disabledReason?: string;
  onAttachClick?: () => void;
  className?: string;
}

export const MessageComposer: React.FC<MessageComposerProps> = ({
  value,
  onChange,
  onSend,
  disabled = false,
  disabledReason,
  onAttachClick,
  className = '',
}) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize textarea height
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [value]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Guard against IME composition (e.g. Japanese, CJK, accents)
    if (e.nativeEvent.isComposing) {
      return;
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!disabled && value.trim()) {
        onSend();
      }
    }
  };

  const placeholderText = disabled
    ? disabledReason || 'Ventana de 24h cerrada. Selecciona una plantilla para reabrir.'
    : 'Escribe un mensaje (Enter para enviar, Shift+Enter para nueva línea)...';

  return (
    <div
      className={`border-t p-3 border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131B2E] ${className}`}
    >
      <div className="flex items-end gap-2">
        <button
          type="button"
          onClick={onAttachClick}
          disabled={disabled}
          className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-200 disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
          title="Adjuntar archivo o imagen"
          aria-label="Adjuntar archivo o imagen"
        >
          <Paperclip size={18} />
        </button>

        <div className="flex-1 relative">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={disabled}
            aria-disabled={disabled}
            aria-label="Escribe un mensaje"
            aria-describedby="composer-keyboard-hint"
            placeholder={placeholderText}
            rows={2}
            className="w-full resize-none rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/60 p-2.5 text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-teal-500 max-h-32 disabled:bg-slate-100 dark:disabled:bg-slate-900/30 disabled:text-slate-400 disabled:cursor-not-allowed"
          />
          <span id="composer-keyboard-hint" className="sr-only">
            Presiona Enter para enviar o Shift+Enter para salto de línea. Presiona Control+Enter para aceptar la sugerencia de IA activa.
          </span>
        </div>

        <button
          type="button"
          onClick={onSend}
          disabled={disabled || !value.trim()}
          className="rounded-lg bg-teal-600 p-2 text-white shadow-sm hover:bg-teal-700 disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-teal-500 shrink-0"
          aria-label="Enviar mensaje"
        >
          <Send size={16} />
        </button>
      </div>
    </div>
  );
};
