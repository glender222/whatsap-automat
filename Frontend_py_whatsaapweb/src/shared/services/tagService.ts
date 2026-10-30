/**
 * Servicio para gestionar Tags (Etiquetas)
 * Endpoints: /api/tags/*
 */

import { api } from '../axios/http';

export interface Tag {
  id: number;
  name: string;
  color: string | null;
  owner_id?: number;
  created_at?: string;
  updated_at?: string;
}

export interface CreateTagPayload {
  name: string;
  color?: string;
}

export interface UpdateTagPayload {
  name?: string;
  color?: string;
}

const TAGS_BASE_URL = '/tags';

export const tagService = {
  /**
   * GET /api/tags
   * Obtener todas las etiquetas del usuario
   */
  async getAll(): Promise<Tag[]> {
    const response = await api.get<Tag[] | { success: boolean; data: Tag[] }>(TAGS_BASE_URL);
    console.log('🏷️ [tagService.getAll] Response:', response);
    console.log('🏷️ [tagService.getAll] Response.data:', response.data);
    return Array.isArray(response.data) ? response.data : response.data.data || [];
  },

  /**
   * GET /api/tags/:id
   * Obtener una etiqueta por ID
   */
  async getById(tagId: number): Promise<Tag> {
    const response = await api.get<Tag | { success: boolean; data: Tag }>(`${TAGS_BASE_URL}/${tagId}`);
    return 'data' in response.data ? response.data.data : response.data;
  },

  /**
   * POST /api/tags
   * Crear una nueva etiqueta
   */
  async create(data: CreateTagPayload): Promise<Tag> {
    const response = await api.post<Tag | { success: boolean; data: Tag }>(TAGS_BASE_URL, data);
    return 'data' in response.data ? response.data.data : response.data;
  },

  /**
   * PUT /api/tags/:id
   * Actualizar una etiqueta
   */
  async update(tagId: number, data: UpdateTagPayload): Promise<Tag> {
    const response = await api.put<Tag | { success: boolean; data: Tag }>(`${TAGS_BASE_URL}/${tagId}`, data);
    return 'data' in response.data ? response.data.data : response.data;
  },

  /**
   * DELETE /api/tags/:id
   * Eliminar una etiqueta
   */
  async delete(tagId: number): Promise<{ success: boolean; message: string }> {
    const response = await api.delete<{ success: boolean; message: string }>(
      `${TAGS_BASE_URL}/${tagId}`
    );
    return response.data;
  },

  /**
   * POST /api/tags/:id/users
   * Asignar empleado a una etiqueta
   */
  async assignUser(tagId: number, employeeId: number): Promise<{ success: boolean; message: string }> {
    const response = await api.post<{ success: boolean; message: string }>(
      `${TAGS_BASE_URL}/${tagId}/users`,
      { employee_id: employeeId }
    );
    return response.data;
  },

  /**
   * GET /api/tags/:id/users
   * Obtener empleados asignados a una etiqueta
   */
  async getUsers(tagId: number): Promise<Array<{
    id: number;
    nombre: string;
    email: string;
  }>> {
    const response = await api.get(`${TAGS_BASE_URL}/${tagId}/users`);
    return response.data?.data || response.data || [];
  },

  /**
   * DELETE /api/tags/:id/users/:employeeId
   * Quitar empleado de una etiqueta
   */
  async removeUser(tagId: number, employeeId: number): Promise<{ success: boolean; message: string }> {
    const response = await api.delete<{ success: boolean; message: string }>(
      `${TAGS_BASE_URL}/${tagId}/users/${employeeId}`
    );
    return response.data;
  },

  /**
   * POST /api/tags/:id/chats
   * Asignar chat a una etiqueta
   */
  async assignChat(tagId: number, chatId: string): Promise<{ success: boolean; message: string }> {
    const response = await api.post<{ success: boolean; message: string }>(
      `${TAGS_BASE_URL}/${tagId}/chats`,
      { chat_id: chatId }
    );
    return response.data;
  },

  /**
   * GET /api/tags/:id/chats
   * Obtener chats de una etiqueta
   */
  async getChats(tagId: number): Promise<string[]> {
    const response = await api.get<string[]>(`${TAGS_BASE_URL}/${tagId}/chats`);
    return (response.data as any)?.data || response.data || [];
  },

  /**
   * DELETE /api/tags/:id/chats/:chatId
   * Remover chat de una etiqueta
   */
  async removeChat(tagId: number, chatId: string): Promise<{ success: boolean; message: string }> {
    const response = await api.delete<{ success: boolean; message: string }>(
      `${TAGS_BASE_URL}/${tagId}/chats/${chatId}`
    );
    return response.data;
  },

  /**
   * GET /api/tags/:id/chats/full
   * Obtener chats completos de una etiqueta (con datos de WhatsApp)
   */
  async getChatsWithDetails(tagId: number): Promise<any[]> {
    const response = await api.get(`${TAGS_BASE_URL}/${tagId}/chats/full`);
    return response.data?.data || response.data || [];
  },

  /**
   * GET /api/tags/:id/stats
   * Obtener estadísticas de una etiqueta
   */
  async getStats(tagId: number): Promise<{
    chat_count: number;
    employee_count: number;
  }> {
    const response = await api.get(`${TAGS_BASE_URL}/${tagId}/stats`);
    return response.data?.data || response.data;
  }
};

export default tagService;
