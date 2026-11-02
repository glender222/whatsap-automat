import React from 'react';
import type { ChannelProvider } from '../types';
import { AlertTriangle, FileText } from 'lucide-react';

export interface ServiceWindowWarningProps {
  channel: ChannelProvider;
  is24hWindowActive: boolean;
  onOpenTemplatePicker?: () => void;
  className?: string;
}

export const ServiceWindowWarning: React.FC<ServiceWindowWarningProps> = ({
  channel,
  is24hWindowActive,
  onOpenTemplatePicker,
  className = '',
}) => {
  // Only Meta WhatsApp enforces the 24-hour customer service window rule
  if (channel !== 'whatsapp' || is24hWindowActive) {
    return null;
  }

  return (
    <div
      role="alert"
      aria-live="assertive"
      aria-atomic="true"
      className={`flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 border-t border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/50 dark:text-amber-200 ${className}`}
    >
      <div className="flex items-center gap-2">
        <AlertTriangle size={16} className="text-amber-600 dark:text-amber-400 shrink-0" aria-hidden="true" />
        <span>
          <strong>Ventana de 24h expirada:</strong> Solo puedes enviar plantillas pre-aprobadas por Meta para reabrir la conversación.
        </span>
      </div>

      <button
        type="button"
        onClick={onOpenTemplatePicker}
        className="flex items-center gap-1.5 rounded-md bg-amber-600 px-3 py-1 text-xs font-semibold text-white shadow-sm hover:bg-amber-700 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:ring-offset-1 shrink-0"
        aria-haspopup="dialog"
        aria-label="Seleccionar plantilla de mensaje de WhatsApp"
      >
        <FileText size={14} aria-hidden="true" />
        <span>Seleccionar Plantilla HSM</span>
      </button>
    </div>
  );
};
