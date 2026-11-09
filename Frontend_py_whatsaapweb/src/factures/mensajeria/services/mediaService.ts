/**
 * Copia una imagen al portapapeles desde una URL.
 */
export async function copyImageToClipboard(imageUrl: string) {
  try {
    const blob = await getAuthenticatedMediaBlob(imageUrl);
    await navigator.clipboard.write([
      new ClipboardItem({
        [blob.type]: blob
      })
    ]);
    alert('Imagen copiada al portapapeles');
  } catch (error) {
    console.error('Error al copiar imagen:', error);
    alert('No se pudo copiar la imagen');
  }
}
// src/factures/mensajeria/services/mediaService.ts
import { api } from '../../../shared/axios/http';
import { isPdfFile } from '../../../shared/components/pdfMedia';

export function getMediaErrorMessage(error: any): string {
  const data = error?.response?.data || {};
  const code = data.error;

  if (code === 'META_AUTH_ERROR') {
    return data.userMessage || 'El token de Meta no es valido o expiro.';
  }

  if (code === 'META_PERMISSION_ERROR') {
    return data.userMessage || 'La app o el token de Meta no tiene permisos para enviar o descargar media.';
  }

  if (code === 'SERVICE_WINDOW_CLOSED') {
    return data.userMessage || 'La ventana de 24 horas esta cerrada. Envia una plantilla aprobada.';
  }

  if (code === 'META_MEDIA_DOWNLOAD_ERROR') {
    return data.userMessage || 'No se pudo descargar el archivo desde Meta.';
  }

  if (code === 'MEDIA_NOT_FOUND') {
    return data.userMessage || 'No se encontro el archivo asociado al mensaje.';
  }

  if (code === 'META_API_ERROR') {
    return data.userMessage || data.message || 'WhatsApp Business no pudo completar la operacion de media.';
  }

  return data.userMessage || data.message || error?.message || 'No se pudo procesar el archivo';
}

/**
 * Función helper para encoding de chatIds en URLs
 * Algunos backends pueden tener problemas con @ encoded como %40
 * Intentaremos diferentes estrategias de encoding
 */
async function tryProfilePhotoRequest(chatId: string): Promise<any> {
  // Ahora que el backend funciona, usar directamente encodeURIComponent (estándar)
  const encodedChatId = encodeURIComponent(chatId);
  const url = `/media/profile-photo/${encodedChatId}`;
  
  try {
    const response = await api.get(url, {
      timeout: 45000, // 45 segundos - tiempo suficiente para descargas de WhatsApp
      validateStatus: (status: number) => status < 600 // Aceptar todos los status sin error
    });
    return response;
    
  } catch (error: any) {
    const response = error.response;
    const status = response?.status;

    // Si es una respuesta HTTP válida, devolverla (404, 403, etc.)
    if (response && status) {
      return response;
    }

    // Solo logear errores de red reales
    console.error(`📸 ❌ Error de red para ${chatId}:`, error.message);
    throw error;
  }
}

// ===================== NUEVAS APIS =====================

function normalizeMediaEndpoint(mediaUrlOrId: string): string {
  if (!mediaUrlOrId) return '';
  if (mediaUrlOrId.startsWith('blob:') || mediaUrlOrId.startsWith('data:')) {
    return mediaUrlOrId;
  }

  try {
    if (mediaUrlOrId.startsWith('http')) {
      const url = new URL(mediaUrlOrId);
      return url.pathname.startsWith('/api/')
        ? url.pathname.substring(4) + url.search
        : url.pathname + url.search;
    }
  } catch {
    // Si no es URL valida, seguimos con las reglas de rutas relativas.
  }

  if (mediaUrlOrId.startsWith('/api/')) return mediaUrlOrId.substring(4);
  if (mediaUrlOrId.startsWith('/')) return mediaUrlOrId;
  return `/media/${encodeURIComponent(mediaUrlOrId)}`;
}

export async function getAuthenticatedMediaBlob(mediaUrlOrId: string): Promise<Blob> {
  const endpoint = normalizeMediaEndpoint(mediaUrlOrId);
  if (!endpoint) {
    throw new Error('Media URL o messageId requerido');
  }

  if (endpoint.startsWith('blob:') || endpoint.startsWith('data:')) {
    const response = await fetch(endpoint);
    return response.blob();
  }

  try {
    const response = await api.get(endpoint, { responseType: 'blob' });
    return response.data;
  } catch (error: any) {
    const contentType = error?.response?.headers?.['content-type'] || '';
    if (contentType.includes('application/json') && error?.response?.data instanceof Blob) {
      try {
        const text = await error.response.data.text();
        error.response.data = JSON.parse(text);
      } catch {
        // Mantener el error original si no se puede parsear.
      }
    }
    throw new Error(getMediaErrorMessage(error));
  }
}

export async function getAuthenticatedMediaObjectUrl(mediaUrlOrId: string): Promise<string> {
  const blob = await getAuthenticatedMediaBlob(mediaUrlOrId);
  return URL.createObjectURL(blob);
}

/**
 * Obtiene mensajes de un chat con paginación opcional.
 * @param chatId string
 * @param limit number (opcional)
 * @param before number (timestamp, opcional)
 */
export async function getChatMessagesAPI(chatId: string, limit?: number, before?: number) {
  const params = new URLSearchParams();
  if (limit) params.append('limit', String(limit));
  if (before) params.append('before', String(before));
  
  const response = await api.get(`/chats/${encodeURIComponent(chatId)}/messages`, { params });
  return response.data.data;
}

/**
 * Envía mensaje con o sin media y opciones avanzadas.
 * @param chatId string
 * @param message string
 * @param file File | null
 * @param options Opciones avanzadas (forceDocument, ptt, asSticker)
 */
export async function sendMessageAPI(
  chatId: string,
  message: string,
  file: File | null = null,
  options: { forceDocument?: boolean; ptt?: boolean; asSticker?: boolean } = {}
): Promise<any> {
  const formData = new FormData();
  // No agregar chatId al formData, va en la URL
  if (message) formData.append('message', message);
  if (file) formData.append('file', file);
  if (options.forceDocument !== undefined) formData.append('forceDocument', String(options.forceDocument));
  if (options.ptt !== undefined) formData.append('ptt', String(options.ptt));
  if (options.asSticker !== undefined) formData.append('asSticker', String(options.asSticker));

  // Endpoint correcto: POST /api/chats/:chatId/messages con multipart/form-data
  const response = await api.post(`/chats/${encodeURIComponent(chatId)}/messages`, formData, {
    headers: { 'Content-Type': 'multipart/form-data' }
  });
  return response.data;
}

/**
 * Descarga el archivo multimedia de un mensaje
 * Endpoint: GET /api/media/:messageId
 * 
 * Retorna el archivo directamente con headers apropiados:
 * - Content-Type: image/jpeg (o el tipo correspondiente)
 * - Content-Disposition: attachment; filename="archivo.ext"
 * 
 * Los empleados solo pueden descargar archivos de chats asignados (403 si no tienen permiso)
 * 
 * @param messageId string - ID del mensaje que contiene el archivo
 * @returns Promise<Blob> - Archivo como Blob
 * @throws 403 - Acceso denegado (empleado sin permiso)
 * @throws 404 - Mensaje no encontrado
 * 
 * @example
 * ```typescript
 * // Descargar y mostrar imagen
 * const blob = await downloadMediaAPI(messageId);
 * const url = URL.createObjectURL(blob);
 * setImageUrl(url);
 * 
 * // Descargar archivo
 * const blob = await downloadMediaAPI(messageId);
 * const url = URL.createObjectURL(blob);
 * const a = document.createElement('a');
 * a.href = url;
 * a.download = 'archivo';
 * a.click();
 * URL.revokeObjectURL(url);
 * ```
 */
export async function downloadMediaAPI(messageId: string): Promise<Blob> {
  return getAuthenticatedMediaBlob(messageId);
}

/**
 * Obtiene la URL pública del media desde el backend.
 * Esta función llama al endpoint que devuelve la URL del archivo subido.
 * El backend híbrido maneja automáticamente el cache.
 * 
 * Endpoint: GET /api/media/:messageId
 * Retorna: { success: true, data: { mediaUrl, filename, mimetype } }
 * 
 * @param messageId string - ID del mensaje (ej: 'true_51925593795@c.us_AC4C68CB6813DE842307EEFB32CFA890')
 * @returns Promise<{ mediaUrl: string, filename: string, mimetype: string } | null>
 * 
 * @example
 * ```typescript
 * const mediaData = await getMediaInfoAPI('true_51925593795@c.us_AC4C68CB6813DE842307EEFB32CFA890');
 * if (mediaData) {
 *   console.log(mediaData.mediaUrl); // http://localhost:3000/uploads/...jpg
 * }
 * ```
 */
export async function getMediaInfoAPI(messageId: string): Promise<{
  mediaUrl: string;
  filename: string;
  mimetype: string;
} | null> {
  try {
    // Backend híbrido maneja cache automáticamente - consulta directa
    const response = await api.get(`/media/${encodeURIComponent(messageId)}/info`);
    if (response.data?.success && response.data?.data) {
      return response.data.data;
    }
    return null;
  } catch (error: any) {
    // Silenciar errores 404 (media no encontrado)
    if (error.response?.status !== 404) {
      console.error('Error fetching media info:', error);
    }
    return null;
  }
}

/**
 * Obtiene la URL pública del media desde el backend usando la ruta completa.
 * Esta es una versión alternativa que acepta la URL completa del media.
 * El backend híbrido maneja automáticamente el cache.
 * 
 * @param mediaUrl string - URL del endpoint del media (ej: '/api/media/messageId')
 * @returns Promise<{ mediaUrl: string, filename: string, mimetype: string } | null>
 * 
 * @example
 * ```typescript
 * const mediaData = await fetchMediaUrlAPI('/api/media/true_51925593795@c.us_AC4C68CB6813DE842307EEFB32CFA890');
 * if (mediaData) {
 *   console.log(mediaData.mediaUrl); // http://localhost:3000/uploads/...jpg
 * }
 * ```
 */
export async function fetchMediaUrlAPI(mediaUrl: string): Promise<{
  mediaUrl: string;
  filename: string;
  mimetype: string;
} | null> {
  try {
    // Backend híbrido maneja cache automáticamente - consulta directa
    
    // Normalizar la URL: remover /api del inicio si existe porque axios ya lo agrega
    let normalizedUrl = mediaUrl;
    if (mediaUrl.startsWith('/api/')) {
      normalizedUrl = mediaUrl.substring(4); // Quitar '/api'
    }
    
    const infoUrl = normalizedUrl.endsWith('/info') ? normalizedUrl : `${normalizedUrl}/info`;
    const response = await api.get(infoUrl);
    if (response.data?.success && response.data?.data) {
      return response.data.data;
    }
    return null;
  } catch (error: any) {
    // Silenciar errores 404 (media no encontrado)
    if (error.response?.status !== 404) {
      console.error('Error fetching media URL:', error);
    }
    return null;
  }
}

export async function fetchMediaObjectUrlAPI(mediaUrl: string): Promise<string> {
  return getAuthenticatedMediaObjectUrl(mediaUrl);
}

/**
 * Obtiene la miniatura/preview en base64 de un media.
 * @param messageId string
 * @returns Blob (miniatura)
 */
export async function getMediaThumbnailAPI(messageId: string): Promise<Blob> {
  const response = await api.get(`/media/${messageId}/thumbnail`, { responseType: 'blob' });
  return response.data;
}

/**
 * Obtiene la foto de perfil de un chat/contacto/grupo.
 * Endpoint: GET /api/media/profile-photo/:chatId
 * 
 * @param chatId string - ID del chat (ej: "5491122334455@c.us")
 * @returns Promise<{ url: string } | null> - URL de la foto de perfil o null si no existe
 * 
 * NOTA: Los errores 404 se manejan internamente y NO se imprimen en consola
 * 
 * @example
 * ```typescript
 * const photo = await getProfilePhotoAPI("5491122334455@c.us");
 * if (photo) {
 *   setProfilePhoto(photo.url);
 * } else {
 *   setProfilePhoto('/default-avatar.png');
 * }
 * ```
 */
export type ProfilePhotoResult = { url?: string; status?: number };

/**
 * Obtiene la foto de perfil de un chat/contacto/grupo.
 * Endpoint: GET /api/media/profile-photo/:chatId
 *
 * Utiliza timeout extendido para permitir que el backend descargue desde WhatsApp.
 * Los códigos 403/404/503 se manejan de forma silenciosa.
 */

export async function getProfilePhotoAPI(chatId: string): Promise<ProfilePhotoResult> {
  try {
    const response = await tryProfilePhotoRequest(chatId);
    
    // Manejar respuesta según el formato del backend

    if (response.status === 200 && response.data) {
      // 200 OK: { "success": true, "data": { "profilePhotoUrl": "url" } }
      if (response.data.success === true && response.data.data?.profilePhotoUrl) {
        const profilePhotoUrl = response.data.data.profilePhotoUrl;
        return { url: profilePhotoUrl };
      }
      
      // 200 OK pero sin foto: { "success": true, "data": { "profilePhotoUrl": null } }
      if (response.data.success === true && response.data.data && !response.data.data.profilePhotoUrl) {
        return { status: 404 }; // Tratar como sin foto
      }
      
      // Si success es false en 200, tratar como sin foto
      if (response.data.success === false) {
        console.debug(`📸 ⚠️  Backend dice que no hay foto para ${chatId}: ${response.data.error || 'Sin detalles'}`);
        return { status: 404 }; // Tratar como sin foto
      }

      // Si llegamos aquí, el formato de respuesta es inesperado
      console.warn(`📸 ⚠️  Formato de respuesta inesperado para ${chatId}:`, response.data);
      console.warn(`📸 🔍 Contenido de data.data:`, response.data.data);
      console.warn(`📸 🔍 Tipo de profilePhotoUrl:`, typeof response.data.data?.profilePhotoUrl, response.data.data?.profilePhotoUrl);
    }

    // 404: { "success": false, "error": "Foto de perfil no encontrada", "details": "No hay foto de perfil" }
    if (response.status === 404) {
      // Es normal, no hay foto
      return { status: 404 };
    }

    // 403: Sin permisos
    if (response.status === 403) {
      return { status: 403 };
    }

    // 503: Sesión WhatsApp no activa
    if (response.status === 503) {
      console.warn(`📸 ⚠️  WhatsApp desconectado - no se pueden obtener fotos de perfil`);
      if (response.data?.error?.includes('no está activa')) {
        console.info(`📸 💡 Para conectar WhatsApp: http://localhost:3000/api/whatsapp/init`);
      }
      return { status: 503 };
    }

    // 500+: Otros errores del backend
    if (response.status >= 500) {
      return { status: response.status };
    }

    // Respuesta inesperada
    console.warn(`📸 ⚠️  Respuesta inesperada del backend para ${chatId}:`, response.status, response.data);
    return { status: response.status };
    
  } catch (error: any) {
    // Solo loggear errores realmente inesperados (network, timeout, etc)
    const status = error.response?.status;
    if (status && (status === 404 || status === 403 || status >= 500)) {
      return { status };
    }

    console.warn(`📸 Error de red obteniendo foto de perfil para ${chatId}:`, error?.message ?? error);
    return { status: status || 500 };
  }
}



/**
 * Marca el chat como leído.
 * @param chatId string
 */
export async function markChatAsReadAPI(chatId: string) {
  const response = await api.post(`/chats/${encodeURIComponent(chatId)}/read`);
  return response.data;
}

/**
 * ❌ DEPRECATED: Usa tagsService.getChatsByTag(tagId) en su lugar
 * La API antigua GET /chats ha sido reemplazada por el endpoint mejorado de tags.
 * 
 * @deprecated Usar tagsService.getChatsByTag(tagId) en su lugar
 */
export async function getChatsListAPI() {
  console.warn('❌ getChatsListAPI() está deprecado. Usa tagsService.getChatsByTag(tagId) en su lugar.');
  throw new Error('getChatsListAPI() está deprecado. Usa tagsService.getChatsByTag(tagId) en su lugar.');
}

/**
 * Obtiene mensajes y media desde el backend y los guarda en IndexedDB.
 * Extraído de useIndexedMessages para separar la lógica de API.
 */
export async function fetchAndCacheMessages(
  chatId: string,
  saveMessage: any,
  saveMedia: any,
  setMessages: any,
  setLoading: any,
  getMessages: any
) {
  setLoading(true);
  try {
    const response = await api.get(`/chats/${encodeURIComponent(chatId)}/messages`);
    const msgs = response.data?.data || response.data || [];
    for (const msg of msgs) {
      await saveMessage({ ...msg, chatId });
      const pdf = isPdfFile(msg.media?.mimetype ?? msg.mimetype, msg.media?.filename ?? msg.filename);
      if (msg.mediaUrl && !pdf) {
        try {
          const mediaBlob = await getAuthenticatedMediaBlob(msg.mediaUrl || msg.id);
          await saveMedia(msg.id, mediaBlob);
        } catch (e) { /* ignora error media */ }
      }
    }
  } catch (err) {
    console.error(`Error en fetchAndCacheMessages para ${chatId}:`, err);
  } finally {
    setMessages(await getMessages(chatId));
    setLoading(false);
  }
}

/**
 * [DEPRECATED] Sube un archivo y mensaje al backend usando el endpoint antiguo.
 * Usa sendMessageAPI para todos los casos nuevos.
 *
 * NOTA: No diferencia bien entre video/documento. No usar para videos ni media moderna.
 */
export async function uploadFileAPI(
  chatId: string,
  message: string,
  file: File
): Promise<any> {
  // ⚠️ DEPRECATED: Usa sendMessageAPI. No usar para videos ni media moderna.
  const formData = new FormData();
  formData.append('chatId', chatId);
  if (message.trim()) {
    formData.append('message', message);
  }
  formData.append('file', file);

  const response = await api.post('/whatsapp/send-message', formData, {
    headers: { 'Content-Type': 'multipart/form-data' }
  });
  return response.data;
}

// RECOMENDADO: Usa sendMessageAPI para enviar archivos/media.
// Ejemplo:
//   const isVideo = file && file.type.startsWith('video/');
//   const options = isVideo ? {} : { forceDocument: true };
//   await sendMessageAPI(chatId, message, file, options);
