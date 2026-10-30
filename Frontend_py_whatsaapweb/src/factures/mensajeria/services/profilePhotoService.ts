/**
 * Servicio para gestionar fotos de perfil de contactos/grupos
 * - Cola de descargas para evitar solicitudes duplicadas
 * - Cache en IndexedDB
 * - Timeouts ajustados para descarga desde WhatsApp
 * - Manejo silencioso de errores 404/403
 */

import { getProfilePhotoAPI } from './mediaService';
import type { ProfilePhotoResult } from './mediaService';
import { saveProfilePhoto, getProfilePhoto, getAllProfilePhotos } from '../../../lib/db';

// Cola de descargas para evitar solicitudes duplicadas
const downloadQueue = new Map<string, Promise<string | null>>();

// Cache de timeouts para evitar reintentos inmediatos
const timeoutCache = new Map<string, number>();

// Estadísticas de descarga para diagnóstico
const downloadStats = {
  total: 0,
  success: 0,
  cached: 0,
  errors: {
    timeout: 0,
    notFound: 0,
    forbidden: 0,
    sessionInactive: 0,
    network: 0
  }
};

/**
 * Obtiene estadísticas de descarga para diagnóstico
 */
export function getDownloadStats() {
  return { ...downloadStats };
}

/**
 * Resetea estadísticas
 */
export function resetDownloadStats() {
  downloadStats.total = 0;
  downloadStats.success = 0;
  downloadStats.cached = 0;
  Object.keys(downloadStats.errors).forEach(key => {
    (downloadStats.errors as any)[key] = 0;
  });
}

/**
 * Obtiene la foto de perfil de un chat (desde cache o API)
 * @param chatId ID del chat
 * @returns URL de la foto o null si no existe
 */
export async function fetchProfilePhoto(chatId: string): Promise<string | null> {
  downloadStats.total++;
  
  // Guardar chats inválidos / placeholders para evitar timeouts innecesarios
  if (!chatId || chatId === '0@c.us' || chatId.startsWith('0@')) {
    return null;
  }

  // Si ya hay una descarga en progreso para este chatId, esperar esa descarga
  const existingDownload = downloadQueue.get(chatId);
  if (existingDownload) {
    return existingDownload;
  }

  // Cache negativo - TIEMPOS MUY CORTOS para máxima velocidad
  const NEGATIVE_TTL = 1000 * 10; // 10 segundos (muy corto)
  const SESSION_INACTIVE_TTL = 1000 * 15; // 15 segundos
  const TIMEOUT_RETRY_TTL = 1000 * 5; // 5 segundos (muy agresivo)

  const caches = (fetchProfilePhoto as any)._caches ||= {
    negative: new Map<string, number>(),
    sessionInactiveUntil: 0,
    loggedSessionInactiveOnce: false,
  };

  // Si la sesión está marcada como inactiva, skip
  if (Date.now() < caches.sessionInactiveUntil) {
    return null;
  }

  // Cache negativo
  const negativeExpiry = caches.negative.get(chatId);
  if (negativeExpiry && negativeExpiry > Date.now()) {
    return null;
  }

  // Cache de timeout - evitar reintentar muy rápido
  const timeoutExpiry = timeoutCache.get(chatId);
  if (timeoutExpiry && timeoutExpiry > Date.now()) {
    return null;
  }

  // Crear promesa para esta descarga y agregarla a la cola
  const downloadPromise = (async (): Promise<string | null> => {
    try {
      // 1. Intentar obtener desde cache (IndexedDB)
      const cachedUrl = await getProfilePhoto(chatId);
      if (cachedUrl) {
        downloadStats.cached++;
        return cachedUrl;
      }

      // 2. Si no está en cache, consultar API (sin timeout adicional, axios ya tiene 45s)
      const result: ProfilePhotoResult = await getProfilePhotoAPI(chatId);

      if (result?.url) {
        // Guardar en cache
        await saveProfilePhoto(chatId, result.url);
        // Limpiar caches negativos
        caches.negative.delete(chatId);
        timeoutCache.delete(chatId);
        downloadStats.success++;
        // Log reducido - solo cada 10 fotos
        if (downloadStats.success % 10 === 0) {
          console.log(`📸 ${downloadStats.success} fotos cargadas...`);
        }
        return result.url;
      }

      // Manejar códigos de estado específicos
      const status = result?.status;

      if (status === 503) {
        // Sesión inactiva - pausar temporalmente
        caches.sessionInactiveUntil = Date.now() + SESSION_INACTIVE_TTL;
        downloadStats.errors.sessionInactive++;
        if (!caches.loggedSessionInactiveOnce) {
          caches.loggedSessionInactiveOnce = true;
          console.warn('📸 ⚠️ WhatsApp session inactive, pausando 30s');
        }
        return null;
      }

      // 404/403 con cache negativo diferenciado
      if (status === 404) {
        caches.negative.set(chatId, Date.now() + NEGATIVE_TTL);
        downloadStats.errors.notFound++;
        // Sin log - esperado para chats sin foto
      } else if (status === 403) {
        // Cache más corto para 403 (puede cambiar permisos)
        caches.negative.set(chatId, Date.now() + (NEGATIVE_TTL / 2));
        downloadStats.errors.forbidden++;
        // Sin log - esperado para grupos privados
      }
      
      return null;
    } catch (error: any) {
      if (error.message === 'Timeout') {
        // Cache de timeout más corto
        timeoutCache.set(chatId, Date.now() + TIMEOUT_RETRY_TTL);
        downloadStats.errors.timeout++;
        // Sin log - esperado en cargas masivas
      } else {
        downloadStats.errors.network++;
        // Solo log en errores graves (no timeouts normales)
        if (downloadStats.errors.network % 10 === 0) {
          console.warn(`📸 ${downloadStats.errors.network} errores de red acumulados`);
        }
        // Cache negativo MUY CORTO para errores de red (podrían ser temporales)
        caches.negative.set(chatId, Date.now() + (NEGATIVE_TTL / 4)); // 2.5 segundos
      }
      return null;
    } finally {
      // Remover de la cola al finalizar
      downloadQueue.delete(chatId);
    }
  })();

  // Agregar a la cola
  downloadQueue.set(chatId, downloadPromise);
  
  return downloadPromise;
}

/**
 * Limpia todos los caches y cola de descargas
 * Útil cuando se reciben actualizaciones que pueden haber añadido nuevas fotos.
 */
export function clearNegativeProfilePhotoCache() {
  const caches = (fetchProfilePhoto as any)._caches;
  if (caches && caches.negative instanceof Map) {
    const clearedCount = caches.negative.size;
    caches.negative.clear();
    // también resetear el flag de sesión inactiva para reintentar
    caches.sessionInactiveUntil = 0;
    caches.loggedSessionInactiveOnce = false;
    console.log(`🧹 Limpiadas ${clearedCount} entradas del cache negativo`);
  }
  
  // Limpiar cache de timeouts
  const timeoutCount = timeoutCache.size;
  timeoutCache.clear();
  
  // Limpiar cola de descargas (las promesas pendientes continuarán)
  const queueCount = downloadQueue.size;
  downloadQueue.clear();
  
  console.log(`🧹 Caches limpiados: ${timeoutCount} timeouts, ${queueCount} en cola`);
}

/**
 * Carga las fotos de perfil de múltiples chats con cola controlada
 * OPTIMIZADO: Sin delays, sin retries, máxima concurrencia
 * @param chatIds Array de IDs de chats
 * @param onProgress Callback opcional para reportar progreso
 * @returns Mapa de chatId -> URL (solo para chats que tienen foto)
 */
export async function fetchMultipleProfilePhotos(
  chatIds: string[],
  onProgress?: (loaded: number, total: number) => void
): Promise<Map<string, string>> {
  const results = new Map<string, string>();
  const CONCURRENT_REQUESTS = 15; // Aumentado de 8 a 15 para máxima velocidad
  
  let completed = 0;
  const total = chatIds.length;

  console.log(`📸 Cargando ${total} fotos de perfil (max concurrencia)...`);

  // Procesar en lotes SIN PAUSA (máxima velocidad)
  for (let i = 0; i < chatIds.length; i += CONCURRENT_REQUESTS) {
    const batch = chatIds.slice(i, i + CONCURRENT_REQUESTS);
    
    const batchPromises = batch.map(async (chatId) => {
      const url = await fetchProfilePhoto(chatId);
      if (url) {
        results.set(chatId, url);
      }
      completed++;
      onProgress?.(completed, total);
      return { chatId, url };
    });

    await Promise.all(batchPromises);
    // SIN DELAY entre lotes - máxima velocidad
  }

  const successRate = ((results.size / total) * 100).toFixed(1);
  console.log(`📸 ✅ ${results.size}/${total} fotos cargadas (${successRate}%)`);
  return results;
}

/**
 * Precarga todas las fotos de perfil de los chats al iniciar sesión
 * @param chatIds Array de IDs de chats
 * @returns Mapa de chatId -> URL
 */
export async function preloadAllProfilePhotos(chatIds: string[]): Promise<Map<string, string>> {
  console.log(`📸 Iniciando precarga de ${chatIds.length} fotos de perfil...`);
  
  const startTime = Date.now();
  
  const results = await fetchMultipleProfilePhotos(chatIds, (loaded, total) => {
    if (loaded % 25 === 0 || loaded === total) {
      console.log(`📸 Progreso: ${loaded}/${total} fotos de perfil cargadas`);
    }
  });

  const duration = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`✅ Precarga completada: ${results.size}/${chatIds.length} fotos encontradas en ${duration}s`);
  
  return results;
}

/**
 * Obtiene fotos de perfil desde el cache (sin hacer peticiones al servidor)
 * @returns Mapa de chatId -> URL
 */
export async function getCachedProfilePhotos(): Promise<Map<string, string>> {
  return await getAllProfilePhotos();
}

/**
 * Fuerza la recarga de una foto de perfil específica (ignora cache)
 * @param chatId ID del chat
 * @returns URL de la foto o null si no existe
 */
export async function reloadProfilePhoto(chatId: string): Promise<string | null> {
  try {
    const result = await getProfilePhotoAPI(chatId);
    
    if (result && result.url) {
      await saveProfilePhoto(chatId, result.url);
      return result.url;
    }
    
    return null;
  } catch (error: any) {
    if (error.response?.status === 404) {
      return null;
    }
    
    console.warn(`Error recargando foto de perfil para ${chatId}:`, error.message);
    return null;
  }
}
