/**
 * Servicio para gestionar chats
 * 
 * Documentación: APIs de Chats
 * Multi-tenant: Los empleados solo ven chats asignados, admins ven todos los suyos
 * 
 * ⚠️ NOTA: La API antigua GET /chats ha sido deprecada.
 * Usa tagsService.getChatsByTag(tagId) con la etiqueta "Todo" en su lugar.
 * La etiqueta "Todo" es la default en la BD y equivale a GET /chats pero mejorada.
 */

import { api } from "../axios/http";

export const chatsService = {
  /**
   * ❌ DEPRECATED: Esta API ha sido reemplazada por /tags/{id}/chats/full
   * 
   * @deprecated Usar tagsService.getChatsByTag(tagId) en su lugar
   */
  async getChats() {
    console.warn('❌ chatsService.getChats() está deprecado.');
    console.warn('📌 Usa tagsService.getChatsByTag(tagId) con la etiqueta "Todo" en su lugar.');
    throw new Error('chatsService.getChats() está deprecado. Usa tagsService.getChatsByTag(tagId) en su lugar.');
  },

  /**
   * Obtiene los mensajes de un chat específico
   * Endpoint: GET /api/chats/:chatId/messages
   * 
   * Restricciones:
   * - Si eres EMPLEADO, necesitas permiso asignado (403 si no lo tienes)
   * - Si eres ADMIN, puedes ver todos tus chats
   * 
   * @param chatId string - ID del chat (ej: "5491122334455@c.us")
   * @param limit number - Número de mensajes a obtener (default: 50)
   * @returns Promise con array de mensajes
   */
  async getMessages(chatId: string, limit: number = 50) {
    try {
      const { data } = await api.get(`/chats/${chatId}/messages`, {
        params: { limit }
      });
      return data;
    } catch (error: any) {
      if (error?.response?.status === 403) {
        throw new Error("Acceso denegado a este chat");
      }
      console.error("Error al obtener mensajes:", error);
      throw new Error(
        error?.response?.data?.message ||
          error?.message ||
          "Error al obtener mensajes"
      );
    }
  },

  /**
   * Envía un mensaje de texto o archivo a un chat
   * Endpoint: POST /api/chats/:chatId/messages
   * 
   * Content-Type: multipart/form-data
   * 
   * Restricciones:
   * - Si eres EMPLEADO, necesitas permiso asignado (403 si no lo tienes)
   * - Si eres ADMIN, puedes enviar a cualquier chat
   * - Al menos uno de 'message' o 'file' es requerido
   * 
   * Tipos de archivo soportados:
   * - Imágenes: jpg, jpeg, png, gif, webp
   * - Videos: mp4, avi, mov
   * - Documentos: pdf, doc, docx, xls, xlsx, txt
   * - Audio: mp3, ogg, wav, opus
   * 
   * @param chatId string - ID del chat
   * @param message string - Texto del mensaje (opcional si hay file)
   * @param file File - Archivo adjunto (opcional)
   * @returns Promise con response: { sentType, messageId }
   */
  async sendMessage(
    chatId: string,
    message: string = "",
    file?: File
  ) {
    try {
      const formData = new FormData();
      if (message) formData.append("message", message);
      if (file) formData.append("file", file);

      const { data } = await api.post(
        `/chats/${chatId}/messages`,
        formData,
        {
          headers: { "Content-Type": "multipart/form-data" }
        }
      );
      return data;
    } catch (error: any) {
      if (error?.response?.status === 403) {
        throw new Error("Acceso denegado a este chat");
      }
      if (error?.response?.status === 400) {
        throw new Error("Mensaje o archivo es requerido");
      }
      console.error("Error al enviar mensaje:", error);
      throw new Error(
        error?.response?.data?.message ||
          error?.message ||
          "Error al enviar mensaje"
      );
    }
  },

  /**
   * Marca un chat como leído
   * Endpoint: PUT /api/chats/:chatId/read
   * 
   * Marca todos los mensajes del chat como leídos
   * 
   * Restricciones:
   * - Si eres EMPLEADO, necesitas permiso asignado
   * - No se pueden marcar como leídos canales (400)
   * 
   * @param chatId string - ID del chat
   * @returns Promise con response de éxito
   */
  async markChatAsRead(chatId: string) {
    try {
      const { data } = await api.put(`/chats/${chatId}/read`);
      return data;
    } catch (error: any) {
      if (error?.response?.status === 400) {
        throw new Error("No se puede marcar como leído un canal");
      }
      if (error?.response?.status === 403) {
        throw new Error("Acceso denegado a este chat");
      }
      console.error("Error al marcar chat como leído:", error);
      throw new Error(
        error?.response?.data?.message ||
          error?.message ||
          "Error al marcar chat como leído"
      );
    }
  }
};
