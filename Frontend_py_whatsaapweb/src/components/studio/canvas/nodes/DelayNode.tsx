import React from 'react';
import type { DelayNodeConfig } from '../../types';
import { Clock } from 'lucide-react';

export interface DelayNodeProps {
  config: DelayNodeConfig | Record<string, unknown>;
}

export const DelayNode: React.FC<DelayNodeProps> = ({ config }) => {
  const durationMs = config.durationMs as number | undefined;
  const seconds = config.seconds as number | undefined;
  const minutes = config.minutes as number | undefined;
  const hours = config.hours as number | undefined;

  let label = '1 segundo';
  if (durationMs) {
    if (durationMs >= 3600000) label = `${(durationMs / 3600000).toFixed(1)}h`;
    else if (durationMs >= 60000) label = `${(durationMs / 60000).toFixed(0)}m`;
    else label = `${(durationMs / 1000).toFixed(0)}s`;
  } else if (hours) {
    label = `${hours}h`;
  } else if (minutes) {
    label = `${minutes}m`;
  } else if (seconds) {
    label = `${seconds}s`;
  }

  return (
    <div className="flex items-center gap-2 text-[11px] text-slate-600 dark:text-slate-400">
      <Clock size={13} className="text-amber-500 shrink-0" />
      <span className="font-semibold text-slate-800 dark:text-slate-200">
        Pausa duradera: {label}
      </span>
    </div>
  );
};
