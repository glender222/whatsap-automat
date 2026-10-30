// src/services/auth.service.ts
import { api } from "../../../shared/axios/http";
import type { login, LoginResponse, AuthTokens, AuthState } from "../types/logTypes";

/**
 * Servicio de autenticación
 * Incluye login, refreshToken, logout y getMe.
 */
export const authService = {
  /**
   * Verifica si el usuario está autenticado (token en localStorage)
   */
  isAuthenticated(): boolean {
    // Puedes ajustar la lógica según cómo almacenes el token
    return !!localStorage.getItem("accessToken");
  },
  /**
   * Iniciar sesión (POST /auth/login)
   */
  async login(credentials: login): Promise<LoginResponse["data"]> {
    try {
      const { data } = await api.post<LoginResponse>("/auth/login", credentials);

      if (!data.success) {
        throw new Error(data.message || "Error al iniciar sesión");
      }

      // Devuelve la data interna: { user, accessToken, refreshToken }
      return data.data;
    } catch (error: any) {
      const message =
        error?.response?.data?.message ||
        error?.response?.data?.error ||
        error?.message ||
        "No se pudo iniciar sesión";
      throw new Error(message);
    }
  },

  /**
   * Refrescar token (POST /auth/refresh)
   * 
   * CAMBIO IMPORTANTE: Según arquitectura multi-tenant, el refresh ahora requiere
   * el Access Token (aunque esté expirado) en el header Authorization.
   * El interceptor de axios ya lo inyecta automáticamente.
   */
  async refreshToken(refreshToken: string): Promise<AuthTokens> {
    try {
      const { data } = await api.post<{ success: boolean; data: AuthTokens }>(
        "/auth/refresh",
        { refreshToken }
        // El header Authorization se inyecta automáticamente por el interceptor
      );

      if (!data.success) throw new Error("No se pudo refrescar el token");
      return data.data;
    } catch (error: any) {
      const message =
        error?.response?.data?.message ||
        error?.message ||
        "Error al refrescar token";
      throw new Error(message);
    }
  },

  /**
   * Cerrar sesión (POST /auth/logout)
   */
  async logout(refreshToken: string): Promise<void> {
    try {
      const { data } = await api.post<{ success: boolean; message: string }>(
        "/auth/logout",
        { refreshToken }
      );

      if (!data.success) {
        throw new Error(data.message || "Error al cerrar sesión");
      }
    } catch (error: any) {
      const message =
        error?.response?.data?.message ||
        error?.message ||
        "Error al cerrar sesión";
      throw new Error(message);
    }
  },

  /**
   * Obtener usuario autenticado (GET /auth/me)
   */
  async getMe(): Promise<AuthState["user"]> {
    try {
      const { data } = await api.get<{ success: boolean; data: AuthState["user"] }>("/auth/me");

      if (!data.success) throw new Error("No se pudo obtener el usuario autenticado");
      return data.data;
    } catch (error: any) {
      const message =
        error?.response?.data?.message ||
        error?.message ||
        "Error al obtener datos del usuario";
      throw new Error(message);
    }
  },
};
