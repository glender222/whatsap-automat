import { useEffect, useRef, useState } from 'react';
import { useAtom } from 'jotai';
import { chatsAtom } from '../../../jotai/slices/messagesAtoms';
import { getChatsByTag } from '../services/tagsService';
import { normalizeMessageTimestamp, parseTimestamp } from '../../../shared/types/wsp';
import type { WhatsAppChat } from '../../../shared/types/wsp';

export function useChatsManagement(tagId: string) {
  const [chats, setChats] = useAtom(chatsAtom);
  const [isLoadingChats, setIsLoadingChats] = useState(Boolean(tagId));
  const [chatsError, setChatsError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const loadedTag = useRef('');

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
    setIsLoadingChats(true);
    setChatsError(null);

    getChatsByTag(tagId, controller.signal)
      .then(({ data }) => {
        if (controller.signal.aborted) return;
        const normalized = data.map((chat): WhatsAppChat => ({
          id: String(chat.id),
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
        setChats(normalized);
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
  }, [tagId, revision, setChats]);

  return {
    chats: loadedTag.current === tagId && tagId ? chats : [],
    reloadChats: () => setRevision((previous) => previous + 1),
    isLoadingChats: Boolean(tagId) && (isLoadingChats || (loadedTag.current !== tagId && !chatsError)),
    chatsError,
  };
}
