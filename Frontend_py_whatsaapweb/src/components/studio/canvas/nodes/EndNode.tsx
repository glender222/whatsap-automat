import React from 'react';
import type { EndNodeConfig } from '../../types';
import { CheckCircle2, XCircle } from 'lucide-react';

export interface EndNodeProps {
  config: EndNodeConfig | Record<string, unknown>;
}

export const EndNode: React.FC<EndNodeProps> = ({ config }) => {
  const status = (config.status as string) || 'completed';
  const isRejected = status === 'rejected' || status === 'failed';

  return (
    <div className="flex flex-col gap-1 text-[11px] text-slate-600 dark:text-slate-400">
      <div className="flex items-center gap-1.5 font-semibold">
        {isRejected ? (
          <>
            <XCircle size={13} className="text-red-500 shrink-0" />
            <span className="text-red-600 dark:text-red-400">Flujo Rechazado</span>
          </>
        ) : (
          <>
            <CheckCircle2 size={13} className="text-emerald-500 shrink-0" />
            <span className="text-emerald-600 dark:text-emerald-400">Flujo Completado</span>
          </>
        )}
      </div>
      {Boolean(config.summary) && (
        <p className="text-[10px] text-slate-500 truncate" title={config.summary as string}>
          {config.summary as string}
        </p>
      )}
    </div>
  );
};
