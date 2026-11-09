import { createProblemDetails, type StandardErrorCode } from '@whatsap-automat/contracts';
import { type Response, Router } from 'express';
import { requireJwt } from '../middleware/jwtAuth';
import { tenantContext } from '../middleware/tenantContext';
import { ChannelConnections } from '../services/channels/ChannelConnections';

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 255 && !/[\u0000-\u001f\u007f]/.test(value);
}

function problem(res: Response, code: StandardErrorCode, detail: string) {
  const req = res.req;
  const requestId = req.get('x-correlation-id') ?? req.get('x-request-id') ?? '';
  const body = createProblemDetails({
    code,
    detail,
    instance: req.originalUrl.split('?')[0],
    correlationId: /^[A-Za-z0-9_.:-]{1,128}$/.test(requestId) ? requestId : 'none',
  });
  return res.status(body.status).type('application/problem+json').json(body);
}

export default function createChannelConnectionRoutes(connections = new ChannelConnections()): Router {
  const router = Router();
  router.use(requireJwt, tenantContext({ allowSandbox: false }), (req, res, next) => {
    const actor = req.tenantContext;
    res.setHeader('Cache-Control', 'no-store');
    if (!actor?.userId || !Number.isSafeInteger(actor.userId) || actor.tenantId > 2_147_483_647) {
      return problem(res, 'POLICY_DENIED', 'Authenticated tenant identity is required.');
    }
    next();
  });

  router.get('/', async (req, res, next) => {
    const after = req.query.after;
    const rawLimit = req.query.limit;
    const limit = typeof rawLimit === 'string' && /^[1-9][0-9]{0,2}$/.test(rawLimit) ? Number(rawLimit) : null;
    if ((after !== undefined && !validId(after)) || (rawLimit !== undefined && (limit === null || limit > 100))) {
      return problem(res, 'VALIDATION_ERROR', 'Invalid channel connection page parameters.');
    }
    try {
      const { items, nextCursor } = await connections.list(req.tenantContext!.tenantId, after ?? '', limit ?? 50);
      if (nextCursor) {
        res.setHeader('X-Next-Cursor', encodeURIComponent(nextCursor));
        res.append('Access-Control-Expose-Headers', 'X-Next-Cursor');
      }
      return res.json(items);
    } catch {
      next(new Error('The channel connections could not be read.'));
    }
  });

  router.get('/:id', async (req, res, next) => {
    if (!validId(req.params.id)) return problem(res, 'VALIDATION_ERROR', 'Invalid channel connection ID.');
    try {
      const connection = await connections.get(req.tenantContext!.tenantId, req.params.id);
      if (!connection) return problem(res, 'NOT_FOUND', 'Channel connection was not found.');
      return res.json(connection);
    } catch {
      next(new Error('The channel connection could not be read.'));
    }
  });

  router.post('/:id/validate', async (req, res, next) => {
    const { role, tenantId } = req.tenantContext!;
    if (role !== 'ADMIN') return problem(res, 'POLICY_DENIED', 'Tenant administrator access is required.');
    if (!validId(req.params.id)) return problem(res, 'VALIDATION_ERROR', 'Invalid channel connection ID.');
    try {
      const health = await connections.validate(tenantId, req.params.id);
      if (!health) return problem(res, 'NOT_FOUND', 'Channel connection was not found.');
      return res.json(health);
    } catch {
      next(new Error('The channel connection could not be checked.'));
    }
  });

  return router;
}
