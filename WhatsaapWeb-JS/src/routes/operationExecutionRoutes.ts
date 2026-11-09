import { randomUUID } from 'node:crypto';
import { createProblemDetails, type StandardErrorCode } from '@whatsap-automat/contracts';
import { Router, type Response } from 'express';
import { requireJwt } from '../middleware/jwtAuth';
import { tenantContext } from '../middleware/tenantContext';
import { OperationExecutionService, parseExecutionFilters } from '../services/workflows/OperationExecutionService';

function problem(res: Response, code: StandardErrorCode, detail: string) {
  const body = createProblemDetails({
    code, detail, instance: res.req.originalUrl.split('?')[0], correlationId: randomUUID(),
  });
  return res.status(body.status).type('application/problem+json').json(body);
}

export default function createOperationExecutionRoutes(service = new OperationExecutionService()): Router {
  const router = Router();
  router.get('/executions', requireJwt, tenantContext({ allowSandbox: false }), async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const actor = req.tenantContext;
    if (!actor?.userId || !Number.isSafeInteger(actor.userId) || actor.tenantId > 2_147_483_647 ||
        actor.role !== 'ADMIN') {
      return problem(res, 'POLICY_DENIED', 'Tenant administrator access is required.');
    }
    const filters = parseExecutionFilters(req.query);
    if (!filters) return problem(res, 'VALIDATION_ERROR', 'Invalid execution filters or cursor.');
    try {
      return res.json(await service.list(actor.tenantId, filters));
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      console.error('Operation executions could not be read', { code });
      return problem(res, 'INTERNAL_ERROR', 'Operation executions could not be read.');
    }
  });

  return router;
}
