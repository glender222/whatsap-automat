import { NextFunction, Request, Response } from 'express';
import config from '../config/index';
import { extractBearerToken, JwtRequest, toPositiveInt } from './jwtAuth';
import { tenantScopedUoW, TenantScopedUoW } from '../db/TenantScopedUoW';
import { Queryable } from '../shared/UnitOfWorkPort';

const jwt = require('jsonwebtoken') as any;

export interface TenantInfo {
  readonly id: number;
  readonly slug: string;
  readonly name?: string;
  readonly status?: string;
}

export interface WorkspaceInfo {
  readonly id?: number | string;
  readonly slug: string;
  readonly isDefault: boolean;
  readonly name?: string;
}

export interface TenantContext {
  readonly tenantId: number;
  readonly workspaceId?: number | string;
  readonly tenant: TenantInfo;
  readonly workspace: WorkspaceInfo;
  readonly userId?: number;
  readonly role?: string;
  readonly source: 'jwt_tenant' | 'legacy_company' | 'sandbox';
  readonly rawClaims?: Record<string, unknown>;
  runInScope<T>(work: (client: Queryable) => Promise<T>): Promise<T>;
}

export interface TenantContextOptions {
  required?: boolean;
  allowLegacyFallback?: boolean;
  allowSandbox?: boolean;
  jwtSecret?: string;
  uow?: TenantScopedUoW;
}

declare global {
  namespace Express {
    interface Request {
      tenantId?: number;
      workspaceId?: number | string;
      tenant?: TenantInfo;
      workspace?: WorkspaceInfo;
      tenantContext?: TenantContext;
      whatsappCompanyId?: number;
    }
  }
}

export type TenantScopedRequest = JwtRequest & {
  tenantId: number;
  workspaceId?: number | string;
  tenant: TenantInfo;
  workspace: WorkspaceInfo;
  tenantContext: TenantContext;
  whatsappCompanyId: number;
};

const WORKSPACE_SLUG_REGEX = /^[a-zA-Z0-9_\-]+$/;

function sanitizeWorkspaceSlug(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 64) return null;
  return WORKSPACE_SLUG_REGEX.test(trimmed) ? trimmed : null;
}

export function tenantContext(options: TenantContextOptions = {}) {
  const isRequired = options.required !== false;
  const allowLegacyFallback = options.allowLegacyFallback !== false;
  const allowSandbox = options.allowSandbox !== false;
  const secret = options.jwtSecret || config.jwt.secret || process.env.JWT_SECRET || '';
  const uowInstance = options.uow || tenantScopedUoW;

  return (req: Request, res: Response, next: NextFunction): void | Response => {
    let claims = (req as JwtRequest).user as Record<string, unknown> | undefined;

    // 1. If req.user not yet populated, verify JWT from header
    if (!claims) {
      const token = extractBearerToken(req.headers.authorization);
      if (!token) {
        if (!isRequired) {
          // Check sandbox fallback if applicable
          if (
            allowSandbox &&
            config.security?.allowInsecureSandbox &&
            process.env.NODE_ENV !== 'production' &&
            !config.security?.whatsappApiRequireJwt
          ) {
            const sandboxTenantId = config.security?.sandboxCompanyId || 1;
            const context: TenantContext = {
              tenantId: sandboxTenantId,
              workspaceId: undefined,
              tenant: { id: sandboxTenantId, slug: 'default-company', name: 'Sandbox Company', status: 'active' },
              workspace: { slug: 'default', isDefault: true, name: 'Default Workspace' },
              source: 'sandbox',
              runInScope: (work) => uowInstance.run(sandboxTenantId, work),
            };
            req.tenantId = sandboxTenantId;
            req.tenant = context.tenant;
            req.workspace = context.workspace;
            req.tenantContext = context;
            req.whatsappCompanyId = sandboxTenantId;
            return next();
          }
          return next();
        }

        return res.status(401).json({
          success: false,
          error: 'Token no proporcionado',
          details: 'Se requiere un token Bearer en el header Authorization',
        });
      }

      try {
        claims = jwt.verify(token, secret) as Record<string, unknown>;
        (req as JwtRequest).user = claims;
      } catch (err: any) {
        return res.status(401).json({
          success: false,
          error: 'Token invalido o expirado',
          details: err?.message || undefined,
        });
      }
    }

    // 2. Resolve Tenant ID
    const explicitTenantId = toPositiveInt(claims.tenantId) ?? toPositiveInt(claims.tenant_id);
    const legacyCompanyId = toPositiveInt(claims.companyId) ?? toPositiveInt(claims.company_id);
    const preAttachedCompanyId = toPositiveInt(req.whatsappCompanyId);

    let resolvedTenantId: number | null = null;
    let source: 'jwt_tenant' | 'legacy_company' | 'sandbox' = 'jwt_tenant';

    if (explicitTenantId) {
      if (legacyCompanyId && legacyCompanyId !== explicitTenantId) {
        return res.status(403).json({
          success: false,
          error: 'TENANT_CLAIM_CONFLICT',
          details: 'Conflicto entre tenantId y companyId en el token de autenticacion',
        });
      }
      resolvedTenantId = explicitTenantId;
      source = 'jwt_tenant';
    } else if (allowLegacyFallback && legacyCompanyId) {
      resolvedTenantId = legacyCompanyId;
      source = 'legacy_company';
    } else if (allowLegacyFallback && preAttachedCompanyId) {
      resolvedTenantId = preAttachedCompanyId;
      source = 'legacy_company';
    }

    if (!resolvedTenantId) {
      if (!isRequired) {
        return next();
      }
      return res.status(403).json({
        success: false,
        error: 'TENANT_CLAIM_REQUIRED',
        message: 'Empresa no asociada al token',
        details: 'El token carece de claim de empresa (tenantId/companyId) valido',
      });
    }

    // 3. Resolve Workspace ID & Slug
    const claimWorkspaceIdNum = toPositiveInt(claims.workspaceId) ?? toPositiveInt(claims.workspace_id);
    const claimWorkspaceSlug = sanitizeWorkspaceSlug(claims.workspaceSlug ?? claims.workspace_slug ?? claims.workspaceId ?? claims.workspace_id);

    const headerWorkspaceIdNum = toPositiveInt(req.headers['x-workspace-id']);
    const headerWorkspaceSlug = sanitizeWorkspaceSlug(req.headers['x-workspace-slug'] ?? req.headers['x-workspace-id']);

    let workspaceId: number | string | undefined = undefined;
    let workspaceSlug = 'default';
    let isDefaultWorkspace = true;

    if (headerWorkspaceIdNum || headerWorkspaceSlug) {
      workspaceId = headerWorkspaceIdNum || headerWorkspaceSlug || undefined;
      workspaceSlug = headerWorkspaceSlug || (headerWorkspaceIdNum ? `workspace-${headerWorkspaceIdNum}` : 'default');
      isDefaultWorkspace = workspaceSlug === 'default';
    } else if (claimWorkspaceIdNum || claimWorkspaceSlug) {
      workspaceId = claimWorkspaceIdNum || claimWorkspaceSlug || undefined;
      workspaceSlug = claimWorkspaceSlug || (claimWorkspaceIdNum ? `workspace-${claimWorkspaceIdNum}` : 'default');
      isDefaultWorkspace = workspaceSlug === 'default';
    }

    // 4. Resolve Tenant Metadata
    const tenantSlug = sanitizeWorkspaceSlug(claims.tenantSlug ?? claims.tenant_slug) ||
      (resolvedTenantId === 1 ? 'default-company' : `tenant-${resolvedTenantId}`);
    const tenantName = (typeof claims.companyName === 'string' && claims.companyName.trim()) ||
      (typeof claims.tenantName === 'string' && claims.tenantName.trim()) ||
      (resolvedTenantId === 1 ? 'Default Company' : `Tenant ${resolvedTenantId}`);

    // 5. Resolve User ID & Role
    const userId = toPositiveInt(claims.userId) ?? toPositiveInt(claims.id) ?? toPositiveInt(claims.sub) ?? undefined;
    const role = typeof claims.rol === 'string' ? claims.rol : typeof claims.role === 'string' ? claims.role : 'USER';

    // 6. Build TenantContext Object
    const currentTenantId = resolvedTenantId;
    const context: TenantContext = {
      tenantId: currentTenantId,
      workspaceId,
      tenant: {
        id: currentTenantId,
        slug: tenantSlug,
        name: tenantName,
        status: 'active',
      },
      workspace: {
        id: workspaceId,
        slug: workspaceSlug,
        isDefault: isDefaultWorkspace,
        name: isDefaultWorkspace ? 'Default Workspace' : `Workspace ${workspaceSlug}`,
      },
      userId,
      role,
      source,
      rawClaims: claims,
      runInScope: <T>(work: (client: Queryable) => Promise<T>): Promise<T> => {
        return uowInstance.run(currentTenantId, work);
      },
    };

    // 7. Decorate Request
    req.tenantId = currentTenantId;
    req.workspaceId = workspaceId;
    req.tenant = context.tenant;
    req.workspace = context.workspace;
    req.tenantContext = context;
    req.whatsappCompanyId = currentTenantId; // backward-compat

    return next();
  };
}

export const requireTenantContext = tenantContext({ required: true });
export const optionalTenantContext = tenantContext({ required: false });

export function resolveTenantContext(req: Request): TenantContext {
  if (req.tenantContext) {
    return req.tenantContext;
  }
  throw new Error('TENANT_CONTEXT_REQUIRED: No tenant context has been resolved on the current request');
}
