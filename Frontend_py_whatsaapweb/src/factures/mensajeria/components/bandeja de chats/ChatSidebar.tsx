
import React, { useState, useEffect } from 'react';
import { Search, Bell } from 'lucide-react';
import { useAtomValue } from 'jotai';
import AvatarCircle from '../extras/AvatarCircle';
import TagManager from '../TagManager';
// ChatSkeletonList ya no se usa - ahora mostramos un loader pequeño
import { userRoleAtom } from '../../../../jotai/middleware/userRoleAtom';
import type { WhatsAppChat } from '../../../../shared/types/wsp';
import * as tagsService from '../../services/tagsService';

interface ChatSidebarProps {
  chats: WhatsAppChat[];
  selectedChat: string | null;
  setSelectedChat: (id: string) => void;
  formatNumeroAfiliado: (id: string) => string;
  onShowContactInfo?: (chatId: string) => void;
  onOpenMainMenu?: () => void;
  categories?: Array<{ name: string; color: string; icon: React.ReactNode }>;
  selectedCategory?: string;
  setSelectedCategory?: (v: string) => void;
  categoryDropdown?: boolean;
  setCategoryDropdown?: (v: boolean) => void;
  onCreateTag?: (data: { name: string; color: string }) => Promise<void>;
  onUpdateTag?: (id: string, data: { name: string; color: string }) => Promise<void>;
  onDeleteTag?: (id: string) => Promise<void>;
  tags?: Array<{ id: string; name: string; color?: string | null }>;
  isLoadingChats?: boolean;
}

function tagSwatchClass(color?: string | null): string {
  if (!color) return 'bg-gray-500';
  if (color.startsWith('bg-')) return color;
  if (color.startsWith('text-')) return color.replace(/^text-/, 'bg-');
  return '';
}

function tagSwatchStyle(color?: string | null): React.CSSProperties | undefined {
  return color && color.startsWith('#') ? { backgroundColor: color } : undefined;
}

const ChatSidebar: React.FC<ChatSidebarProps> = ({
  chats,
  selectedChat,
  setSelectedChat,
  formatNumeroAfiliado,
  onShowContactInfo,
  onOpenMainMenu,
  categories = [],
  selectedCategory = 'Seleccione',
  setSelectedCategory = () => { },
  categoryDropdown = false,
  setCategoryDropdown = () => { },
  onCreateTag,
  onUpdateTag,
  onDeleteTag,
  tags = [],
  isLoadingChats = false,
}) => {
  const [searchText, setSearchText] = useState('');
  const [tagManagerOpen, setTagManagerOpen] = useState(false);
  const [tagLoading, setTagLoading] = useState(false);
  const userRole = useAtomValue(userRoleAtom);

  // Estado para menú contextual (clic derecho)
  const [contextMenu, setContextMenu] = useState<{
    open: boolean;
    x: number;
    y: number;
    chatId: string | null;
  }>({ open: false, x: 0, y: 0, chatId: null });

  // Estado para controlar si se muestra el submenu de etiquetas
  const [showTagSubmenu, setShowTagSubmenu] = useState(false);

  // Cerrar menús al hacer click fuera o presionar Escape
  useEffect(() => {
    function onDocClick() {
      if (contextMenu.open) {
        setContextMenu({ open: false, x: 0, y: 0, chatId: null });
        setShowTagSubmenu(false);
      }
      if (categoryDropdown) setCategoryDropdown(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (showTagSubmenu) {
          setShowTagSubmenu(false);
        } else {
          setContextMenu({ open: false, x: 0, y: 0, chatId: null });
        }
        setCategoryDropdown(false);
      }
    }
    window.addEventListener('click', onDocClick);
    window.addEventListener('scroll', onDocClick, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', onDocClick);
      window.removeEventListener('scroll', onDocClick, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [contextMenu.open, categoryDropdown, setCategoryDropdown, showTagSubmenu]);

  const onChatContextMenu = (e: React.MouseEvent, chatId: string) => {
    e.preventDefault();
    // posicionamos el menú en el punto del click
    setContextMenu({ open: true, x: e.clientX, y: e.clientY, chatId });
  };

  const handlePinContact = (chatId: string | null) => {
    // TODO: implementar pin/fijar en backend o local state
    console.log('Fijar contacto', chatId);
    setContextMenu({ open: false, x: 0, y: 0, chatId: null });
  };

  // Asignar chat a una etiqueta
  const handleAssignToTag = async (chatId: string | null, tagId: string) => {
    if (!chatId) return;

    try {
      await tagsService.assignChatToTag(tagId, chatId);
      console.log(`✅ Chat ${chatId} asignado a etiqueta ${tagId}`);
      setContextMenu({ open: false, x: 0, y: 0, chatId: null });
      setShowTagSubmenu(false);

      // Opcional: mostrar notificación de éxito
      // toast.success('Chat asignado a la etiqueta exitosamente');
    } catch (error) {
      console.error('Error asignando chat a etiqueta:', error);
      // Opcional: mostrar notificación de error
      // toast.error('No se pudo asignar el chat a la etiqueta');
    }
  };

  const handleAddTag = async (data: { name: string; color: string }) => {
    if (!onCreateTag) return;

    setTagLoading(true);
    try {
      await onCreateTag(data);
    } catch (err) {
      console.error('Error creando tag:', err);
    } finally {
      setTagLoading(false);
    }
  };

  const handleUpdateTag = async (id: string, data: { name: string; color: string }) => {
    if (!onUpdateTag) return;

    setTagLoading(true);
    try {
      await onUpdateTag(id, data);
    } catch (err) {
      console.error('Error actualizando tag:', err);
    } finally {
      setTagLoading(false);
    }
  };

  const handleDeleteTag = async (id: string) => {
    if (!onDeleteTag) return;

    setTagLoading(true);
    try {
      await onDeleteTag(id);
    } catch (err) {
      console.error('Error eliminando tag:', err);
    } finally {
      setTagLoading(false);
    }
  };

  // Función para formatear timestamp
  const formatTimestamp = (timestamp?: number) => {
    if (!timestamp) return '';
    const date = new Date(timestamp);
    const now = new Date();
    const diffInHours = (now.getTime() - date.getTime()) / (1000 * 60 * 60);

    if (diffInHours < 24) {
      return date.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
    } else if (diffInHours < 168) { // menos de una semana
      return date.toLocaleDateString('es-ES', { weekday: 'short' });
    } else {
      return date.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit' });
    }
  };

  // Filtra los chats por nombre o número (NO los reordena)
  const filteredChats = chats.filter(chat => {
    const name = (chat.name || '').toLowerCase();
    const number = formatNumeroAfiliado(chat.id);
    const search = searchText.toLowerCase();
    return (
      name.includes(search) ||
      number.includes(search)
    );
  });

  // Los chats ya vienen ordenados desde useSocketSimple, solo los filtramos

  return (
    <div className="w-full md:w-80 bg-white dark:bg-gray-800 border-r border-gray-200 dark:border-gray-700 flex flex-col h-full">
      <div className="p-4 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
        <div className="flex items-center justify-between mb-4">
          {/* Botón hamburguesa visible solo en móvil */}
          {onOpenMainMenu && (
            <button
              onClick={onOpenMainMenu}
              className="md:hidden p-2 -ml-2 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors text-gray-900 dark:text-gray-100"
              aria-label="Abrir menú principal"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
          )}
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">Chats</h1>
          <div className="flex items-center ml-auto">
            <div className="relative">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setCategoryDropdown(!categoryDropdown);
                }}
                className={`px-3 py-1.5 text-sm rounded border flex items-center font-medium transition-colors ${
                  // Marcar como activa solo si la categoría seleccionada corresponde a una categoría real
                  categories.find(c => c.name === selectedCategory)
                    ? 'bg-blue-50 dark:bg-blue-900/30 border-blue-200 dark:border-blue-700 text-blue-700 dark:text-blue-300'
                    : 'bg-gray-50 dark:bg-gray-700 border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-600'
                  }`}
              >
                {selectedCategory}
                {/* ChevronDown icon */}
                <svg width="16" height="16" fill="none" stroke="currentColor" className="ml-2"><path d="M6 9l3 3 3-3" strokeWidth="1.5" /></svg>
              </button>
              {categoryDropdown && (
                <div
                  className="absolute right-0 mt-2 w-44 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 shadow-lg rounded-lg z-20"
                  onClick={(e) => e.stopPropagation()}
                >
                  <ul className="py-2">
                    {categories.map((cat: { name: string; color: string; icon: React.ReactNode }) => {
                      return (
                        <li key={cat.name}>
                          <button
                            className="w-full text-left px-4 py-2 flex items-center hover:bg-gray-100 dark:hover:bg-gray-700 text-sm text-gray-900 dark:text-gray-100"
                            onClick={() => {
                              setSelectedCategory(cat.name);
                              setCategoryDropdown(false);
                            }}
                          >
                            {cat.icon}
                            <span className={`${cat.color}`}>{cat.name}</span>
                          </button>
                        </li>
                      );
                    })}
                    {userRole === 'ADMIN' && (
                      <li className="border-t border-gray-100 dark:border-gray-700">
                        <button
                          className="w-full px-3 py-2.5 flex items-center justify-center hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors gap-2"
                          onClick={() => {
                            setTagManagerOpen(true);
                            setCategoryDropdown(false);
                          }}
                          title="Gestionar categorías"
                        >
                          <svg width="18" height="18" fill="none" stroke="currentColor" className="text-blue-500 dark:text-blue-400" strokeWidth="2">
                            <path d="M9 4v10M4 9h10" strokeLinecap="round" />
                          </svg>
                          <span className="text-xs font-medium text-gray-600 dark:text-gray-300">Gestionar</span>
                        </button>
                      </li>
                    )}
                  </ul>
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="relative mb-4">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 dark:text-gray-500" size={20} />
          <input
            type="text"
            placeholder="Buscar por nombre o número"
            className="w-full pl-10 pr-4 py-2 bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-400 focus:border-transparent text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500"
            value={searchText}
            onChange={e => setSearchText(e.target.value)}
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto min-h-0">
        {/* Loader pequeño mientras esperamos los primeros chats */}
        {isLoadingChats && chats.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-gray-400 dark:text-gray-500">
            <div className="w-8 h-8 border-3 border-gray-200 dark:border-gray-600 border-t-blue-500 rounded-full animate-spin mb-3"></div>
            <span className="text-sm">Cargando chats...</span>
          </div>
        )}

        {/* Mensaje de vacío solo cuando no está cargando y no hay chats */}
        {!isLoadingChats && filteredChats.length === 0 ? (
          <div className="p-4 text-center text-gray-500 dark:text-gray-400">
            <div className="mb-4">
              <div className="w-16 h-16 bg-gray-100 dark:bg-gray-700 rounded-full mx-auto flex items-center justify-center">
                <span className="text-2xl text-gray-400 dark:text-gray-500">💬</span>
              </div>
            </div>
            <p className="text-sm">No hay chats disponibles</p>
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
              Los chats aparecerán aquí cuando estén disponibles
            </p>
          </div>
        ) : filteredChats.length > 0 ? (
          <>
            <ul>
              {filteredChats.map(chat => {
                const showNotification = chat.unreadCount !== undefined && chat.unreadCount > 0 && chat.id !== selectedChat;
                return (
                  <li
                    key={chat.id}
                    className={`animate-slideIn px-4 py-3 border-b border-gray-100 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700 cursor-pointer flex items-center justify-between ${chat.id === selectedChat ? 'bg-blue-50 dark:bg-blue-900/30' : ''}`}
                    onClick={() => setSelectedChat(chat.id)}
                    onContextMenu={(e) => onChatContextMenu(e, chat.id)}
                  >
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                      {/* Avatar */}
                      <AvatarCircle src={chat.profilePhotoUrl} alt={chat.name} size={38} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between">
                          <div className="font-semibold text-gray-800 dark:text-gray-200 truncate">{chat.name || formatNumeroAfiliado(chat.id)}</div>
                          <div className="text-xs text-gray-400 dark:text-gray-500 ml-2 flex-shrink-0">
                            {formatTimestamp(chat.lastMessageTimestamp)}
                          </div>
                        </div>
                        <div className="text-xs text-gray-500 dark:text-gray-400 truncate">
                          {chat.lastMessagePreview || formatNumeroAfiliado(chat.id)}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center ml-2">
                      {showNotification && (
                        <div className="flex items-center gap-1">
                          <span className="bg-green-500 text-white text-xs rounded-full px-2 py-1 min-w-[20px] text-center">
                            {chat.unreadCount}
                          </span>
                          <Bell size={16} className="text-green-500" />
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
              {/* Context menu rendered at top-level of sidebar */}
              {contextMenu.open && (
                <div
                  className="absolute z-50 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 overflow-hidden"
                  style={{ top: contextMenu.y, left: contextMenu.x, minWidth: 200 }}
                  onClick={(e) => e.stopPropagation()} // evitar que el click exterior cierre antes de manejar la opción
                >
                  {/* Submenu: Añadir a etiqueta */}
                  {showTagSubmenu ? (
                    <>
                      <div className="px-4 py-2 border-b border-gray-200 dark:border-gray-700 text-sm text-gray-600 dark:text-gray-300 flex items-center justify-between">
                        <button
                          onClick={() => setShowTagSubmenu(false)}
                          className="text-blue-500 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300"
                        >
                          ← Atrás
                        </button>
                        <span>Seleccionar etiqueta</span>
                      </div>
                      <div className="max-h-64 overflow-y-auto">
                        {tags.length === 0 ? (
                          <div className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">
                            No hay etiquetas disponibles
                          </div>
                        ) : (
                          tags.map((tag) => (
                            <button
                              key={tag.id}
                              className="flex items-center gap-3 px-4 py-3 w-full text-left hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-900 dark:text-gray-100"
                              onClick={() => handleAssignToTag(contextMenu.chatId, tag.id)}
                            >
                              <div
                                className={`w-3 h-3 rounded-full ${tagSwatchClass(tag.color)}`}
                                style={tagSwatchStyle(tag.color)}
                              />
                              <span className="text-sm">{tag.name}</span>
                            </button>
                          ))
                        )}
                      </div>
                    </>
                  ) : (
                    <>
                      {/* Menu principal */}
                      <div className="px-4 py-2 border-b border-gray-200 dark:border-gray-700 text-sm text-gray-600 dark:text-gray-300">Añadir a</div>
                      {/* Solo mostrar opción de añadir a etiqueta para ADMIN */}
                      {userRole === 'ADMIN' && (
                        <button
                          className="flex items-center gap-3 px-4 py-3 w-full text-left hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-900 dark:text-gray-100"
                          onClick={() => setShowTagSubmenu(true)}
                        >
                          <span className="text-sm">Añadir a</span>
                        </button>
                      )}
                      <button
                        className="flex items-center gap-3 px-4 py-3 w-full text-left hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-900 dark:text-gray-100"
                        onClick={() => handlePinContact(contextMenu.chatId)}
                      >
                        <span className="text-sm">Fijar contacto</span>
                      </button>
                      <button
                        className="flex items-center gap-3 px-4 py-3 w-full text-left hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-900 dark:text-gray-100"
                        onClick={() => {
                          if (onShowContactInfo && contextMenu.chatId) {
                            onShowContactInfo(contextMenu.chatId);
                          }
                          setContextMenu({ open: false, x: 0, y: 0, chatId: null });
                        }}
                      >
                        <span className="text-sm">Información de contacto</span>
                      </button>
                    </>
                  )}
                </div>
              )}
            </ul>
            {/* Indicador sutil de sincronización cuando hay chats y se cargan más */}
            {isLoadingChats && (
              <div className="flex items-center justify-center py-3 text-xs text-gray-400 dark:text-gray-500 gap-2">
                <div className="w-3 h-3 border-2 border-gray-300 dark:border-gray-600 border-t-blue-500 rounded-full animate-spin"></div>
                <span>Sincronizando chats...</span>
              </div>
            )}
          </>
        ) : null}
      </div>

      {/* Tag Manager para crear, editar y eliminar etiquetas */}
      <TagManager
        open={tagManagerOpen}
        onClose={() => setTagManagerOpen(false)}
        tags={tags}
        onCreateTag={handleAddTag}
        onUpdateTag={handleUpdateTag}
        onDeleteTag={handleDeleteTag}
        loading={tagLoading}
      />
    </div>
  );
};

export default ChatSidebar;
