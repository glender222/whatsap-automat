/**
 * Whatsap-Automat v0.4 — Omnichannel 4-Panel Workspace Container
 * Phase F3: PR-F3-04 (WCAG 2.2 AA Accessibility & CAS Concurrency Guard)
 */

import React, { useState, useMemo, useCallback } from 'react';
import type {
  OmnichannelConversation,
  OmnichannelMessage,
  AiSuggestionPayload,
  AiToolTraceItem,
  CustomerOrderSummary,
  InternalNote,
  ChannelProvider,
  ConversationStatus,
  OperatorPresence,
  FunctionalPlaneId,
} from './types';
import {
  MOCK_CONVERSATIONS,
  MOCK_MESSAGES,
  MOCK_AI_SUGGESTIONS,
  MOCK_AGENT_TRACES,
  MOCK_CUSTOMER_ORDERS,
  MOCK_INTERNAL_NOTES,
  MOCK_FUNCTIONAL_PLANES,
} from './mockData';
import { NavigationPanel } from './panels/NavigationPanel';
import { QueuePanel } from './panels/QueuePanel';
import { TimelinePanel } from './panels/TimelinePanel';
import { ContextPanel } from './panels/ContextPanel';
import { AlertCircle, X } from 'lucide-react';

export interface OmnichannelInboxProps {
  initialConversations?: OmnichannelConversation[];
  initialMessages?: Record<string, OmnichannelMessage[]>;
  initialActiveSuggestion?: AiSuggestionPayload | null;
  initialAgentTraces?: Record<string, AiToolTraceItem[]>;
  initialActiveOrders?: Record<string, CustomerOrderSummary>;
  initialInternalNotes?: Record<string, InternalNote[]>;
  operatorName?: string;
  onSendMessageAsync?: (
    conversationId: string,
    text: string,
    attachments?: File[]
  ) => Promise<void>;
  onTakeoverAsync?: (
    conversationId: string,
    expectedVersion: number
  ) => Promise<{ success: boolean; newVersion?: number; conflict?: boolean }>;
  className?: string;
}

export const OmnichannelInbox: React.FC<OmnichannelInboxProps> = ({
  initialConversations = MOCK_CONVERSATIONS,
  initialMessages = MOCK_MESSAGES,
  initialActiveSuggestion,
  initialAgentTraces = MOCK_AGENT_TRACES,
  initialActiveOrders = MOCK_CUSTOMER_ORDERS,
  initialInternalNotes = MOCK_INTERNAL_NOTES,
  operatorName = 'Ana Pérez',
  onSendMessageAsync,
  onTakeoverAsync,
  className = '',
}) => {
  // Master state
  const [conversations, setConversations] =
    useState<OmnichannelConversation[]>(initialConversations);
  const [selectedChatId, setSelectedChatId] = useState<string | null>(
    initialConversations[0]?.id ?? null
  );
  const [currentChannel, setCurrentChannel] = useState<'all' | ChannelProvider>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<
    ConversationStatus | 'all' | 'mine' | 'sla_risk'
  >('all');
  const [activeFunctionalPlane, setActiveFunctionalPlane] =
    useState<FunctionalPlaneId>('operations');
  const [operatorPresence, setOperatorPresence] =
    useState<OperatorPresence>('available');

  // Timeline and Context states
  const [composerText, setComposerText] = useState('');
  const [contextPanelOpen, setContextPanelOpen] = useState(true);
  const [messagesMap, setMessagesMap] =
    useState<Record<string, OmnichannelMessage[]>>(initialMessages);
  const [tracesMap] =
    useState<Record<string, AiToolTraceItem[]>>(initialAgentTraces);
  const [ordersMap] =
    useState<Record<string, CustomerOrderSummary>>(initialActiveOrders);
  const [notesMap, setNotesMap] =
    useState<Record<string, InternalNote[]>>(initialInternalNotes);

  // Active suggestion per chat
  const [activeSuggestion, setActiveSuggestion] =
    useState<AiSuggestionPayload | null>(
      initialActiveSuggestion !== undefined
        ? initialActiveSuggestion
        : selectedChatId
        ? MOCK_AI_SUGGESTIONS[selectedChatId] ?? null
        : null
    );

  // Concurrency & Takeover status
  const [isTakeoverLoading, setIsTakeoverLoading] = useState(false);
  const [casConflictMessage, setCasConflictMessage] = useState<string | null>(null);

  // Active conversation resolution
  const activeConversation = useMemo(() => {
    return conversations.find((c) => c.id === selectedChatId) ?? null;
  }, [conversations, selectedChatId]);

  // Messages of active conversation
  const activeMessages = useMemo(() => {
    if (!selectedChatId) return [];
    return messagesMap[selectedChatId] ?? [];
  }, [messagesMap, selectedChatId]);

  // Unread totals calculated across channels
  const unreadTotalsByChannel = useMemo(() => {
    const totals: Partial<Record<ChannelProvider | 'all', number>> = {
      all: 0,
      whatsapp: 0,
      telegram: 0,
      instagram: 0,
      webchat: 0,
    };
    conversations.forEach((c) => {
      totals[c.channel] = (totals[c.channel] ?? 0) + c.unreadCount;
      totals.all = (totals.all ?? 0) + c.unreadCount;
    });
    return totals;
  }, [conversations]);

  // Filtered conversations for Panel 2
  const filteredConversations = useMemo(() => {
    return conversations.filter((chat) => {
      // 1. Channel Filter
      if (currentChannel !== 'all' && chat.channel !== currentChannel) {
        return false;
      }

      // 2. Search Query Filter
      if (searchQuery.trim()) {
        const query = searchQuery.trim().toLowerCase();
        const matchesName = chat.participant.name.toLowerCase().includes(query);
        const matchesPhone = chat.participant.phoneNumber?.includes(query);
        const matchesUsername = chat.participant.username
          ?.toLowerCase()
          .includes(query);
        const matchesPreview = chat.lastMessagePreview.toLowerCase().includes(query);
        if (!matchesName && !matchesPhone && !matchesUsername && !matchesPreview) {
          return false;
        }
      }

      // 3. Operational Status Filter
      if (statusFilter === 'mine') {
        const isAssigned =
          chat.assignedOperatorName?.includes('Tú') ||
          chat.assignedOperatorId === 'op-01';
        if (!isAssigned) return false;
      } else if (statusFilter === 'sla_risk') {
        const isRisk =
          chat.slaBreached || chat.slaDeadline - Date.now() <= 5 * 60 * 1000;
        if (!isRisk) return false;
      } else if (statusFilter !== 'all') {
        if (chat.status !== statusFilter) {
          return false;
        }
      }

      return true;
    });
  }, [conversations, currentChannel, searchQuery, statusFilter]);

  // Chat selection handler
  const handleSelectChat = useCallback(
    (conversationId: string) => {
      setSelectedChatId(conversationId);
      // Reset unread count for selected chat
      setConversations((prev) =>
        prev.map((c) => (c.id === conversationId ? { ...c, unreadCount: 0 } : c))
      );
      // Load chat specific suggestion or null
      setActiveSuggestion(MOCK_AI_SUGGESTIONS[conversationId] ?? null);
      setCasConflictMessage(null);
    },
    []
  );

  // CAS Takeover Handler
  const handleTakeover = useCallback(async () => {
    if (!activeConversation || isTakeoverLoading) return;

    const previousVersion = activeConversation.stateVersion;
    const conversationId = activeConversation.id;

    // 1. Synchronously invalidate any pending AI suggestion
    setActiveSuggestion(null);

    // 2. Optimistic CAS state update
    setConversations((prev) =>
      prev.map((c) =>
        c.id === conversationId
          ? {
              ...c,
              status: 'open',
              stateVersion: c.stateVersion + 1,
              ownershipEpoch: (c.ownershipEpoch ?? 0) + 1,
              assignedOperatorName: `${operatorName} (Tú)`,
            }
          : c
      )
    );

    // 3. Dispatched external async takeover call if provided
    if (onTakeoverAsync) {
      setIsTakeoverLoading(true);
      try {
        const res = await onTakeoverAsync(conversationId, previousVersion);
        if (res.conflict) {
          // Reconcile version and notify
          setConversations((prev) =>
            prev.map((c) =>
              c.id === conversationId
                ? {
                    ...c,
                    stateVersion: res.newVersion ?? c.stateVersion,
                  }
                : c
            )
          );
          setCasConflictMessage(
            `Conflicto CAS: Esta conversación fue modificada concurrentemente (v${
              res.newVersion ?? previousVersion + 1
            }). Tu borrador fue preservado.`
          );
        }
      } catch (err) {
        console.error('[CAS Takeover Error]:', err);
        // Revert optimistic update on hard error
        setConversations((prev) =>
          prev.map((c) =>
            c.id === conversationId
              ? { ...c, stateVersion: previousVersion, status: 'ai_handling' }
              : c
          )
        );
      } finally {
        setIsTakeoverLoading(false);
      }
    }
  }, [activeConversation, isTakeoverLoading, operatorName, onTakeoverAsync]);

  // Accept and send AI suggestion
  const handleAcceptSuggestion = useCallback(
    (suggestion: AiSuggestionPayload) => {
      if (!activeConversation) return;

      const newMessage: OmnichannelMessage = {
        id: `msg-${Date.now()}`,
        conversationId: activeConversation.id,
        senderType: 'operator',
        senderName: operatorName,
        body: suggestion.replyText,
        timestamp: Date.now(),
        status: 'sent',
        channel: activeConversation.channel,
        isOptimistic: true,
        agentTraceId: 'trace-suggestion-dispatched',
      };

      setMessagesMap((prev) => ({
        ...prev,
        [activeConversation.id]: [
          ...(prev[activeConversation.id] ?? []),
          newMessage,
        ],
      }));

      // Invalidate suggestion immediately
      setActiveSuggestion(null);

      // Async dispatch
      onSendMessageAsync?.(activeConversation.id, suggestion.replyText);
    },
    [activeConversation, operatorName, onSendMessageAsync]
  );

  // Send message from composer
  const handleSendMessage = useCallback(() => {
    if (!activeConversation || !composerText.trim()) return;

    const trimmed = composerText.trim();
    const newMessage: OmnichannelMessage = {
      id: `msg-${Date.now()}`,
      conversationId: activeConversation.id,
      senderType: 'operator',
      senderName: operatorName,
      body: trimmed,
      timestamp: Date.now(),
      status: 'sent',
      channel: activeConversation.channel,
      isOptimistic: true,
    };

    setMessagesMap((prev) => ({
      ...prev,
      [activeConversation.id]: [
        ...(prev[activeConversation.id] ?? []),
        newMessage,
      ],
    }));

    // Update conversation preview and timestamp
    setConversations((prev) =>
      prev.map((c) =>
        c.id === activeConversation.id
          ? {
              ...c,
              lastMessagePreview: trimmed,
              lastMessageTimestamp: Date.now(),
            }
          : c
      )
    );

    setComposerText('');
    onSendMessageAsync?.(activeConversation.id, trimmed);
  }, [activeConversation, composerText, operatorName, onSendMessageAsync]);

  // Edit suggestion text in composer
  const handleEditSuggestionInComposer = useCallback((text: string) => {
    setComposerText(text);
    setActiveSuggestion(null);
  }, []);

  // Tag management
  const handleAddTag = useCallback(
    (tagName: string) => {
      if (!activeConversation) return;
      const newTag = {
        id: `tag-${Date.now()}`,
        name: tagName,
        color: '#0D9488',
      };
      setConversations((prev) =>
        prev.map((c) =>
          c.id === activeConversation.id
            ? { ...c, tags: [...c.tags, newTag] }
            : c
        )
      );
    },
    [activeConversation]
  );

  const handleRemoveTag = useCallback(
    (tagId: string) => {
      if (!activeConversation) return;
      setConversations((prev) =>
        prev.map((c) =>
          c.id === activeConversation.id
            ? { ...c, tags: c.tags.filter((t) => t.id !== tagId) }
            : c
        )
      );
    },
    [activeConversation]
  );

  // Internal notes
  const handleAddInternalNote = useCallback(
    (text: string) => {
      if (!activeConversation) return;
      const newNote: InternalNote = {
        id: `note-${Date.now()}`,
        authorName: operatorName,
        text,
        timestamp: Date.now(),
      };
      setNotesMap((prev) => ({
        ...prev,
        [activeConversation.id]: [
          ...(prev[activeConversation.id] ?? []),
          newNote,
        ],
      }));
    },
    [activeConversation, operatorName]
  );

  return (
    <div
      className={`flex h-full w-full overflow-hidden bg-slate-50 dark:bg-[#0B0F19] text-slate-900 dark:text-slate-100 ${className}`}
      data-testid="omnichannel-inbox"
    >
      {/* CAS Conflict Alert Toast */}
      {casConflictMessage && (
        <div
          role="alert"
          aria-live="assertive"
          className="fixed top-4 right-4 z-50 flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2.5 text-xs font-semibold text-white shadow-xl animate-fade-in"
        >
          <AlertCircle size={16} className="shrink-0" aria-hidden="true" />
          <span>{casConflictMessage}</span>
          <button
            type="button"
            onClick={() => setCasConflictMessage(null)}
            className="ml-2 rounded p-0.5 hover:bg-red-700"
            aria-label="Cerrar notificación de conflicto"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* PANEL 1: Navigation & Channels */}
      <NavigationPanel
        currentChannel={currentChannel}
        onSelectChannel={setCurrentChannel}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        statusFilter={statusFilter}
        onSelectStatusFilter={setStatusFilter}
        activeFunctionalPlane={activeFunctionalPlane}
        onSelectFunctionalPlane={setActiveFunctionalPlane}
        functionalPlanes={MOCK_FUNCTIONAL_PLANES}
        unreadTotalsByChannel={unreadTotalsByChannel}
      />

      {/* PANEL 2: Work Queue with SLA & Presence */}
      <QueuePanel
        conversations={filteredConversations}
        selectedChatId={selectedChatId}
        onSelectChat={handleSelectChat}
        operatorPresence={operatorPresence}
        onPresenceChange={setOperatorPresence}
        onResetFilters={() => {
          setCurrentChannel('all');
          setSearchQuery('');
          setStatusFilter('all');
        }}
      />

      {/* PANEL 3: Conversational Timeline & Composer */}
      <TimelinePanel
        activeConversation={activeConversation}
        messages={activeMessages}
        activeSuggestion={activeSuggestion}
        composerText={composerText}
        onComposerTextChange={setComposerText}
        onSendMessage={handleSendMessage}
        onTakeover={handleTakeover}
        onAcceptSuggestion={handleAcceptSuggestion}
        onDismissSuggestion={() => setActiveSuggestion(null)}
        onEditSuggestionInComposer={handleEditSuggestionInComposer}
        isContextPanelOpen={contextPanelOpen}
        onToggleContextPanel={() => setContextPanelOpen(!contextPanelOpen)}
        isTakeoverLoading={isTakeoverLoading}
        onAttachClick={() => alert('Selector de archivos o multimedia')}
        onOpenTemplatePicker={() =>
          alert('Selector de plantillas WhatsApp HSM aprobadas por Meta')
        }
      />

      {/* PANEL 4: Contact Context, AI Traces, Order, Notes */}
      <ContextPanel
        isOpen={contextPanelOpen}
        conversation={activeConversation}
        agentTraces={selectedChatId ? tracesMap[selectedChatId] ?? [] : []}
        activeOrder={selectedChatId ? ordersMap[selectedChatId] : undefined}
        internalNotes={selectedChatId ? notesMap[selectedChatId] ?? [] : []}
        onAddInternalNote={handleAddInternalNote}
        onAddTag={handleAddTag}
        onRemoveTag={handleRemoveTag}
        onClose={() => setContextPanelOpen(false)}
      />
    </div>
  );
};

export default OmnichannelInbox;
