import { randomUUID } from 'node:crypto';
import { Request, Response, Router } from 'express';
import { createProblemDetails, StandardErrorCode, UNIFIED_RISK_LEVELS } from '@whatsap-automat/contracts';
import { requireJwt } from '../middleware/jwtAuth';
import { resolveTenantContext, tenantContext } from '../middleware/tenantContext';
import {
  ApprovalAlreadyDecidedError, ApprovalCasConflictError, ApprovalExpiredError,
  ApprovalIdempotencyConflictError, ApprovalNotFoundError, hitlApprovalService,
} from '../services/ai/broker';
import { getCurrentWorkspace } from '../services/workspaces/WorkspaceQueryService';

const identifier = /^[A-Za-z0-9_.:-]{1,128}$/;

function problem(req: Request, res: Response, code: StandardErrorCode, detail: string, status?: number) {
  const error = createProblemDetails({ code, detail, instance: req.path, correlationId: randomUUID() });
  return res.status(status ?? error.status).type('application/problem+json').json({ ...error, status: status ?? error.status });
}

function queryInteger(value: unknown, fallback: number, minimum: number, maximum: number): number | null {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d{1,5}$/.test(value)) return null;
  const number = Number(value);
  return number >= minimum && number <= maximum ? number : null;
}

export default function createApprovalRoutes(): Router {
  const router = Router();
  router.use(requireJwt, tenantContext({ allowSandbox: false }));
  router.use(async (req, res, next) => {
    const actor = resolveTenantContext(req);
    const workspace = actor.userId ? await getCurrentWorkspace(actor.tenantId, actor.userId, actor.role) : null;
    if (!workspace?.capabilities.includes('approvals.review')) {
      return problem(req, res, StandardErrorCode.POLICY_DENIED, 'Approval access requires an active administrator membership');
    }
    res.setHeader('Cache-Control', 'private, no-store');
    return next();
  });

  router.get('/', async (req, res) => {
    const limit = queryInteger(req.query.limit, 50, 1, 100);
    const offset = queryInteger(req.query.offset, 0, 0, 10000);
    const { risk, status } = req.query;
    if (limit === null || offset === null || (status !== undefined && status !== 'pending') ||
        (risk !== undefined && !UNIFIED_RISK_LEVELS.some((level) => level === risk))) {
      return problem(req, res, StandardErrorCode.VALIDATION_ERROR, 'Invalid pending approval filters');
    }
    return res.json(await hitlApprovalService.listPendingApprovals(resolveTenantContext(req).tenantId, {
      limit, offset, risk: typeof risk === 'string' ? risk : undefined,
    }));
  });

  router.get('/:id', async (req, res) => {
    const id = String(req.params.id);
    const approval = identifier.test(id)
      ? await hitlApprovalService.getApprovalById(resolveTenantContext(req).tenantId, id)
      : null;
    if (!approval) return problem(req, res, StandardErrorCode.NOT_FOUND, 'Approval was not found');
    const expired = approval.status === 'pending' && Date.parse(approval.expiresAt) <= Date.now();
    return res.json(expired ? { ...approval, status: 'expired' } : approval);
  });

  router.post('/:id/decision', async (req, res) => {
    const id = String(req.params.id);
    const key = req.get('Idempotency-Key');
    const { decision, expectedVersion, reason } = req.body ?? {};
    if (!identifier.test(id)) return problem(req, res, StandardErrorCode.NOT_FOUND, 'Approval was not found');
    if (!key || !identifier.test(key) || !['approved', 'rejected'].includes(decision) ||
        !Number.isSafeInteger(expectedVersion) || expectedVersion < 1 || expectedVersion > 2147483647 ||
        (reason !== undefined && (typeof reason !== 'string' || reason.length > 1000))) {
      return problem(req, res, StandardErrorCode.VALIDATION_ERROR, 'A valid key, decision, version and optional reason are required');
    }
    const actor = resolveTenantContext(req);
    try {
      const result = await hitlApprovalService.decideApproval({
        tenantId: actor.tenantId, approvalId: id, actorId: String(actor.userId), actorRole: 'admin',
        decision, expectedVersion, reason, idempotencyKey: key,
      });
      return res.json(result);
    } catch (error) {
      if (error instanceof ApprovalNotFoundError) return problem(req, res, StandardErrorCode.NOT_FOUND, 'Approval was not found');
      if (error instanceof ApprovalExpiredError) return problem(req, res, StandardErrorCode.CONFLICT, 'Approval has expired', 410);
      if (error instanceof ApprovalCasConflictError || error instanceof ApprovalAlreadyDecidedError ||
          error instanceof ApprovalIdempotencyConflictError) {
        return problem(req, res, StandardErrorCode.CONFLICT, error.message);
      }
      throw error;
    }
  });
  return router;
}
