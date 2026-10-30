import { useCallback, useEffect, useRef } from 'react';
import { useAtom } from 'jotai';
import { 
  messagesAtom, 
  selectedChatAtom, 
  loadingMessagesAtom,
  chatsAtom 
} from '../../../jotai/slices/messagesAtoms';
import type { WhatsAppMessage } from '../../../shared/types/wsp';
import { markChatAsRead } from '../services/chatService';
import { getMessagesByChat, sendMessage } from '../services/messageService';
import SocketService from '../../../utils/socket';

/**
 * Hook para gestionar mensajes del chat seleccionado
 * Principio de Responsabilidad Única: Solo maneja la lógica de mensajes
 */
export function useMessagesManagement() {
  const [messages, setMessages] = useAtom(messagesAtom);
  const [selectedChat, setSelectedChat] = useAtom(selectedChatAtom);
  const [loadingMessages, setLoadingMessages] = useAtom(loadingMessagesAtom);
  const [, setChats] = useAtom(chatsAtom);
  
  const selectedChatRef = useRef<string | null>(null);
  const isLoadingRef = useRef<boolean>(false); // Guard contra cargas simultáneas

  // Actualizar ref cuando cambie selectedChat
  useEffect(() => {
    selectedChatRef.current = selectedChat;
  }, [selectedChat]);

  // Callback para manejar nuevos mensajes
  const handleNewMessage = useCallback((newMessage: WhatsAppMessage) => {
    const currentSelectedChat = selectedChatRef.current;
    
    setMessages(prev => {
      if (newMessage.chatId === currentSelectedChat) {
        // Evitar duplicados
        if (prev.some(m => m.id === newMessage.id)) {
          return prev;
        }
        
        // Si es un mensaje mío, verificar si hay mensaje optimista
        if (newMessage.fromMe) {
          const existingOptimisticIndex = prev.findIndex(m => 
            m.fromMe && 
            m.body === newMessage.body && 
            m.id.startsWith('temp-') &&
            Math.abs(m.timestamp - newMessage.timestamp) < 5000
          );
          
          if (existingOptimisticIndex !== -1) {
            const newMessages = [...prev];
            newMessages[existingOptimisticIndex] = newMessage;
            return newMessages;
          }
        }
        
        return [...prev, newMessage];
      }
      return prev;
    });
  }, [setMessages]);

  // Seleccionar chat y cargar mensajes
  const selectChat = useCallback(async (chatId: string) => {
    const socketService = SocketService.getInstance();
    socketService.joinRoom(chatId);

    if (selectedChatRef.current === chatId) {
      return;
    }
    
    try {
      await markChatAsRead(chatId);
    } catch (error) {
      console.warn('Error al marcar chat como leído:', error);
    }
    
    // Actualizar localmente el unread count
    setChats(prev => {
      const idx = prev.findIndex(c => c.id === chatId);
      if (idx === -1) return prev;
      const updated = [...prev];
      updated[idx] = { ...updated[idx], unreadCount: 0 };
      return updated;
    });
    
    setSelectedChat(chatId);
  }, [setChats, setSelectedChat]);

  // Cargar mensajes cuando se selecciona un chat
  useEffect(() => {
    if (selectedChat) {
      // Guard: evitar cargas simultáneas
      if (isLoadingRef.current) {
        console.log('⏳ Ya hay una carga de mensajes en progreso, omitiendo...');
        return;
      }
      
      isLoadingRef.current = true;
      setLoadingMessages(true);
      
      getMessagesByChat(selectedChat)
        .then(data => {
          setMessages(data);
          setLoadingMessages(false);
          isLoadingRef.current = false;
          console.log(`✅ Mensajes cargados para chat ${selectedChat}:`, data.length);
        })
        .catch((error) => {
          console.error('Error cargando mensajes:', error);
          setLoadingMessages(false);
          isLoadingRef.current = false;

          if ((error as any)?.status === 429) {
            console.info('Carga de mensajes omitida temporalmente por rate limit; se conservan los mensajes actuales.');
            return;
          }

          setMessages([]);
          
          if (error.message?.includes('403') || error.message?.includes('Acceso denegado')) {
            console.warn('⚠️ Sin permisos para acceder a este chat');
          }
        });
    } else {
      setMessages([]);
      isLoadingRef.current = false;
    }
  }, [selectedChat, setMessages, setLoadingMessages]);

  // Enviar mensaje
  const handleSendMessage = useCallback(async (messageText: string) => {
    if (!messageText.trim() || !selectedChat) return;

    // Crear mensaje optimista
    const optimisticMessage: WhatsAppMessage = {
      id: `temp-${Date.now()}`,
      body: messageText,
      fromMe: true,
      timestamp: Math.floor(Date.now() / 1000),
      sender: selectedChat,
      chatId: selectedChat,
      type: "text"
    };

    // Agregar mensaje inmediatamente (UI optimista)
    setMessages(prev => [...prev, optimisticMessage]);

    try {
      // Enviar al backend
      const response = await sendMessage(selectedChat, messageText);
      
      const realMessageId = response?.messageId || response?.data?.messageId || response?.data?.id;
      if (response.success && realMessageId) {
        setMessages(prev => prev.map(msg =>
          msg.id === optimisticMessage.id
            ? { ...msg, id: realMessageId }
            : msg
        ));
        
        // Actualizar chats
        setChats(prev => {
          const idx = prev.findIndex(c => c.id === selectedChat);
          if (idx === -1) return prev;
          const updated = [...prev];
          const [chat] = updated.splice(idx, 1);
          chat.lastMessageTimestamp = Math.floor(Date.now() / 1000);
          chat.lastMessagePreview = messageText.substring(0, 50);
          return [chat, ...updated];
        });
      }
    } catch (error) {
      console.error('Error enviando mensaje:', error);
      // Eliminar mensaje optimista en caso de error
      setMessages(prev => prev.filter(msg => msg.id !== optimisticMessage.id));
      throw error;
    }
  }, [selectedChat, setMessages, setChats]);

  // Actualizar mensaje optimista con el ID real
  const updateOptimisticMessage = useCallback((tempId: string, realId: string) => {
    setMessages(prev => prev.map(msg =>
      msg.id === tempId
        ? { ...msg, id: realId, isOptimistic: false }
        : msg
    ));
  }, [setMessages]);

  // Marcar mensaje con error
  const markMessageError = useCallback((tempId: string) => {
    setMessages(prev => prev.map(msg =>
      msg.id === tempId
        ? { ...msg, uploadError: 'Error al enviar mensaje' }
        : msg
    ));
  }, [setMessages]);

  return {
    messages,
    selectedChat,
    loadingMessages,
    setMessages,
    setSelectedChat,
    selectChat,
    handleNewMessage,
    handleSendMessage,
    updateOptimisticMessage,
    markMessageError
  };
}
