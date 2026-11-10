import { useCallback, useEffect, useRef, useState } from 'react';
import { useAtom, useSetAtom, useStore } from 'jotai';
import { chatsAtom, loadingMessagesAtom, messagesAtom, selectedChatAtom } from '../../../jotai/slices/messagesAtoms';
import { normalizeMessageTimestamp } from '../../../shared/types/wsp';
import type { WhatsAppMessage } from '../../../shared/types/wsp';
import { markChatAsRead } from '../services/chatService';
import { getMessagesByChat } from '../services/messageService';

const pageSize = 50;

function historyIdentities(messages: WhatsAppMessage[]) {
  const external = new Set<string>();
  const stored = new Set<string>();
  for (const message of messages) {
    external.add(message.id);
    if (message.historyId) stored.add(message.historyId);
  }
  return { external, stored };
}

function hasHistoryMessage(identities: ReturnType<typeof historyIdentities>, message: WhatsAppMessage) {
  return identities.external.has(message.id) || Boolean(message.historyId && identities.stored.has(message.historyId));
}

export function useMessagesManagement() {
  const store = useStore();
  const [messages, setMessages] = useAtom(messagesAtom);
  const [selectedChat, setSelectedChat] = useAtom(selectedChatAtom);
  const [loadingMessages, setLoadingMessages] = useAtom(loadingMessagesAtom);
  const setChats = useSetAtom(chatsAtom);
  const selectedChatRef = useRef(selectedChat);
  const loadedHistory = useRef<{ chatId: string; identities: ReturnType<typeof historyIdentities> } | null>(null);
  const historyRequest = useRef<{ chatId: string; arrivals: Set<string> } | null>(null);
  const [messageError, setMessageError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const olderRequest = useRef<AbortController | null>(null);
  const boundary = useRef<{ cursor: string | null; paging: boolean } | null>(null);
  const [older, setOlder] = useState({ available: false, loading: false, requested: false, error: '' });

  const resetOlder = useCallback((cursor: string | null) => {
    olderRequest.current?.abort();
    olderRequest.current = null;
    boundary.current = { cursor, paging: false };
    setOlder({ available: Boolean(cursor), loading: false, requested: false, error: '' });
  }, []);

  useEffect(() => () => olderRequest.current?.abort(), []);

  const loadOlder = useCallback(async () => {
    const chatId = selectedChatRef.current;
    const page = boundary.current;
    if (!chatId || !page?.cursor || olderRequest.current) return;
    const controller = new AbortController();
    olderRequest.current = controller;
    page.paging = true;
    setOlder({ available: true, loading: true, requested: true, error: '' });
    try {
      const { messages: history, nextCursor } = await getMessagesByChat(chatId, pageSize, controller.signal, page.cursor);
      if (controller.signal.aborted) return;
      page.cursor = nextCursor;
      setMessages((current) => {
        const identities = historyIdentities(current);
        return [...history.filter((message) => !hasHistoryMessage(identities, message)), ...current];
      });
      setOlder({ available: Boolean(nextCursor), loading: false, requested: true, error: '' });
    } catch {
      if (!controller.signal.aborted) {
        setOlder({ available: true, loading: false, requested: true, error: 'No se pudieron cargar los mensajes anteriores.' });
      }
    } finally {
      if (olderRequest.current === controller) olderRequest.current = null;
    }
  }, [setMessages]);

  const handleNewMessage = useCallback((incoming: WhatsAppMessage) => {
    if (incoming.chatId !== selectedChatRef.current) return;

    if (historyRequest.current?.chatId === incoming.chatId) historyRequest.current.arrivals.add(incoming.id);
    setMessages((current) => {
      if (current.some((message) => message.id === incoming.id)) return current;
      const incomingTime = normalizeMessageTimestamp(incoming.timestamp);
      const optimistic = incoming.fromMe && current.find((message) => (
        message.fromMe && message.id.startsWith('temp-') && message.body === incoming.body &&
        Math.abs(normalizeMessageTimestamp(message.timestamp) - incomingTime) < 5_000
      ));

      return optimistic
        ? current.map((message) => message === optimistic ? incoming : message)
        : [...current, incoming];
    });
  }, [setMessages]);

  const selectChat = useCallback((chatId: string) => {
    const nextChat = chatId || null;
    if (selectedChatRef.current === nextChat) return;
    selectedChatRef.current = nextChat;
    loadedHistory.current = null;
    resetOlder(null);
    setSelectedChat(nextChat);
    setMessages([]);
    setMessageError(null);
    setLoadingMessages(Boolean(nextChat));

    if (nextChat) {
      void markChatAsRead(nextChat).then(() => {
        setChats((current) => current.map((chat) => chat.id === nextChat ? { ...chat, unreadCount: 0 } : chat));
      }).catch(() => undefined);
    }
  }, [resetOlder, setChats, setLoadingMessages, setMessages, setSelectedChat]);

  useEffect(() => {
    if (!selectedChat) return;
    const controller = new AbortController();
    const request = { chatId: selectedChat, arrivals: new Set<string>() };
    historyRequest.current = request;
    const isCurrent = () => !controller.signal.aborted && selectedChatRef.current === selectedChat;
    if (loadedHistory.current?.chatId !== selectedChat) setLoadingMessages(true);
    setMessageError(null);

    getMessagesByChat(selectedChat, pageSize, controller.signal)
      .then(({ messages: history, nextCursor }) => {
        if (!isCurrent()) return;
        const identities = historyIdentities(history);
        const current = store.get(messagesAtom);
        // Retain older pages only if the refreshed head overlaps the visible history.
        // After a long disconnect, restart from the fresh page to avoid a hidden gap.
        const previousHead = loadedHistory.current;
        const retainOlder = boundary.current?.paging && previousHead?.chatId === selectedChat &&
          history.some((message) => hasHistoryMessage(previousHead.identities, message));
        loadedHistory.current = { chatId: selectedChat, identities };
        if (!retainOlder) resetOlder(nextCursor);
        const newest = Math.max(0, ...history.map((message) => normalizeMessageTimestamp(message.timestamp)));
        // A socket event received during this request can be newer than the snapshot
        // even if both messages have the same provider timestamp.
        const previous: WhatsAppMessage[] = [];
        const arrivals: WhatsAppMessage[] = [];
        for (const message of current) {
          if (message.chatId !== selectedChat || hasHistoryMessage(identities, message)) continue;
          if (request.arrivals.has(message.id) || message.id.startsWith('temp-file-') ||
              normalizeMessageTimestamp(message.timestamp) > newest) arrivals.push(message);
          else if (retainOlder && !message.id.startsWith('temp-')) previous.push(message);
        }
        setMessages([...previous, ...history, ...arrivals]);
      })
      .catch((error: unknown) => {
        if (isCurrent()) {
          setMessageError(error instanceof Error ? error.message : 'No se pudieron cargar los mensajes.');
        }
      })
      .finally(() => {
        if (historyRequest.current === request) historyRequest.current = null;
        if (isCurrent()) setLoadingMessages(false);
      });

    return () => {
      controller.abort();
      if (historyRequest.current === request) historyRequest.current = null;
    };
  }, [resetOlder, revision, selectedChat, setLoadingMessages, setMessages, store]);

  const addOptimisticMessage = useCallback((message: WhatsAppMessage) => {
    if (message.chatId === selectedChatRef.current) {
      setMessages((current) => [...current, message]);
    }
  }, [setMessages]);

  const updateOptimisticMessage = useCallback((tempId: string, realId: string) => {
    setMessages((current) => {
      if (current.some((message) => message.id === realId)) {
        return current.filter((message) => message.id !== tempId);
      }
      return current.map((message) => (
        message.id === tempId ? { ...message, id: realId, isOptimistic: false } : message
      ));
    });
  }, [setMessages]);

  const markMessageError = useCallback((tempId: string) => {
    setMessages((current) => current.map((message) => (
      message.id === tempId ? { ...message, uploadError: 'Error al enviar mensaje' } : message
    )));
  }, [setMessages]);

  const reloadMessages = useCallback(() => setRevision((previous) => previous + 1), []);

  return {
    messages, selectedChat, loadingMessages, messageError, selectChat, handleNewMessage,
    olderHistory: { ...older, load: loadOlder },
    reloadMessages, addOptimisticMessage, updateOptimisticMessage, markMessageError,
  };
}
