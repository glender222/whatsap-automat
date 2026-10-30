/**
 * Tipos para empleados/estaciones según arquitectura multi-tenant
 * Alineados con el modelo de datos del backend
 */

export interface Employee {
  id: string;
  nombre: string;
  email: string;
  // Número de WhatsApp asociado (opcional)
  whatsappNumber?: string;
  rol: "ADMIN" | "EMPLEADO";
  id_padre: string | null;  // Multi-tenancy: NULL para ADMIN, <adminId> para EMPLEADO
  activo: boolean;
  fecha_creacion: string;
  fecha_actualizacion?: string;
}

export interface EmployeeResponse {
  success: boolean;
  data: Employee[];
}

export interface CurrentUserResponse {
  success: boolean;
  data: Employee;
}

/**
 * Respuesta al crear estación de trabajo
 * Incluye contraseña temporal que debe mostrarse solo una vez
 */
export interface CreateStationResponse {
  success: boolean;
  message: string;
  data: {
    employee: Employee;
    tempPassword: string;
  };
}

/**
 * Respuesta al actualizar empleado
 */
export interface UpdateEmployeeResponse {
  success: boolean;
  message: string;
  data: Employee;
}

/**
 * Respuesta al cambiar contraseña
 */
export interface ChangePasswordResponse {
  success: boolean;
  message: string;
}

export interface DeleteEmployeeResponse {
  success: boolean;
  message: string;
}
