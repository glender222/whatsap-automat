import axios, { CanceledError, type AxiosRequestConfig, type InternalAxiosRequestConfig } from 'axios';
import { authService } from '../../factures/auth/services/authService';
import { invalidateSession, readSession, saveRenewedAccess, type SessionSnapshot } from '../auth/session';

export const api = axios.create({
  baseURL: import.meta.env?.VITE_API_URL ?? 'http://localhost:3000/api',
  timeout: 20000,
  headers: { 'Content-Type': 'application/json' },
});

const publicAuthRoutes = new Set(['/auth/register', '/auth/login', '/auth/refresh']);

export type AuthRequestConfig = AxiosRequestConfig & { replayOnAuthRenewal?: boolean; sessionGeneration?: number };
type SessionRequest = InternalAxiosRequestConfig & {
  authRetryGeneration?: number; replayOnAuthRenewal?: boolean; sessionGeneration?: number;
};

const requestSessions = new WeakMap<InternalAxiosRequestConfig, SessionSnapshot>();
const pendingRenewals = new Map<number, Promise<SessionSnapshot>>();

api.interceptors.request.use((config: SessionRequest) => {
  const publicRoute = publicAuthRoutes.has(config.url ?? '');
  const expectedGeneration = config.authRetryGeneration ?? config.sessionGeneration;
  if (publicRoute && expectedGeneration === undefined) return config;
  const session = readSession();
  if (expectedGeneration !== undefined && expectedGeneration !== session.generation) {
    throw new CanceledError('La sesión cambió antes del reintento.');
  }
  if (publicRoute) return config;
  requestSessions.set(config, session);
  if (session.accessToken) config.headers.set('Authorization', `Bearer ${session.accessToken}`);
  return config;
});

export async function renewAccess(sent: SessionSnapshot): Promise<SessionSnapshot> {
  const current = readSession();
  const { generation, refreshToken } = current;
  if (sent.generation !== generation) throw new CanceledError('La sesión cambió antes de la renovación.');
  if (current.accessToken && sent.accessToken !== current.accessToken) return current;
  if (!refreshToken) {
    invalidateSession(generation);
    throw new CanceledError('La sesión no tiene token de renovación.');
  }

  const pending = pendingRenewals.get(generation);
  if (pending) return pending;

  const renewal = authService.refreshToken(refreshToken, generation).then((tokens) => {
    const renewed = saveRenewedAccess(generation, tokens.accessToken, tokens.refreshToken);
    if (!renewed) throw new CanceledError('La sesión cambió durante la renovación.');
    return renewed;
  }).catch((error) => {
    if (axios.isAxiosError(error) && error.response?.status === 401) invalidateSession(generation);
    throw error;
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
    if (error?.response?.status !== 401 || !request) throw error;
    const sent = requestSessions.get(request);
    if (!sent) throw error;

    const payload = error.response.data;
    const body = payload instanceof Blob && payload.size <= 4096 &&
      /^application\/(?:[\w.+-]+\+)?json(?:;|$)/i.test(payload.type)
      ? await payload.text().then((value) => JSON.parse(value)).catch(() => null)
      : payload;
    if (body?.code === 'SESSION_REVOKED') {
      invalidateSession(sent.generation);
      throw error;
    }
    const expiredAccess = body?.code === 'ACCESS_TOKEN_EXPIRED' ||
      (body?.error === 'Token invalido o expirado' && body?.details === 'jwt expired');
    if (!expiredAccess || request.authRetryGeneration !== undefined || sent.generation !== readSession().generation) throw error;

    await renewAccess(sent);
    if (request.replayOnAuthRenewal === false) throw error;
    request.authRetryGeneration = sent.generation;
    return api(request);
  },
);
