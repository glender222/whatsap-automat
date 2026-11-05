// services/http.ts
import axios from "axios";
import { authService } from "../../factures/auth/services/authService";

export const api = axios.create({
  baseURL: (import.meta as any)?.env?.VITE_API_URL ?? "http://localhost:3000/api",
  timeout: 20000, // Aumentado a 20 segundos para permitir descargas de WhatsApp
  headers: { "Content-Type": "application/json" },
});

// Interceptor para inyectar el token en cada solicitud
api.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('accessToken');
    const publicAuthRoutes = ['/auth/register', '/auth/login'];
    const isPublicAuthRoute = publicAuthRoutes.some((route) => config.url?.startsWith(route));
    console.log(`🔐 [AXIOS] ${config.method?.toUpperCase()} ${config.url} - Token: ${token ? 'SÍ' : 'NO'}`);
    
    if (token && !isPublicAuthRoute) {
      // Asegurar que headers existe y es un objeto
      if (!config.headers) {
        (config.headers as any) = {};
      }
      // Asignar el Authorization header de forma segura
      (config.headers as any)['Authorization'] = `Bearer ${token}`;
      console.log(`✅ [AXIOS] Authorization header inyectado para ${config.method?.toUpperCase()} ${config.url}`);
    } else if (isPublicAuthRoute) {
      console.log(`ℹ️ [AXIOS] Ruta publica de auth sin Authorization: ${config.method?.toUpperCase()} ${config.url}`);
    } else {
      console.warn(`⚠️ [AXIOS] NO hay token en localStorage para: ${config.method?.toUpperCase()} ${config.url}`);
    }
    return config;
  },
  (error) => Promise.reject(error)
);

// ===== Response interceptor: refresh token on 401 (with concurrency handling) =====
let isRefreshing = false;
let refreshSubscribers: Array<(token: string | null) => void> = [];

function subscribeTokenRefresh(cb: (token: string | null) => void) {
  refreshSubscribers.push(cb);
}

function onRefreshed(token: string | null) {
  refreshSubscribers.forEach((cb) => cb(token));
  refreshSubscribers = [];
}

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error?.config;
    const responseCode = error?.response?.data?.error;

    // Solo intentamos refresh en respuestas 401 y si no hemos reintentado ya
    if (
      error?.response?.status === 401 &&
      responseCode !== 'META_API_ERROR' &&
      originalRequest &&
      !(originalRequest as any)._retry
    ) {
      (originalRequest as any)._retry = true;

      const refreshToken = localStorage.getItem('refreshToken');

      if (!refreshToken) {
        // No hay refresh token -> forzar logout
        localStorage.removeItem('accessToken');
        localStorage.removeItem('refreshToken');
        window.location.href = '/auth/login';
        return Promise.reject(error);
      }

      if (isRefreshing) {
        // Si ya se está refrescando, encolar la petición y resolverla cuando termine
        return new Promise((resolve, reject) => {
          subscribeTokenRefresh((token) => {
            if (token) {
              originalRequest.headers = originalRequest.headers || {};
              originalRequest.headers['Authorization'] = `Bearer ${token}`;
              resolve(api(originalRequest));
            } else {
              reject(error);
            }
          });
        });
      }

      isRefreshing = true;

      try {
        const tokens = await authService.refreshToken(refreshToken);

        // Guardar nuevos tokens
        localStorage.setItem('accessToken', tokens.accessToken);
        if (tokens.refreshToken) {
          localStorage.setItem('refreshToken', tokens.refreshToken);
        }

        // Actualizar header por defecto
        api.defaults.headers = api.defaults.headers || {};
        (api.defaults.headers as any)['Authorization'] = `Bearer ${tokens.accessToken}`;

        onRefreshed(tokens.accessToken);
        isRefreshing = false;

        // Reintentar la petición original con nuevo token
        originalRequest.headers = originalRequest.headers || {};
        originalRequest.headers['Authorization'] = `Bearer ${tokens.accessToken}`;
        return api(originalRequest);
      } catch (refreshError) {
        isRefreshing = false;
        onRefreshed(null);

        // Si el refresh falla, intentar logout en backend (best-effort) y forzar redirección
        try {
          await authService.logout(refreshToken);
        } catch (e) {
          // ignore
        }

        localStorage.removeItem('accessToken');
        localStorage.removeItem('refreshToken');
        window.location.href = '/auth/login';
        return Promise.reject(refreshError);
      }
    }

    return Promise.reject(error);
  }
);
