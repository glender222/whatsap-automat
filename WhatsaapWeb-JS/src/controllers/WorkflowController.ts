import { Request, Response, NextFunction } from 'express';
import {
  createProblemDetails,
  StandardErrorCode,
} from '@whatsap-automat/contracts';
import { JwtRequest, resolveWhatsappCompanyId, toPositiveInt } from '../middleware/jwtAuth';
import {
  workflowTriggerService,
  WorkflowTriggerService,
} from '../services/workflows/WorkflowTriggerService';
import {
  workflowRevisionService,
  WorkflowRevisionService,
} from '../services/workflows/WorkflowRevisionService';
import {
  TriggerNotFoundError,
  TriggerInactiveError,
  WebhookAuthenticationError,
  WorkflowNotPublishedError,
  WorkflowNotFoundError,
  WorkflowArchivedError,
  RevisionNotFoundError,
} from '../services/workflows/types';

function getCorrelationId(req: Request): string {
  return (
    (req.headers?.['x-correlation-id'] as string) ||
    (req.headers?.['x-request-id'] as string) ||
    'none'
  );
}

function setProblemContentType(res: Response): void {
  if (typeof res.setHeader === 'function') {
    res.setHeader('Content-Type', 'application/problem+json');
  }
}

export class WorkflowController {
  constructor(
    private readonly triggerService: WorkflowTriggerService = workflowTriggerService,
    private readonly revisionService: WorkflowRevisionService = workflowRevisionService
  ) {}

  /**
   * Channel-less Inbound Webhook (UC-06)
   * POST /api/v1/workflows/triggers/webhook/:endpointKey
   */
  handleWebhookTrigger = async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    const correlationId = getCorrelationId(req);
    const instance = req.originalUrl || req.url;
    const endpointKey = String(req.params?.endpointKey || '').trim();

    if (!endpointKey || !/^[a-zA-Z0-9_\-]{3,128}$/.test(endpointKey)) {
      setProblemContentType(res);
      res.status(400).json(
        createProblemDetails({
          code: StandardErrorCode.VALIDATION_ERROR,
          title: 'Invalid Endpoint Key',
          detail:
            'endpointKey must be 3-128 alphanumeric characters (hyphens and underscores allowed)',
          instance,
          correlationId,
        })
      );
      return;
    }

    // Extract authorization token from headers or query
    const headers = req.headers || {};
    const authHeader = headers['authorization'];
    const xToken = headers['x-webhook-token'] as string | undefined;
    let token: string | undefined = undefined;

    if (xToken) {
      token = xToken;
    } else if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.slice(7).trim();
    } else if (typeof req.query?.token === 'string') {
      token = req.query.token;
    }

    try {
      const result = await this.triggerService.processInboundWebhook(
        endpointKey,
        token,
        headers,
        req.body || {}
      );

      res.status(202).json({
        status: 'accepted',
        runId: result.runId,
        workflowId: result.workflowId,
        revisionId: result.revisionId,
        idempotencyKey: result.idempotencyKey,
        duplicate: result.duplicate,
      });
    } catch (err: any) {
      setProblemContentType(res);

      if (err instanceof TriggerNotFoundError) {
        res.status(404).json(
          createProblemDetails({
            code: StandardErrorCode.NOT_FOUND,
            title: 'Trigger Not Found',
            detail: err.message,
            instance,
            correlationId,
          })
        );
        return;
      }

      if (err instanceof TriggerInactiveError) {
        res.status(403).json(
          createProblemDetails({
            code: StandardErrorCode.POLICY_DENIED,
            title: 'Trigger Inactive',
            detail: err.message,
            instance,
            correlationId,
          })
        );
        return;
      }

      if (err instanceof WebhookAuthenticationError) {
        res.status(401).json(
          createProblemDetails({
            code: StandardErrorCode.UNAUTHORIZED,
            title: 'Unauthorized Webhook Trigger',
            detail: err.message,
            instance,
            correlationId,
          })
        );
        return;
      }

      if (err instanceof WorkflowNotPublishedError) {
        res.status(409).json(
          createProblemDetails({
            code: StandardErrorCode.CONFLICT,
            title: 'Workflow Not Published',
            detail: err.message,
            instance,
            correlationId,
          })
        );
        return;
      }

      next(err);
    }
  };

  /**
   * Atomic Rollback Engine
   * POST /api/v1/workflows/:id/rollback
   */
  rollbackWorkflow = async (
    req: JwtRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    const correlationId = getCorrelationId(req);
    const instance = req.originalUrl || req.url;
    const workflowId = String(req.params?.id || '').trim();

    if (!workflowId) {
      setProblemContentType(res);
      res.status(400).json(
        createProblemDetails({
          code: StandardErrorCode.VALIDATION_ERROR,
          title: 'Missing Workflow ID',
          detail: 'Workflow ID parameter is required',
          instance,
          correlationId,
        })
      );
      return;
    }

    let tenantId: number | null = null;
    try {
      tenantId = resolveWhatsappCompanyId(req);
    } catch {
      tenantId = req.tenantId || null;
    }

    if (!tenantId) {
      setProblemContentType(res);
      res.status(403).json(
        createProblemDetails({
          code: StandardErrorCode.POLICY_DENIED,
          title: 'Missing Tenancy Context',
          detail: 'Authenticated tenant context could not be resolved',
          instance,
          correlationId,
        })
      );
      return;
    }

    // Cross-tenant payload anti-spoofing check
    if (req.body?.tenantId && toPositiveInt(req.body.tenantId) !== tenantId) {
      setProblemContentType(res);
      res.status(403).json(
        createProblemDetails({
          code: StandardErrorCode.POLICY_DENIED,
          title: 'Cross-Tenant Access Denied',
          detail: 'Tenant ID in payload does not match authenticated token',
          instance,
          correlationId,
        })
      );
      return;
    }

    const targetRevisionNumber =
      req.body?.targetRevisionNumber !== undefined && req.body?.targetRevisionNumber !== null
        ? Number(req.body.targetRevisionNumber)
        : undefined;
    const targetRevisionId =
      typeof req.body?.targetRevisionId === 'string'
        ? req.body.targetRevisionId.trim()
        : undefined;
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';

    if (!reason || reason.length < 5) {
      setProblemContentType(res);
      res.status(400).json(
        createProblemDetails({
          code: StandardErrorCode.VALIDATION_ERROR,
          title: 'Validation Error',
          detail: 'reason is mandatory and must contain at least 5 characters',
          instance,
          correlationId,
          invalidParams: [{ name: 'reason', reason: 'Must be at least 5 characters' }],
        })
      );
      return;
    }

    if (targetRevisionNumber === undefined && !targetRevisionId) {
      setProblemContentType(res);
      res.status(400).json(
        createProblemDetails({
          code: StandardErrorCode.VALIDATION_ERROR,
          title: 'Validation Error',
          detail: 'Either targetRevisionNumber or targetRevisionId must be provided',
          instance,
          correlationId,
          invalidParams: [
            { name: 'targetRevisionNumber', reason: 'Missing target revision pointer' },
          ],
        })
      );
      return;
    }

    const userId = Number(req.user?.userId || req.user?.id || req.body?.userId) || 1;

    try {
      const result = await this.revisionService.rollbackRevision(tenantId, workflowId, {
        targetRevisionNumber,
        targetRevisionId,
        reason,
        userId,
      });

      res.status(200).json({
        success: true,
        workflowId: result.workflowId,
        previousRevisionId: result.previousRevisionId,
        publishedRevisionId: result.publishedRevisionId,
        targetRevisionNumber: result.targetRevisionNumber,
        latencyMs: result.latencyMs,
        updatedAt: result.updatedAt,
      });
    } catch (err: any) {
      setProblemContentType(res);

      if (err instanceof WorkflowNotFoundError) {
        res.status(404).json(
          createProblemDetails({
            code: StandardErrorCode.NOT_FOUND,
            title: 'Workflow Not Found',
            detail: err.message,
            instance,
            correlationId,
          })
        );
        return;
      }

      if (err instanceof WorkflowArchivedError) {
        res.status(409).json(
          createProblemDetails({
            code: StandardErrorCode.CONFLICT,
            title: 'Workflow Archived',
            detail: err.message,
            instance,
            correlationId,
          })
        );
        return;
      }

      if (err instanceof RevisionNotFoundError) {
        res.status(404).json(
          createProblemDetails({
            code: StandardErrorCode.NOT_FOUND,
            title: 'Revision Not Found',
            detail: err.message,
            instance,
            correlationId,
          })
        );
        return;
      }

      next(err);
    }
  };
}

export const workflowController = new WorkflowController();
