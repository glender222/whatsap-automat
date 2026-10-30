import { useEffect } from 'react';
import { useSetAtom } from 'jotai';
import { chatsAtom } from '../../../jotai/slices/messagesAtoms';
import SocketService from '../../../utils/socket';
import type { LoadingChatsState, WhatsAppConnectionState, SocketEventData } from '../types/settings.types';
import { parseTimestamp } from '../../../shared/types/wsp';

interface UseSocketEventsProps {
  connectionState: WhatsAppConnectionState;
  onLoadingUpdate: (updates: Partial<LoadingChatsState> | ((prev: LoadingChatsState) => Partial<LoadingChatsState>)) => void;
  onConnectionUpdate: (updates: Partial<WhatsAppConnectionState>) => void;
  onNumeroDetected: () => void;
}

/**
 * Hook para manejar todos los eventos de socket en tiempo real
 */
export const useSocketEvents = ({
  connectionState,
  onLoadingUpdate,
  onConnectionUpdate,
  onNumeroDetected
}: UseSocketEventsProps) => {
  const setChats = useSetAtom(chatsAtom);

  useEffect(() => {
    const socket = SocketService.getInstance().getSocket();
    if (!socket) return;

    // ✅ EVENTO 1: Usuario escanea QR → WhatsApp conectado
    const onReady = (data: SocketEventData) => {
      console.log('✅ WhatsApp ready:', data);
      onConnectionUpdate({ afiliando: false });
      onNumeroDetected();

      // Activar overlay de carga
      onLoadingUpdate({
        isLoading: true,
        status: 'started',
        message: 'Iniciando sincronización...',
        loaded: 0,
        total: 0,
        percentage: 0
      });

      // ⏱️ Timeout de seguridad: cerrar overlay después de 15s si el backend no responde
      // Esto evita que la pantalla se quede bloqueada indefinidamente
      setTimeout(() => {
        onLoadingUpdate(prev => {
          if (prev.isLoading && prev.status === 'started') {
             console.log('⏱️ Timeout de seguridad: cerrando overlay automáticamente');
             return { isLoading: false };
          }
          return prev;
        });
      }, 15000);
    };

    // ✅ EVENTO: Session Status (Por si no llega ready o llega diferente)
    const onSessionStatus = (data: any) => {
      if (data && data.status === 'connected') {
        console.log('✅ WhatsApp session_status connected:', data);
        onConnectionUpdate({ afiliando: false });
        onNumeroDetected();
      }
    };

    // ✅ EVENTO 2: Carga de chats en tiempo real
    const onLoadingChats = (data: SocketEventData) => {
      console.log('📊 Loading chats event:', data);

      const { status, loaded = 0, total = 0, percentage = 0, message = '' } = data;

      if (!status) return;

      onLoadingUpdate({ isLoading: true, status });

      switch (status) {
        case 'fetching':
          onLoadingUpdate({
            message: message || 'Obteniendo lista de chats...',
            loaded: 0,
            total: 0,
            percentage: 0
          });
          break;

        case 'processing':
          onLoadingUpdate({
            message: message || `Procesando ${total} chats...`,
            loaded: 0,
            total,
            percentage: 0
          });
          break;

        case 'initial-loaded':
          onLoadingUpdate({
            loaded,
            total,
            percentage,
            message: message || `⚡ ${loaded} chats iniciales listos`
          });
          break;

        case 'loading':
          onLoadingUpdate({
            loaded,
            total,
            percentage,
            message: message || `Cargando chats: ${loaded}/${total}`
          });
          break;

        case 'completed':
          onLoadingUpdate({
            loaded: loaded || total,
            total,
            percentage: 100,
            message: message || '✅ Todos los chats cargados'
          });

          // Ocultar overlay después de 2s
          setTimeout(() => {
            onLoadingUpdate({ isLoading: false });
          }, 2000);
          break;

        default:
          // Manejo de error o estados desconocidos
          if (status === 'error' as any) {
            onLoadingUpdate({
              message: message || '❌ Error cargando chats'
            });
            setTimeout(() => {
              onLoadingUpdate({ isLoading: false });
            }, 3000);
          }
          break;
      }
    };

    // ✅ EVENTO 3: Chats actualizados en tiempo real
    const onChatsUpdated = (chats: any[]) => {
      console.log(`📬 ${chats.length} chats actualizados`);
      
      if (chats && Array.isArray(chats)) {
        const normalized = chats.map((chat: any) => ({
          id: String(chat.id || ''),
          name: String(chat.name || ''),
          profilePhotoUrl: chat.profilePhotoUrl || null,
          lastMessageTimestamp: parseTimestamp(chat.lastMessageTimestamp) || 0,
          lastMessagePreview: chat.lastMessagePreview ?? null,
          unreadCount: typeof chat.unreadCount === 'number' ? chat.unreadCount : 0,
          isGroup: Boolean(chat.isGroup),
        }));
        setChats(normalized);
      }

      if (chats.length === 0 && connectionState.loggingOut) {
        console.log('🧹 Datos limpiados después de logout');
      }
    };

    // 🔴 EVENTO 4: Logout - animación de cierre
    const onDisconnected = (info: SocketEventData) => {
      console.log('WhatsApp disconnected:', info);

      if (info.reason === 'LOGOUT') {
        console.log('🔴 Sesión cerrada por el servidor');
        
        // Limpiar caché de chats
        setChats([]);

        // Mantener animación por 500ms
        setTimeout(() => {
          onConnectionUpdate({
            numeroAfiliado: null,
            qrUrl: null,
            afiliando: false
          });

          // Después de 2s, ocultar animación
          setTimeout(() => {
            onConnectionUpdate({
              showLogoutAnimation: false,
              loggingOut: false
            });
            console.log('📱 Listo para nuevo QR');
          }, 1500);
        }, 500);
      }
    };

    // ✅ EVENTO 5: Nuevo QR generado
    const onQr = (qrImage: string) => {
      console.log('📱 Nuevo QR recibido');
      onConnectionUpdate({
        qrUrl: qrImage,
        afiliando: true,
        loggingOut: false
      });
    };

    // Eventos adicionales
    const onLogoutConfirmed = (payload: SocketEventData) => {
      if (payload && payload.success) {
        console.log('✅ Logout confirmado');
        setChats([]);
        onConnectionUpdate({ loggingOut: false });
      }
    };

    const onAuthFailure = (err: any) => {
      console.warn('⚠️ Auth failure:', err);
      onConnectionUpdate({
        afiliando: false,
        qrUrl: null
      });
    };

    // Registrar eventos
    socket.on('ready', onReady);
    socket.on('session_status', onSessionStatus);
    socket.on('loading-chats', onLoadingChats);
    socket.on('chats-updated', onChatsUpdated);
    socket.on('disconnected', onDisconnected);
    socket.on('qr', onQr);
    socket.on('logout-confirmed', onLogoutConfirmed);
    socket.on('auth_failure', onAuthFailure);

    return () => {
      socket.off('ready', onReady);
      socket.off('session_status', onSessionStatus);
      socket.off('loading-chats', onLoadingChats);
      socket.off('chats-updated', onChatsUpdated);
      socket.off('disconnected', onDisconnected);
      socket.off('qr', onQr);
      socket.off('logout-confirmed', onLogoutConfirmed);
      socket.off('auth_failure', onAuthFailure);
    };
  }, [connectionState.loggingOut, onLoadingUpdate, onConnectionUpdate, onNumeroDetected, setChats]);
};
