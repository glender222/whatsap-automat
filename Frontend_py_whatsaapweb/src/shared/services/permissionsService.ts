/**
 * Servicio para gestionar permisos de chats
 * 
 * IMPORTANTE: Todas estas APIs requieren rol ADMIN
 * 
 * Documentación: APIs de Permisos
 */

import { api } from "../axios/http";

/**
 * Interfaz para respuesta de asignación de permiso
 */
interface PermissionResponse {
  success: boolean;
  message: string;
  data?: {
    id: number;
    employee_id: number;
    chat_id: string;
    owner_id: number;
    created_at: string;
  };
}

/**
 * Interfaz para respuesta de listado de permisos
 */
interface PermissionListResponse {
  success: boolean;
  data: {
    id: number;
    employee_id: number;
    chat_id: string;
    owner_id: number;
    created_at: string;
    employee_name?: string;
    employee_email?: string;
  }[];
}

export const permissionsService = {
  /**
   * Asigna permiso de acceso a un chat a un empleado
   * Endpoint: POST /api/permissions/assign
   * 
   * RESTRICCIÓN: Solo ADMIN puede hacer esto
   * 
   * Otorga a un empleado acceso a un chat específico.
   * Si ya tiene permiso, retorna error 409 (Conflict).
   * 
   * @param employeeId number - ID del empleado
   * @param chatId string - ID del chat (ej: "5491122334455@c.us")
   * @returns Promise con datos del permiso asignado
   * 
   * @example
   * ```typescript
   * const result = await assignChatPermission(5, "5491122334455@c.us");
   * // result = {
   * //   success: true,
   * //   message: "Permiso asignado correctamente",
   * //   data: {
   * //     id: 1,
   * //     employee_id: 5,
   * //     chat_id: "5491122334455@c.us",
   * //     owner_id: 1,
   * //     created_at: "2024-01-15T10:30:00.000Z"
   * //   }
   * // }
   * ```
   * 
   * @throws 400 - Empleado y chatId son requeridos
   * @throws 401 - No autenticado
   * @throws 403 - Solo ADMIN puede asignar permisos
   * @throws 404 - Empleado no encontrado o no pertenece a este ADMIN
   * @throws 409 - El empleado ya tiene permiso en este chat
   */
  async assignChatPermission(
    employeeId: number,
    chatId: string
  ): Promise<PermissionResponse> {
    try {
      const { data } = await api.post("/permissions/assign", {
        employeeId,
        chatId
      });
      return data;
    } catch (error: any) {
      if (error?.response?.status === 403) {
        throw new Error("Solo administradores pueden asignar permisos");
      }
      if (error?.response?.status === 404) {
        throw new Error(
          "Empleado no encontrado o no pertenece a tu organización"
        );
      }
      if (error?.response?.status === 409) {
        throw new Error("El empleado ya tiene acceso a este chat");
      }
      console.error("Error al asignar permiso:", error);
      throw new Error(
        error?.response?.data?.error ||
          error?.message ||
          "Error al asignar permiso"
      );
    }
  },

  /**
   * Revoca el permiso de acceso a un chat a un empleado
   * Endpoint: POST /api/permissions/revoke
   * 
   * RESTRICCIÓN: Solo ADMIN puede hacer esto
   * 
   * Elimina el acceso de un empleado a un chat específico.
   * 
   * @param employeeId number - ID del empleado
   * @param chatId string - ID del chat
   * @returns Promise con respuesta de éxito
   * 
   * @example
   * ```typescript
   * await revokeChatPermission(5, "5491122334455@c.us");
   * // Response: { success: true, message: "Permiso revocado correctamente" }
   * ```
   * 
   * @throws 401 - No autenticado
   * @throws 403 - Solo ADMIN puede revocar permisos
   * @throws 404 - Permiso no encontrado
   */
  async revokeChatPermission(
    employeeId: number,
    chatId: string
  ): Promise<PermissionResponse> {
    try {
      const { data } = await api.post("/permissions/revoke", {
        employeeId,
        chatId
      });
      return data;
    } catch (error: any) {
      if (error?.response?.status === 403) {
        throw new Error("Solo administradores pueden revocar permisos");
      }
      if (error?.response?.status === 404) {
        throw new Error("Permiso no encontrado");
      }
      console.error("Error al revocar permiso:", error);
      throw new Error(
        error?.response?.data?.error ||
          error?.message ||
          "Error al revocar permiso"
      );
    }
  },

  /**
   * Lista todos los chats a los que un empleado tiene acceso
   * Endpoint: GET /api/permissions/employee/:employeeId
   * 
   * RESTRICCIÓN: Solo ADMIN puede hacer esto
   * 
   * Devuelve todos los chats a los que un empleado tiene permiso asignado.
   * 
   * @param employeeId number - ID del empleado
   * @returns Promise con array de permisos
   * 
   * @example
   * ```typescript
   * const { data: permissions } = await getEmployeePermissions(5);
   * // permissions = [{
   * //   id: 1,
   * //   employee_id: 5,
   * //   chat_id: "5491122334455@c.us",
   * //   owner_id: 1,
   * //   created_at: "2024-01-15T10:30:00.000Z"
   * // }, {
   * //   id: 2,
   * //   employee_id: 5,
   * //   chat_id: "5491166778899@c.us",
   * //   owner_id: 1,
   * //   created_at: "2024-01-16T14:20:00.000Z"
   * // }]
   * 
   * // Extraer solo los IDs de chats
   * const chatIds = permissions.map(p => p.chat_id);
   * ```
   * 
   * @throws 401 - No autenticado
   * @throws 403 - Solo ADMIN puede ver permisos de empleados
   * @throws 404 - Empleado no encontrado
   */
  async getEmployeePermissions(
    employeeId: number
  ): Promise<PermissionListResponse> {
    try {
      const { data } = await api.get(`/permissions/employee/${employeeId}`);
      return data;
    } catch (error: any) {
      if (error?.response?.status === 403) {
        throw new Error("Solo administradores pueden ver permisos de empleados");
      }
      if (error?.response?.status === 404) {
        throw new Error("Empleado no encontrado");
      }
      console.error("Error al obtener permisos del empleado:", error);
      throw new Error(
        error?.response?.data?.error ||
          error?.message ||
          "Error al obtener permisos"
      );
    }
  },

  /**
   * Lista todos los empleados que tienen acceso a un chat específico
   * Endpoint: GET /api/permissions/chat/:chatId
   * 
   * RESTRICCIÓN: Solo ADMIN puede hacer esto
   * 
   * Devuelve todos los empleados que tienen permiso asignado a un chat.
   * 
   * @param chatId string - ID del chat (ej: "5491122334455@c.us")
   * @returns Promise con array de permisos extendidos con info del empleado
   * 
   * @example
   * ```typescript
   * const { data: permissions } = await getChatPermissions("5491122334455@c.us");
   * // permissions = [{
   * //   id: 1,
   * //   employee_id: 5,
   * //   chat_id: "5491122334455@c.us",
   * //   owner_id: 1,
   * //   created_at: "2024-01-15T10:30:00.000Z",
   * //   employee_name: "Carlos López",
   * //   employee_email: "carlos@empresa.com"
   * // }]
   * ```
   * 
   * @throws 401 - No autenticado
   * @throws 403 - Solo ADMIN puede ver permisos de chats
   * @throws 404 - Chat no encontrado
   */
  async getChatPermissions(
    chatId: string
  ): Promise<PermissionListResponse> {
    try {
      const { data } = await api.get(`/permissions/chat/${chatId}`);
      return data;
    } catch (error: any) {
      if (error?.response?.status === 403) {
        throw new Error("Solo administradores pueden ver permisos de chats");
      }
      if (error?.response?.status === 404) {
        throw new Error("Chat no encontrado");
      }
      console.error("Error al obtener permisos del chat:", error);
      throw new Error(
        error?.response?.data?.error ||
          error?.message ||
          "Error al obtener permisos"
      );
    }
  }
};
