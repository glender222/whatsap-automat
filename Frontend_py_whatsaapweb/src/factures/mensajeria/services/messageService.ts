// src/factures/mensajeria/services/messageService.ts

import { api } from '../../../shared/axios/http';
import type { WhatsAppMessage } from '../../../shared/types/wsp';

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
export async function getMessagesByChat(
  chatId: string,
  limit: number = 50,
  signal?: AbortSignal
): Promise<WhatsAppMessage[]> {
  try {
    const response = await api.get<{ success: boolean; data: WhatsAppMessage[]; total: number }>(
      `/chats/${encodeURIComponent(chatId)}/messages`,
      { params: { limit }, signal }
    );
    if (!response.data.success || !Array.isArray(response.data.data)) {
      throw new Error('El historial de mensajes no es válido.');
    }
    return response.data.data;
  } catch (error) {
    if (signal?.aborted) throw error;
    const response = (error as { response?: { status?: number; data?: { message?: string } } })?.response;
    if (response?.status === 403) throw new Error('No tienes permiso para acceder a esta conversación.');
    if (response?.status === 429) throw new Error('Demasiadas solicitudes. Espera unos segundos y vuelve a intentar.');
    throw new Error(response?.data?.message || 'No se pudieron cargar los mensajes.');
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
