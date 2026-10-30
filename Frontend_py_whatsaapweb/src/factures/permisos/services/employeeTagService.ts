// src/factures/permisos/services/employeeTagService.ts

import { api } from '../../../shared/axios/http';
import type { ApiResponse } from '../../../shared/types/api.types';
import type {
  AssignEmployeeTagRequest,
  RevokeEmployeeTagRequest,
  EmployeeTag
} from '../types/employeeTagTypes';
import type { Tag } from '../../mensajeria/types/tagTypes';

/**
 * Servicio para gestionar asignación de tags a empleados
 * ✅ Token inyectado automáticamente en todas las solicitudes
 */
export const EmployeeTagService = {
  /**
   * GET /api/tags
   * Obtiene la lista de TODOS los tags disponibles para asignar
   */
  async getAllTagsForEmployees(): Promise<Tag[]> {
    try {
      console.log('📥 Solicitando GET /api/tags');
      const response = await api.get<{ success: boolean; data: Tag[] }>('/tags');
      console.log('✅ Tags obtenidos:', response.data.data?.length || 0);
      // El endpoint retorna "data" en lugar de "tags"
      return response.data.data || [];
    } catch (error: any) {
      console.error('❌ Error en /api/tags:', error.response?.status, error.message);
      throw new Error(error?.response?.data?.message || 'Error al obtener lista de tags');
    }
  },

  /**
   * POST /api/tags/:id/users
   * Asigna un tag a un empleado
   */
  async assignTagToEmployee(request: AssignEmployeeTagRequest): Promise<ApiResponse<EmployeeTag>> {
    try {
      console.log('📤 POST /api/tags/:id/users', request);
      const response = await api.post<ApiResponse<EmployeeTag>>(`/tags/${request.tagId}/users`, {
        employeeId: request.employeeId
      });
      console.log('✅ Tag asignado');
      return response.data;
    } catch (error: any) {
      console.error('❌ Error asignando tag:', error.message);
      throw new Error(error?.response?.data?.message || 'Error al asignar tag');
    }
  },

  /**
   * DELETE /api/tags/:id/users/:employeeId
   * Revoca el tag de un empleado
   */
  async revokeTagFromEmployee(request: RevokeEmployeeTagRequest): Promise<ApiResponse<EmployeeTag>> {
    try {
      console.log('📤 DELETE /api/tags/:id/users/:employeeId', request);
      const response = await api.delete<ApiResponse<EmployeeTag>>(
        `/tags/${request.tagId}/users/${request.employeeId}`
      );
      console.log('✅ Tag revocado');
      return response.data;
    } catch (error: any) {
      console.error('❌ Error revocando tag:', error.message);
      throw new Error(error?.response?.data?.message || 'Error al revocar tag');
    }
  },

  /**
   * GET /api/tags/:id/users
   * Obtiene todos los empleados que tienen asignado un tag específico
   */
  async getEmployeesWithTag(tagId: string): Promise<any[]> {
    try {
      console.log('📥 Solicitando GET /api/tags/:id/users');
      const response = await api.get<{ success: boolean; data: any[] }>(
        `/tags/${tagId}/users`
      );
      console.log('✅ Empleados con tag obtenidos:', response.data.data?.length || 0);
      return response.data.data || [];
    } catch (error: any) {
      console.error('❌ Error en /api/tags/:id/users:', error.response?.status, error.message);
      throw new Error(error?.response?.data?.message || 'Error al obtener empleados del tag');
    }
  },

  /**
   * Verifica si un empleado tiene un tag específico
   */
  async hasTag(employeeId: string, tagId: string): Promise<boolean> {
    try {
      const employees = await this.getEmployeesWithTag(tagId);
      return employees.some((emp: any) => emp.id === employeeId || emp.employee_id === employeeId);
    } catch (error) {
      console.error('Error verificando tag:', error);
      return false;
    }
  }
};

