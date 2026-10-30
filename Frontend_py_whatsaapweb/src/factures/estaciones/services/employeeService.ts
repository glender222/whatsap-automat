import { api } from "./../../../shared/axios/http";
import type { ApiResponse } from "../../../shared/types/api.types";
import type {
  Employee,
  DeleteEmployeeResponse
} from "../types/Employee";

/**
 * Obtener el rol actual del usuario desde localStorage
 */
const getCurrentUserRole = (): string | null => {
  return localStorage.getItem('userRole');
};

/**
 * Servicio para gestión de empleados/estaciones
 * Arquitectura multi-tenant: los empleados son creados bajo un ADMIN padre
 */
export const EmployeeService = {
  /**
   * Obtener todos los empleados del administrador autenticado
   * GET /api/auth/employees
   * 
   * ⚠️ PROTECCIÓN: Solo ejecuta si el usuario tiene rol ADMIN
   * El backend filtra automáticamente por id_padre basándose en el JWT
   */
  async getAll() {
    const userRole = getCurrentUserRole();
    
    // Validación de permisos: solo ADMIN puede obtener la lista de empleados
    if (userRole !== 'ADMIN') {
      throw new Error('No tienes permisos para acceder a esta funcionalidad. Solo administradores pueden ver empleados.');
    }
    
    const response = await api.get<ApiResponse<Employee[]>>("/auth/employees");
    return response.data;
  },

  /**
   * Obtener empleado por ID
   * GET /api/auth/employees/:id
   */
  async getById(id: string) {
    const response = await api.get<ApiResponse<Employee[]>>(`/auth/employees/${id}`);
    return response.data;
  },

  /**
   * Obtener el usuario autenticado actual
   * GET /api/auth/me
   */
  async getCurrentUser() {
    const response = await api.get<ApiResponse<Employee>>("/auth/me");
    return response.data;
  },

  /**
   * Crear estación de trabajo (Solo ADMIN)
   * POST /api/auth/create-station
   * 
   * ⚠️ PROTECCIÓN: Solo ejecuta si el usuario tiene rol ADMIN
   * 
   * IMPORTANTE: La respuesta incluye una contraseña temporal que debe
   * mostrarse al usuario SOLO UNA VEZ, ya que no se puede recuperar después.
   * 
   * El empleado creado tendrá:
   * - rol: "EMPLEADO"
   * - id_padre: <adminId del usuario autenticado>
   * - activo: true
   * 
   * @param nombre Nombre del empleado
   * @param email Email del empleado
   * @param password Contraseña personalizada (opcional)
   * @returns Respuesta con empleado creado y contraseña
   */
  async createStation(nombre: string, email: string, password?: string): Promise<ApiResponse<{ employee: Employee; tempPassword: string; }>> {
    const userRole = getCurrentUserRole();
    
    // Validación de permisos: solo ADMIN puede crear estaciones
    if (userRole !== 'ADMIN') {
      throw new Error('No tienes permisos para crear estaciones. Solo administradores pueden realizar esta acción.');
    }
    
    const response = await api.post<ApiResponse<{ employee: Employee; tempPassword: string; }>>("/auth/create-station", { 
      nombre, 
      email,
      ...(password && { password })
    });
    return response.data;
  },

  /**
   * Actualizar empleado (Solo ADMIN puede actualizar sus empleados)
   * PUT /api/auth/employees/:id
   * 
   * @param id ID del empleado
   * @param data Datos a actualizar
   */
  async updateEmployee(id: string, data: { nombre?: string; email?: string }): Promise<ApiResponse<Employee>> {
    const userRole = getCurrentUserRole();
    
    if (userRole !== 'ADMIN') {
      throw new Error('No tienes permisos para actualizar empleados.');
    }
    
    const response = await api.put<ApiResponse<Employee>>(`/auth/employees/${id}`, data);
    return response.data;
  },

  /**
   * Cambiar contraseña del empleado
   * PUT /api/auth/employees/:id
   * 
   * Usa el mismo endpoint de actualización pero solo con el campo password
   * 
   * @param id ID del empleado
   * @param newPassword Nueva contraseña
   */
  async changeEmployeePassword(id: string, newPassword: string): Promise<ApiResponse<void>> {
    const userRole = getCurrentUserRole();
    
    if (userRole !== 'ADMIN') {
      throw new Error('No tienes permisos para cambiar contraseñas.');
    }
    
    const response = await api.put<ApiResponse<void>>(
      `/auth/employees/${id}`,
      { password: newPassword }
    );
    return response.data;
  },

  /**
   * Desactivar estación de trabajo (Solo ADMIN)
   * DELETE /api/auth/employees/:id
   */
  async deleteEmployee(id: string): Promise<DeleteEmployeeResponse> {
    const userRole = getCurrentUserRole();

    if (userRole !== 'ADMIN') {
      throw new Error('No tienes permisos para eliminar estaciones.');
    }

    const response = await api.delete<DeleteEmployeeResponse>(`/auth/employees/${id}`);
    return response.data;
  },
};
