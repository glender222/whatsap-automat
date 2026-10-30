/**
 * Servicio simplificado sin localStorage - el backend híbrido maneja el cache
 * Las URLs ya son servidas directamente por el backend con su propio cache
 */

/**
 * Funciones de compatibilidad (no hacen nada - solo para mantener API)
 * El backend híbrido ya maneja todo el caching automáticamente
 */

export function cacheMediaUrl(_messageId: string, _data: {
  mediaUrl: string;
  filename: string;
  mimetype: string;
}): void {
  // No-op: El backend híbrido maneja el cache automáticamente
  void _messageId;
  void _data;
}

export function getCachedMediaUrl(_messageId: string): {
  mediaUrl: string;
  filename: string;
  mimetype: string;
} | null {
  // No-op: El backend híbrido maneja el cache automáticamente
  void _messageId;
  return null;
}

export function clearMediaCache(): void {
  // No-op: El backend híbrido maneja el cache automáticamente
}

export function cleanExpiredCache(): void {
  // No-op: El backend híbrido maneja el cache automáticamente
}

export function getCacheStats(): {
  totalEntries: number;
  oldestEntry: number | null;
  newestEntry: number | null;
} {
  // No-op: El backend híbrido maneja el cache automáticamente
  return { totalEntries: 0, oldestEntry: null, newestEntry: null };
}
