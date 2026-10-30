// src/factures/mensajeria/types/permissionTypes.ts

/**
 * Representa un permiso de acceso a un chat
 */
export interface ChatPermission {
  id: string;
  employee_id: string;
  chat_id: string;
  granted_by: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Información extendida de permiso con datos del chat
 */
export interface PermissionWithChat {
  id: string;
  employee_id: string;
  chat_id: string;
  granted_by: string;
  createdAt: string;
  updatedAt: string;
  chat?: {
    id: string;
    name: string;
    photoUrl?: string;
    lastMessageTimestamp?: number;
  };
}

/**
 * Información extendida de permiso con datos del empleado
 */
export interface PermissionWithEmployee {
  id: string;
  employee_id: string;
  chat_id: string;
  granted_by: string;
  createdAt: string;
  updatedAt: string;
  employee?: {
    id: string;
    nombre: string;
    email: string;
    rol: string;
  };
}

/**
 * Request para asignar un permiso
 */
export interface AssignPermissionRequest {
  employeeId: string;
  chatId: string;
}

/**
 * Request para revocar un permiso
 */
export interface RevokePermissionRequest {
  employeeId: string;
  chatId: string;
}

/**
 * Respuesta de la API de permisos
 */
export interface PermissionResponse {
  success: boolean;
  message: string;
  data?: ChatPermission | ChatPermission[];
}
