import { Socket } from 'socket.io';
import config from '../config/index';
import { extractBearerToken, toPositiveInt } from '../middleware/jwtAuth';
import { readAccessSession } from '../services/auth/AccessSession';
import type { SocketSessionMonitor } from './SocketSessionMonitor';

const jwt = require('jsonwebtoken') as any;

export interface AuthenticatedSocketData {
  user: Record<string, unknown>;
  tenantId: string;
  companyId: number;
  workspaceId?: string;
  userId?: string;
  role?: string;
  expiresAt?: number;
}

export interface SocketAuthErrorData {
  code: 'UNAUTHORIZED' | 'FORBIDDEN' | 'ACCESS_TOKEN_EXPIRED' | 'SESSION_REVOKED' | 'SESSION_CHECK_UNAVAILABLE';
  status: number;
  message: string;
  details?: string;
}

export interface ExtendedError extends Error {
  data?: SocketAuthErrorData;
}

export function createAuthError(
  message: string,
  code: SocketAuthErrorData['code'],
  status: number,
  details?: string
): ExtendedError {
  const err = new Error(message) as ExtendedError;
  err.data = {
    code,
    status,
    message,
    ...(details ? { details } : {}),
  };
  return err;
}

/**
 * Middleware fail-closed de autenticación JWT para Socket.IO.
 * Extrae y valida el token en handshake.auth.token, handshake.headers.authorization, o query.token.
 * Valida de forma estricta los claims de empresa (companyId, company_id, tenantId) mediante toPositiveInt.
 */
export function socketJwtAuthMiddleware(jwtSecret?: string, monitor?: SocketSessionMonitor) {
  return (socket: Socket, next: (err?: ExtendedError) => void): void | Promise<void> => {
    try {
      // 1. Extraer token de auth, headers o query
      let rawToken: unknown = null;

      if (socket.handshake.auth && typeof socket.handshake.auth.token === 'string') {
        rawToken = socket.handshake.auth.token;
      } else if (socket.handshake.auth && typeof socket.handshake.auth.jwt === 'string') {
        rawToken = socket.handshake.auth.jwt;
      } else if (socket.handshake.headers && typeof socket.handshake.headers.authorization === 'string') {
        rawToken = socket.handshake.headers.authorization;
      } else if (socket.handshake.query && typeof socket.handshake.query.token === 'string') {
        rawToken = socket.handshake.query.token;
      }

      if (!rawToken || typeof rawToken !== 'string') {
        return next(
          createAuthError(
            'AUTHENTICATION_ERROR: Token no proporcionado',
            'UNAUTHORIZED',
            401,
            'Se requiere token JWT en handshake'
          )
        );
      }

      const token = extractBearerToken(rawToken) || rawToken.trim();
      if (!token) {
        return next(
          createAuthError(
            'AUTHENTICATION_ERROR: Formato de token invalido',
            'UNAUTHORIZED',
            401,
            'Token vacio o no valido'
          )
        );
      }

      // 2. Verificar firma y expiración del JWT
      const secretToUse = jwtSecret || config.jwt.secret || process.env.JWT_SECRET || '';
      let decoded: Record<string, unknown>;
      try {
        decoded = jwt.verify(token, secretToUse) as Record<string, unknown>;
      } catch (verifyError: any) {
        const errorMsg = verifyError?.message || 'Token invalido o expirado';
        return next(
          createAuthError(
            `AUTHENTICATION_ERROR: ${errorMsg}`,
            verifyError?.name === 'TokenExpiredError' ? 'ACCESS_TOKEN_EXPIRED' : 'UNAUTHORIZED',
            401,
            errorMsg
          )
        );
      }

      // 3. SEC-03: Validar claim de empresa/tenant (rechaza booleano, cero, negativo)
      const companyIdNum =
        toPositiveInt(decoded.companyId) ||
        toPositiveInt(decoded.company_id) ||
        toPositiveInt(decoded.tenantId);

      if (!companyIdNum) {
        return next(
          createAuthError(
            'AUTHENTICATION_ERROR: Empresa no asociada al token',
            'FORBIDDEN',
            403,
            'El token carece de claim de empresa (companyId/tenantId) valido'
          )
        );
      }

      // 4. Extraer claims de usuario y workspace
      const userIdNum =
        toPositiveInt(decoded.userId) ||
        toPositiveInt(decoded.id) ||
        toPositiveInt(decoded.sub);

      const workspaceIdRaw =
        toPositiveInt(decoded.workspaceId) ||
        toPositiveInt(decoded.workspace_id) ||
        (typeof decoded.workspaceId === 'string' && decoded.workspaceId.trim() ? decoded.workspaceId.trim() : null) ||
        (typeof decoded.workspace_id === 'string' && decoded.workspace_id.trim() ? decoded.workspace_id.trim() : null);

      const role =
        typeof decoded.rol === 'string'
          ? decoded.rol
          : typeof decoded.role === 'string'
          ? decoded.role
          : 'USER';

      // 5. Vincular claims verificados a socket.data
      const authData: AuthenticatedSocketData = {
        user: decoded,
        tenantId: String(companyIdNum),
        companyId: companyIdNum,
        ...(userIdNum ? { userId: String(userIdNum) } : {}),
        ...(workspaceIdRaw ? { workspaceId: String(workspaceIdRaw) } : {}),
        role,
        ...(typeof decoded.exp === 'number' && Number.isSafeInteger(decoded.exp * 1000) ? { expiresAt: decoded.exp * 1000 } : {}),
      };

      const accept = () => {
        socket.data = { ...socket.data, ...authData };
        next();
      };
      const session = readAccessSession(decoded, companyIdNum);
      if (session === undefined) return accept();
      const revoked = () => next(createAuthError('La sesión ya no está activa', 'SESSION_REVOKED', 401));
      const unavailable = () => next(createAuthError('No se pudo comprobar la sesión', 'SESSION_CHECK_UNAVAILABLE', 503));
      if (!session) return revoked();
      if (!monitor) return unavailable();
      return monitor.admit(socket, session).then((active) => {
        if (!active) return revoked();
        if (session.expiresAt <= Date.now()) {
          return next(createAuthError('Token invalido o expirado', 'ACCESS_TOKEN_EXPIRED', 401));
        }
        return accept();
      }, unavailable);
    } catch (unexpectedError: any) {
      return next(
        createAuthError(
          `AUTHENTICATION_ERROR: ${unexpectedError?.message || 'Error inesperado en autenticacion'}`,
          'UNAUTHORIZED',
          401,
          unexpectedError?.message
        )
      );
    }
  };
}
