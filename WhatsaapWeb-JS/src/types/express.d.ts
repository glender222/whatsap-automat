import type { TenantContext, TenantInfo, WorkspaceInfo } from '../middleware/tenantContext';

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

export {};
