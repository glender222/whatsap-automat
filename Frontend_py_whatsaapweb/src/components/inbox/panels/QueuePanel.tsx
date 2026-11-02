import React, { useState, useEffect } from 'react';
import type { OmnichannelConversation, OperatorPresence } from '../types';
import { ConversationCard } from '../components/ConversationCard';
import { Inbox } from 'lucide-react';

export interface QueuePanelProps {
  conversations: OmnichannelConversation[];
  selectedChatId: string | null;
  onSelectChat: (conversationId: string) => void;
  operatorPresence: OperatorPresence;
  onPresenceChange: (presence: OperatorPresence) => void;
  onResetFilters?: () => void;
  isLoading?: boolean;
  className?: string;
}

export const QueuePanel: React.FC<QueuePanelProps> = ({
  conversations,
  selectedChatId,
  onSelectChat,
  operatorPresence,
  onPresenceChange,
  onResetFilters,
  isLoading = false,
  className = '',
}) => {
  const [currentTime, setCurrentTime] = useState<number>(Date.now());
  const [announcement, setAnnouncement] = useState<string>('');

  // 1-second dynamic SLA timer ticker
  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentTime(Date.now());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // Update live region announcement when breached count or list changes
  useEffect(() => {
    const breachedCount = conversations.filter(
      (c) => c.slaBreached || c.slaDeadline <= currentTime
    ).length;

    if (breachedCount > 0) {
      setAnnouncement(
        `Atención: ${breachedCount} conversación(es) con SLA vencido en la cola de trabajo.`
      );
    } else {
      setAnnouncement(`Cola actualizada: ${conversations.length} conversaciones activas.`);
    }
  }, [conversations.length]);

  const getPresenceColor = (presence: OperatorPresence) => {
    switch (presence) {
      case 'available':
        return 'bg-emerald-500';
      case 'busy':
        return 'bg-amber-500';
      case 'offline':
        return 'bg-slate-400';
    }
  };

  const handleListKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (conversations.length === 0) return;
    const currentIndex = conversations.findIndex((c) => c.id === selectedChatId);

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const nextIndex = Math.min(currentIndex + 1, conversations.length - 1);
      onSelectChat(conversations[nextIndex].id);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prevIndex = Math.max(currentIndex - 1, 0);
      onSelectChat(conversations[prevIndex].id);
    } else if (e.key === 'Home') {
      e.preventDefault();
      onSelectChat(conversations[0].id);
    } else if (e.key === 'End') {
      e.preventDefault();
      onSelectChat(conversations[conversations.length - 1].id);
    }
  };

  return (
    <section
      role="region"
      id="panel-conversation-queue"
      aria-label="Cola de trabajo de conversaciones"
      className={`flex w-80 shrink-0 flex-col border-r bg-white dark:bg-[#131B2E] border-slate-200 dark:border-slate-800 ${className}`}
    >
      {/* Polite Screen Reader Live Region for SLA & Queue updates */}
      <div
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
        id="queue-live-announcer"
      >
        {announcement}
      </div>

      {/* Header & Operator Presence */}
      <div className="flex h-14 shrink-0 items-center justify-between border-b px-3.5 border-inherit">
        <div className="flex items-center gap-2">
          <h2 className="text-xs font-bold uppercase tracking-wider text-slate-700 dark:text-slate-300">
            Cola de Trabajo
          </h2>
          <span className="rounded-full bg-slate-100 dark:bg-slate-800 px-2 py-0.5 text-[10px] font-bold text-slate-600 dark:text-slate-300">
            {conversations.length}
          </span>
        </div>

        {/* Presence Selector */}
        <div className="flex items-center gap-1.5">
          <span
            className={`h-2.5 w-2.5 rounded-full ${getPresenceColor(operatorPresence)}`}
            aria-hidden="true"
          />
          <select
            role="combobox"
            value={operatorPresence}
            onChange={(e) => onPresenceChange(e.target.value as OperatorPresence)}
            aria-label="Estado de disponibilidad del operador"
            className="rounded border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/60 py-1 pl-1.5 pr-6 text-xs font-medium text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-teal-500 cursor-pointer"
          >
            <option value="available">Disponible</option>
            <option value="busy">Ocupado</option>
            <option value="offline">Desconectado</option>
          </select>
        </div>
      </div>

      {/* Conversation List */}
      <div
        role="list"
        aria-label="Lista de conversaciones"
        onKeyDown={handleListKeyDown}
        className="flex-1 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800/60"
      >
        {isLoading ? (
          <div className="flex h-40 flex-col items-center justify-center p-4 text-slate-400">
            <span className="text-xs">Cargando conversaciones...</span>
          </div>
        ) : conversations.length === 0 ? (
          <div className="flex h-64 flex-col items-center justify-center p-6 text-center text-slate-400">
            <Inbox size={32} className="mb-2 opacity-40" aria-hidden="true" />
            <p className="text-xs font-semibold text-slate-600 dark:text-slate-300">
              No hay conversaciones
            </p>
            <p className="mt-1 text-[11px] text-slate-400">
              No se encontraron resultados con los filtros actuales.
            </p>
            {onResetFilters && (
              <button
                type="button"
                onClick={onResetFilters}
                className="mt-3 rounded bg-teal-50 dark:bg-teal-950/60 px-3 py-1 text-xs font-medium text-teal-700 dark:text-teal-300 hover:bg-teal-100"
              >
                Limpiar filtros
              </button>
            )}
          </div>
        ) : (
          conversations.map((chat) => (
            <ConversationCard
              key={chat.id}
              conversation={chat}
              isSelected={chat.id === selectedChatId}
              onClick={() => onSelectChat(chat.id)}
              currentTime={currentTime}
            />
          ))
        )}
      </div>
    </section>
  );
};
