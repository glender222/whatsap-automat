import React from 'react';
import type { OmnichannelConversation, ChannelProvider } from '../types';
import { AlertTriangle, Clock, CheckCircle } from 'lucide-react';

export interface SlaBadgeInfo {
  text: string;
  variant: 'green' | 'amber' | 'red';
  ariaLabel: string;
  isBreached: boolean;
}

export function formatSlaBadge(
  slaDeadline: number,
  slaBreached: boolean,
  now = Date.now()
): SlaBadgeInfo {
  const diffMs = slaDeadline - now;

  if (slaBreached || diffMs <= 0) {
    const overdueMinutes = Math.max(1, Math.floor(Math.abs(diffMs) / 60000));
    return {
      text: `+${overdueMinutes}m breach`,
      variant: 'red',
      ariaLabel: `Alerta: SLA incumplido hace ${overdueMinutes} minutos`,
      isBreached: true,
    };
  }

  const remainingSeconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;

  if (diffMs <= 5 * 60 * 1000) {
    return {
      text: `${minutes}m ${seconds}s`,
      variant: 'amber',
      ariaLabel: `SLA en riesgo: restan ${minutes} minutos y ${seconds} segundos`,
      isBreached: false,
    };
  }

  if (minutes < 60) {
    return {
      text: `${minutes}m`,
      variant: 'green',
      ariaLabel: `SLA en tiempo: restan ${minutes} minutos`,
      isBreached: false,
    };
  }

  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return {
    text: `${hours}h ${remMin}m`,
    variant: 'green',
    ariaLabel: `SLA en tiempo: restan ${hours} horas y ${remMin} minutos`,
    isBreached: false,
  };
}

export interface ConversationCardProps {
  conversation: OmnichannelConversation;
  isSelected: boolean;
  onClick: () => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  currentTime?: number;
  className?: string;
}

export const ConversationCard: React.FC<ConversationCardProps> = ({
  conversation,
  isSelected,
  onClick,
  onKeyDown,
  currentTime,
  className = '',
}) => {
  const sla = formatSlaBadge(conversation.slaDeadline, conversation.slaBreached, currentTime);

  const getChannelColor = (ch: ChannelProvider) => {
    switch (ch) {
      case 'whatsapp':
        return 'bg-emerald-500';
      case 'telegram':
        return 'bg-sky-500';
      case 'instagram':
        return 'bg-pink-500';
      case 'webchat':
        return 'bg-purple-500';
      default:
        return 'bg-slate-500';
    }
  };

  const getInitials = (name: string) => {
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[1][0]).toUpperCase();
    }
    return name.slice(0, 2).toUpperCase();
  };

  const formatTimestamp = (ts: number) => {
    const diff = Math.floor((Date.now() - ts) / 60000);
    if (diff < 1) return 'Ahora';
    if (diff < 60) return `${diff} min`;
    const hours = Math.floor(diff / 60);
    if (hours < 24) return `${hours} h`;
    const days = Math.floor(hours / 24);
    return `${days} d`;
  };

  return (
    <div
      role="listitem"
      tabIndex={isSelected ? 0 : -1}
      aria-current={isSelected ? 'true' : 'false'}
      aria-label={`${conversation.participant.name}, canal ${conversation.channel}, ${
        conversation.unreadCount > 0 ? `${conversation.unreadCount} sin leer` : 'leído'
      }, ${sla.ariaLabel}`}
      onClick={onClick}
      onKeyDown={onKeyDown}
      className={`group flex h-16 cursor-pointer items-center gap-3 px-3 py-2 transition-colors border-b border-slate-100 dark:border-slate-800/60 select-none focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 ${
        isSelected
          ? 'bg-teal-50/70 dark:bg-teal-950/30 border-l-4 border-l-teal-600'
          : 'hover:bg-slate-50 dark:hover:bg-slate-800/40 border-l-4 border-l-transparent'
      } ${className}`}
    >
      {/* Avatar with Channel Indicator */}
      <div className="relative shrink-0">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-200 text-slate-700 font-bold text-xs dark:bg-slate-700 dark:text-slate-200">
          {getInitials(conversation.participant.name)}
        </div>
        <span
          className={`absolute bottom-0 right-0 h-3 w-3 rounded-full border-2 border-white dark:border-slate-900 ${getChannelColor(
            conversation.channel
          )}`}
          title={`Canal: ${conversation.channel}`}
          aria-hidden="true"
        />
      </div>

      {/* Details Container */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-1">
          <span className="truncate text-xs font-semibold text-slate-900 dark:text-slate-100">
            {conversation.participant.name}
          </span>
          <span className="text-[10px] text-slate-400 shrink-0">
            {formatTimestamp(conversation.lastMessageTimestamp)}
          </span>
        </div>

        <p className="truncate text-xs text-slate-500 dark:text-slate-400 mt-0.5">
          {conversation.lastMessagePreview}
        </p>

        {/* Tags & SLA Badge */}
        <div className="flex items-center gap-1.5 mt-1 overflow-hidden">
          {conversation.tags.slice(0, 2).map((t) => (
            <span
              key={t.id}
              className="rounded px-1.5 py-0.2 text-[9px] font-medium truncate max-w-[70px]"
              style={{ backgroundColor: `${t.color}20`, color: t.color }}
            >
              {t.name}
            </span>
          ))}

          {/* Dynamic SLA Badge */}
          {sla.variant === 'red' && (
            <span
              role="alert"
              aria-label={sla.ariaLabel}
              className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[9px] font-bold bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-400 border border-red-300 dark:border-red-800 animate-pulse"
            >
              <AlertTriangle size={10} className="shrink-0" aria-hidden="true" />
              <span>{sla.text}</span>
            </span>
          )}

          {sla.variant === 'amber' && (
            <span
              role="status"
              aria-label={sla.ariaLabel}
              className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[9px] font-medium bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-400 border border-amber-300 dark:border-amber-800"
            >
              <Clock size={10} className="shrink-0" aria-hidden="true" />
              <span>{sla.text}</span>
            </span>
          )}

          {sla.variant === 'green' && (
            <span
              role="status"
              aria-label={sla.ariaLabel}
              className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[9px] font-medium bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-400 border border-emerald-300 dark:border-emerald-800"
            >
              <CheckCircle size={10} className="shrink-0" aria-hidden="true" />
              <span>{sla.text}</span>
            </span>
          )}

          {/* Unread count pill */}
          {conversation.unreadCount > 0 && (
            <span
              className="ml-auto shrink-0 rounded-full bg-teal-600 px-1.5 py-0.2 text-[9px] font-bold text-white dark:bg-teal-500"
              aria-label={`${conversation.unreadCount} mensajes no leídos`}
            >
              {conversation.unreadCount}
            </span>
          )}
        </div>
      </div>
    </div>
  );
};
