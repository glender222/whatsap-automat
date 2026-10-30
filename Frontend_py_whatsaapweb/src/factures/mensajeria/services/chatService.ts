// src/factures/mensajeria/services/chatService.ts

import { api } from '../../../shared/axios/http';
import type { WhatsAppChat } from '../../../shared/types/wsp';

/**
 * ❌ DEPRECATED: Usa /tags/{id}/chats/full en su lugar (vía tagsService.getChatsByTag)
 * La API antigua GET /chats ha sido reemplazada por el endpoint mejorado de tags.
 * 
 * @deprecated Usar tagsService.getChatsByTag(tagId) en su lugar
 */
export async function getChats(): Promise<WhatsAppChat[]> {
  console.warn('❌ getChats() está deprecado. Usa tagsService.getChatsByTag(tagId) en su lugar.');
  throw new Error('getChats() está deprecado. Usa tagsService.getChatsByTag(tagId) en su lugar.');
}

/**
 * Obtiene los mensajes de un chat específico
 * Valida permisos automáticamente en el backend
 */
export async function getChatMessages(chatId: string) {
  try {
    const response = await api.get(`/chats/${encodeURIComponent(chatId)}/messages`);
    return response.data;
  } catch (error: any) {
    if (error?.response?.status === 403) {
      throw new Error('No tienes permiso para acceder a este chat');
    }
    throw new Error(error?.response?.data?.message || 'No se pudieron obtener los mensajes');
  }
}

/**
 * Envía un mensaje a un chat
 * Valida permisos automáticamente en el backend
 */
export async function sendMessage(chatId: string, message: string, mediaUrl?: string) {
  try {
    const response = await api.post(`/chats/${encodeURIComponent(chatId)}/messages`, {
      message,
      mediaUrl
    });
    return response.data;
  } catch (error: any) {
    if (error?.response?.status === 403) {
      throw new Error('No tienes permiso para enviar mensajes en este chat');
    }
    throw new Error(error?.response?.data?.message || 'No se pudo enviar el mensaje');
  }
}

/**
 * Marca un chat como leído en el backend.
 */
export async function markChatAsRead(chatId: string) {
  try {
    const response = await api.put(`/chats/${encodeURIComponent(chatId)}/read`);
    return response.data;
  } catch (error: any) {
    throw new Error(error?.response?.data?.message || 'No se pudo marcar el chat como leído');
  }
}

/**
 * Fija un chat en el backend.
 */
export async function pinChat(chatId: string) {
  try {
    const response = await api.post(`/chats/${encodeURIComponent(chatId)}/pin`);
    return response.data;
  } catch (error: any) {
    throw new Error(error?.response?.data?.message || 'No se pudo fijar el chat');
  }
}

/**
 * Añade un chat a un grupo o lista en el backend.
 */
export async function addToGroup(chatId: string, groupId: string) {
  try {
    const response = await api.post(`/chats/${encodeURIComponent(chatId)}/add-to-group`, {
      groupId
    });
    return response.data;
  } catch (error: any) {
    throw new Error(error?.response?.data?.message || 'No se pudo añadir el chat al grupo');
  }
}
