// services/http.ts
import axios from "axios";
import { authService } from "../../factures/auth/services/authService";

export const api = axios.create({
  baseURL: import.meta.env?.VITE_API_URL ?? "http://localhost:3000/api",
  timeout: 20000, // Aumentado a 20 segundos para permitir descargas de WhatsApp
  headers: { "Content-Type": "application/json" },
});

const publicAuthRoutes = new Set(['/auth/register', '/auth/login', '/auth/refresh']);

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('accessToken');
  if (token && !publicAuthRoutes.has(config.url ?? '')) {
    config.headers.set('Authorization', `Bearer ${token}`);
  }
  return config;
});

// ===== Response interceptor: refresh token on 401 (with concurrency handling) =====
let isRefreshing = false;
let refreshSubscribers: Array<(token: string | null) => void> = [];

function subscribeTokenRefresh(cb: (token: string | null) => void) {
  refreshSubscribers.push(cb);
}

function clearExpiredSession() {
  for (const key of ['accessToken', 'refreshToken', 'auth', 'userRole']) {
    localStorage.removeItem(key);
  }
  window.location.assign('/auth/login');
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
      !publicAuthRoutes.has(originalRequest.url) &&
      !originalRequest._retry
    ) {
      originalRequest._retry = true;

      const refreshToken = localStorage.getItem('refreshToken');

      if (!refreshToken) {
        // No hay refresh token -> forzar logout
        clearExpiredSession();
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
        if (localStorage.getItem('refreshToken') !== refreshToken) throw error;

        // Guardar nuevos tokens
        localStorage.setItem('accessToken', tokens.accessToken);
        if (tokens.refreshToken) {
          localStorage.setItem('refreshToken', tokens.refreshToken);
        }

        onRefreshed(tokens.accessToken);
        isRefreshing = false;

        // Reintentar la petición original con nuevo token
        originalRequest.headers = originalRequest.headers || {};
        originalRequest.headers['Authorization'] = `Bearer ${tokens.accessToken}`;
        return api(originalRequest);
      } catch (refreshError) {
        isRefreshing = false;
        onRefreshed(null);

        if (localStorage.getItem('refreshToken') === refreshToken) clearExpiredSession();
        return Promise.reject(refreshError);
      }
    }

    return Promise.reject(error);
  }
);
