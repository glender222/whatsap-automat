import { atom } from 'jotai';
import type { WhatsAppChat, WhatsAppMessage } from '../../shared/types/wsp';

// Chats - NO persiste en localStorage (siempre obtiene del backend)
export const chatsAtom = atom<WhatsAppChat[]>([]);

// The session's Provider keeps unsent text across routes and discards it on account changes.
export const inboxDraftsAtom = atom<ReadonlyMap<string, string>>(new Map());

// Mensajes del chat seleccionado - NO persiste en localStorage
export const messagesAtom = atom<WhatsAppMessage[]>([]);

// Chat seleccionado - NO persiste en localStorage
export const selectedChatAtom = atom<string | null>(null);

// Flag de loading de mensajes (no persiste)
export const loadingMessagesAtom = atom<boolean>(false);

// Flag de loading de chats - para carga progresiva (no persiste)
export const loadingChatsAtom = atom<boolean>(false);
