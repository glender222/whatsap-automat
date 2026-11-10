import { useCallback, useEffect, useRef, useState } from 'react';
import { useAtom, useSetAtom } from 'jotai';
import { chatsAtom, loadingMessagesAtom, messagesAtom, selectedChatAtom } from '../../../jotai/slices/messagesAtoms';
import { normalizeMessageTimestamp } from '../../../shared/types/wsp';
import type { WhatsAppMessage } from '../../../shared/types/wsp';
import { markChatAsRead } from '../services/chatService';
import { getMessagesByChat } from '../services/messageService';

export function useMessagesManagement() {
  const [messages, setMessages] = useAtom(messagesAtom);
  const [selectedChat, setSelectedChat] = useAtom(selectedChatAtom);
  const [loadingMessages, setLoadingMessages] = useAtom(loadingMessagesAtom);
  const setChats = useSetAtom(chatsAtom);
  const selectedChatRef = useRef(selectedChat);
  const loadedHistory = useRef<string | null>(null);
  const historyRequest = useRef<{ chatId: string; arrivals: Set<string> } | null>(null);
  const [messageError, setMessageError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

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
    setSelectedChat(nextChat);
    setMessages([]);
    setMessageError(null);
    setLoadingMessages(Boolean(nextChat));

    if (nextChat) {
      void markChatAsRead(nextChat).then(() => {
        setChats((current) => current.map((chat) => chat.id === nextChat ? { ...chat, unreadCount: 0 } : chat));
      }).catch(() => undefined);
    }
  }, [setChats, setLoadingMessages, setMessages, setSelectedChat]);

  useEffect(() => {
    if (!selectedChat) return;
    const controller = new AbortController();
    const request = { chatId: selectedChat, arrivals: new Set<string>() };
    historyRequest.current = request;
    const isCurrent = () => !controller.signal.aborted && selectedChatRef.current === selectedChat;
    if (loadedHistory.current !== selectedChat) setLoadingMessages(true);
    setMessageError(null);

    getMessagesByChat(selectedChat, 50, controller.signal)
      .then((history) => {
        if (!isCurrent()) return;
        loadedHistory.current = selectedChat;
        const ids = new Set(history.map((message) => message.id));
        const newest = Math.max(0, ...history.map((message) => normalizeMessageTimestamp(message.timestamp)));
        // A socket event received during this request can be newer than the snapshot
        // even if both messages have the same provider timestamp.
        setMessages((current) => [
          ...history,
          ...current.filter((message) => message.chatId === selectedChat && !ids.has(message.id) &&
            (request.arrivals.has(message.id) || message.id.startsWith('temp-file-') ||
              normalizeMessageTimestamp(message.timestamp) > newest)),
        ]);
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
  }, [revision, selectedChat, setLoadingMessages, setMessages]);

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
    reloadMessages, addOptimisticMessage, updateOptimisticMessage, markMessageError,
  };
}
