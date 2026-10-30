// src/factures/mensajeria/services/messageService.ts

import { api } from '../../../shared/axios/http';

function getSendErrorMessage(error: any): string {
  const data = error?.response?.data || {};
  const code = data.error;

  if (code === 'SERVICE_WINDOW_CLOSED') {
    return data.userMessage || 'La ventana de 24 horas esta cerrada. Envia una plantilla aprobada.';
  }

  if (code === 'META_AUTH_ERROR') {
    return data.userMessage || 'El token de Meta no es valido o expiro.';
  }

  if (code === 'META_PERMISSION_ERROR') {
    return data.userMessage || 'La app o el token de Meta no tiene permisos para esta cuenta.';
  }

  if (code === 'META_TEMPLATE_ERROR') {
    return data.userMessage || 'La plantilla no existe, no esta aprobada o no coincide con el idioma.';
  }

  if (code === 'META_RECIPIENT_ERROR') {
    return data.userMessage || 'Meta no pudo entregar el mensaje a ese numero.';
  }

  if (code === 'META_API_ERROR') {
    return data.userMessage || data.message || 'WhatsApp Business no pudo enviar el mensaje.';
  }

  return data.userMessage || data.message || error?.message || 'No se pudo enviar el mensaje';
}

/**
 * Obtiene los mensajes de un chat - USA EL ENDPOINT CORRECTO CON TOKEN INYECTADO
 * 📥 GET /api/chats/{chatId}/messages
 * ✅ Token inyectado automáticamente por axios interceptor en src/shared/axios/http.ts
 * 🔐 Valida permisos en backend según rol del usuario
 */
export async function getMessagesByChat(chatId: string, limit: number = 50) {
  try {
    console.log(`📥 Obteniendo mensajes del chat: ${chatId} (limit: ${limit})`);
    
    const response = await api.get<{ success: boolean; data: any[]; total: number }>(
      `/chats/${encodeURIComponent(chatId)}/messages`, 
      { params: { limit } }
    );
    
    // El backend devuelve { success, data: [...], total }
    const messageArray = response.data?.data || [];
    return messageArray;
  } catch (error: any) {
    const status = error?.response?.status;
    console.error(`❌ Error al obtener mensajes de ${chatId}:`, {
      status,
      statusText: error?.response?.statusText,
      message: error?.response?.data?.message,
      fullResponse: error?.response?.data,
      error: error?.message,
      config: {
        url: error?.config?.url,
        method: error?.config?.method
      }
    });
    
    if (error?.response?.status === 403) {
      throw new Error('❌ No tienes permiso para acceder a este chat');
    }

    if (status === 429) {
      const rateLimitError = new Error('Demasiadas solicitudes. Espera unos segundos y vuelve a intentar.');
      (rateLimitError as any).status = 429;
      throw rateLimitError;
    }
    
    throw new Error(
      error?.response?.data?.message || 'No se pudieron obtener los mensajes'
    );
  }
}

/**
 * Pre-carga mensajes de un chat (útil para grupos nuevos)
 * 📥 GET /api/chats/{chatId}/messages/preload?max=100
 * ✅ Token inyectado automáticamente por axios interceptor
 * Devuelve { success: true, data: [...], total: N }
 */
export async function preloadChatMessages(chatId: string, max: number = 100) {
  try {
    console.log(`📥 Pre-cargando mensajes del chat: ${chatId} (max: ${max})`);
    
    const response = await api.get<{ success: boolean; data: any[]; total: number }>(
      `/chats/${encodeURIComponent(chatId)}/messages/preload`, 
      { params: { max } }
    );
    
    // El backend devuelve { success: true, data: [...], total: N }
    const messageArray = response.data?.data || [];
    console.log(`✅ ${messageArray.length || 0} mensajes pre-cargados correctamente (total: ${response.data?.total || 0})`);
    return messageArray;
  } catch (error: any) {
    console.error(`❌ Error al pre-cargar mensajes de ${chatId}:`, {
      status: error?.response?.status,
      message: error?.response?.data?.message,
      error: error?.message
    });
    
    throw new Error(
      error?.response?.data?.message || 'No se pudieron pre-cargar los mensajes'
    );
  }
}

/**
 * Envía un mensaje de texto a un chat
 * 📤 POST /api/chats/{chatId}/messages
 * ✅ Token inyectado automáticamente por axios interceptor
 * 🔐 Valida permisos en backend según rol del usuario
 */
export async function sendMessage(chatId: string, message: string, mediaUrl?: string) {
  try {
    console.log(`📤 Enviando mensaje a: ${chatId}`);
    
    const response = await api.post(`/chats/${encodeURIComponent(chatId)}/messages`, {
      message,
      mediaUrl
    });
    
    console.log(`✅ Mensaje enviado correctamente con ID: ${response.data?.messageId}`);
    return response.data;
  } catch (error: any) {
    console.error(`❌ Error al enviar mensaje a ${chatId}:`, {
      status: error?.response?.status,
      message: error?.response?.data?.message,
      error: error?.message
    });
    
    if (error?.response?.status === 403) {
      throw new Error('❌ No tienes permiso para enviar mensajes en este chat');
    }

    throw new Error(getSendErrorMessage(error));
  }
}

export async function sendTemplateMessage(
  chatId: string,
  templateName: string,
  templateLanguage: string
) {
  try {
    const response = await api.post(`/chats/${encodeURIComponent(chatId)}/messages`, {
      templateName,
      templateLanguage,
    });

    return response.data;
  } catch (error: any) {
    console.error(`❌ Error al enviar template a ${chatId}:`, {
      status: error?.response?.status,
      code: error?.response?.data?.error,
      message: error?.response?.data?.message,
      userMessage: error?.response?.data?.userMessage,
    });

    throw new Error(getSendErrorMessage(error));
  }
}
