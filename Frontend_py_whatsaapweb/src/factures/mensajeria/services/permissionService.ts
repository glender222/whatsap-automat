// src/factures/mensajeria/services/permissionService.ts

import { api } from '../../../shared/axios/http';
import type { 
  PermissionWithChat, 
  PermissionWithEmployee,
  AssignPermissionRequest,
  RevokePermissionRequest,
  PermissionResponse 
} from '../types/permissionTypes';

/**
 * Servicio para gestionar permisos de acceso a chats
 * ✅ Token inyectado automáticamente en todas las solicitudes
 */
export const PermissionService = {
  /**
   * 🔴 GET /permissions/available-chats
   * Obtiene la lista de TODOS los chats disponibles para asignar permisos
   * ✅ Solo ADMIN puede ver esta lista
   */
  async getAllChatsForPermissions() {
    try {
      console.log('📥 Solicitando GET /permissions/available-chats');
      const response = await api.get<{ success: boolean; chats: any[] }>('/permissions/available-chats');
      console.log('✅ Chats obtenidos:', response.data.chats?.length || 0);
      return response.data.chats || [];
    } catch (error: any) {
      console.error('❌ Error en /permissions/available-chats:', error.response?.status, error.message);
      throw new Error(error?.response?.data?.message || 'Error al obtener lista de chats');
    }
  },

  /**
   * 🔴 POST /permissions/assign
   * Asigna un permiso de acceso a un chat para un empleado
   */
  async assignPermission(request: AssignPermissionRequest): Promise<PermissionResponse> {
    try {
      console.log('📤 POST /permissions/assign', request);
      const response = await api.post<PermissionResponse>('/permissions/assign', request);
      console.log('✅ Permiso asignado');
      return response.data;
    } catch (error: any) {
      console.error('❌ Error asignando permiso:', error.message);
      throw new Error(error?.response?.data?.message || 'Error al asignar permiso');
    }
  },

  /**
   * 🔴 POST /permissions/revoke
   * Revoca el permiso de acceso a un chat para un empleado
   */
  async revokePermission(request: RevokePermissionRequest): Promise<PermissionResponse> {
    try {
      console.log('📤 POST /permissions/revoke', request);
      const response = await api.post<PermissionResponse>('/permissions/revoke', request);
      console.log('✅ Permiso revocado');
      return response.data;
    } catch (error: any) {
      console.error('❌ Error revocando permiso:', error.message);
      throw new Error(error?.response?.data?.message || 'Error al revocar permiso');
    }
  },

  /**
   * 🔴 GET /permissions/employee/{employeeId}
   * Obtiene todos los permisos de un empleado específico
   */
  async getEmployeePermissions(employeeId: string): Promise<PermissionWithChat[]> {
    try {
      console.log('📥 Solicitando GET /permissions/employee/' + employeeId);
      const response = await api.get<{ success: boolean; permissions: PermissionWithChat[] }>(
        `/permissions/employee/${employeeId}`
      );
      console.log('✅ Permisos del empleado obtenidos:', response.data.permissions?.length || 0);
      return response.data.permissions || [];
    } catch (error: any) {
      console.error('❌ Error en /permissions/employee:', error.response?.status, error.message);
      throw new Error(error?.response?.data?.message || 'Error al obtener permisos del empleado');
    }
  },

  /**
   * 🔴 GET /permissions/chat/{chatId}
   * Obtiene todos los empleados que tienen acceso a un chat específico
   */
  async getChatPermissions(chatId: string): Promise<PermissionWithEmployee[]> {
    try {
      console.log('📥 Solicitando GET /permissions/chat/' + chatId);
      const response = await api.get<{ success: boolean; permissions: PermissionWithEmployee[] }>(
        `/permissions/chat/${chatId}`
      );
      console.log('✅ Permisos del chat obtenidos:', response.data.permissions?.length || 0);
      return response.data.permissions || [];
    } catch (error: any) {
      console.error('❌ Error en /permissions/chat:', error.response?.status, error.message);
      throw new Error(error?.response?.data?.message || 'Error al obtener permisos del chat');
    }
  },

  /**
   * Verifica si un empleado tiene permiso para acceder a un chat
   */
  async hasPermission(employeeId: string, chatId: string): Promise<boolean> {
    try {
      const permissions = await this.getEmployeePermissions(employeeId);
      return permissions.some(p => p.chat_id === chatId);
    } catch (error) {
      console.error('Error verificando permiso:', error);
      return false;
    }
  },

  /**
   * Asigna múltiples permisos a un empleado de una sola vez
   */
  async assignMultiplePermissions(employeeId: string, chatIds: string[]): Promise<void> {
    try {
      console.log('📤 Asignando múltiples permisos:', chatIds.length);
      const promises = chatIds.map(chatId => 
        this.assignPermission({ employeeId, chatId })
      );
      await Promise.all(promises);
      console.log('✅ Todos los permisos asignados');
    } catch (error: any) {
      console.error('❌ Error asignando múltiples permisos:', error.message);
      throw new Error('Error al asignar múltiples permisos');
    }
  },

  /**
   * Revoca múltiples permisos de un empleado de una sola vez
   */
  async revokeMultiplePermissions(employeeId: string, chatIds: string[]): Promise<void> {
    try {
      console.log('📤 Revocando múltiples permisos:', chatIds.length);
      const promises = chatIds.map(chatId => 
        this.revokePermission({ employeeId, chatId })
      );
      await Promise.all(promises);
      console.log('✅ Todos los permisos revocados');
    } catch (error: any) {
      console.error('❌ Error revocando múltiples permisos:', error.message);
      throw new Error('Error al revocar múltiples permisos');
    }
  }
};
