import React from 'react';
import type {
  OmnichannelConversation,
  OmnichannelMessage,
  AiSuggestionPayload,
} from '../types';
import { MessageBubble } from '../components/MessageBubble';
import { AiSuggestionBanner } from '../components/AiSuggestionBanner';
import { ServiceWindowWarning } from '../components/ServiceWindowWarning';
import { MessageComposer } from '../components/MessageComposer';
import { TakeoverButton } from '../components/TakeoverButton';
import { Layers, MessageSquareDashed } from 'lucide-react';

export interface TimelinePanelProps {
  activeConversation: OmnichannelConversation | null;
  messages: OmnichannelMessage[];
  activeSuggestion: AiSuggestionPayload | null;
  composerText: string;
  onComposerTextChange: (text: string) => void;
  onSendMessage: () => void;
  onTakeover: () => void;
  onAcceptSuggestion: (suggestion: AiSuggestionPayload) => void;
  onDismissSuggestion: () => void;
  onEditSuggestionInComposer: (text: string) => void;
  isContextPanelOpen: boolean;
  onToggleContextPanel: () => void;
  isTakeoverLoading?: boolean;
  onAttachClick?: () => void;
  onOpenTemplatePicker?: () => void;
  className?: string;
}

export const TimelinePanel: React.FC<TimelinePanelProps> = ({
  activeConversation,
  messages,
  activeSuggestion,
  composerText,
  onComposerTextChange,
  onSendMessage,
  onTakeover,
  onAcceptSuggestion,
  onDismissSuggestion,
  onEditSuggestionInComposer,
  isContextPanelOpen,
  onToggleContextPanel,
  isTakeoverLoading = false,
  onAttachClick,
  onOpenTemplatePicker,
  className = '',
}) => {
  if (!activeConversation) {
    return (
      <section
        role="region"
        aria-label="Conversación activa"
        className={`flex flex-1 flex-col items-center justify-center p-8 bg-white dark:bg-[#0E1526] text-slate-400 ${className}`}
      >
        <MessageSquareDashed size={40} className="mb-3 opacity-30" aria-hidden="true" />
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300">
          Ninguna conversación seleccionada
        </h3>
        <p className="mt-1 text-xs text-slate-400">
          Selecciona un chat de la cola de trabajo para comenzar a interactuar.
        </p>
      </section>
    );
  }

  // Meta 24-hour service window check: WhatsApp only
  const is24hWindowBlocked =
    activeConversation.channel === 'whatsapp' && !activeConversation.is24hWindowActive;

  const getStatusBadge = () => {
    switch (activeConversation.status) {
      case 'ai_handling':
        return { label: 'IA Activa', classes: 'bg-teal-50 text-teal-700 dark:bg-teal-950/60 dark:text-teal-300 border-teal-200' };
      case 'pending_handoff':
        return { label: 'Handoff Pendiente', classes: 'bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300 border-amber-200' };
      case 'open':
        return { label: 'Atendido por Humano', classes: 'bg-blue-50 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300 border-blue-200' };
      case 'resolved':
        return { label: 'Resuelto', classes: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300 border-slate-300' };
    }
  };

  const statusBadge = getStatusBadge();

  return (
    <section
      role="region"
      aria-label={`Conversación con ${activeConversation.participant.name}`}
      className={`flex flex-1 flex-col overflow-hidden bg-white dark:bg-[#0E1526] ${className}`}
    >
      {/* Top Header */}
      <header className="flex h-14 shrink-0 items-center justify-between border-b px-4 border-slate-200 dark:border-slate-800 bg-white dark:bg-[#131B2E]">
        <div className="flex items-center gap-3 min-w-0">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
                {activeConversation.participant.name}
              </h2>
              <span className="rounded bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 text-[10px] font-medium text-slate-600 dark:text-slate-300 capitalize">
                {activeConversation.channel}
              </span>
              <span
                role="status"
                aria-label={`Estado de la conversación: ${statusBadge.label}`}
                className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${statusBadge.classes}`}
              >
                {statusBadge.label}
              </span>
              <span
                className="rounded bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 text-[10px] font-mono text-slate-500 dark:text-slate-400"
                aria-label={`Versión de concurrencia CAS: ${activeConversation.stateVersion}`}
                title="Versión de concurrencia optimista (CAS)"
              >
                CAS v{activeConversation.stateVersion}
              </span>
            </div>
            <p className="truncate text-[11px] text-slate-400">
              {activeConversation.participant.phoneNumber ||
                activeConversation.participant.username ||
                'Canal web'}
            </p>
          </div>
        </div>

        {/* Action Buttons: Takeover & Context Toggle */}
        <div className="flex items-center gap-2 shrink-0">
          {(activeConversation.status === 'ai_handling' ||
            activeConversation.status === 'pending_handoff') && (
            <TakeoverButton
              stateVersion={activeConversation.stateVersion}
              isLoading={isTakeoverLoading}
              onTakeover={onTakeover}
            />
          )}

          <button
            type="button"
            onClick={onToggleContextPanel}
            aria-label="Alternar panel de contexto del cliente"
            aria-expanded={isContextPanelOpen}
            aria-controls="context-panel-inspector"
            title="Alternar panel de contexto"
            className={`rounded-lg p-2 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 ${
              isContextPanelOpen
                ? 'bg-teal-50 text-teal-700 dark:bg-teal-950/60 dark:text-teal-300'
                : 'text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
            }`}
          >
            <Layers size={17} />
          </button>
        </div>
      </header>

      {/* Messages Timeline */}
      <div
        role="log"
        aria-label="Historial de mensajes"
        aria-live="polite"
        aria-relevant="additions text"
        className="flex-1 overflow-y-auto p-4 space-y-2.5"
      >
        {messages.length === 0 ? (
          <div className="flex h-32 items-center justify-center text-xs text-slate-400">
            No hay mensajes en esta conversación.
          </div>
        ) : (
          messages.map((m) => <MessageBubble key={m.id} message={m} />)
        )}
      </div>

      {/* AI Suggestion Banner (floating above composer) */}
      {activeSuggestion && (
        <AiSuggestionBanner
          suggestion={activeSuggestion}
          onAccept={() => onAcceptSuggestion(activeSuggestion)}
          onEdit={() => onEditSuggestionInComposer(activeSuggestion.replyText)}
          onDismiss={onDismissSuggestion}
        />
      )}

      {/* 24-Hour Service Window Warning */}
      <ServiceWindowWarning
        channel={activeConversation.channel}
        is24hWindowActive={activeConversation.is24hWindowActive}
        onOpenTemplatePicker={onOpenTemplatePicker}
      />

      {/* Message Composer */}
      <MessageComposer
        value={composerText}
        onChange={onComposerTextChange}
        onSend={onSendMessage}
        disabled={is24hWindowBlocked}
        disabledReason="Ventana de 24h expirada. Envía una plantilla aprobada por Meta para reabrir."
        onAttachClick={onAttachClick}
      />
    </section>
  );
};
