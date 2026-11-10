import { useEffect, useState } from 'react';
import { readSession } from '../../../shared/auth/session';
import SocketService from '../../../utils/socket';
import {
  readPublishedWhatsappSuggestion, type CanonicalConversation, type PublishedWhatsappSuggestion,
} from '../services/canonicalConversationApi';

export function usePublishedWhatsappSuggestion(conversation: CanonicalConversation | null, chatId: string | null) {
  const [{ generation, userId }] = useState(() => {
    const session = readSession();
    return { generation: session.generation, userId: session.user?.id ?? null };
  });
  const [snapshot, setSnapshot] = useState<{ scope: string; suggestion: PublishedWhatsappSuggestion | null }>();
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const conversationId = conversation?.id;
  const stateVersion = conversation?.stateVersion;
  const key = userId !== null && conversationId && conversation?.tenantId && chatId
    ? `published-whatsapp-suggestion/${userId}/${conversation.tenantId}/${conversationId}` : null;
  const scope = key && !conversation?.aiPaused ? `${key}/${stateVersion}/${refresh}` : null;

  useEffect(() => {
    if (!conversationId || !chatId) return;
    const socket = SocketService.getInstance().connect();
    const reload = () => setRefresh((value) => value + 1);
    const signal = (event: { chatId?: unknown; conversationId?: unknown; origin?: { kind?: unknown } }) => {
      if (event?.origin?.kind === 'published_graph' && event.chatId === chatId &&
          event.conversationId === conversationId) reload();
    };
    socket.on('agent:suggestion', signal);
    socket.on('connect', reload);
    return () => {
      socket.off('agent:suggestion', signal);
      socket.off('connect', reload);
    };
  }, [chatId, conversationId]);

  useEffect(() => {
    if (!conversationId || !key || !scope) return;
    const request = new AbortController();
    readPublishedWhatsappSuggestion(conversationId, request.signal, generation).then((suggestion) => {
      if (request.signal.aborted) return;
      try { setDismissed(sessionStorage.getItem(key)); } catch { /* The current view still tracks dismissal. */ }
      setSnapshot({ scope, suggestion });
    }).catch(() => {
      if (!request.signal.aborted) setSnapshot({ scope, suggestion: null });
    });
    return () => request.abort();
  }, [conversationId, generation, key, scope]);

  const suggestion = snapshot?.scope === scope && snapshot.suggestion?.runId !== dismissed ? snapshot.suggestion : null;
  useEffect(() => {
    if (!suggestion) return;
    const remaining = Math.max(0, Date.parse(suggestion.expiresAt) - Date.now());
    const timer = window.setTimeout(() => setSnapshot((current) =>
      current?.suggestion?.runId === suggestion.runId ? { ...current, suggestion: null } : current), remaining);
    return () => window.clearTimeout(timer);
  }, [suggestion]);

  function dismiss() {
    if (!key || !suggestion) return;
    setDismissed(suggestion.runId);
    try { sessionStorage.setItem(key, suggestion.runId); } catch { /* The current view still tracks dismissal. */ }
  }

  return { suggestion, dismiss };
}
