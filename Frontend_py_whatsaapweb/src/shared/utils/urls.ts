import { api } from '../axios/http';

/**
 * Obtiene la URL base del backend sin el sufijo /api
 * @returns URL base del backend (ej: http://localhost:3000)
 */
export function getBackendUrl(): string {
  return api.defaults.baseURL?.replace('/api', '') || 'http://localhost:3000';
}

/**
 * Construye una URL completa para un endpoint específico
 * @param path - Ruta del endpoint (ej: '/profile-photo/123')
 * @returns URL completa (ej: http://localhost:3000/api/profile-photo/123)
 */
export function getApiUrl(path: string): string {
  return `${api.defaults.baseURL}${path}`;
}

/**
 * Construye una URL para recursos que no van bajo /api
 * @param path - Ruta del recurso (ej: '/profile-photo/123')
 * @returns URL completa (ej: http://localhost:3000/profile-photo/123)
 */
export function getResourceUrl(path: string): string {
  return `${getBackendUrl()}${path}`;
}

/**
 * Construye una URL para media (que va bajo /api)
 * @param mediaUrl - URL del media que viene del backend (ej: '/media/123.jpg')
 * @returns URL completa (ej: http://localhost:3000/api/media/123.jpg)
 */
export function getMediaUrl(mediaUrl: string): string {
  // Si ya es una URL completa, la devolvemos tal cual
  if (mediaUrl.startsWith('http')) return mediaUrl;
  // Si empieza con /api, usamos la base URL directamente
  if (mediaUrl.startsWith('/api')) return `${getBackendUrl()}${mediaUrl}`;
  // Si empieza con /, lo tratamos como una ruta relativa al /api
  if (mediaUrl.startsWith('/')) return getApiUrl(mediaUrl);
  // Si no empieza con /, le agregamos el prefijo
  return getApiUrl(`/${mediaUrl}`);
}