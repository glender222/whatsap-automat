import { useCallback, useEffect, useRef, useState } from 'react';
import type { SetStateAction } from 'react';
import { useSetAtom } from 'jotai';
import { useSearchParams } from 'react-router-dom';
import { Inbox, X } from 'lucide-react';
import ChatSidebar from './components/bandeja de chats/ChatSidebar';
import UserMediaPanel from './components/extras/UserMediaPanel';
import ImageGalleryModal from './components/extras/ImageGalleryModal';
import ChatContainer from './components/ChatContainer';
import ConversationHeader from './components/MobileHeader';
import { chatsAtom } from '../../jotai/slices/messagesAtoms';
import type { WhatsAppChat, WhatsAppMessage } from '../../shared/types/wsp';
import { useSocketSimple } from './hooks/useSocketSimple';
import { useChatsManagement } from './hooks/useChatsManagement';
import { useMessagesManagement } from './hooks/useMessagesManagement';
import { useTagsManagement } from './hooks/useTagsManagement';
import { useContactPanel } from './hooks/useContactPanel';
import { useGalleryModal } from './hooks/useGalleryModal';

function formatNumeroAfiliado(chatId: string): string {
  const number = chatId.split('@')[0];
  return number.startsWith('51') ? number.slice(2) : number;
}

export default function Inicio() {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedChat = searchParams.get('chat');
  const queue = useRef<HTMLDivElement>(null);
  const conversationTitle = useRef<HTMLHeadingElement>(null);
  const setChats = useSetAtom(chatsAtom);

  const {
    tags, selectedTagId, setSelectedTagId, isLoadingTags, tagsError, reloadTags,
    handleCreateTag, handleUpdateTag, handleDeleteTag,
  } = useTagsManagement();
  const { chats, reloadChats, isLoadingChats, chatsError } = useChatsManagement(selectedTagId);
  const {
    messages, selectedChat, loadingMessages, messageError, reloadMessages, selectChat, handleNewMessage,
    handleSendMessage, addOptimisticMessage, updateOptimisticMessage, markMessageError,
  } = useMessagesManagement();
  const {
    contactPanelOpen, contactPanelMounted, contactMedia, contactUserInfo,
    handleShowContactInfo, closeContactPanel,
  } = useContactPanel();
  const {
    galleryOpen, galleryImages, galleryAllMedia, galleryUserInfo, galleryIndex, handleOpenGallery, closeGallery,
  } = useGalleryModal();

  const onChatUpdate = useCallback((update: (current: WhatsAppChat[]) => WhatsAppChat[]) => {
    setChats((current) => {
      // La pertenencia a la etiqueta la determina la API, no un evento de Socket.IO.
      const visibleIds = new Set(current.map((chat) => chat.id));
      return update(current).filter((chat) => visibleIds.has(chat.id));
    });
  }, [setChats]);

  useSocketSimple({ selectedChat, chats, onNewMessage: handleNewMessage, onChatUpdate });

  useEffect(() => {
    selectChat(requestedChat ?? '');
  }, [requestedChat, selectChat]);

  useEffect(() => {
    if (selectedChat && window.matchMedia('(max-width: 767px)').matches) {
      conversationTitle.current?.focus();
    }
  }, [selectedChat]);

  const activeChat = chats.find((chat) => chat.id === selectedChat);
  const selectedName = activeChat?.name || formatNumeroAfiliado(selectedChat ?? '');

  function setDraft(update: SetStateAction<string>) {
    if (!selectedChat) return;
    setDrafts((current) => {
      const oldDraft = current[selectedChat] || '';
      const nextDraft = typeof update === 'function' ? update(oldDraft) : update;
      if (nextDraft === oldDraft) return current;
      return { ...current, [selectedChat]: nextDraft };
    });
  }

  function chooseConversation(chatId: string) {
    selectChat(chatId);
    if ((requestedChat ?? '') === chatId) return;
    const next = new URLSearchParams(searchParams);
    if (chatId) next.set('chat', chatId);
    else next.delete('chat');
    setSearchParams(next);
  }

  function handleBackToChats() {
    chooseConversation('');
    requestAnimationFrame(() => queue.current?.querySelector<HTMLInputElement>('input[type="search"]')?.focus());
  }

  function handleImageClick(message: WhatsAppMessage) {
    handleOpenGallery(message, messages, {
      name: activeChat?.name || '',
      number: formatNumeroAfiliado(selectedChat ?? ''),
      photoUrl: activeChat?.profilePhotoUrl,
    });
  }

  function refreshQueue() {
    if (tagsError) void reloadTags();
    reloadChats();
  }

  return (
    <div className="relative flex h-full min-h-0 min-w-0 overflow-hidden">
      <div ref={queue} className={`h-full w-full md:block md:w-80 md:shrink-0 ${selectedChat ? 'hidden' : ''}`}>
        <ChatSidebar
          chats={chats}
          selectedChat={selectedChat}
          setSelectedChat={chooseConversation}
          formatNumeroAfiliado={formatNumeroAfiliado}
          onShowContactInfo={(chatId) => void handleShowContactInfo(chatId, chats)}
          selectedTagId={selectedTagId}
          setSelectedTagId={setSelectedTagId}
          onCreateTag={handleCreateTag}
          onUpdateTag={handleUpdateTag}
          onDeleteTag={handleDeleteTag}
          tags={tags}
          loading={isLoadingTags || isLoadingChats}
          error={tagsError || chatsError}
          onReload={refreshQueue}
        />
      </div>

      <section
        aria-label="Conversación seleccionada"
        className={`${selectedChat ? 'flex' : 'hidden md:flex'} h-full min-w-0 flex-1 flex-col bg-canvas`}
      >
        {selectedChat ? (
          <>
            <ConversationHeader titleRef={conversationTitle} selectedChatName={selectedName} onBack={handleBackToChats} />
            {messageError ? (
              <div role="alert" className="m-4 rounded-lg border border-subtle bg-surface p-5 text-sm text-red-700 dark:text-red-300">
                <p>{messageError}</p>
                <button type="button" className="mt-3 min-h-11 rounded-md px-2 font-semibold underline" onClick={reloadMessages}>
                  Reintentar
                </button>
              </div>
            ) : (
              <ChatContainer
                key={selectedChat}
                selectedChat={selectedChat}
                loadingMessages={loadingMessages}
                messages={messages}
                message={drafts[selectedChat] || ''}
                setMessage={setDraft}
                onImageClick={handleImageClick}
                onSendMessage={handleSendMessage}
                onOptimisticMessage={addOptimisticMessage}
                onMessageSent={updateOptimisticMessage}
                onMessageError={markMessageError}
              />
            )}
          </>
        ) : (
          <div className="m-auto max-w-sm px-6 text-center">
            <span className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl border border-subtle bg-surface text-emerald-700 dark:text-emerald-300">
              <Inbox size={25} aria-hidden="true" />
            </span>
            <h2 className="text-lg font-semibold">Selecciona una conversación</h2>
            <p className="mt-2 text-sm text-secondary">Abre un chat de la lista para consultar el historial y responder al cliente.</p>
          </div>
        )}
      </section>

      {contactPanelMounted && (
        <>
          {contactPanelOpen && <div className="fixed inset-0 z-40 bg-black/50 md:hidden" onClick={closeContactPanel} />}
          <aside
            aria-label="Información de contacto"
            className={`fixed right-0 top-0 z-50 flex h-[100dvh] w-full flex-col bg-surface shadow-xl
              transition-transform md:max-w-[340px] ${contactPanelOpen ? 'translate-x-0' : 'translate-x-full'}`}
          >
            <div className="flex shrink-0 items-center justify-end border-b border-subtle p-2">
              <button type="button" onClick={closeContactPanel} className="grid h-11 w-11 place-items-center rounded-lg text-secondary hover:bg-canvas" aria-label="Cerrar información de contacto">
                <X size={18} aria-hidden="true" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              <UserMediaPanel
                userInfo={contactUserInfo}
                allMedia={contactMedia}
                onMediaClick={(message: WhatsAppMessage) => {
                  if (message.type === 'image') handleOpenGallery(message, contactMedia, contactUserInfo);
                }}
              />
            </div>
          </aside>
        </>
      )}

      <ImageGalleryModal
        open={galleryOpen}
        images={galleryImages}
        allMedia={galleryAllMedia}
        userInfo={galleryUserInfo}
        initialIndex={galleryIndex}
        onClose={closeGallery}
      />
    </div>
  );
}
