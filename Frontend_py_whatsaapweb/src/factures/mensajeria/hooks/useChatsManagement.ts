import { useCallback, useEffect, useRef, useState } from 'react';
import { useAtom, useStore } from 'jotai';
import { chatsAtom } from '../../../jotai/slices/messagesAtoms';
import { getChatsByTag } from '../services/tagsService';
import { normalizeMessageTimestamp, parseTimestamp } from '../../../shared/types/wsp';
import type { WhatsAppChat } from '../../../shared/types/wsp';

export function useChatsManagement(tagId: string) {
  const store = useStore();
  const [chats, setChats] = useAtom(chatsAtom);
  const [isLoadingChats, setIsLoadingChats] = useState(Boolean(tagId));
  const [chatsError, setChatsError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const loadedTag = useRef('');
  const reloadChats = useCallback(() => setRevision((previous) => previous + 1), []);

  useEffect(() => {
    if (!tagId) {
      loadedTag.current = '';
      setChats([]);
      setIsLoadingChats(false);
      setChatsError(null);
      return;
    }

    const controller = new AbortController();
    if (loadedTag.current !== tagId) setChats([]);
    const before = new Map(store.get(chatsAtom).map((chat) => [chat.id, chat]));
    setIsLoadingChats(true);
    setChatsError(null);

    getChatsByTag(tagId, controller.signal)
      .then(({ data }) => {
        if (controller.signal.aborted) return;
        const normalized = data.map((chat): WhatsAppChat => ({
          id: String(chat.id),
          conversationId: typeof chat.conversationId === 'string' ? chat.conversationId : undefined,
          name: String(chat.name ?? ''),
          profilePhotoUrl: chat.profilePhotoUrl ?? null,
          lastMessageTimestamp: normalizeMessageTimestamp(
            typeof chat.lastMessageTimestamp === 'number'
              ? chat.lastMessageTimestamp
              : parseTimestamp(chat.lastMessageTimestamp)
          ),
          lastMessagePreview: chat.lastMessagePreview ?? null,
          unreadCount: chat.unreadCount ?? 0,
          isGroup: Boolean(chat.isGroup),
        }));
        loadedTag.current = tagId;
        setChats((current) => {
          const visible = new Map(current.map((chat) => [chat.id, chat]));
          return normalized.map((chat) => {
            const start = before.get(chat.id);
            const live = visible.get(chat.id);
            if (!start || !live || start === live || chat.conversationId !== live.conversationId) return chat;

            // HTTP owns membership. Keep a live preview only when HTTP is behind it
            // or still contains the preview from the start of the request.
            const sameSnapshot = chat.lastMessageTimestamp === start.lastMessageTimestamp &&
              chat.lastMessagePreview === start.lastMessagePreview && chat.unreadCount === start.unreadCount;
            const keepPreview = live.lastMessageTimestamp > chat.lastMessageTimestamp || (
              live.lastMessageTimestamp === chat.lastMessageTimestamp && sameSnapshot
            );
            return {
              ...chat,
              lastMessageTimestamp: keepPreview ? live.lastMessageTimestamp : chat.lastMessageTimestamp,
              lastMessagePreview: keepPreview ? live.lastMessagePreview : chat.lastMessagePreview,
              unreadCount: sameSnapshot ? live.unreadCount : chat.unreadCount,
            };
          });
        });
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setChatsError('No se pudieron cargar las conversaciones.');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoadingChats(false);
      });

    return () => controller.abort();
  }, [tagId, revision, setChats, store]);

  return {
    chats: loadedTag.current === tagId && tagId ? chats : [],
    reloadChats,
    isLoadingChats: Boolean(tagId) && (isLoadingChats || (loadedTag.current !== tagId && !chatsError)),
    chatsError,
  };
}
