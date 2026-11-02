import React from 'react';
import type { ApprovalNodeConfig } from '../../types';
import { UserCheck, ShieldAlert } from 'lucide-react';

export interface ApprovalNodeProps {
  config: ApprovalNodeConfig | Record<string, unknown>;
}

export const ApprovalNode: React.FC<ApprovalNodeProps> = ({ config }) => {
  const roles = (config.requiredRoles as string[]) || [];

  return (
    <div className="flex flex-col gap-1 text-[11px] text-slate-600 dark:text-slate-400">
      <div className="flex items-center gap-1.5 text-purple-700 dark:text-purple-300 font-semibold">
        <UserCheck size={13} className="shrink-0 text-purple-600 dark:text-purple-400" />
        <span>Gate HITL Operador</span>
      </div>
      <div className="flex items-center gap-1 text-[10px] text-slate-500 overflow-hidden">
        <ShieldAlert size={11} className="shrink-0 text-amber-500" />
        <span className="truncate">
          Roles: {roles.length > 0 ? roles.join(', ') : 'Cualquier operador'}
        </span>
      </div>
    </div>
  );
};
