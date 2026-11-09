import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { createProblemDetails, StandardErrorCode } from '@whatsap-automat/contracts';
import { requireJwt } from '../middleware/jwtAuth';
import { resolveTenantContext, tenantContext } from '../middleware/tenantContext';
import { getCurrentWorkspace } from '../services/workspaces/WorkspaceQueryService';

export default function createWorkspaceRoutes(): Router {
  const router = Router();
  router.get('/current', requireJwt, tenantContext({ allowSandbox: false }), async (req, res, next) => {
    try {
      const session = resolveTenantContext(req);
      const workspace = session.userId ? await getCurrentWorkspace(session.tenantId, session.userId, session.role) : null;
      if (workspace) return res.json(workspace);

      const error = createProblemDetails({
        code: StandardErrorCode.POLICY_DENIED,
        detail: 'An active membership in the current workspace is required',
        instance: req.originalUrl,
        correlationId: randomUUID(),
      });
      return res.status(error.status).type('application/problem+json').json(error);
    } catch (error) {
      return next(error);
    }
  });
  return router;
}
