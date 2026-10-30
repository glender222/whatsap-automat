# Guía de Uso - Hooks Refactorizados

Esta guía proporciona ejemplos prácticos de cómo usar los nuevos hooks personalizados creados durante la refactorización.

## 📚 Tabla de Contenidos

- [useChatsManagement](#usechatsmanagement)
- [useMessagesManagement](#usemessagesmanagement)
- [useTagsManagement](#usetagsmanagement)
- [useContactPanel](#usecontactpanel)
- [useGalleryModal](#usegallerymodal)
- [useWhatsAppInitialization](#usewhatsappinitialization)

---

## useChatsManagement

### Propósito
Gestiona la carga, recarga y actualización de chats basándose en etiquetas.

### Ejemplo de Uso

```typescript
import { useChatsManagement } from './hooks/useChatsManagement';
import { useWhatsAppInitialization } from './hooks/useWhatsAppInitialization';
import { useTagsManagement } from './hooks/useTagsManagement';

function MyComponent() {
  const { initializeWhatsApp } = useWhatsAppInitialization();
  const { tags, selectedCategory } = useTagsManagement();
  
  const { chats, reloadChats } = useChatsManagement({
    tags,
    selectedCategory,
    onWhatsAppInitNeeded: initializeWhatsApp
  });

  // Recargar chats manualmente
  const handleRefresh = async () => {
    await reloadChats();
  };

  return (
    <div>
      <button onClick={handleRefresh}>Recargar Chats</button>
      <ChatList chats={chats} />
    </div>
  );
}
```

### API

```typescript
interface UseChatsManagementReturn {
  chats: ChatInfo[];           // Lista de chats cargados
  setChats: (chats) => void;   // Actualizar chats manualmente
  reloadChats: (tagId?) => Promise<void>; // Recargar chats
}
```

### Características
- ✅ Precarga automática de fotos de perfil
- ✅ Precarga inteligente de mensajes y multimedia
- ✅ Reintentos automáticos en caso de error
- ✅ Inicialización automática de WhatsApp si es necesario
- ✅ Recarga automática al cambiar de etiqueta
- ✅ Recarga automática al volver a la pestaña

---

## useMessagesManagement

### Propósito
Gestiona los mensajes del chat seleccionado, incluyendo envío y recepción en tiempo real.

### Ejemplo de Uso

```typescript
import { useMessagesManagement } from './hooks/useMessagesManagement';

function ChatComponent() {
  const {
    messages,
    selectedChat,
    loadingMessages,
    selectChat,
    handleSendMessage
  } = useMessagesManagement();

  const handleChatSelect = async (chatId: string) => {
    await selectChat(chatId);
  };

  const handleSend = async (text: string) => {
    try {
      await handleSendMessage(text);
      console.log('Mensaje enviado');
    } catch (error) {
      console.error('Error al enviar:', error);
    }
  };

  if (loadingMessages) {
    return <Spinner />;
  }

  return (
    <div>
      <MessageList messages={messages} />
      <MessageInput onSend={handleSend} />
    </div>
  );
}
```

### API

```typescript
interface UseMessagesManagementReturn {
  messages: MessageInfo[];                    // Mensajes del chat actual
  selectedChat: string | null;                // ID del chat seleccionado
  loadingMessages: boolean;                   // Estado de carga
  setMessages: (messages) => void;            // Actualizar mensajes
  setSelectedChat: (chatId) => void;          // Cambiar chat
  selectChat: (chatId: string) => Promise<void>; // Seleccionar chat
  handleNewMessage: (msg: MessageInfo) => void;  // Callback para nuevos mensajes
  handleSendMessage: (text: string) => Promise<void>; // Enviar mensaje
  updateOptimisticMessage: (tempId, realId) => void; // Actualizar mensaje optimista
  markMessageError: (tempId) => void;         // Marcar mensaje con error
}
```

### Características
- ✅ UI optimista (mensajes aparecen instantáneamente)
- ✅ Integración con Socket.IO para tiempo real
- ✅ Marca chats como leídos automáticamente
- ✅ Manejo de errores con recuperación
- ✅ Actualización automática de lista de chats

---

## useTagsManagement

### Propósito
Gestiona el CRUD completo de etiquetas (tags) y la selección de categoría actual.

### Ejemplo de Uso

```typescript
import { useTagsManagement } from './hooks/useTagsManagement';

function TagsManager() {
  const {
    tags,
    selectedCategory,
    setSelectedCategory,
    handleCreateTag,
    handleUpdateTag,
    handleDeleteTag
  } = useTagsManagement();

  const createNewTag = async () => {
    try {
      await handleCreateTag({
        name: 'Importante',
        color: '#ff0000'
      });
      console.log('Etiqueta creada');
    } catch (error) {
      console.error('Error:', error);
    }
  };

  const updateTag = async (tagId: string) => {
    await handleUpdateTag(tagId, {
      name: 'Muy Importante',
      color: '#ff5500'
    });
  };

  const deleteTag = async (tagId: string) => {
    await handleDeleteTag(tagId);
  };

  return (
    <div>
      <h2>Categoría Actual: {selectedCategory}</h2>
      <TagList
        tags={tags}
        onUpdate={updateTag}
        onDelete={deleteTag}
      />
      <button onClick={createNewTag}>Nueva Etiqueta</button>
    </div>
  );
}
```

### API

```typescript
interface UseTagsManagementReturn {
  tags: Tag[];                            // Lista de etiquetas
  selectedCategory: string;               // Categoría seleccionada
  setSelectedCategory: (name) => void;    // Cambiar categoría
  handleCreateTag: (data) => Promise<void>;  // Crear etiqueta
  handleUpdateTag: (id, data) => Promise<void>; // Actualizar etiqueta
  handleDeleteTag: (id) => Promise<void>;    // Eliminar etiqueta
}
```

### Características
- ✅ Carga automática de etiquetas al montar
- ✅ Selección automática de etiqueta "Todo" si existe
- ✅ Fallback a primera etiqueta disponible
- ✅ Actualización automática después de operaciones CRUD

---

## useContactPanel

### Propósito
Gestiona el estado del panel de información de contacto con animaciones.

### Ejemplo de Uso

```typescript
import { useContactPanel } from './hooks/useContactPanel';

function ContactInfoPanel({ chats }: { chats: ChatInfo[] }) {
  const {
    contactPanelOpen,
    contactPanelMounted,
    contactMedia,
    contactUserInfo,
    handleShowContactInfo,
    closeContactPanel
  } = useContactPanel();

  const showInfo = async (chatId: string) => {
    await handleShowContactInfo(chatId, chats);
  };

  if (!contactPanelMounted) return null;

  return (
    <div className={contactPanelOpen ? 'open' : 'closed'}>
      <button onClick={closeContactPanel}>Cerrar</button>
      <UserInfo info={contactUserInfo} />
      <MediaGallery media={contactMedia} />
    </div>
  );
}
```

### API

```typescript
interface UseContactPanelReturn {
  contactPanelOpen: boolean;              // Panel visible
  contactPanelMounted: boolean;           // Panel montado (para animación)
  contactMedia: MessageInfo[];            // Media del contacto
  contactUserInfo: {                      // Info del usuario
    name: string;
    number: string;
    photoUrl?: string | null;
  };
  handleShowContactInfo: (chatId, chats) => Promise<void>; // Mostrar panel
  closeContactPanel: () => void;          // Cerrar panel
}
```

### Características
- ✅ Animaciones suaves de entrada/salida
- ✅ Carga automática de media del contacto
- ✅ Formateo automático de número telefónico
- ✅ Delay para animaciones CSS

---

## useGalleryModal

### Propósito
Gestiona el modal de galería de imágenes con navegación.

### Ejemplo de Uso

```typescript
import { useGalleryModal } from './hooks/useGalleryModal';

function ImageGallery() {
  const {
    galleryOpen,
    galleryImages,
    galleryUserInfo,
    galleryIndex,
    handleOpenGallery,
    closeGallery
  } = useGalleryModal();

  const openGalleryAt = (msg: MessageInfo, allMessages: MessageInfo[]) => {
    const userInfo = {
      name: 'Juan Pérez',
      number: '987654321',
      photoUrl: 'https://...'
    };
    
    handleOpenGallery(msg, allMessages, userInfo);
  };

  return (
    <ImageGalleryModal
      open={galleryOpen}
      images={galleryImages}
      initialIndex={galleryIndex}
      userInfo={galleryUserInfo}
      onClose={closeGallery}
    />
  );
}
```

### API

```typescript
interface UseGalleryModalReturn {
  galleryOpen: boolean;                   // Modal visible
  galleryImages: MessageInfo[];           // Solo imágenes
  galleryAllMedia: MessageInfo[];         // Todo el media
  galleryUserInfo: {                      // Info del usuario
    name: string;
    number: string;
    photoUrl?: string | null;
  };
  galleryIndex: number;                   // Índice actual
  handleOpenGallery: (msg, messages, userInfo) => void; // Abrir galería
  closeGallery: () => void;               // Cerrar galería
}
```

### Características
- ✅ Filtra automáticamente solo imágenes
- ✅ Mantiene referencia a todo el media
- ✅ Calcula índice correcto de la imagen clickeada
- ✅ Estado independiente de otros componentes

---

## useWhatsAppInitialization

### Propósito
Gestiona la inicialización automática del servicio de WhatsApp.

### Ejemplo de Uso

```typescript
import { useWhatsAppInitialization } from './hooks/useWhatsAppInitialization';

function WhatsAppConnector() {
  const {
    whatsappInitializing,
    initMessage,
    initializeWhatsApp
  } = useWhatsAppInitialization();

  const connect = async () => {
    try {
      const result = await initializeWhatsApp();
      if (result.success) {
        console.log('WhatsApp conectado');
      }
    } catch (error) {
      console.error('Error conectando:', error);
    }
  };

  if (whatsappInitializing) {
    return <LoadingScreen message={initMessage} />;
  }

  return (
    <button onClick={connect}>Conectar WhatsApp</button>
  );
}
```

### API

```typescript
interface UseWhatsAppInitializationReturn {
  whatsappInitializing: boolean;          // Estado de inicialización
  initMessage: string;                    // Mensaje para mostrar
  initializeWhatsApp: () => Promise<any>; // Inicializar servicio
}
```

### Características
- ✅ Mensajes informativos durante la conexión
- ✅ Manejo de errores
- ✅ Estado de carga para UI
- ✅ Retorna resultado de la inicialización

---

## 🎯 Composición de Hooks

Ejemplo de cómo combinar múltiples hooks:

```typescript
function CompleteMessagingApp() {
  // 1. Inicialización de WhatsApp
  const { initializeWhatsApp, whatsappInitializing, initMessage } = 
    useWhatsAppInitialization();

  // 2. Gestión de etiquetas
  const { tags, selectedCategory, setSelectedCategory } = 
    useTagsManagement();

  // 3. Gestión de chats
  const { chats, reloadChats } = useChatsManagement({
    tags,
    selectedCategory,
    onWhatsAppInitNeeded: initializeWhatsApp
  });

  // 4. Gestión de mensajes
  const { messages, selectedChat, selectChat, handleSendMessage } = 
    useMessagesManagement();

  // 5. Panel de contacto
  const { handleShowContactInfo, contactPanelOpen } = 
    useContactPanel();

  // 6. Galería de imágenes
  const { handleOpenGallery, galleryOpen } = 
    useGalleryModal();

  // Toda la lógica está encapsulada en los hooks
  // El componente solo coordina y renderiza
  
  return (
    <div>
      {whatsappInitializing && <Loading message={initMessage} />}
      <Sidebar chats={chats} onSelectChat={selectChat} />
      <ChatView 
        messages={messages} 
        onSend={handleSendMessage}
        onImageClick={handleOpenGallery}
      />
      {contactPanelOpen && <ContactPanel />}
      {galleryOpen && <Gallery />}
    </div>
  );
}
```

## 🧪 Testing

Ejemplo de cómo testear un hook:

```typescript
import { renderHook, act } from '@testing-library/react-hooks';
import { useMessagesManagement } from './useMessagesManagement';

describe('useMessagesManagement', () => {
  it('debe enviar mensaje correctamente', async () => {
    const { result } = renderHook(() => useMessagesManagement());
    
    await act(async () => {
      await result.current.selectChat('chat123');
    });
    
    await act(async () => {
      await result.current.handleSendMessage('Hola');
    });
    
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].body).toBe('Hola');
  });
});
```

---

## 📝 Notas Importantes

1. **Orden de hooks**: Los hooks deben ser llamados en el mismo orden en cada render
2. **Dependencias**: Asegúrate de pasar todas las dependencias correctas
3. **Cleanup**: Los hooks limpian automáticamente sus efectos al desmontar
4. **Tipos**: Todos los hooks están completamente tipados con TypeScript
5. **Error handling**: Los hooks manejan errores internamente, pero también los propagan

## 🚀 Mejores Prácticas

1. **No llames hooks condicionalmente**: Siempre llámalos en el nivel superior
2. **Memoiza callbacks**: Usa `useCallback` para callbacks pesados
3. **Optimiza re-renders**: Los hooks ya están optimizados internamente
4. **Maneja errores**: Siempre usa try/catch con operaciones asíncronas
5. **TypeScript**: Aprovecha los tipos para evitar errores

---

**¿Preguntas?** Consulta la documentación completa en `REFACTORING.md` y `ARCHITECTURE.md`
