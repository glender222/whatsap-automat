// src/factures/mensajeria/services/tagsService.ts
import { api } from '../../../shared/axios/http';
import type { Tag, TagCreate, TagUpdate } from '../types/tagTypes';
import type { WhatsAppChat } from '../../../shared/types/wsp';

export const ALL_CHATS_TAG_ID = '__all__';

export const allChatsTag: Tag = {
  id: ALL_CHATS_TAG_ID,
  name: 'Todo',
  color: 'text-green-500',
  is_default: true,
};

/**
 * Servicio frontend para tags/etiquetas.
 * Usa los endpoints del backend expuestos en /api/tags
 */
export async function getTags(): Promise<Tag[]> {
  try {
    const resp = await api.get('/tags');
    const body = resp.data;
    if (body?.data && Array.isArray(body.data)) return body.data;
    if (Array.isArray(body)) return body;
    if (body?.tags && Array.isArray(body.tags)) return body.tags;
    return [];
  } catch (err: any) {
    if (err?.response?.status === 404) {
      return [allChatsTag];
    }
    console.error('tagsService.getTags error', err);
    throw new Error(err?.response?.data?.message || err?.message || 'No se pudieron obtener las etiquetas');
  }
}

export async function createTag(payload: TagCreate) {
  try {
    const resp = await api.post('/tags', payload);
    return resp.data;
  } catch (err: any) {
    console.error('tagsService.createTag error', err);
    throw new Error(err?.response?.data?.message || err?.message || 'No se pudo crear la etiqueta');
  }
}

export async function updateTag(id: string, payload: TagUpdate) {
  try {
    const resp = await api.put(`/tags/${encodeURIComponent(id)}`, payload);
    return resp.data;
  } catch (err: any) {
    console.error('tagsService.updateTag error', err);
    throw new Error(err?.response?.data?.message || err?.message || 'No se pudo actualizar la etiqueta');
  }
}

export async function deleteTag(id: string) {
  try {
    const resp = await api.delete(`/tags/${encodeURIComponent(id)}`);
    return resp.data;
  } catch (err: any) {
    console.error('tagsService.deleteTag error', err);
    throw new Error(err?.response?.data?.message || err?.message || 'No se pudo eliminar la etiqueta');
  }
}

export async function getChatsByTag(tagId: string, signal?: AbortSignal) {
  const path = tagId === ALL_CHATS_TAG_ID
    ? '/chats'
    : `/tags/${encodeURIComponent(tagId)}/chats/full`;
  const response = await api.get<{ data?: WhatsAppChat[]; tag?: Tag }>(path, { signal });
  if (!Array.isArray(response.data?.data)) throw new Error('El listado de conversaciones no es válido.');
  return {
    data: response.data.data,
    tag: response.data?.tag ?? { id: tagId, name: tagId === ALL_CHATS_TAG_ID ? 'Todo' : '', is_default: tagId === ALL_CHATS_TAG_ID },
  };
}

/**
 * Asigna un chat a una etiqueta específica
 * @param tagId ID de la etiqueta
 * @param chatId ID del chat a asignar
 */
export async function assignChatToTag(tagId: string, chatId: string): Promise<void> {
  if (tagId === ALL_CHATS_TAG_ID) return;
  try {
    await api.post(`/tags/${encodeURIComponent(tagId)}/chats`, { chatId });
  } catch (err: any) {
    console.error('tagsService.assignChatToTag error', err);
    throw new Error(err?.response?.data?.message || err?.message || 'No se pudo asignar el chat a la etiqueta');
  }
}

/**
 * Obtiene las estadísticas/etiquetas asignadas a un usuario/empleado
 * Endpoint: /tags/{id}/stats
 * @param id ID del usuario/empleado
 * @returns array de etiquetas o estructura con data/tags
 */
export async function getTagsStatsByUser(id: string): Promise<any[]> {
  try {
    const resp = await api.get(`/tags/${encodeURIComponent(id)}/stats`);
    const body = resp.data;

    // Intentar normalizar distintos formatos de respuesta
    if (body == null) return [];
    if (Array.isArray(body)) return body;
    if (Array.isArray(body.data)) return body.data;
    if (Array.isArray(body.tags)) return body.tags;

    // Si viene en algún campo inesperado, intentar extraer objetos
    return [];
  } catch (err: any) {
    console.error('tagsService.getTagsStatsByUser error', err);
    throw new Error(err?.response?.data?.message || err?.message || 'No se pudieron obtener las estadísticas de tags para el usuario');
  }
}

export default {
  getTags,
  createTag,
  updateTag,
  deleteTag,
  getChatsByTag,
  assignChatToTag,
};
