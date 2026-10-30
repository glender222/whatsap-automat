// src/shared/types/user.types.ts
/**
 * Tipos actualizados según arquitectura multi-tenant
 * Referencia: Documento "Arquitectura Multi-Tenant - Sistema de Gestión de WhatsApp"
 */

export interface BaseEntity {
  id: string;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Interfaz de Usuario según modelo del backend
 * 
 * ESTRUCTURA MULTI-TENANT:
 * - id_padre = NULL → Usuario es ADMIN (propietario)
 * - id_padre = <adminId> → Usuario es EMPLEADO del admin
 */
export interface User extends BaseEntity {
  nombre: string;
  email: string;
  rol: UserRole;
  idPadre: string | null;  // Clave para multi-tenancy
  activo?: boolean;
  fecha_creacion?: string;  // Campos adicionales del backend
  fecha_actualizacion?: string;
}

/**
 * Roles disponibles en el sistema
 * - ADMIN: Propietario con sesión de WhatsApp propia
 * - EMPLEADO: Trabajador con acceso limitado a chats específicos
 */
export type UserRole = "ADMIN" | "EMPLEADO";

/**
 * Datos necesarios para registrar un nuevo ADMIN
 * Los empleados se crean mediante /auth/create-station
 */
export interface UserRegistrationData {
  nombre: string;
  email: string;
  password: string;
}

/**
 * Respuesta al crear una estación de trabajo (empleado)
 */
export interface CreateStationResponse {
  success: boolean;
  message: string;
  data: {
    employee: User;
    tempPassword: string;  // ⚠️ Se muestra solo una vez
  };
}
