import React from 'react';
import type { TriggerNodeConfig } from '../../types';
import { Webhook, Calendar, Zap, MessageSquare } from 'lucide-react';

export interface TriggerNodeProps {
  config: TriggerNodeConfig | Record<string, unknown>;
}

export const TriggerNode: React.FC<TriggerNodeProps> = ({ config }) => {
  const triggerType = (config.triggerType as string) || 'webhook';
  const endpointKey = config.endpointKey as string | undefined;
  const cronExpression = config.cronExpression as string | undefined;

  let Icon = Webhook;
  if (triggerType === 'schedule') Icon = Calendar;
  else if (triggerType === 'event') Icon = Zap;
  else if (triggerType === 'channel.message') Icon = MessageSquare;

  return (
    <div className="flex flex-col gap-1 text-[11px] text-slate-600 dark:text-slate-400">
      <div className="flex items-center gap-1.5 font-mono text-slate-700 dark:text-slate-300">
        <Icon size={13} className="text-teal-600 dark:text-teal-400 shrink-0" />
        <span className="truncate">
          {triggerType === 'webhook' && (endpointKey ? `/${endpointKey}` : 'Webhook Ingress')}
          {triggerType === 'schedule' && (cronExpression || 'Programado')}
          {triggerType === 'event' && ((config.eventName as string) || 'Evento')}
          {triggerType === 'channel.message' && 'Mensaje de Canal'}
        </span>
      </div>
      <div className="text-[10px] text-slate-500 flex items-center justify-between">
        <span>Tipo: {triggerType}</span>
        {config.authScheme === 'token' && (
          <span className="px-1 bg-slate-100 dark:bg-slate-800 rounded font-semibold text-[9px]">Token Auth</span>
        )}
      </div>
    </div>
  );
};
