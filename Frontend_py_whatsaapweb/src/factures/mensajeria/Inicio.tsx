import React, { useState } from 'react';
import { useSocketSimple } from './hooks/useSocketSimple';
import { useLocation, useNavigate } from 'react-router-dom';
import { Home, BarChart3, Server, Bookmark, X, Sparkles } from 'lucide-react';
import LocalTopbar from './components/bandeja de chats/LocalTopbar';
import ChatSidebar from './components/bandeja de chats/ChatSidebar';
import UserMediaPanel from './components/extras/UserMediaPanel';
import ImageGalleryModal from '../mensajeria/components/extras/ImageGalleryModal';
import Sidebar from '../setting/components/Sidebar';
import type { MenuItem } from '../setting/components/Sidebar';
import GlobalTransition from '../../shared/components/GlobalTransition';
import ChatContainer from './components/ChatContainer';
import MobileHeader from './components/MobileHeader';

// Hooks personalizados
import { useChatsManagement } from './hooks/useChatsManagement';
import { useMessagesManagement } from './hooks/useMessagesManagement';
import { useTagsManagement } from './hooks/useTagsManagement';
import { useContactPanel } from './hooks/useContactPanel';
import { useGalleryModal } from './hooks/useGalleryModal';
import { useWhatsAppInitialization } from './hooks/useWhatsAppInitialization';

// Función para formatear el número afiliado
function formatNumeroAfiliado(chatId: string): string {
  let numero = chatId.split('@')[0];
  if (numero.startsWith('51')) {
    numero = numero.substring(2);
  }
  return numero;
}

// Convierte el valor de color de la etiqueta a una clase tailwind válida
const colorClassFrom = (color?: string | null) => {
  if (!color) return '';
  if (color.startsWith('text-') || color.startsWith('bg-')) return color;
  if (/^[a-zA-Z].*/.test(color) && !color.includes('#')) return `text-${color}`;
  return '';
};

/**
 * Componente principal de Inicio - Refactorizado siguiendo principios SOLID
 * - Single Responsibility: Orquesta los diferentes módulos pero no contiene lógica compleja
 * - Open/Closed: Extensible mediante hooks y componentes reutilizables
 * - Liskov Substitution: Los hooks pueden ser reemplazados fácilmente
 * - Interface Segregation: Cada hook tiene una interfaz específica
 * - Dependency Inversion: Depende de abstracciones (hooks) no de implementaciones concretas
 */
const Inicio: React.FC = () => {
  // Estados locales de UI
  const [selectedFilter, setSelectedFilter] = useState('Todo');
  const [categoryDropdown, setCategoryDropdown] = useState(false);
  const [mainSidebarOpen, setMainSidebarOpen] = useState(false);

  const location = useLocation();
  const navigate = useNavigate();

  // Hook: Inicialización de WhatsApp
  const { whatsappInitializing, initMessage, initializeWhatsApp } = useWhatsAppInitialization();
  void initializeWhatsApp; // Disponible para uso futuro

  // Hook: Gestión de etiquetas
  const {
    tags,
    selectedCategory,
    setSelectedCategory,
    handleCreateTag,
    handleUpdateTag,
    handleDeleteTag
  } = useTagsManagement();

  // Hook: Gestión de chats
  const { chats, reloadChats, isLoadingChats } = useChatsManagement({
    tags,
    selectedCategory
  });

  // Hook: Gestión de mensajes
  const {
    messages,
    selectedChat,
    loadingMessages,
    setMessages,
    selectChat,
    handleNewMessage,
    handleSendMessage,
    updateOptimisticMessage,
    markMessageError
  } = useMessagesManagement();

  // Hook: Panel de contacto
  const {
    contactPanelOpen,
    contactPanelMounted,
    contactMedia,
    contactUserInfo,
    handleShowContactInfo,
    closeContactPanel
  } = useContactPanel();

  // Hook: Modal de galería
  const {
    galleryOpen,
    galleryImages,
    galleryAllMedia,
    galleryUserInfo,
    galleryIndex,
    handleOpenGallery,
    closeGallery
  } = useGalleryModal();

  // Socket.IO - manejo de mensajes en tiempo real
  useSocketSimple({
    selectedChat,
    chats,
    onNewMessage: handleNewMessage,
    onChatUpdate: () => { } // setChats se maneja internamente en useChatsManagement
  });

  // Filtros para el topbar
  const filters = [
    { name: 'Pendiente', count: 10 },
    { name: 'Completo', count: 35 },
  ];

  // Categorías para el sidebar derivadas de tags
  const categories = tags.map(tag => {
    const cls = colorClassFrom(tag.color ?? undefined);
    const icon = cls
      ? <Bookmark size={16} className={`mr-1 ${cls}`} />
      : <Bookmark size={16} className="mr-1" style={tag.color ? { color: tag.color } : undefined} />;

    return { name: tag.name, color: cls || '', icon };
  });

  // Handler para volver a la lista de chats (mobile)
  const handleBackToChats = () => {
    selectChat('');
  };

  // Menu items para el sidebar principal
  const menuItems: MenuItem[] = [
    { id: 'inicio', label: 'Inicio', icon: Home },
    { id: 'reportes', label: 'Reportes', icon: BarChart3 },
    { id: 'seguimiento', label: 'Administrar máquinas', icon: Server },
    { id: 'agentes', label: 'Agentes', icon: Sparkles },
  ];

  // Handler para abrir galería desde el chat
  const handleImageClick = (msg: any) => {
    const chat = chats.find(c => c.id === selectedChat);
    handleOpenGallery(msg, messages, {
      name: chat?.name || '',
      number: formatNumeroAfiliado(selectedChat ?? ''),
      photoUrl: chat?.photoUrl || undefined
    });
  };

  return (
    <div className="h-screen flex overflow-hidden relative">
      {/* Transición global durante inicialización de WhatsApp */}
      <GlobalTransition show={whatsappInitializing} message={initMessage} zIndex={1200} />

      {/* Overlay para sidebar principal en móvil */}
      {mainSidebarOpen && (
        <div
          className="fixed inset-0 bg-black bg-opacity-50 z-50 md:hidden"
          onClick={() => setMainSidebarOpen(false)}
        />
      )}

      {/* Sidebar principal - Solo visible en móvil cuando está abierto */}
      <div className={`
        fixed md:hidden inset-y-0 left-0 z-50 transform transition-transform duration-300 ease-in-out
        ${mainSidebarOpen ? 'translate-x-0' : '-translate-x-full'}
      `}>
        <Sidebar
          activeMenu="inicio"
          menuItems={menuItems}
          onConfig={() => {
            setMainSidebarOpen(false);
            navigate('/gestion-web/settings', { state: { background: location } });
          }}
          onMenuClick={() => setMainSidebarOpen(false)}
        />
      </div>

      {/* ChatSidebar - Lista de chats */}
      <div className={`
        w-full md:w-80 md:flex-shrink-0 h-full
        ${selectedChat ? 'hidden md:block' : 'block'}
      `}>
        <ChatSidebar
          chats={chats}
          selectedChat={selectedChat}
          setSelectedChat={selectChat}
          formatNumeroAfiliado={formatNumeroAfiliado}
          onShowContactInfo={(chatId) => handleShowContactInfo(chatId, chats)}
          onOpenMainMenu={() => setMainSidebarOpen(true)}
          categories={categories}
          selectedCategory={selectedCategory}
          setSelectedCategory={setSelectedCategory}
          categoryDropdown={categoryDropdown}
          setCategoryDropdown={setCategoryDropdown}
          onCreateTag={handleCreateTag}
          onUpdateTag={handleUpdateTag}
          onDeleteTag={handleDeleteTag}
          tags={tags}
          isLoadingChats={isLoadingChats}
        />
      </div>

      {/* Panel de Mensajes - En mobile solo visible cuando hay chat seleccionado */}
      <div className={`
        flex-1 flex flex-col h-full min-w-0
        ${!selectedChat ? 'hidden md:flex' : 'flex'}
      `}>
        {/* Header móvil - Solo cuando hay chat seleccionado */}
        {selectedChat && (
          <MobileHeader
            selectedChatName={chats.find(c => c.id === selectedChat)?.name || 'Chat'}
            onBack={handleBackToChats}
            onMenuOpen={() => setMainSidebarOpen(true)}
          />
        )}

        {/* Topbar local con filtros */}
        <LocalTopbar
          filters={filters}
          selectedFilter={selectedFilter}
          setSelectedFilter={setSelectedFilter}
          onReloadChats={reloadChats}
        />

        {/* Contenedor de chat con mensajes e input */}
        <ChatContainer
          selectedChat={selectedChat}
          loadingMessages={loadingMessages}
          messages={messages}
          onImageClick={handleImageClick}
          onSendMessage={handleSendMessage}
          onOptimisticMessage={(msg) => setMessages(prev => [...prev, msg])}
          onMessageSent={updateOptimisticMessage}
          onMessageError={markMessageError}
        />
      </div>

      {/* Panel derecho de información de contacto */}
      {contactPanelMounted && (
        <>
          {/* Overlay para panel derecho en móvil */}
          {contactPanelOpen && (
            <div
              className="fixed inset-0 bg-black bg-opacity-50 z-40 md:hidden"
              onClick={closeContactPanel}
            />
          )}

          <div
            className={`w-full md:w-[340px] bg-white h-full shadow-xl flex-shrink-0 flex flex-col transform transition-transform duration-300 ease-in-out fixed right-0 top-0 z-50 ${contactPanelOpen ? 'translate-x-0' : 'translate-x-full'
              }`}
            style={{ height: '100vh' }}
          >
            <div className="flex items-center justify-end p-2 border-b">
              <button
                onClick={closeContactPanel}
                className="p-2 rounded hover:bg-gray-100 text-gray-600"
                aria-label="Cerrar panel"
              >
                <X size={18} />
              </button>
            </div>
            <div className="flex-1 overflow-auto">
              <UserMediaPanel
                userInfo={contactUserInfo}
                allMedia={contactMedia}
                onMediaClick={(msg: any) => {
                  const images = contactMedia.filter(m => m.type === 'image');
                  const idx = images.findIndex((img: any) => img.id === msg.id);
                  if (idx !== -1) {
                    handleOpenGallery(msg, contactMedia, contactUserInfo);
                  }
                }}
              />
            </div>
          </div>
        </>
      )}

      {/* Modal de galería de imágenes */}
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
};

export default Inicio;
