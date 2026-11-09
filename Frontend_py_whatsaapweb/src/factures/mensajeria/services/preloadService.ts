/**
 * Servicio para precarga automática de mensajes y multimedia
 * 
 * Flujo completo:
 * 1. Obtener lista de chats (GET /chats)
 * 2. Para cada chat, obtener sus mensajes (GET /chats/{chatId}/messages)
 * 3. Para cada mensaje con multimedia, descargar archivo (GET /media/{messageId})
 * 4. Guardar todo en IndexedDB
 */

import { api } from '../../../shared/axios/http';
import { saveMessage, saveMedia } from '../../../lib/db';
import { downloadMediaAPI, getMediaInfoAPI } from './mediaService';
import { getMediaUrl as buildMediaUrl } from '../../../shared/utils/urls';
import { isPdfFile } from '../../../shared/components/pdfMedia';

/**
 * Obtiene los mensajes de un chat específico
 */
async function fetchMessagesForChat(chatId: string, limit: number = 50): Promise<any[]> {
  try {
    const response = await api.get(`/chats/${encodeURIComponent(chatId)}/messages`, {
      params: { limit }
    });
    return response.data?.data || [];
  } catch (error: any) {
    if (error.response?.status === 403) {
      console.warn(`⚠️ Sin permiso para chat ${chatId}`);
      return [];
    }
    if (error.response?.status === 404) {
      return [];
    }
    throw error;
  }
}

/**
 * Descarga el archivo multimedia de un mensaje
 */
async function downloadMessageMedia(messageId: string): Promise<Blob | null> {
  try {
    // Primero intentamos obtener una URL pública desde el endpoint
    try {
      const info = await getMediaInfoAPI(messageId);
      if (info?.mediaUrl && typeof info.mediaUrl === 'string') {
        const publicUrl = buildMediaUrl(info.mediaUrl);
        // Descargar el binario desde la URL pública (sin auth)
        const resp = await fetch(publicUrl);
        if (!resp.ok) throw new Error(`Failed to fetch public media: ${resp.status}`);
        const blob = await resp.blob();
        return blob;
      }
    } catch (e) {
      // Ignorar y usar fallback
    }

    // Fallback: intentar descargar vía la API (aún puede devolver blob)
    const blob = await downloadMediaAPI(messageId);
    return blob;
  } catch (error: any) {
    if (error.response?.status === 404) {
      return null; // Media no disponible
    }
    console.warn(`⚠️ Error descargando media ${messageId}:`, error.message);
    return null;
  }
}

/**
 * Procesa y guarda un mensaje en IndexedDB
 */
async function saveMessageToCache(message: any, chatId: string): Promise<void> {
  // Guardar mensaje
  await saveMessage({
    ...message,
    chatId,
    id: message.id?._serialized || message.id || `${chatId}_${Date.now()}`
  });

  // El visor PDF obtiene el original con la sesión actual al abrirlo.
  const pdf = isPdfFile(message.media?.mimetype ?? message.mimetype, message.media?.filename ?? message.filename);
  if (message.hasMedia && message.id && !pdf) {
    const mediaId = message.id?._serialized || message.id;
    const blob = await downloadMessageMedia(mediaId);
    
    if (blob) {
      await saveMedia(mediaId, blob);
    }
  }
}

/**
 * Precarga los mensajes y multimedia de un chat específico
 */
export async function preloadChatData(
  chatId: string,
  options: {
    limit?: number;
    includeMedia?: boolean;
    onProgress?: (current: number, total: number) => void;
  } = {}
): Promise<void> {
  const { limit = 50, onProgress } = options;

  try {
    console.log(`📥 Precargando datos del chat: ${chatId}`);

    // 1. Obtener mensajes
    const messages = await fetchMessagesForChat(chatId, limit);
    
    if (messages.length === 0) {
      console.log(`ℹ️ No hay mensajes para ${chatId}`);
      return;
    }

    console.log(`📨 ${messages.length} mensajes encontrados para ${chatId}`);

    // 2. Guardar cada mensaje (y su media si existe)
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      await saveMessageToCache(message, chatId);
      onProgress?.(i + 1, messages.length);
    }

    console.log(`✅ Chat ${chatId} precargado: ${messages.length} mensajes`);
  } catch (error: any) {
    console.error(`❌ Error precargando chat ${chatId}:`, error.message);
    throw error;
  }
}

/**
 * Precarga los mensajes y multimedia de múltiples chats en paralelo
 */
export async function preloadMultipleChats(
  chatIds: string[],
  options: {
    limit?: number;
    includeMedia?: boolean;
    concurrency?: number;
    onProgress?: (loaded: number, total: number, currentChat?: string) => void;
  } = {}
): Promise<Map<string, number>> {
  const { limit = 50, concurrency = 3, onProgress } = options;
  
  const results = new Map<string, number>(); // chatId -> cantidad de mensajes
  let completed = 0;
  const total = chatIds.length;

  console.log(`📥 Iniciando precarga de ${total} chats (${concurrency} simultáneos)...`);

  // Procesar en lotes
  for (let i = 0; i < chatIds.length; i += concurrency) {
    const batch = chatIds.slice(i, i + concurrency);
    
    const batchPromises = batch.map(async (chatId) => {
      try {
        const messages = await fetchMessagesForChat(chatId, limit);
        
        if (messages.length > 0) {
          // Guardar mensajes
          for (const message of messages) {
            await saveMessageToCache(message, chatId);
          }
          results.set(chatId, messages.length);
        } else {
          results.set(chatId, 0);
        }
        
        completed++;
        onProgress?.(completed, total, chatId);
      } catch (error) {
        console.warn(`⚠️ Error precargando chat ${chatId}:`, error);
        results.set(chatId, 0);
        completed++;
        onProgress?.(completed, total, chatId);
      }
    });

    await Promise.all(batchPromises);
  }

  return results;
}

/**
 * Precarga SOLO los chats más recientes (últimos N días)
 */
export async function preloadRecentChats(
  chatIds: string[],
  daysBack: number = 7,
  options: {
    limit?: number;
    includeMedia?: boolean;
    concurrency?: number;
    onProgress?: (loaded: number, total: number) => void;
  } = {}
): Promise<Map<string, number>> {
  const { limit = 50, includeMedia = true, concurrency = 3, onProgress } = options;

  console.log(`📥 Precargando chats de los últimos ${daysBack} días...`);
  
  // Por ahora procesamos todos, en una mejora futura se puede filtrar por timestamp
  return await preloadMultipleChats(chatIds, {
    limit,
    includeMedia,
    concurrency,
    onProgress
  });
}

/**
 * Precarga solo los chats con mensajes no leídos
 */
export async function preloadUnreadChats(
  chats: Array<{ id: string; unreadCount: number }>,
  options: {
    limit?: number;
    includeMedia?: boolean;
    concurrency?: number;
    onProgress?: (loaded: number, total: number) => void;
  } = {}
): Promise<Map<string, number>> {
  const unreadChatIds = chats
    .filter(chat => chat.unreadCount > 0)
    .map(chat => chat.id);

  if (unreadChatIds.length === 0) {
    console.log('ℹ️ No hay chats con mensajes no leídos');
    return new Map();
  }

  console.log(`📥 Precargando ${unreadChatIds.length} chats con mensajes no leídos...`);

  return await preloadMultipleChats(unreadChatIds, options);
}

/**
 * Obtiene estadísticas de cache de mensajes
 */
export async function getCacheStats(): Promise<{
  totalMessages: number;
  totalMedia: number;
  chatsWithData: number;
}> {
  // Placeholder para futuras estadísticas
  return {
    totalMessages: 0,
    totalMedia: 0,
    chatsWithData: 0
  };
}

/**
 * Estrategia inteligente de precarga
 * Prioriza chats con mensajes no leídos, luego los más recientes
 */
export async function smartPreload(
  chats: Array<{ id: string; unreadCount: number; lastMessageTimestamp?: number }>,
  options: {
    maxChats?: number;
    limit?: number;
    includeMedia?: boolean;
    concurrency?: number;
    onProgress?: (loaded: number, total: number, phase: string) => void;
  } = {}
): Promise<void> {
  const { maxChats = 50, limit = 50, includeMedia = true, concurrency = 3, onProgress } = options;

  console.log('🧠 Iniciando precarga inteligente...');

  // 1. Separar chats no leídos y leídos
  const unreadChats = chats.filter(c => c.unreadCount > 0);
  const readChats = chats.filter(c => c.unreadCount === 0);

  // 2. Ordenar chats leídos por timestamp (más recientes primero)
  const sortedReadChats = readChats
    .sort((a, b) => (b.lastMessageTimestamp || 0) - (a.lastMessageTimestamp || 0))
    .slice(0, maxChats - unreadChats.length);

  // 3. Combinar: primero no leídos, luego recientes
  const chatsToPreload = [...unreadChats, ...sortedReadChats];

  console.log(`📊 Precarga planificada:
  - ${unreadChats.length} chats no leídos
  - ${sortedReadChats.length} chats recientes
  - ${chatsToPreload.length} total a precargar`);

  // 4. Precargar en orden de prioridad
  let loaded = 0;
  const total = chatsToPreload.length;

  for (let i = 0; i < chatsToPreload.length; i += concurrency) {
    const batch = chatsToPreload.slice(i, i + concurrency);
    
    const batchPromises = batch.map(async (chat) => {
      try {
        await preloadChatData(chat.id, { limit, includeMedia });
        loaded++;
        const phase = chat.unreadCount > 0 ? 'no leídos' : 'recientes';
        onProgress?.(loaded, total, phase);
      } catch (error) {
        console.warn(`⚠️ Error precargando chat ${chat.id}:`, error);
        loaded++;
        onProgress?.(loaded, total, 'error');
      }
    });

    await Promise.all(batchPromises);
  }

  console.log(`✅ Precarga inteligente completada: ${loaded}/${total} chats`);
}
