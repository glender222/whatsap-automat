import { useCallback, useEffect, useRef, useState } from 'react';
import { useAtom, useSetAtom } from 'jotai';
import { chatsAtom, loadingMessagesAtom, messagesAtom, selectedChatAtom } from '../../../jotai/slices/messagesAtoms';
import { createOptimisticMessage, normalizeMessageTimestamp } from '../../../shared/types/wsp';
import type { WhatsAppMessage } from '../../../shared/types/wsp';
import { markChatAsRead } from '../services/chatService';
import { getMessagesByChat, sendMessage } from '../services/messageService';

export function useMessagesManagement() {
  const [messages, setMessages] = useAtom(messagesAtom);
  const [selectedChat, setSelectedChat] = useAtom(selectedChatAtom);
  const [loadingMessages, setLoadingMessages] = useAtom(loadingMessagesAtom);
  const setChats = useSetAtom(chatsAtom);
  const selectedChatRef = useRef(selectedChat);
  const [messageError, setMessageError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  const handleNewMessage = useCallback((incoming: WhatsAppMessage) => {
    if (incoming.chatId !== selectedChatRef.current) return;

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
    const isCurrent = () => !controller.signal.aborted && selectedChatRef.current === selectedChat;
    setLoadingMessages(true);
    setMessageError(null);

    getMessagesByChat(selectedChat, 50, controller.signal)
      .then((history) => {
        if (!isCurrent()) return;
        const ids = new Set(history.map((message) => message.id));
        setMessages((current) => [
          ...history,
          ...current.filter((message) => message.chatId === selectedChat && !ids.has(message.id)),
        ]);
      })
      .catch((error: unknown) => {
        if (isCurrent()) {
          setMessageError(error instanceof Error ? error.message : 'No se pudieron cargar los mensajes.');
        }
      })
      .finally(() => {
        if (isCurrent()) setLoadingMessages(false);
      });

    return () => controller.abort();
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

  const handleSendMessage = useCallback(async (messageText: string) => {
    if (!selectedChat || selectedChatRef.current !== selectedChat || !messageText.trim()) return;

    const optimistic = createOptimisticMessage(selectedChat, messageText);
    addOptimisticMessage(optimistic);
    try {
      const response = await sendMessage(selectedChat, messageText);
      if (!response.success) throw new Error(response.message || 'No se pudo enviar el mensaje.');
      const messageId = response.messageId || response.data?.messageId || response.data?.id;
      if (messageId) updateOptimisticMessage(optimistic.id, messageId);

      setChats((current) => {
        const chat = current.find((item) => item.id === selectedChat);
        if (!chat) return current;
        return [
          { ...chat, lastMessageTimestamp: Date.now(), lastMessagePreview: messageText.slice(0, 50) },
          ...current.filter((item) => item.id !== selectedChat),
        ];
      });
    } catch (error) {
      setMessages((current) => current.filter((message) => message.id !== optimistic.id));
      throw error;
    }
  }, [addOptimisticMessage, selectedChat, setChats, setMessages, updateOptimisticMessage]);

  return {
    messages, selectedChat, loadingMessages, messageError, selectChat, handleNewMessage,
    reloadMessages: () => setRevision((previous) => previous + 1),
    handleSendMessage, addOptimisticMessage, updateOptimisticMessage, markMessageError,
  };
}
