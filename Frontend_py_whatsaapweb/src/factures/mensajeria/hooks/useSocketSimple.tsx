
import { useEffect, useRef } from 'react';
import { isAxiosError } from 'axios';
import { Socket } from 'socket.io-client';
import SocketService from '../../../utils/socket';
import { readSession } from '../../../shared/auth/session';
import { markChatAsRead } from '../services/chatService';
import type { WhatsAppChat, WhatsAppMessage, MessageReplacedEvent } from '../../../shared/types/wsp';
import { normalizeMessageTimestamp } from '../../../shared/types/wsp';

// Alias para compatibilidad
type ChatInfo = WhatsAppChat;
type MessageInfo = WhatsAppMessage;

interface UseSocketSimpleProps {
  selectedChat: string | null;
  onNewMessage: (message: MessageInfo) => void;
  onChatUpdate: (updater: (prevChats: ChatInfo[]) => ChatInfo[]) => void;
  onConnect: () => void;
  onUnlistedChat: () => void;
  onHistoryInvalidated: () => void;
  chats: ChatInfo[];
}

export const useSocketSimple = ({
  selectedChat, onNewMessage, onChatUpdate, onConnect, onUnlistedChat, onHistoryInvalidated, chats,
}: UseSocketSimpleProps) => {
  const socketRef = useRef<Socket | null>(null);
  const lastReadMarkRef = useRef<Record<string, number>>({});

  // Función de ordenamiento que coincide exactamente con el backend
  const sortChatsByActivity = (list: ChatInfo[]) => {
    return list.sort((a, b) => {
      // 1. Prioridad máxima: mensajes no leídos (igual que WhatsApp Web)
      const aUnread = a.unreadCount || 0;
      const bUnread = b.unreadCount || 0;
      if (aUnread > 0 && bUnread === 0) return -1;
      if (bUnread > 0 && aUnread === 0) return 1;

      // 2. Ordenar por timestamp de último mensaje (como WhatsApp Web)
      const timestampA = a.lastMessageTimestamp || 0;
      const timestampB = b.lastMessageTimestamp || 0;

      return timestampB - timestampA;
    });
  };

  // Conectar Socket.IO al montar (solo si hay token)
  useEffect(() => {
    const { accessToken } = readSession();

    // No conectar si no hay token
    if (!accessToken) {
      console.warn('⚠️ No se puede conectar Socket.IO sin token de autenticación');
      return;
    }

    const socketService = SocketService.getInstance();
    const socket = socketService.connect();
    socketRef.current = socket;

    // Verificar estado del socket
    if (socket.connected) {
      console.log('📡 Socket ya estaba conectado - ID:', socket.id);
    } else {
      console.log('⏳ Esperando conexión del socket...');
    }

    socket.on('connect', onConnect);

    return () => {
      socket.off('connect', onConnect);
      // NO desconectar aquí, ya que otros componentes pueden necesitar el socket
      // Cleanup se maneja en el nivel superior (App.tsx)
    };
  }, [onConnect]);

  // Configurar listeners cuando cambien las dependencias
  useEffect(() => {
    const socket = socketRef.current;
    if (!socket) return;
    const socketService = SocketService.getInstance();

    // Función para manejar mensajes
    const handleMessage = async (incoming: MessageInfo) => {
      if (socketService.getSocket() !== socket) return;
      // Normalizar timestamp del servidor (s -> ms) usando función robusta
      const normalizedTimestamp = normalizeMessageTimestamp(incoming.timestamp);
      const msg: MessageInfo = { ...incoming, timestamp: normalizedTimestamp };

      // Llamar al callback con timestamp ya en ms
      onNewMessage(msg);
      if (msg.chatId && !chats.some((chat) => chat.id === msg.chatId)) onUnlistedChat();

      // Si el usuario está en el chat, marcar como leído automáticamente
      if (msg.chatId === selectedChat && !msg.fromMe) {
        const now = Date.now();
        const lastReadMark = lastReadMarkRef.current[msg.chatId] || 0;
        if (now - lastReadMark > 5000) {
          lastReadMarkRef.current[msg.chatId] = now;
          try {
            await markChatAsRead(msg.chatId);
          } catch (error: unknown) {
            const status = isAxiosError(error) ? error.response?.status : undefined;
            if (status === 429 || (error instanceof Error && error.message.includes('Demasiadas solicitudes'))) {
              console.info('[WhatsApp Socket] marcado como leído omitido por rate limit temporal');
            } else {
              console.warn('Error al marcar mensaje como leído automáticamente', {
                status: status ?? null,
                code: isAxiosError(error) ? error.code ?? null : null,
              });
            }
          }
        }
      }

      if (socketService.getSocket() !== socket) return;

      // Mostrar notificación solo si NO estoy en ese chat
      if (!msg.fromMe && msg.chatId !== selectedChat && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        const chatName = chats.find(c => c.id === msg.chatId)?.name || 'Desconocido';
        new Notification(`Nuevo mensaje de ${chatName}`, {
          body: msg.body || 'Archivo multimedia',
          icon: '/logo.png',
        });
      }

      // Extraer preview
      const preview = (msg.body && msg.body.trim()) ? msg.body.substring(0, 120) : (msg.mediaUrl ? '[Media]' : null);

      // La API decide la pertenencia al filtro activo. El socket solo actualiza filas visibles.
      onChatUpdate((prevChats: ChatInfo[]) => {
        const index = prevChats.findIndex((chat) => chat.id === msg.chatId);
        if (index === -1) return prevChats;

        const existing = prevChats[index];
        const older = msg.timestamp < existing.lastMessageTimestamp;
        const unreadCount = selectedChat === msg.chatId ? 0
          : msg.fromMe ? (older ? existing.unreadCount : 0) : existing.unreadCount + 1;
        const next = [...prevChats];
        next[index] = {
          ...existing,
          lastMessageTimestamp: older ? existing.lastMessageTimestamp : msg.timestamp,
          lastMessagePreview: older ? existing.lastMessagePreview : preview ?? existing.lastMessagePreview,
          unreadCount,
        };
        return sortChatsByActivity(next);
      });
    };

    // Configurar listener para mensajes normales
    socket.on('message', handleMessage);

    // Configurar listener para mensajes reconciliados (v1.34.4+)
    // Cuando falla el envío por bug de markedUnread, el backend reconcilia el mensaje
    const handleMessageReplaced = (event: MessageReplacedEvent) => {
      if (socketService.getSocket() !== socket) return;
      console.log('🔄 Mensaje reemplazado:', event.tempId, '->', event.realMessage.id);
      
      // Normalizar el timestamp del mensaje real
      const normalizedRealMessage = {
        ...event.realMessage,
        timestamp: normalizeMessageTimestamp(event.realMessage.timestamp)
      };
      
      // Llamar al callback para reemplazar el mensaje temporal
      onNewMessage(normalizedRealMessage);
    };
    socket.on('message-replaced', handleMessageReplaced);

    const handleDeliveryChanged = (event: { chatId?: string } | undefined) => {
      if (socketService.getSocket() === socket && selectedChat && event?.chatId === selectedChat) onHistoryInvalidated();
    };
    socket.on('conversation.delivery_changed', handleDeliveryChanged);

    return () => {
      socket.off('message', handleMessage);
      socket.off('message-replaced', handleMessageReplaced);
      socket.off('conversation.delivery_changed', handleDeliveryChanged);
    };
  }, [selectedChat, onNewMessage, onChatUpdate, onUnlistedChat, onHistoryInvalidated, chats]);

  useEffect(() => {
    const socket = socketRef.current;
    if (!selectedChat || !socket) return;
    const socketService = SocketService.getInstance();
    socketService.joinRoom(selectedChat, socket);
    return () => socketService.leaveRoom(selectedChat, socket);
  }, [selectedChat]);

  return socketRef.current;
};
