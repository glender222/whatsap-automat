import { io, Socket } from 'socket.io-client';
import { authService } from "../factures/auth/services/authService";
import { api } from '../shared/axios/http';

// Configuración del socket
const SOCKET_URL = (api.defaults.baseURL || 'http://localhost:3000/api').replace(/\/api\/?$/, '');

class SocketService {
  private socket: Socket | null = null;
  private static instance: SocketService;

  private constructor() {}

  public static getInstance(): SocketService {
    if (!SocketService.instance) {
      SocketService.instance = new SocketService();
    }
    return SocketService.instance;
  }

  public connect(): Socket {
    if (!this.socket) {
      // Obtener token JWT
      const token = localStorage.getItem('accessToken');
      
      this.socket = io(SOCKET_URL, {
        transports: ['websocket', 'polling'],
        timeout: 20000,
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        reconnectionAttempts: Infinity, // Intentar reconectar siempre
        auth: {
          token: token || '' // Enviar token en auth
        }
      });

      this.socket.on('connect', () => {
        console.log('✅ Conectado a Socket.IO - ID:', this.socket?.id);
      });

      this.socket.on('disconnect', (reason) => {
        console.log('❌ Desconectado de Socket.IO:', reason);
      });

      this.socket.on('connect_error', async (error: any) => {
        console.error('🚫 Error de conexión Socket.IO:', error);

        const message = error?.message || String(error);

        // Caso crítico: token inválido -> forzar logout y redirección al login
        if (message.includes('Invalid token')) {
          console.warn('🔒 Token inválido detectado por Socket.IO, forzando logout...');

          try {
            const refreshToken = localStorage.getItem('refreshToken');
            if (refreshToken) {
              // Intento 'best-effort' de hacer logout en el backend
              await authService.logout(refreshToken);
            }
          } catch (e) {
            // No interrumpimos el flujo si el logout backend falla
            console.warn('⚠️ Error during server logout (ignored):', e);
          }

          // Limpieza local y forzar navegación a pantalla de login
          try {
            this.disconnect();
          } catch (e) {
            // ignore
          }
          localStorage.removeItem('accessToken');
          localStorage.removeItem('refreshToken');
          // Redirigir a la ruta de login
          window.location.href = '/auth/login';
          return;
        }

        // Caso menos crítico: error de autenticación (p.ej. token expirado) -> intentar reconectar con token actualizado
        if (message.includes('Authentication')) {
          console.log('🔄 Intentando reconectar con token actualizado...');
          const newToken = localStorage.getItem('accessToken');
          if (this.socket && newToken) {
            this.socket.auth = { token: newToken };
          }
        }
      });
    } else if (!this.socket.connected) {
      // Si el socket existe pero no está conectado, reconectar
      console.log('🔄 Socket existe pero no está conectado, reconectando...');
      this.socket.connect();
    }

    return this.socket;
  }

  public disconnect(): void {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
  }

  public reconnectWithToken(): void {
    const token = localStorage.getItem('accessToken');
    
    if (this.socket) {
      // Actualizar token y reconectar
      this.socket.auth = { token: token || '' };
      this.socket.connect();
    } else {
      // Crear nueva conexión
      this.connect();
    }
  }

  public getSocket(): Socket | null {
    return this.socket;
  }

  public joinRoom(chatId: string): void {
    if (this.socket) {
      this.socket.emit('join', chatId);
    }
  }

  public leaveRoom(chatId: string): void {
    if (this.socket) {
      this.socket.emit('leave', chatId);
    }
  }
}

export default SocketService;
