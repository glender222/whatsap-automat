import axios, { CanceledError, type InternalAxiosRequestConfig } from 'axios';
import { authService } from '../../factures/auth/services/authService';

export const api = axios.create({
  baseURL: import.meta.env?.VITE_API_URL ?? 'http://localhost:3000/api',
  timeout: 20000,
  headers: { 'Content-Type': 'application/json' },
});

const publicAuthRoutes = new Set(['/auth/register', '/auth/login', '/auth/refresh']);

interface SessionSnapshot {
  accessToken: string | null;
  refreshToken: string | null;
  generation: number;
}

type SessionRequest = InternalAxiosRequestConfig & { authRetryGeneration?: number };

let observedSession: SessionSnapshot = { accessToken: null, refreshToken: null, generation: 0 };
const requestSessions = new WeakMap<InternalAxiosRequestConfig, SessionSnapshot>();
const pendingRenewals = new Map<number, Promise<void>>();

function readSession(): SessionSnapshot {
  const accessToken = localStorage.getItem('accessToken');
  const refreshToken = localStorage.getItem('refreshToken');
  const changed = refreshToken !== observedSession.refreshToken ||
    (!refreshToken && accessToken !== observedSession.accessToken);
  observedSession = { accessToken, refreshToken, generation: observedSession.generation + Number(changed) };
  return observedSession;
}

api.interceptors.request.use((config: SessionRequest) => {
  if (publicAuthRoutes.has(config.url ?? '')) return config;
  const session = readSession();
  if (config.authRetryGeneration !== undefined && config.authRetryGeneration !== session.generation) {
    throw new CanceledError('La sesión cambió antes del reintento.');
  }
  requestSessions.set(config, session);
  if (session.accessToken) config.headers.set('Authorization', `Bearer ${session.accessToken}`);
  return config;
});

function clearExpiredSession() {
  for (const key of ['accessToken', 'refreshToken', 'auth', 'userRole']) {
    localStorage.removeItem(key);
  }
  window.location.assign('/auth/login');
}

function renewAccess(generation: number, refreshToken: string): Promise<void> {
  const pending = pendingRenewals.get(generation);
  if (pending) return pending;

  const renewal = authService.refreshToken(refreshToken).then((tokens) => {
    if (readSession().generation !== generation) throw new CanceledError('La sesión cambió durante la renovación.');
    localStorage.setItem('accessToken', tokens.accessToken);
    const nextRefreshToken = tokens.refreshToken || refreshToken;
    localStorage.setItem('refreshToken', nextRefreshToken);
    observedSession = { accessToken: tokens.accessToken, refreshToken: nextRefreshToken, generation };
  }).finally(() => pendingRenewals.delete(generation));
  pendingRenewals.set(generation, renewal);
  return renewal;
}

api.interceptors.response.use(
  (response) => {
    const sent = requestSessions.get(response.config);
    if (sent && sent.generation !== readSession().generation) {
      throw new CanceledError('La respuesta pertenece a una sesión anterior.');
    }
    return response;
  },
  async (error) => {
    const request = error?.config as SessionRequest | undefined;
    const body = error?.response?.data;
    const expiredAccess = body?.code === 'ACCESS_TOKEN_EXPIRED' ||
      (body?.error === 'Token invalido o expirado' && body?.details === 'jwt expired');
    if (error?.response?.status !== 401 || !expiredAccess ||
        !request || request.authRetryGeneration !== undefined) throw error;

    const sent = requestSessions.get(request);
    if (!sent) throw error;
    const current = readSession();
    if (sent.generation !== current.generation) throw error;
    if (!current.refreshToken) {
      clearExpiredSession();
      throw error;
    }

    if (sent.accessToken === current.accessToken) {
      try {
        await renewAccess(current.generation, current.refreshToken);
      } catch (renewalError) {
        if (axios.isAxiosError(renewalError) && renewalError.response?.status === 401 &&
            readSession().generation === current.generation) clearExpiredSession();
        throw renewalError;
      }
    }

    request.authRetryGeneration = current.generation;
    return api(request);
  },
);
