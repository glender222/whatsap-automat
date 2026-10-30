/**
 * Service para gestión de sesiones de atención en chats
 * Utiliza el cliente axios centralizado de http.ts
 */

import { api } from '../../../shared/axios/http';
import type { SessionStatusResponse, CompleteSessionResponse } from '../types/sessionTypes';

const SESSION_STATUS_TTL_MS = 10_000;

const sessionStatusCache = new Map<
  string,
  { expiresAt: number; value?: SessionStatusResponse; pending?: Promise<SessionStatusResponse> }
>();

/**
 * Obtiene el estado actual de la sesión de atención de un chat
 * @param chatId ID del chat (ej: "51912345678@c.us")
 * @returns SessionStatusResponse con el estado actual
 */
export const getSessionStatus = async (chatId: string, forceRefresh = false): Promise<SessionStatusResponse> => {
  const now = Date.now();
  const cached = sessionStatusCache.get(chatId);

  if (!forceRefresh && cached) {
    if (cached.value && cached.expiresAt > now) {
      return cached.value;
    }

    if (cached.pending) {
      return cached.pending;
    }
  }

  const pending = api
    .get<SessionStatusResponse>(`/chats/${encodeURIComponent(chatId)}/session/status`)
    .then((response) => {
      const value = response.data;
      sessionStatusCache.set(chatId, {
        value,
        expiresAt: Date.now() + SESSION_STATUS_TTL_MS,
      });
      return value;
    })
    .catch((error) => {
      sessionStatusCache.delete(chatId);
      throw error;
    });

  sessionStatusCache.set(chatId, { pending, expiresAt: now + SESSION_STATUS_TTL_MS });
  return pending;
};

/**
 * Completa/finaliza la sesión de atención de un chat
 * @param chatId ID del chat (ej: "51912345678@c.us")
 * @returns CompleteSessionResponse confirmando la finalización
 */
export const completeSession = async (chatId: string): Promise<CompleteSessionResponse> => {
  const response = await api.post<CompleteSessionResponse>(
    `/chats/${encodeURIComponent(chatId)}/sessions/complete`
  );
  sessionStatusCache.delete(chatId);
  return response.data;
};
