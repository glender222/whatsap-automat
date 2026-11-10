// src/services/auth.service.ts
import { api, type AuthRequestConfig } from "../../../shared/axios/http";
import { clearSession, readSession } from "../../../shared/auth/session";
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
    return Boolean(readSession().accessToken);
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

  /** Refresca el acceso con el token de renovación. */
  async refreshToken(refreshToken: string, sessionGeneration: number): Promise<AuthTokens> {
    const config: AuthRequestConfig = { sessionGeneration };
    const { data } = await api.post<{ success: boolean; data: AuthTokens }>(
      "/auth/refresh",
      { refreshToken },
      config,
    );
    if (!data.success || typeof data.data?.accessToken !== 'string' || !data.data.accessToken) {
      throw new Error("No se pudo refrescar el token");
    }
    return data.data;
  },

  /**
   * Cerrar sesión (POST /auth/logout)
   */
  async logout(refreshToken: string, sessionGeneration: number): Promise<void> {
    const config: AuthRequestConfig = { sessionGeneration };
    try {
      const { data } = await api.post<{ success: boolean; message: string }>(
        "/auth/logout",
        { refreshToken },
        config,
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


export async function logoutSession(generation = readSession().generation): Promise<boolean> {
  const current = readSession();
  if (current.generation !== generation) return false;
  try {
    if (current.refreshToken) await authService.logout(current.refreshToken, generation);
  } catch {
    // A transport failure still permits closing this session locally.
  }
  return clearSession(generation);
}
