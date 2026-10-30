// services/user.service.ts
import { api } from "../axios/http";
import type { User, UserRegistrationData } from "../types/user.types";

/**
 * Interfaz de respuesta de registro según arquitectura multi-tenant
 * El backend ahora retorna tokens junto con el usuario
 */
interface RegisterResponse {
  success: boolean;
  message: string;
  data: {
    user: User;
    accessToken: string;
    refreshToken: string;
  };
}

/**
 * Registra un nuevo usuario ADMIN.
 * Endpoint: POST /api/auth/register
 * 
 * CAMBIO IMPORTANTE: El backend ahora retorna tokens en el registro
 * El rol siempre es ADMIN para nuevos registros (propietarios)
 */
export const userService = {
  async register(userData: UserRegistrationData): Promise<RegisterResponse['data']> {
    try {
      const { data } = await api.post<RegisterResponse>("/auth/register", {
        nombre: userData.nombre,
        email: userData.email,
        password: userData.password,
        // El backend asigna automáticamente:
        // - rol: "ADMIN"
        // - id_padre: null
      });

      if (!data.success) {
        throw new Error(data.message || "Error al registrar el usuario");
      }

      // Retorna user + tokens
      return data.data;
    } catch (error: any) {
      const message =
        error?.response?.data?.message ||
        error?.response?.data?.error ||
        error?.message ||
        "Error al registrar el usuario";
      throw new Error(message);
    }
  },
};
