import { Ellipsis, MessageSquareText, RefreshCw, Search, Tags, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { useAtomValue } from 'jotai';
import AvatarCircle from '../extras/AvatarCircle';
import TagManager from '../TagManager';
import { userRoleAtom } from '../../../../jotai/middleware/userRoleAtom';
import type { WhatsAppChat } from '../../../../shared/types/wsp';
import type { Tag } from '../../types/tagTypes';
import { ALL_CHATS_TAG_ID, assignChatToTag } from '../../services/tagsService';

interface ChatSidebarProps {
  chats: WhatsAppChat[];
  selectedChat: string | null;
  setSelectedChat: (id: string) => void;
  formatNumeroAfiliado: (id: string) => string;
  onShowContactInfo: (chatId: string) => void;
  selectedTagId: string;
  setSelectedTagId: (id: string) => void;
  onCreateTag: (data: { name: string; color: string }) => Promise<void>;
  onUpdateTag: (id: string, data: { name: string; color: string }) => Promise<void>;
  onDeleteTag: (id: string) => Promise<void>;
  tags: Tag[];
  loading: boolean;
  error: string | null;
  onReload: () => void;
}

const iconButton = 'grid h-11 w-11 shrink-0 place-items-center rounded-lg text-secondary hover:bg-canvas focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600 disabled:opacity-50';
const field = 'min-h-11 w-full rounded-lg border border-subtle bg-canvas px-3 text-sm text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600';
const dateFormat = new Intl.DateTimeFormat('es-PE', { day: 'numeric', month: 'short' });
const timeFormat = new Intl.DateTimeFormat('es-PE', { hour: '2-digit', minute: '2-digit' });

function formatTime(timestamp: number): string {
  if (!timestamp) return '';
  const format = Date.now() - timestamp < 86_400_000 ? timeFormat : dateFormat;
  return format.format(timestamp);
}

export default function ChatSidebar({
  chats, selectedChat, setSelectedChat, formatNumeroAfiliado, onShowContactInfo,
  selectedTagId, setSelectedTagId, onCreateTag, onUpdateTag, onDeleteTag, tags, loading, error, onReload,
}: ChatSidebarProps) {
  const [search, setSearch] = useState('');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [tagManagerOpen, setTagManagerOpen] = useState(false);
  const [actionChat, setActionChat] = useState<WhatsAppChat | null>(null);
  const [tagToAssign, setTagToAssign] = useState('');
  const [assigning, setAssigning] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const actionsDialog = useRef<HTMLDialogElement>(null);
  const isAdmin = useAtomValue(userRoleAtom) === 'ADMIN';

  const query = search.trim().toLocaleLowerCase('es-PE');
  const unreadCount = chats.filter((chat) => chat.unreadCount > 0).length;
  const filteredChats = chats.filter((chat) => (
    (!unreadOnly || chat.unreadCount > 0) &&
    (chat.name.toLocaleLowerCase('es-PE').includes(query) || formatNumeroAfiliado(chat.id).includes(query))
  ));
  const assignableTags = tags.filter((tag) => tag.id !== ALL_CHATS_TAG_ID && !tag.is_default);

  function openActions(chat: WhatsAppChat) {
    setActionChat(chat);
    setTagToAssign('');
    setActionError(null);
    actionsDialog.current?.showModal();
  }

  async function assignTag() {
    if (!actionChat || !tagToAssign || assigning) return;
    setAssigning(true);
    setActionError(null);
    try {
      await assignChatToTag(tagToAssign, actionChat.id);
      setNotice('Etiqueta asignada a la conversación.');
      actionsDialog.current?.close();
      onReload();
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : 'No se pudo asignar la etiqueta.');
    } finally {
      setAssigning(false);
    }
  }

  return (
    <section aria-label="Conversaciones" className="flex h-full min-w-0 flex-col border-r border-subtle bg-surface">
      <div className="shrink-0 space-y-3 border-b border-subtle p-4">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <h2 className="truncate font-semibold text-primary">Conversaciones</h2>
            <p className="text-xs text-secondary">WhatsApp</p>
          </div>
          <div className="flex">
            {isAdmin && (
              <button type="button" aria-label="Gestionar etiquetas" title="Gestionar etiquetas" className={iconButton} onClick={() => setTagManagerOpen(true)}>
                <Tags size={17} aria-hidden="true" />
              </button>
            )}
            <button type="button" aria-label="Actualizar conversaciones" title="Actualizar conversaciones" className={iconButton} onClick={onReload} disabled={loading}>
              <RefreshCw size={17} aria-hidden="true" className={loading ? 'animate-spin motion-reduce:animate-none' : ''} />
            </button>
          </div>
        </div>

        <div className="relative">
          <Search aria-hidden="true" size={17} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-secondary" />
          <input
            type="search"
            aria-label="Buscar conversaciones por nombre o número"
            placeholder="Buscar conversación"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className={`${field} pl-10 placeholder:text-secondary`}
          />
        </div>

        <label className="block text-xs font-medium text-secondary">
          Etiqueta
          <select className={`${field} mt-1`} value={selectedTagId} onChange={(event) => setSelectedTagId(event.target.value)} disabled={tags.length === 0}>
            {tags.length === 0 && <option value="">{loading ? 'Cargando etiquetas…' : 'Sin etiquetas disponibles'}</option>}
            {tags.map((tag) => <option key={tag.id} value={tag.id}>{tag.name === 'Todo' ? 'Todas las conversaciones' : tag.name}</option>)}
          </select>
        </label>

        <div className="flex gap-2">
          {([
            { label: 'Todas', active: !unreadOnly, action: () => setUnreadOnly(false) },
            { label: `Sin leer (${unreadCount})`, active: unreadOnly, action: () => setUnreadOnly(true) },
          ]).map(({ label, active, action }) => (
            <button
              type="button"
              key={label === 'Todas' ? 'all' : 'unread'}
              aria-pressed={active}
              onClick={action}
              className={`min-h-10 rounded-lg border px-3 text-xs font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600 ${
                active
                  ? 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-100'
                  : 'border-subtle bg-surface text-secondary hover:bg-canvas'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto" aria-busy={loading}>
        {error && (
          <div role="alert" className="border-b border-subtle p-4 text-sm text-red-700 dark:text-red-300">
            <p>{error}</p>
            <button type="button" onClick={onReload} className="mt-2 min-h-10 rounded-md px-2 font-semibold underline">
              Reintentar
            </button>
          </div>
        )}
        {loading && chats.length === 0 && <p role="status" className="p-6 text-center text-sm text-secondary">Cargando conversaciones…</p>}
        {!loading && !error && filteredChats.length === 0 && (
          <div className="px-5 py-10 text-center">
            <MessageSquareText aria-hidden="true" size={26} className="mx-auto mb-3 text-secondary" />
            <p className="text-sm font-semibold">No hay conversaciones para mostrar</p>
            <p className="mt-1 text-sm text-secondary">
              {query || unreadOnly ? 'Prueba con otra búsqueda o cambia el filtro.' : 'Las conversaciones asignadas aparecerán aquí.'}
            </p>
          </div>
        )}

        <ul>
          {filteredChats.map((chat) => {
            const title = chat.name || formatNumeroAfiliado(chat.id);
            const isSelected = chat.id === selectedChat;
            return (
              <li key={chat.id} className={`flex items-center gap-1 border-b border-subtle pr-2 ${isSelected ? 'bg-emerald-50 dark:bg-emerald-950' : 'hover:bg-canvas'}`}>
                <button
                  type="button"
                  aria-current={isSelected ? 'true' : undefined}
                  onClick={() => setSelectedChat(chat.id)}
                  onContextMenu={(event) => { event.preventDefault(); openActions(chat); }}
                  className="flex min-h-16 min-w-0 flex-1 items-center gap-3 px-3 py-2 text-left focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-emerald-600"
                >
                  <AvatarCircle src={chat.profilePhotoUrl} alt="" size={36} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-semibold text-primary">{title}</span>
                      <span className="shrink-0 text-xs text-secondary">{formatTime(chat.lastMessageTimestamp)}</span>
                    </span>
                    <span className="block truncate text-xs text-secondary">{chat.lastMessagePreview || formatNumeroAfiliado(chat.id)}</span>
                  </span>
                  {chat.unreadCount > 0 && (
                    <span className="shrink-0 rounded-full bg-emerald-700 px-1.5 py-0.5 text-xs font-semibold text-white" aria-label={`${chat.unreadCount} sin leer`}>
                      {chat.unreadCount}
                    </span>
                  )}
                </button>
                <button type="button" aria-label={`Opciones de ${title}`} aria-haspopup="dialog" className={iconButton} onClick={() => openActions(chat)}>
                  <Ellipsis size={17} aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      <p className="sr-only" role="status">{notice}</p>
      <dialog
        ref={actionsDialog}
        aria-labelledby="conversation-actions-title"
        className="w-[calc(100%-2rem)] max-w-sm rounded-xl border border-subtle bg-surface p-5 text-primary shadow-xl backdrop:bg-slate-950/50"
      >
        <div className="flex items-center justify-between gap-3">
          <h2 id="conversation-actions-title" className="min-w-0 truncate font-semibold">{actionChat?.name || 'Opciones de conversación'}</h2>
          <button type="button" aria-label="Cerrar opciones" className={iconButton} onClick={() => actionsDialog.current?.close()}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <button
          type="button"
          className="mt-2 min-h-11 rounded-lg px-3 text-sm font-semibold text-emerald-800 hover:bg-canvas dark:text-emerald-200"
          onClick={() => {
            if (!actionChat) return;
            actionsDialog.current?.close();
            onShowContactInfo(actionChat.id);
          }}
        >
          Información de contacto
        </button>
        {isAdmin && assignableTags.length > 0 && (
          <form className="mt-4 flex flex-col gap-2 border-t border-subtle pt-4" onSubmit={(event) => { event.preventDefault(); void assignTag(); }}>
            <label className="block text-sm font-medium">
              Asignar etiqueta
              <select required className={`${field} mt-1`} value={tagToAssign} onChange={(event) => setTagToAssign(event.target.value)}>
                <option value="">Selecciona una etiqueta</option>
                {assignableTags.map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}
              </select>
            </label>
            {actionError && <p role="alert" className="text-sm text-red-700 dark:text-red-300">{actionError}</p>}
            <button type="submit" disabled={!tagToAssign || assigning} className="btn-primary self-start">{assigning ? 'Asignando…' : 'Asignar'}</button>
          </form>
        )}
      </dialog>

      <TagManager
        open={tagManagerOpen}
        onClose={() => setTagManagerOpen(false)}
        tags={tags}
        onCreateTag={onCreateTag}
        onUpdateTag={onUpdateTag}
        onDeleteTag={onDeleteTag}
      />
    </section>
  );
}
