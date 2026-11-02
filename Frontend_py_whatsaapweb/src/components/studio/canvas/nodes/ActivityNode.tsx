import React from 'react';
import type { ActivityNodeConfig } from '../../types';
import { Globe, Database, ShieldCheck } from 'lucide-react';

export interface ActivityNodeProps {
  config: ActivityNodeConfig | Record<string, unknown>;
}

export const ActivityNode: React.FC<ActivityNodeProps> = ({ config }) => {
  const isHttp = 'url' in config;
  const isEffect = 'effectType' in config;

  return (
    <div className="flex flex-col gap-1 text-[11px] text-slate-600 dark:text-slate-400">
      {isHttp && (
        <div className="flex items-center gap-1.5 font-mono text-slate-700 dark:text-slate-300">
          <Globe size={13} className="text-blue-500 shrink-0" />
          <span className="font-bold text-blue-600 dark:text-blue-400 text-[10px]">
            {((config as any).method || 'POST')}
          </span>
          <span className="truncate text-[10px]" title={(config as any).url}>
            {(config as any).url}
          </span>
        </div>
      )}

      {isEffect && (
        <div className="flex items-center gap-1.5 font-mono text-slate-700 dark:text-slate-300">
          <Database size={13} className="text-indigo-500 shrink-0" />
          <span className="font-bold text-[10px]">
            {(config as any).effectType}
          </span>
        </div>
      )}

      <div className="flex items-center justify-between text-[10px] text-slate-500 pt-0.5">
        <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
          <ShieldCheck size={11} />
          {isHttp ? 'SSRF Protegido' : 'Idempotente'}
        </span>
      </div>
    </div>
  );
};
