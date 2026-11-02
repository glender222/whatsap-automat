import React from 'react';
import { User, Loader2 } from 'lucide-react';

export interface TakeoverButtonProps {
  stateVersion: number;
  isLoading?: boolean;
  onTakeover: () => void;
  size?: 'sm' | 'md';
  className?: string;
}

export const TakeoverButton: React.FC<TakeoverButtonProps> = ({
  stateVersion,
  isLoading = false,
  onTakeover,
  size = 'md',
  className = '',
}) => {
  const sizeClasses =
    size === 'sm' ? 'px-2.5 py-1 text-[11px]' : 'px-3 py-1.5 text-xs';

  return (
    <button
      type="button"
      onClick={onTakeover}
      disabled={isLoading}
      aria-label={`Tomar control de la conversación y pausar IA (versión actual CAS ${stateVersion})`}
      aria-live="polite"
      className={`inline-flex items-center gap-1.5 rounded-lg bg-teal-600 font-semibold text-white shadow-sm hover:bg-teal-700 disabled:opacity-60 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 focus-visible:ring-offset-1 transition-colors ${sizeClasses} ${className}`}
    >
      {isLoading ? (
        <>
          <Loader2 size={14} className="animate-spin" aria-hidden="true" />
          <span>Tomando control...</span>
        </>
      ) : (
        <>
          <User size={14} aria-hidden="true" />
          <span>Tomar control (Pausar IA)</span>
        </>
      )}
    </button>
  );
};
