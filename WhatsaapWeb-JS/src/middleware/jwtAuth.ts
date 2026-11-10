import { NextFunction, Request, Response } from 'express';
import config from '../config/index';
import { isActiveAccessSession, readAccessSession } from '../services/auth/AccessSession';
import { toPositiveInt } from '../shared/positiveInt';

export { toPositiveInt } from '../shared/positiveInt';

const jwt = require('jsonwebtoken') as any;

export type JwtRequest = Request & {
  user?: Record<string, unknown>;
  whatsappCompanyId?: number;
  conversation?: Record<string, unknown>;
  mediaAttachment?: Record<string, unknown>;
};

export function extractBearerToken(authHeader: unknown): string | null {
  if (typeof authHeader !== 'string') return null;
  const trimmed = authHeader.trim();
  const [scheme, token] = trimmed.split(/\s+/);
  if (!scheme || scheme.toLowerCase() !== 'bearer' || !token) return null;
  return token;
}

export function hasCompanyClaim(user: Record<string, unknown> | undefined): boolean {
  if (!user || typeof user !== 'object') return false;
  return Boolean(
    toPositiveInt(user.companyId) ||
    toPositiveInt(user.company_id) ||
    toPositiveInt(user.tenantId)
  );
}

/**
 * Resuelve el companyId asociado a la petición autenticada.
 * Invariante P0: No se permite defaultCompanyId como fallback en operaciones autenticadas.
 */
export function resolveWhatsappCompanyId(req: JwtRequest): number {
  const user = req.user || {};
  const resolved = (
    toPositiveInt(req.whatsappCompanyId) ||
    toPositiveInt(user.companyId) ||
    toPositiveInt(user.company_id) ||
    toPositiveInt(user.tenantId)
  );

  if (resolved) {
    return resolved;
  }

  throw new Error('TENANT_CLAIM_REQUIRED: No se encontro un companyId valido en el token o peticion operativa');
}

/**
 * Middleware fail-closed de autenticación JWT.
 * Valida firma, expiración y claim de empresa (SEC-03).
 */
const validatedSessions = new WeakMap<Request, string>();

export function requireActiveAccessSession(
  req: Request, res: Response, claims: Record<string, unknown>, companyId: number | null, next: () => void,
): void | Response | Promise<void | Response> {
  const session = readAccessSession(claims, companyId);
  if (session === undefined) return next();
  const revoked = () => res.status(401).json({ success: false, error: 'La sesión ya no está activa', code: 'SESSION_REVOKED' });
  if (!session) return revoked();
  const key = JSON.stringify(session);
  if (validatedSessions.get(req) === key) return next();
  return isActiveAccessSession(session).then((active) => {
    if (!active) return revoked();
    if (session.expiresAt <= Date.now()) {
      return res.status(401).json({ success: false, error: 'Token invalido o expirado', code: 'ACCESS_TOKEN_EXPIRED' });
    }
    validatedSessions.set(req, key);
    return next();
  }, () => res.status(503).json({ success: false, error: 'No se pudo comprobar la sesión', code: 'SESSION_CHECK_UNAVAILABLE' }));
}

export function requireJwt(req: JwtRequest, res: Response, next: NextFunction): void | Response | Promise<void | Response> {
  const token = extractBearerToken(req.headers.authorization);
  if (!token) {
    return res.status(401).json({
      success: false,
      error: 'Token no proporcionado',
      details: 'Se requiere un token Bearer en el header Authorization',
    });
  }

  try {
    const decoded = jwt.verify(token, config.jwt.secret) as Record<string, unknown>;

    // SEC-03: JWT sin company claim -> 401/403 sin fallback
    const enforceCompanyClaim = config.security.whatsappApiRequireCompanyClaim !== false;
    if (enforceCompanyClaim && !hasCompanyClaim(decoded)) {
      return res.status(403).json({
        success: false,
        error: 'Empresa no asociada al token',
        details: 'El token carece de claim de empresa (companyId/tenantId) valido',
      });
    }

    const companyId = toPositiveInt(decoded.companyId) ||
      toPositiveInt(decoded.company_id) ||
      toPositiveInt(decoded.tenantId);

    if (enforceCompanyClaim && !companyId) {
      return res.status(403).json({
        success: false,
        error: 'Empresa no asociada al token',
      });
    }

    return requireActiveAccessSession(req, res, decoded, companyId, () => {
      req.user = decoded;
      req.whatsappCompanyId = companyId || undefined;
      next();
    });
  } catch (error: any) {
    return res.status(401).json({
      success: false,
      error: 'Token invalido o expirado',
      ...(error?.name === 'TokenExpiredError' && { code: 'ACCESS_TOKEN_EXPIRED' }),
      details: error?.message || undefined,
    });
  }
}

/**
 * Middleware para endpoints que admiten modo sandbox aislado en desarrollo.
 * En producción o por defecto actúa como requireJwt (fail-closed).
 */
export function optionalWhatsappJwt(req: JwtRequest, res: Response, next: NextFunction): void | Response | Promise<void | Response> {
  if (
    config.security.allowInsecureSandbox &&
    process.env.NODE_ENV !== 'production' &&
    !config.security.whatsappApiRequireJwt
  ) {
    req.whatsappCompanyId = config.security.sandboxCompanyId || 1;
    return next();
  }
  return requireJwt(req, res, next);
}
