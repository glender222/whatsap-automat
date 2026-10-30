import { NextFunction, Request, Response } from 'express';
import config from '../config/index';

const jwt = require('jsonwebtoken') as any;

export type JwtRequest = Request & {
  user?: Record<string, unknown>;
  whatsappCompanyId?: number;
};

function extractBearerToken(authHeader: unknown): string | null {
  if (typeof authHeader !== 'string') return null;
  const [scheme, token] = authHeader.split(' ');
  if (scheme !== 'Bearer' || !token) return null;
  return token;
}

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
    req.user = jwt.verify(token, config.jwt.secret);
    const companyId = resolveWhatsappCompanyId(req);
    if (config.security.whatsappApiRequireCompanyClaim && !hasCompanyClaim(req.user)) {
      return res.status(403).json({
        success: false,
        error: 'Empresa no asociada al token',
      });
    }
    req.whatsappCompanyId = companyId;
    return next();
  } catch {
    return res.status(401).json({
      success: false,
      error: 'Token invalido o expirado',
    });
  }
}

export function optionalWhatsappJwt(req: JwtRequest, res: Response, next: NextFunction): void | Response {
  if (!config.security.whatsappApiRequireJwt) {
    req.whatsappCompanyId = config.defaultCompanyId || 1;
    return next();
  }
  return requireJwt(req, res, next);
}

function toPositiveInt(value: unknown): number | null {
  const numberValue = Number(value);
  return Number.isInteger(numberValue) && numberValue > 0 ? numberValue : null;
}

function hasCompanyClaim(user: Record<string, unknown> | undefined): boolean {
  if (!user) return false;
  return Boolean(
    toPositiveInt(user.companyId) ||
    toPositiveInt(user.company_id) ||
    toPositiveInt(user.tenantId)
  );
}

export function resolveWhatsappCompanyId(req: JwtRequest): number {
  const user = req.user || {};
  return (
    toPositiveInt(user.companyId) ||
    toPositiveInt(user.company_id) ||
    toPositiveInt(user.tenantId) ||
    toPositiveInt(req.whatsappCompanyId) ||
    config.defaultCompanyId ||
    1
  );
}
