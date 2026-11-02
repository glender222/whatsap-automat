import React from 'react';
import type { ConditionNodeConfig } from '../../types';
import { GitBranch } from 'lucide-react';

export interface ConditionNodeProps {
  config: ConditionNodeConfig | Record<string, unknown>;
}

export const ConditionNode: React.FC<ConditionNodeProps> = ({ config }) => {
  const expression = (config.expression as string) || 'condición';

  return (
    <div className="flex flex-col gap-1.5 text-[11px]">
      <div className="flex items-center gap-1.5 font-mono bg-slate-100 dark:bg-slate-800/80 px-2 py-1 rounded text-purple-700 dark:text-purple-300 truncate">
        <GitBranch size={12} className="shrink-0 text-purple-600 dark:text-purple-400" />
        <span className="truncate" title={expression}>{expression}</span>
      </div>
      <div className="flex items-center justify-between text-[10px] text-slate-500 font-semibold px-0.5">
        <span className="text-emerald-600 dark:text-emerald-400">● True</span>
        <span className="text-rose-600 dark:text-rose-400">● False</span>
      </div>
    </div>
  );
};
