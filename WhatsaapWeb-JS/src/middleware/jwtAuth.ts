import { NextFunction, Request, Response } from 'express';
import config from '../config/index';

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

export function toPositiveInt(value: unknown): number | null {
  if (typeof value === 'boolean') {
    return null;
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 ? value : null;
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const num = Number(value.trim());
    return Number.isInteger(num) && num > 0 ? num : null;
  }
  return null;
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
export function requireJwt(req: JwtRequest, res: Response, next: NextFunction): void | Response {
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
    req.user = decoded;

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

    req.whatsappCompanyId = companyId || undefined;
    return next();
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
export function optionalWhatsappJwt(req: JwtRequest, res: Response, next: NextFunction): void | Response {
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
