import React, { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { useAtom, useSetAtom } from 'jotai';
import MessagesPanel from './bandeja de chats/MessagesPanel';
import MessageInputBar from './bandeja de chats/MessageInputBar';
import CanonicalSendStatus from './CanonicalSendStatus';
import type { CanonicalComposer } from '../hooks/useCanonicalComposer';
import type { WhatsAppMessage } from '../../../shared/types/wsp';
import {
  AlertTriangle,
  Check,
  History,
  Loader2,
  PauseCircle,
  PlayCircle,
  RefreshCw,
  Sparkles,
  X,
} from 'lucide-react';
import { agentService, type AgentActivityTurn, type AiAgent } from '../../agentes/services/agentService';
import { useCustomerHistory } from '../hooks/useCustomerHistory';
import CustomerHistoryPanel from './customer-history/CustomerHistoryPanel';
import { iaService } from '../../dashboard/services/iaService';
import { agentStateAtom, setChatActivityAtom } from '../../../jotai/slices/agentStateAtom';

interface ChatContainerProps {
  selectedChat: string | null;
  loadingMessages: boolean;
  message: string;
  setMessage: React.Dispatch<React.SetStateAction<string>>;
  messages: WhatsAppMessage[];
  onImageClick: (msg: WhatsAppMessage) => void;
  composer: CanonicalComposer;
  onOptimisticMessage: (msg: WhatsAppMessage) => void;
  onMessageSent: (tempId: string, realId: string) => void;
  onMessageError: (tempId: string) => void;
}

const ChatContainer: React.FC<ChatContainerProps> = ({
  selectedChat,
  loadingMessages,
  message,
  setMessage,
  messages,
  onImageClick,
  composer,
  onOptimisticMessage,
  onMessageSent,
  onMessageError,
}) => {
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [agentSuggestion, setAgentSuggestion] = useState<{
    reply: string;
    confidence: number;
    action: string;
    reason?: string;
    usedKnowledgeIds?: number[];
  } | null>(null);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [defaultAgent, setDefaultAgent] = useState<AiAgent | null>(null);
  const [agentStatusLoading, setAgentStatusLoading] = useState(false);
  const [desktopHistoryOpen, setDesktopHistoryOpen] = useState(true);
  const [mobileHistoryOpen, setMobileHistoryOpen] = useState(false);
  const [iaPauseLoading, setIaPauseLoading] = useState(false);
  const [handoffBanner, setHandoffBanner] = useState<{ ticketId: number; reason: string } | null>(null);
  const [agentActivity, setAgentActivity] = useState<AgentActivityTurn[]>([]);
  const [agentState] = useAtom(agentStateAtom);
  const setChatActivity = useSetAtom(setChatActivityAtom);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const emojiPickerRef = useRef<HTMLDivElement>(null);
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  const pendingEmojiCaret = useRef<{ input: HTMLTextAreaElement; offset: number }>(null);
  const ownershipFocus = useRef(false);
  const customerHistory = useCustomerHistory(selectedChat);

  const iaPauseStatus = selectedChat ? agentState.iaPauseByChat[selectedChat] : undefined;
  const isIaPaused = composer.conversation?.aiPaused ?? Boolean(iaPauseStatus?.paused);

  useLayoutEffect(() => {
    const caret = pendingEmojiCaret.current;
    if (emojiPickerOpen || !caret) return;
    pendingEmojiCaret.current = null;
    if (composerInputRef.current !== caret.input) return;
    caret.input.focus();
    caret.input.setSelectionRange(caret.offset, caret.offset);
  }, [emojiPickerOpen, message]);

  useEffect(() => {
    if (!composer.owns) ownershipFocus.current = false;
    if (composer.canSend && composer.notice?.message === 'Control confirmado para tu sesión.' && !ownershipFocus.current) {
      ownershipFocus.current = true;
      composerInputRef.current?.focus();
    }
  }, [composer.canSend, composer.notice, composer.owns]);

  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, selectedChat]);

  useEffect(() => {
    if (!selectedChat) {
      setDefaultAgent(null);
      setMobileHistoryOpen(false);
      setDesktopHistoryOpen(true);
      setAgentSuggestion(null);
      setHandoffBanner(null);
      setAgentActivity([]);
      return;
    }

    let mounted = true;
    setAgentStatusLoading(true);
    agentService
      .listDomains()
      .then((domains) => {
        if (!mounted) return;
        const gestionWeb = domains.find((domain) => domain.domainKey === 'gestion_web');
        const assignedAgent = gestionWeb?.assignedAgent;
        setDefaultAgent(
          assignedAgent && assignedAgent.status === 'active' && assignedAgent.mode !== 'disabled'
            ? assignedAgent
            : null
        );
      })
      .catch(() => {
        if (mounted) setDefaultAgent(null);
      })
      .finally(() => {
        if (mounted) setAgentStatusLoading(false);
      });

    iaService
      .getPauseStatus(selectedChat)
      .then(() => {
        if (!mounted) return;
      })
      .catch(() => undefined);

    agentService
      .listChatAgentActivity(selectedChat, 50)
      .then((activity) => {
        if (mounted) {
          setAgentActivity(activity);
          setChatActivity({ chatId: selectedChat, turns: activity });
        }
      })
      .catch(() => {
        if (mounted) setAgentActivity([]);
      });

    return () => {
      mounted = false;
    };
  }, [selectedChat]);

  useEffect(() => {
    if (!selectedChat) return;
    const liveActivity = agentState.activityByChat[selectedChat];
    if (liveActivity) setAgentActivity(liveActivity);
  }, [agentState.activityByChat, selectedChat]);

  useEffect(() => {
    if (!emojiPickerOpen) return;
    function handlePointerOutside(event: PointerEvent) {
      if (emojiPickerRef.current && !emojiPickerRef.current.contains(event.target as Node)) {
        setEmojiPickerOpen(false);
      }
    }
    function handleEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      if (emojiPickerRef.current?.contains(event.target as Node)) event.stopPropagation();
      setEmojiPickerOpen(false);
      emojiPickerRef.current?.querySelector('button')?.focus();
    }
    document.addEventListener('pointerdown', handlePointerOutside);
    // Emoji Mart stops Escape from bubbling out of its shadow-root search input.
    document.addEventListener('keydown', handleEscape, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerOutside);
      document.removeEventListener('keydown', handleEscape, true);
    };
  }, [emojiPickerOpen]);

  useEffect(() => {
    if (!selectedChat) return;
    const matchingHandoff = agentState.handoffTickets.find(
      (ticket) => ticket.chatId === selectedChat && ticket.status === 'open'
    );
    if (matchingHandoff) {
      setHandoffBanner({ ticketId: matchingHandoff.id, reason: matchingHandoff.reason });
    } else {
      setHandoffBanner(null);
    }
  }, [agentState.handoffTickets, selectedChat]);

  const handleSendMessage = async () => {
    if (!message.trim() || !selectedChat || !composer.canSend) return;
    setAgentSuggestion(null);
    await composer.send(message);
  };

  const handleEmojiSelect = (emoji: string) => {
    const input = composerInputRef.current;
    const start = input?.selectionStart ?? message.length;
    const end = input?.selectionEnd ?? start;
    if (input) pendingEmojiCaret.current = { input, offset: start + emoji.length };
    setMessage((previous) => previous.slice(0, start) + emoji + previous.slice(end));
    setEmojiPickerOpen(false);
    // Keep focus in the selection gesture so mobile browsers can reopen the keyboard.
    input?.focus();
  };

  const getAgentStatusText = () => {
    if (agentStatusLoading) return 'Consultando estado del agente...';
    if (!defaultAgent) return 'No hay agente asignado a Gestion Web.';
    if (isIaPaused) return `IA pausada en este chat. ${defaultAgent.name} no respondera hasta reanudar.`;
    if (defaultAgent.mode === 'auto') {
      return `Agente automatico activo: ${defaultAgent.name} respondera cuando llegue un mensaje nuevo.`;
    }
    return `Agente en modo sugerencia: ${defaultAgent.name} genera respuestas para revisar antes de enviar.`;
  };

  const handleSuggestResponse = async () => {
    if (!selectedChat || !defaultAgent || suggesting) return;

    const lastCustomerMessage = [...messages].reverse().find((item) => !item.fromMe && item.body?.trim());
    if (!lastCustomerMessage) {
      setAgentError('No hay un mensaje reciente del cliente para sugerir respuesta.');
      return;
    }

    setSuggesting(true);
    setAgentError(null);
    setAgentSuggestion(null);

    try {
      const result = await agentService.suggestDefault({
        chatId: selectedChat,
        message: lastCustomerMessage.body,
        history: messages.slice(-12).map((item) => ({
          fromMe: item.fromMe,
          body: item.body,
          type: item.type,
          timestamp: item.timestamp,
        })),
      });

      setAgentSuggestion({
        reply: result.reply,
        confidence: result.confidence,
        action: result.action,
        reason: result.reason,
        usedKnowledgeIds: result.usedKnowledgeIds,
      });
      const activity = await agentService.listChatAgentActivity(selectedChat, 50);
      setAgentActivity(activity);
      setChatActivity({ chatId: selectedChat, turns: activity });
    } catch (error: unknown) {
      const err = error as Error & { response?: { data?: { error?: string } } };
      setAgentError(err?.response?.data?.error || err?.message || 'No se pudo generar la sugerencia.');
    } finally {
      setSuggesting(false);
    }
  };

  const handleAcceptSuggestion = () => {
    if (!agentSuggestion) return;
    setMessage(agentSuggestion.reply);
    setAgentSuggestion(null);
  };

  const handleRejectSuggestion = () => {
    setAgentSuggestion(null);
  };

  const handleRegenerateSuggestion = async () => {
    if (!selectedChat || !defaultAgent || suggesting) return;
    setAgentSuggestion(null);
    await handleSuggestResponse();
  };

  const handleToggleIaPause = async () => {
    if (!selectedChat || iaPauseLoading) return;
    setIaPauseLoading(true);
    try {
      if (isIaPaused) {
        await iaService.resumeIa(selectedChat);
      } else {
        await iaService.pauseIa(selectedChat, 'Pausado manualmente desde chat', 24);
      }
      composer.refresh();
    } catch (error: unknown) {
      const err = error as Error & { response?: { data?: { message?: string } } };
      setAgentError(err?.response?.data?.message || err?.message || 'No se pudo cambiar el estado de la IA.');
    } finally {
      setIaPauseLoading(false);
    }
  };

  const handleTakeHandoff = async () => {
    if (!handoffBanner) return;
    try {
      await iaService.takeHandoffTicket(handoffBanner.ticketId);
      setHandoffBanner(null);
      customerHistory.reload();
      if (selectedChat) {
        const activity = await agentService.listChatAgentActivity(selectedChat, 50);
        setAgentActivity(activity);
        setChatActivity({ chatId: selectedChat, turns: activity });
      }
    } catch (error: unknown) {
      const err = error as Error & { response?: { data?: { message?: string } } };
      setAgentError(err?.response?.data?.message || err?.message || 'No se pudo tomar el ticket.');
    }
  };

  const handleHistoryClick = () => {
    if (typeof window !== 'undefined' && window.matchMedia('(min-width: 1280px)').matches) {
      setDesktopHistoryOpen((open) => !open);
      return;
    }
    setMobileHistoryOpen(true);
  };

  return (
    <div className="flex-1 flex h-0 min-h-0">
      <div className="transition-all flex-1 flex flex-col h-full min-w-0">
        <div className="flex flex-1 min-h-0">
          <MessagesPanel
            selectedChat={selectedChat}
            loadingMessages={loadingMessages}
            messages={messages}
            messagesEndRef={messagesEndRef}
            onImageClick={onImageClick}
            onServiceCompleted={customerHistory.reload}
            agentActivity={agentActivity}
          />
        </div>

        {selectedChat && handoffBanner && (
          <div className="border-t border-[#D9E5DF] bg-[#EEF4F1] px-4 py-2 dark:border-slate-700 dark:bg-slate-900">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-xs font-semibold text-[#0E766A] dark:text-emerald-300">
                <AlertTriangle className="h-4 w-4" />
                <span>IA derivo a humano: {handoffBanner.reason}</span>
              </div>
              <button
                type="button"
                onClick={handleTakeHandoff}
                className="rounded-md bg-[#128C7E] px-3 py-1 text-xs font-semibold text-white hover:bg-[#0E766A]"
              >
                Tomar chat
              </button>
            </div>
          </div>
        )}

        {selectedChat && (
          <div className="border-t border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 px-4 py-2">
            <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
              <div className="text-xs text-gray-500 dark:text-gray-400">
                {agentSuggestion ? (
                  <span>
                    Sugerencia lista · {Math.round(agentSuggestion.confidence * 100)}% · {agentSuggestion.action}
                  </span>
                ) : (
                  <span>{getAgentStatusText()}</span>
                )}
                {agentError && <span className="ml-2 text-red-500">{agentError}</span>}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={handleHistoryClick}
                  className="inline-flex items-center justify-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-50 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-200 dark:hover:bg-gray-900"
                >
                  <History className="h-4 w-4" />
                  <span className="xl:hidden">Historial</span>
                  <span className="hidden xl:inline">{desktopHistoryOpen ? 'Ocultar historial' : 'Historial'}</span>
                </button>
                <button
                  type="button"
                  onClick={handleToggleIaPause}
                  disabled={iaPauseLoading || !defaultAgent}
                  className={`inline-flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-xs font-semibold transition disabled:opacity-60 ${
                    isIaPaused
                      ? 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                      : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-200 dark:hover:bg-gray-900'
                  }`}
                  title={isIaPaused ? 'Reanudar IA en este chat' : 'Pausar IA en este chat'}
                >
                  {iaPauseLoading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : isIaPaused ? (
                    <PlayCircle className="h-4 w-4" />
                  ) : (
                    <PauseCircle className="h-4 w-4" />
                  )}
                  {isIaPaused ? 'Reanudar IA' : 'Pausar IA'}
                </button>
                <button
                  type="button"
                  onClick={handleSuggestResponse}
                  disabled={suggesting || isIaPaused || !defaultAgent}
                  className="inline-flex items-center justify-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-700 hover:bg-emerald-100 disabled:opacity-60 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300"
                >
                  <Sparkles className="h-4 w-4" />
                  {suggesting ? 'Generando...' : 'Sugerir respuesta'}
                </button>
              </div>
            </div>
          </div>
        )}

        {selectedChat && agentSuggestion && (
          <div className="border-t border-emerald-200 bg-emerald-50/60 px-4 py-3 dark:border-emerald-900 dark:bg-emerald-950/30">
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <div className="mb-1 flex items-center gap-2 text-xs font-semibold text-emerald-800 dark:text-emerald-300">
                  <Sparkles className="h-4 w-4" />
                  Sugerencia IA · {Math.round(agentSuggestion.confidence * 100)}% · {agentSuggestion.action}
                </div>
                <p className="text-sm text-gray-800 dark:text-gray-200 whitespace-pre-wrap">
                  {agentSuggestion.reply || '(sin respuesta)'}
                </p>
                {agentSuggestion.reason && (
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{agentSuggestion.reason}</p>
                )}
              </div>
              <button
                type="button"
                onClick={handleRejectSuggestion}
                className="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-200"
                aria-label="Cerrar sugerencia"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={handleAcceptSuggestion}
                className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
              >
                <Check className="h-3.5 w-3.5" />
                Aceptar y editar
              </button>
              <button
                type="button"
                onClick={handleRegenerateSuggestion}
                disabled={suggesting}
                className="inline-flex items-center gap-1.5 rounded-md border border-emerald-200 bg-white px-3 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-50 disabled:opacity-60 dark:border-emerald-900 dark:bg-gray-950 dark:text-emerald-300"
              >
                {suggesting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                Regenerar
              </button>
              <button
                type="button"
                onClick={handleRejectSuggestion}
                className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-3 py-1.5 text-xs font-semibold text-gray-600 hover:bg-gray-50 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-300"
              >
                <X className="h-3.5 w-3.5" />
                Rechazar
              </button>
            </div>
          </div>
        )}

        <CanonicalSendStatus composer={composer} />
        <MessageInputBar
          message={message}
          setMessage={setMessage}
          selectedChat={selectedChat}
          handleSendMessage={handleSendMessage}
          canSendText={composer.canSend}
          canSendFile={composer.canAttach}
          textSending={composer.phase === 'send'}
          inputRef={composerInputRef}
          emojiPickerOpen={emojiPickerOpen}
          setEmojiPickerOpen={setEmojiPickerOpen}
          emojiPickerRef={emojiPickerRef}
          handleEmojiSelect={handleEmojiSelect}
          onOptimisticMessage={onOptimisticMessage}
          onMessageSent={onMessageSent}
          onMessageError={onMessageError}
        />
      </div>
      {selectedChat && desktopHistoryOpen && (
        <div className="hidden w-[300px] flex-shrink-0 2xl:w-80 xl:flex">
          <CustomerHistoryPanel
            history={customerHistory.history}
            loading={customerHistory.loading}
            error={customerHistory.error}
            onReload={customerHistory.reload}
          />
        </div>
      )}
      {selectedChat && mobileHistoryOpen && (
        <div className="fixed inset-0 z-50 bg-black/40 xl:hidden">
          <div className="ml-auto h-full w-full max-w-sm bg-white shadow-xl dark:bg-gray-950">
            <CustomerHistoryPanel
              history={customerHistory.history}
              loading={customerHistory.loading}
              error={customerHistory.error}
              onReload={customerHistory.reload}
              onClose={() => setMobileHistoryOpen(false)}
            />
          </div>
        </div>
      )}
    </div>
  );
};

export default ChatContainer;
