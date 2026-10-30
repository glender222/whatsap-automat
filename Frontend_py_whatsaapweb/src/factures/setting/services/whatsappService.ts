/**
 * Servicio para manejar operaciones de WhatsApp
 * 
 * ARQUITECTURA MULTI-TENANT:
 * - Cada ADMIN tiene su propia sesión de WhatsApp independiente
 * - Los EMPLEADOS acceden a la sesión de su admin padre (id_padre)
 * - El backend usa el JWT para determinar qué sesión corresponde al usuario
 * - Las sesiones se gestionan en un Map<adminId, WhatsAppClient> en el backend
 * 
 * RUTAS:
 * - Todas requieren autenticación (Bearer token)
 * - El middleware injectWhatsAppClient determina el tenant automáticamente
 * - Si eres ADMIN → usa tu sesión (tenantId = userId)
 * - Si eres EMPLEADO → usa la sesión de tu admin padre (tenantId = id_padre)
 */

import { api } from '../../../shared/axios/http';
import { authService } from '../../auth/services/authService';

export class WhatsAppService {
  /**
   * Obtiene el número afiliado actual
   * GET /api/whatsapp/me (con token JWT inyectado)
   */
  static async fetchNumeroAfiliado(): Promise<string | null> {
    try {
      const { data, status } = await api.get('/whatsapp/me');      if (status === 503) {
        // WhatsApp no inicializado aún, es normal - no loggear
        return null;
      }
      // El backend puede devolver el número en diferentes formas. Normalizar:
      // - { numero: '519...' }
      // - { whatsappNumber: '519...' } / { whatsapp_number: '519...' }
      // - { user: '519...' } (antiguo)
      // - { id: '519...@c.us' }
      const maybe = (d: any) => d !== undefined && d !== null;

      // Si viene anidado en data.data (por ejemplo respuesta tipo { success: true, data: { ... } })
      const payload = data?.data ?? data;

      if (maybe(payload?.numero)) {
        return String(payload.numero);
      }

      if (maybe(payload?.whatsappNumber)) {
        return String(payload.whatsappNumber);
      }

      if (maybe(payload?.whatsapp_number)) {
        return String(payload.whatsapp_number);
      }

      if (maybe(payload?.user)) {
        return String(payload.user);
      }

      if (maybe(payload?.id)) {
        return String(payload.id).split('@')[0];
      }

      // Intentar fallback: obtener número desde la lista de chats si está disponible
      try {
        const fallback = await WhatsAppService.fetchNumeroAfiliadoFromChats();
        if (fallback) return fallback;
      } catch (e) {
        // ignore
      }

      return null;
    } catch (error: any) {
        // Si el endpoint /whatsapp/me no existe (404), intentar obtener el número
        // desde el endpoint de usuario autenticado (/auth/me) que contiene `whatsappNumber`.
        if (error.response?.status === 404) {
          try {
            const user = await authService.getMe();
            const maybe = (d: any) => d !== undefined && d !== null;
            const u: any = user;
            if (maybe(u?.whatsappNumber)) return String(u.whatsappNumber);
            if (maybe(u?.whatsapp_number)) return String(u.whatsapp_number);
            if (maybe(u?.numero)) return String(u.numero);
            if (maybe(u?.phone)) return String(u.phone);
            return null;
          } catch (e) {
            // Si falla getMe, continuar al log genérico abajo
          }
        }

        // Solo loggear errores no relacionados con servicio no disponible
        if (error.response?.status !== 503) {
          console.error('Error fetching número afiliado:', error.message || error);
        }
        return null;
    }
  }

  /**
   * Cierra la sesión de WhatsApp en el backend
   * POST /api/whatsapp/logout
   */
  static async logout(): Promise<{ success: boolean; message?: string }> {
    try {
      const { data } = await api.post('/whatsapp/logout', {});
      return { success: true, message: data?.message || 'Logout successful' };
    } catch (error: any) {
      console.error('Error during WhatsApp logout:', error?.message || error);
      if (error.response) {
        return { success: false, message: error.response?.data?.message || `Error ${error.response?.status}` };
      }
      return { success: false, message: error.message || 'Unknown error' };
    }
  }

  /**
   * Obtiene el número afiliado desde la lista de chats (fallback)
   * GET /api/chats (con token JWT inyectado)
   */
  static async fetchNumeroAfiliadoFromChats(): Promise<string | null> {
    try {
      const response = await api.get('/chats');      
      const data = response.data?.data || response.data;
      if (Array.isArray(data) && data.length > 0) {
        return data[0].id.split('@')[0];
      }
      
      return null;
    } catch (error) {
      console.error('Error fetching chats:', error);
      return null;
    }
  }

  /**
   * Solicita el código QR para afiliación
   * GET /api/whatsapp/qr (con token JWT inyectado automáticamente)
   * El QR puede recibirse por respuesta HTTP o por evento del socket
   */
  static async requestQR(): Promise<{ success: boolean; message?: string; qr?: string }> {
    try {
      console.log('🚀 Solicitando código QR al servidor...');
      
      const token = localStorage.getItem('accessToken');
      if (!token) {
        return { 
          success: false, 
          message: 'No hay token de autenticación. Inicia sesión primero.' 
        };
      }
      
      const { data } = await api.get('/whatsapp/qr');
      console.log('✅ Respuesta del servidor recibida');
      
      // Si el QR viene en la respuesta HTTP directamente
      if (data.qr) {
        console.log('✅ QR recibido en respuesta HTTP');
        return { 
          success: true,
          qr: data.qr,
          message: 'QR recibido correctamente'
        };
      } else {
        // El QR llegará por el evento 'qr' del socket
        console.log('⏳ QR no disponible aún, esperando por socket...');
        return { 
          success: true, 
          message: 'Esperando generación de QR...' 
        };
      }
    } catch (error: any) {
      if (error.response?.status === 401) {
        console.error('❌ Token inválido o expirado');
        return { 
          success: false, 
          message: 'Token inválido o expirado. Inicia sesión nuevamente.' 
        };
      }
      if (error.response?.status === 503) {
        console.error('❌ Servicio no disponible');
        return { 
          success: false, 
          message: 'Servicio no disponible. Intenta nuevamente.' 
        };
      }
      console.error('❌ Error al solicitar QR:', error.message || error);
      return { 
        success: false, 
        message: error.message || 'Error desconocido' 
      };
    }
  }

  /**
   * Verifica el estado de conexión de WhatsApp
   * GET /api/whatsapp/me (con token JWT inyectado)
   */
  static async checkConnectionStatus(): Promise<{
    connected: boolean;
    numero?: string;
    message?: string;
  }> {
    try {
      const { data } = await api.get('/whatsapp/me');
      const payload = data?.data || data;
      const isConnected = payload.status === 'connected' || payload.status === 'READY';
      return {
        connected: isConnected,
        numero: payload.numero || null,
        message: isConnected ? 'Conectado' : 'Desconectado'
      };
    } catch (error: any) {
      console.error('Error checking WhatsApp status:', error.message || error);
      return {
        connected: false,
        message: 'Error al verificar estado de conexión'
      };
    }
  }

  /**
   * Inicializa WhatsApp al inicio de sesión
   * POST /api/whatsapp/init (con token JWT inyectado)
   * 
   * MULTI-TENANT:
   * - Si eres ADMIN → crea/inicia TU sesión de WhatsApp
   * - Si eres EMPLEADO → el backend verifica que la sesión de tu admin padre exista
   * 
   * ⚠️ IMPORTANTE: Solo los ADMIN pueden iniciar sesiones de WhatsApp.
   * Los empleados solo pueden usar la sesión ya iniciada por su admin.
   * 
   * Esta función se debe llamar después de que el usuario inicie sesión.
   */
  static async initializeWhatsApp(): Promise<{ success: boolean; message?: string }> {
    try {
      const token = localStorage.getItem('accessToken');
      if (!token) {
        console.log('⚠️ Token no disponible, omitiendo inicialización de WhatsApp');
        return { 
          success: false, 
          message: 'No hay token de autenticación' 
        };
      }

      console.log('🚀 Inicializando WhatsApp con token inyectado (vía cliente compartido)...');
      console.log('🔗 Enviando POST a /api/whatsapp/init...');
      
      // Agregar timestamp para medir duración
      const startTime = Date.now();

      // Usamos el cliente central `api` que ya inyecta el token; ahora con ruta /api/whatsapp/init
      const { data, status } = await api.post('/whatsapp/init', {});
      
      const duration = Date.now() - startTime;
      console.log(`✅ WhatsApp inicializado correctamente en ${duration}ms`);
      console.log('📊 Respuesta del servidor:', { status, data });
      
      return { 
        success: true,
        message: data.message || 'WhatsApp inicializado'
      };
    } catch (error: any) {
      const duration = Date.now() - (error.startTime || Date.now());
      console.error(`❌ Error inicializando WhatsApp después de ${duration}ms:`, error);
      
      // Manejo específico de errores
      if (error.response) {
        const { status, data } = error.response;
        console.error('📊 Detalles del error:', { status, data });
        
        // No es error, es normal si ya está inicializado
        if (status === 400 || status === 409) {
          console.log('ℹ️ WhatsApp ya estaba inicializado');
          return { 
            success: true,
            message: 'WhatsApp ya inicializado'
          };
        }
        
        // Error de autorización
        if (status === 401 || status === 403) {
          console.error('🔒 Error de autorización - Token inválido o sin permisos');
          return { 
            success: false, 
            message: 'Token inválido o sin permisos de administrador'
          };
        }
        
        // Error interno del servidor
        if (status === 500) {
          console.error('💥 Error interno del servidor backend');
          return { 
            success: false, 
            message: 'Error interno del servidor'
          };
        }
        
        return { 
          success: false, 
          message: `Error ${status}: ${data?.message || error.message}`
        };
      } else if (error.request) {
        console.error('🌐 Error de red - No hay respuesta del servidor');
        return { 
          success: false, 
          message: 'Error de conexión con el servidor'
        };
      } else {
        console.error('⚠️ Error desconocido:', error.message);
        return { 
          success: false, 
          message: error.message || 'Error desconocido al inicializar WhatsApp'
        };
      }
    }
  }

  /**
   * Formatea el número afiliado removiendo el prefijo del país
   */
  static formatNumeroAfiliado(numero: string | null): string {
    if (!numero) return '';
    if (numero.startsWith('51')) {
      return numero.substring(2);
    }
    return numero;
  }
}
