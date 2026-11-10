import { Server, Socket } from 'socket.io';
import pool from '../config/database';
import config from '../config/index';
import { DbQueryable, isInternalChatId, normalizeChatIdCandidates, queryTenantResource } from '../middleware/resourceAuth';
import { socketJwtAuthMiddleware, AuthenticatedSocketData } from './socketAuth';
import { SocketSessionMonitor } from './SocketSessionMonitor';

const CHAT_ID_REGEX = /^[a-zA-Z0-9_\-+.:@]+$/;

export class SocketHandler {
  private whatsappService?: any;
  private db: DbQueryable;

  constructor(whatsappService?: any, db?: DbQueryable) {
    this.whatsappService = whatsappService;
    this.db = db || pool;
  }

  handleConnection(io: Server): () => void {
    const sessions = new SocketSessionMonitor(pool);
    // 1. Registrar middleware fail-closed de autenticación JWT
    io.use(socketJwtAuthMiddleware(undefined, sessions));

    io.on('connection', (socket: Socket) => {
      const data = socket.data as Partial<AuthenticatedSocketData>;
      const tenantId = data.tenantId ? String(data.tenantId) : null;
      const companyId = data.companyId || (tenantId ? Number(tenantId) : null);
      const workspaceId = data.workspaceId ? String(data.workspaceId) : null;
      const userId = data.userId ? String(data.userId) : null;

      if (!sessions.activate(socket, data.expiresAt)) return;

      if (!tenantId || !companyId) {
        console.error(`[SocketHandler] Conexión rechazada: socket ${socket.id} sin tenantId válido.`);
        socket.disconnect(true);
        return;
      }

      // 2. Unirse automáticamente a salas autorizadas del tenant
      socket.join(`tenant:${tenantId}`);
      const isWebJs = this.whatsappService?.provider === 'webjs';
      const hasChannelAccess = !isWebJs || companyId === config.defaultCompanyId;
      if (isWebJs && hasChannelAccess && data.user?.rol === 'ADMIN') {
        socket.join(`whatsapp-link-admin:${tenantId}`);
      }
      if (workspaceId) {
        socket.join(`workspace:${tenantId}:${workspaceId}`);
      }
      if (userId) {
        socket.join(`user:${tenantId}:${userId}`);
      }

      // Eliminado: socket.emit("chats-updated", ...) global no acotado.

      // 3. Manejador de suscripción a conversaciones con validación en BD
      const handleJoin = async (
        roomOrChatId: unknown,
        callback?: (res: { success: boolean; error?: string; status?: number; message?: string; room?: string }) => void
      ) => {
        let rawTarget = '';
        if (typeof roomOrChatId === 'string') {
          rawTarget = roomOrChatId.trim();
        } else if (roomOrChatId && typeof roomOrChatId === 'object') {
          const obj = roomOrChatId as Record<string, unknown>;
          rawTarget = String(obj.chatId || obj.conversationId || obj.room || '').trim();
        }

        if (!rawTarget) {
          const response = {
            success: false,
            error: 'BAD_REQUEST',
            status: 400,
            message: 'Identificador de chat requerido',
          };
          if (callback && typeof callback === 'function') callback(response);
          socket.emit('subscription_error', response);
          return;
        }

        // Bloquear suscripción cross-tenant a salas con prefijo tenant:
        if (rawTarget.startsWith('tenant:')) {
          const requestedTenant = rawTarget.split(':')[1];
          if (String(requestedTenant) !== String(tenantId)) {
            const response = {
              success: false,
              error: 'CROSS_TENANT_FORBIDDEN',
              status: 403,
              message: 'Acceso denegado a tenant ajeno',
            };
            if (callback && typeof callback === 'function') callback(response);
            socket.emit('subscription_error', response);
            return;
          }
          if (callback && typeof callback === 'function') callback({ success: true, room: rawTarget });
          return;
        }

        // Bloquear suscripción cross-tenant a salas workspace o user
        if (rawTarget.startsWith('workspace:') || rawTarget.startsWith('user:')) {
          const parts = rawTarget.split(':');
          if (parts[1] && String(parts[1]) !== String(tenantId)) {
            const response = {
              success: false,
              error: 'CROSS_TENANT_FORBIDDEN',
              status: 403,
              message: 'Acceso denegado a recurso de otro tenant',
            };
            if (callback && typeof callback === 'function') callback(response);
            socket.emit('subscription_error', response);
            return;
          }
        }

        let chatId = rawTarget;
        if (rawTarget.startsWith('conversation:')) {
          const parts = rawTarget.split(':');
          const targetTenant = parts[1];
          if (targetTenant && String(targetTenant) !== String(tenantId)) {
            const response = {
              success: false,
              error: 'CROSS_TENANT_FORBIDDEN',
              status: 403,
              message: 'Acceso denegado a conversacion de otra empresa',
            };
            if (callback && typeof callback === 'function') callback(response);
            socket.emit('subscription_error', response);
            return;
          }
          chatId = parts.slice(2).join(':');
        }

        if (!CHAT_ID_REGEX.test(chatId) || chatId.length > 128) {
          const response = {
            success: false,
            error: 'INVALID_CHAT_ID',
            status: 400,
            message: 'Formato de identificador de chat invalido',
          };
          if (callback && typeof callback === 'function') callback(response);
          socket.emit('subscription_error', response);
          return;
        }

        // 4. Verificación de propiedad del chat en PostgreSQL
        try {
          const numericId = Number(chatId);
          const isNumericId = isInternalChatId(chatId);

          if (isNumericId) {
            const result = await queryTenantResource(this.db, companyId,
              `SELECT id, company_id, external_conversation_id FROM conversations WHERE id = $1 AND company_id = $2 LIMIT 1`,
              [numericId, companyId]
            );

            if (!result.rows || result.rows.length === 0) {
              const existence = await queryTenantResource(this.db, companyId,
                `SELECT id, company_id FROM conversations WHERE id = $1 LIMIT 1`,
                [numericId]
              );
              if (existence.rows && existence.rows.length > 0) {
                const response = {
                  success: false,
                  error: 'FORBIDDEN',
                  status: 403,
                  message: 'Acceso denegado a conversacion de otra empresa',
                };
                if (callback && typeof callback === 'function') callback(response);
                socket.emit('subscription_error', response);
                return;
              }
              const response = {
                success: false,
                error: 'CHAT_NOT_FOUND',
                status: 404,
                message: 'Conversacion no encontrada',
              };
              if (callback && typeof callback === 'function') callback(response);
              socket.emit('subscription_error', response);
              return;
            }
          } else {
            const candidates = normalizeChatIdCandidates(chatId);
            const result = await queryTenantResource(this.db, companyId,
              `SELECT id, company_id, external_conversation_id FROM conversations
               WHERE external_conversation_id = ANY($1::varchar[]) AND company_id = $2
               ORDER BY last_message_at DESC NULLS LAST, id DESC
               LIMIT 1`,
              [candidates, companyId]
            );

            if (!result.rows || result.rows.length === 0) {
              const existence = await queryTenantResource(this.db, companyId,
                `SELECT id, company_id FROM conversations
                 WHERE external_conversation_id = ANY($1::varchar[])
                 LIMIT 1`,
                [candidates]
              );
              if (existence.rows && existence.rows.length > 0) {
                const response = {
                  success: false,
                  error: 'FORBIDDEN',
                  status: 403,
                  message: 'Acceso denegado al chat de otra empresa',
                };
                if (callback && typeof callback === 'function') callback(response);
                socket.emit('subscription_error', response);
                return;
              }
              const response = {
                success: false,
                error: 'CHAT_NOT_FOUND',
                status: 404,
                message: 'Conversacion no encontrada',
              };
              if (callback && typeof callback === 'function') callback(response);
              socket.emit('subscription_error', response);
              return;
            }
          }

          // Chat verificado: unir a la sala de la empresa.
          const scopedRoom = `conversation:${tenantId}:${chatId}`;
          socket.join(scopedRoom);

          if (hasChannelAccess && !chatId.includes('@newsletter') && this.whatsappService && typeof this.whatsappService.markAsRead === 'function') {
            try {
              await this.whatsappService.markAsRead(chatId, companyId);
            } catch (err) {
              console.error(`[SocketHandler] Error marcando como leido al unirse:`, err);
            }
          }

          const response = { success: true, room: scopedRoom };
          if (callback && typeof callback === 'function') callback(response);
          socket.emit('conversation_joined', response);
        } catch (dbErr: any) {
          console.error(`[SocketHandler] Error en validacion de conversacion en BD:`, dbErr);
          const response = {
            success: false,
            error: 'INTERNAL_ERROR',
            status: 500,
            message: 'Error validando autorizacion del chat',
          };
          if (callback && typeof callback === 'function') callback(response);
          socket.emit('subscription_error', response);
        }
      };

      socket.on('join_conversation', handleJoin);
      socket.on('join', handleJoin);

      // Salir de una conversación
      const handleLeave = (roomOrChatId: unknown) => {
        let target = '';
        if (typeof roomOrChatId === 'string') {
          target = roomOrChatId.trim();
        } else if (roomOrChatId && typeof roomOrChatId === 'object') {
          const obj = roomOrChatId as Record<string, unknown>;
          target = String(obj.chatId || obj.conversationId || obj.room || '').trim();
        }
        const prefix = `conversation:${tenantId}:`;
        if (target.startsWith('conversation:') && !target.startsWith(prefix)) return;
        const chatId = target.startsWith(prefix) ? target.slice(prefix.length) : target;
        if (CHAT_ID_REGEX.test(chatId)) socket.leave(prefix + chatId);
      };

      socket.on('leave_conversation', handleLeave);
      socket.on('leave', handleLeave);

      // Solicitar chats acotados por tenant
      socket.on('request-chats', async () => {
        if (!hasChannelAccess) {
          socket.emit('chats-updated', []);
          return;
        }
        if (this.whatsappService && typeof this.whatsappService.getChatsList === 'function') {
          try {
            const chats = await this.whatsappService.getChatsList(companyId);
            socket.emit('chats-updated', chats);
          } catch (err) {
            console.error('[SocketHandler] Error en request-chats:', err);
          }
        }
      });

      // Logout desde Socket.IO deshabilitado por seguridad
      socket.on('logout', async (callback?: (res: any) => void) => {
        const response = {
          success: false,
          error: 'LOGOUT_VIA_SOCKET_DISABLED',
          message: 'El cierre de sesion via Socket.IO esta deshabilitado por seguridad. Utilice el endpoint REST administrativo.',
        };
        socket.emit('logout-confirmed', response);
        if (callback && typeof callback === 'function') {
          callback(response);
        }
      });

    });
    return () => sessions.close();
  }
}

export default SocketHandler;
