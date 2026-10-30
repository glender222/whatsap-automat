// src/factures/mensajeria/services/tagsService.ts
import { api } from '../../../shared/axios/http';
import type { Tag, TagCreate, TagUpdate } from '../types/tagTypes';

export const ALL_CHATS_TAG_ID = '__all__';

const allChatsTag: Tag = {
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

/**
 * Obtiene los chats asociados a una etiqueta específica
 * @param tagId ID de la etiqueta
 * @returns Objeto con data (array de chats) y tag (información de la etiqueta)
 */
export async function getChatsByTag(tagId: string): Promise<{
  data: any[];
  tag: { id: string; name: string; is_default: boolean };
}> {
  if (tagId === ALL_CHATS_TAG_ID) {
    const resp = await api.get('/whatsapp/chats');
    return {
      data: resp.data?.data || [],
      tag: { id: ALL_CHATS_TAG_ID, name: 'Todo', is_default: true },
    };
  }

  try {
    const resp = await api.get(`/tags/${encodeURIComponent(tagId)}/chats/full`);
    const body = resp.data;
    
    if (body?.success && body?.data && body?.tag) {
      return {
        data: body.data,
        tag: body.tag
      };
    }
    
    // Fallback si la estructura es diferente
    return {
      data: body?.data || [],
      tag: body?.tag || { id: tagId, name: '', is_default: false }
    };
  } catch (err: any) {
    if (err?.response?.status === 404) {
      const resp = await api.get('/whatsapp/chats');
      return {
        data: resp.data?.data || [],
        tag: { id: ALL_CHATS_TAG_ID, name: 'Todo', is_default: true },
      };
    }
    // Importante: re-lanzar el error original (AxiosError) para conservar response.status y permitir lógica de auto-init
    console.error('tagsService.getChatsByTag error (preservando AxiosError)', err);
    throw err;
  }
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
