import React, { useRef } from 'react';
import type { ChannelProvider } from '../types';
import { MessageSquare, Send, Instagram, Globe } from 'lucide-react';

export interface ChannelFilterTabsProps {
  currentChannel: 'all' | ChannelProvider;
  onSelectChannel: (channel: 'all' | ChannelProvider) => void;
  unreadTotals?: Partial<Record<ChannelProvider | 'all', number>>;
  className?: string;
}

const CHANNELS: Array<{ id: 'all' | ChannelProvider; label: string }> = [
  { id: 'all', label: 'Todos' },
  { id: 'whatsapp', label: 'WhatsApp' },
  { id: 'telegram', label: 'Telegram' },
  { id: 'instagram', label: 'Instagram' },
  { id: 'webchat', label: 'Webchat' },
];

export const ChannelFilterTabs: React.FC<ChannelFilterTabsProps> = ({
  currentChannel,
  onSelectChannel,
  unreadTotals = {},
  className = '',
}) => {
  const tabsRef = useRef<Array<HTMLButtonElement | null>>([]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    let targetIndex: number | null = null;

    if (e.key === 'ArrowRight') {
      targetIndex = (index + 1) % CHANNELS.length;
    } else if (e.key === 'ArrowLeft') {
      targetIndex = (index - 1 + CHANNELS.length) % CHANNELS.length;
    } else if (e.key === 'Home') {
      targetIndex = 0;
    } else if (e.key === 'End') {
      targetIndex = CHANNELS.length - 1;
    }

    if (targetIndex !== null) {
      e.preventDefault();
      const targetChannel = CHANNELS[targetIndex].id;
      onSelectChannel(targetChannel);
      tabsRef.current[targetIndex]?.focus();
    }
  };

  const getChannelIcon = (ch: 'all' | ChannelProvider) => {
    switch (ch) {
      case 'whatsapp':
        return <span className="inline-block h-2 w-2 rounded-full bg-emerald-500 mr-1" aria-hidden="true" />;
      case 'telegram':
        return <Send size={11} className="inline mr-1 text-sky-500" aria-hidden="true" />;
      case 'instagram':
        return <Instagram size={11} className="inline mr-1 text-pink-500" aria-hidden="true" />;
      case 'webchat':
        return <Globe size={11} className="inline mr-1 text-purple-500" aria-hidden="true" />;
      default:
        return <MessageSquare size={11} className="inline mr-1 text-slate-400" aria-hidden="true" />;
    }
  };

  return (
    <div
      role="tablist"
      aria-label="Filtrar por canal de mensajería"
      aria-orientation="horizontal"
      className={`flex rounded-lg bg-slate-100 p-1 dark:bg-slate-800 text-xs font-medium gap-0.5 overflow-x-auto ${className}`}
    >
      {CHANNELS.map((ch, idx) => {
        const isSelected = currentChannel === ch.id;
        const unread = unreadTotals[ch.id] ?? 0;

        return (
          <button
            key={ch.id}
            ref={(el) => {
              tabsRef.current[idx] = el;
            }}
            type="button"
            role="tab"
            id={`tab-channel-${ch.id}`}
            aria-selected={isSelected}
            aria-controls="panel-conversation-queue"
            tabIndex={isSelected ? 0 : -1}
            onClick={() => onSelectChannel(ch.id)}
            onKeyDown={(e) => handleKeyDown(e, idx)}
            className={`flex flex-1 items-center justify-center py-1.5 px-2 rounded-md transition-colors text-center whitespace-nowrap focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 ${
              isSelected
                ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-white font-semibold'
                : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200'
            }`}
          >
            {getChannelIcon(ch.id)}
            <span>{ch.label}</span>
            {unread > 0 && (
              <span
                className="ml-1.5 rounded-full bg-teal-600 px-1.5 py-0.2 text-[10px] font-bold text-white dark:bg-teal-500"
                aria-label={`${unread} mensajes sin leer`}
              >
                {unread}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
};
