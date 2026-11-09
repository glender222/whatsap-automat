import { Request, Response, NextFunction } from 'express';
import { createProblemDetails, StandardErrorCode } from '@whatsap-automat/contracts';
import { extractBearerToken, toPositiveInt } from '../middleware/jwtAuth';
import { workflowTriggerService, WorkflowTriggerService } from '../services/workflows/WorkflowTriggerService';
import { workflowRevisionService, WorkflowRevisionService } from '../services/workflows/WorkflowRevisionService';
import {
  RevisionNotFoundError,
  TriggerInactiveError,
  TriggerNotFoundError,
  WebhookAuthenticationError,
  WorkflowArchivedError,
  WorkflowIdempotencyConflictError,
  WorkflowInputError,
  WorkflowNotFoundError,
  WorkflowNotPublishedError,
  WorkflowPolicyError,
} from '../services/workflows/types';

function getActor(req: Request, needsAdmin = true) {
  const actor = req.tenantContext;
  if (!actor?.userId || (needsAdmin && actor.role !== 'ADMIN')) {
    throw new WorkflowPolicyError(needsAdmin ? 'Administrator access is required.' : 'Authenticated tenant identity is required.');
  }
  if (req.body?.tenantId !== undefined && toPositiveInt(req.body.tenantId) !== actor.tenantId) {
    throw new WorkflowPolicyError('Tenant ID in payload does not match the authenticated tenant.');
  }
  return actor;
}

function readId(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) {
    throw new WorkflowInputError(`Invalid ${name}.`);
  }
  return value;
}

function sendFailure(error: unknown, req: Request, res: Response, next: NextFunction): void {
  let problem: { status: number; code: StandardErrorCode; title: string };
  if (error instanceof WorkflowInputError) {
    problem = { status: 400, code: StandardErrorCode.VALIDATION_ERROR, title: 'Validation Error' };
  } else if (error instanceof WebhookAuthenticationError) {
    problem = { status: 401, code: StandardErrorCode.UNAUTHORIZED, title: 'Unauthorized Webhook Trigger' };
  } else if (error instanceof WorkflowPolicyError || error instanceof TriggerInactiveError) {
    problem = { status: 403, code: StandardErrorCode.POLICY_DENIED, title: 'Workflow Access Denied' };
  } else if (error instanceof TriggerNotFoundError || error instanceof WorkflowNotFoundError ||
             error instanceof RevisionNotFoundError) {
    problem = { status: 404, code: StandardErrorCode.NOT_FOUND, title: 'Workflow Resource Not Found' };
  } else if (error instanceof WorkflowNotPublishedError || error instanceof WorkflowArchivedError ||
             error instanceof WorkflowIdempotencyConflictError) {
    problem = { status: 409, code: StandardErrorCode.CONFLICT, title: 'Workflow Conflict' };
  } else {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    console.error('Workflow request failed', { code });
    next(new Error('The workflow request could not be completed.'));
    return;
  }

  const correlation = req.headers['x-correlation-id'] ?? req.headers['x-request-id'];
  const correlationId = typeof correlation === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(correlation) ? correlation : 'none';
  res.setHeader('Content-Type', 'application/problem+json');
  res.status(problem.status).json({
    ...createProblemDetails({
      code: problem.code,
      title: problem.title,
      detail: error.message,
      instance: (req.originalUrl || req.url).split('?')[0],
      correlationId,
    }),
    status: problem.status,
  });
}

export class WorkflowController {
  constructor(
    private readonly triggerService: WorkflowTriggerService = workflowTriggerService,
    private readonly revisionService: WorkflowRevisionService = workflowRevisionService
  ) {}

  handleWebhookTrigger = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const endpointKey = readId(req.params.endpointKey, 'endpoint key');
      if (endpointKey.length < 3) throw new WorkflowInputError('Endpoint key must contain at least three characters.');
      const body = req.body ?? {};
      if (typeof body !== 'object' || Array.isArray(body)) {
        throw new WorkflowInputError('Webhook payload must be a JSON object.');
      }
      const headerToken = req.headers['x-webhook-token'];
      const token = typeof headerToken === 'string' ? headerToken.trim() : extractBearerToken(req.headers.authorization) ?? undefined;
      const result = await this.triggerService.processInboundWebhook(endpointKey, token, req.headers, body);
      res.status(202).json(result);
    } catch (error) {
      sendFailure(error, req, res, next);
    }
  };

  createWorkflow = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { tenantId } = getActor(req);
      const draft = await this.revisionService.createWorkflow(tenantId, req.body ?? {});
      res.status(201).json({ success: true, data: draft });
    } catch (error) {
      sendFailure(error, req, res, next);
    }
  };

  createRevision = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { tenantId } = getActor(req);
      const workflowId = readId(req.params.id, 'workflow ID');
      const draft = await this.revisionService.createRevision(tenantId, workflowId, req.body?.dagGraph, req.body?.limits);
      res.status(201).json({ success: true, data: draft });
    } catch (error) {
      sendFailure(error, req, res, next);
    }
  };

  publishWorkflow = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { tenantId } = getActor(req);
      const workflowId = readId(req.params.id, 'workflow ID');
      const revisionId = readId(req.body?.revisionId, 'revision ID');
      const published = await this.revisionService.publishRevision(tenantId, workflowId, revisionId);
      res.status(200).json({ success: true, data: published });
    } catch (error) {
      sendFailure(error, req, res, next);
    }
  };

  createWebhookTrigger = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { tenantId } = getActor(req);
      const workflowId = readId(req.params.id, 'workflow ID');
      const trigger = await this.revisionService.createWebhookTrigger(tenantId, workflowId);
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(201).json({ success: true, data: trigger });
    } catch (error) {
      sendFailure(error, req, res, next);
    }
  };

  setWebhookTriggerActive = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { tenantId } = getActor(req);
      const workflowId = readId(req.params.id, 'workflow ID');
      const triggerId = readId(req.params.triggerId, 'trigger ID');
      const isActive = req.body?.isActive;
      if (typeof isActive !== 'boolean') throw new WorkflowInputError('isActive must be a boolean.');
      const trigger = await this.revisionService.setWebhookTriggerActive(tenantId, workflowId, triggerId, isActive);
      res.status(200).json({ success: true, data: trigger });
    } catch (error) {
      sendFailure(error, req, res, next);
    }
  };

  getRun = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { tenantId } = getActor(req, false);
      const runId = readId(req.params.runId, 'workflow run ID');
      const run = await this.revisionService.getRun(tenantId, runId);
      if (!run) throw new WorkflowNotFoundError(runId);
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(200).json({ success: true, data: run });
    } catch (error) {
      sendFailure(error, req, res, next);
    }
  };

  rollbackWorkflow = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { tenantId, userId } = getActor(req);
      const workflowId = readId(req.params.id, 'workflow ID');
      const body = req.body ?? {};
      const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
      if (reason.length < 5 || reason.length > 500) {
        throw new WorkflowInputError('Rollback reason must contain 5-500 characters.');
      }
      const targetRevisionNumber = body.targetRevisionNumber == null ? undefined : toPositiveInt(body.targetRevisionNumber);
      const targetRevisionId = body.targetRevisionId == null ? undefined : readId(body.targetRevisionId, 'target revision ID');
      if (targetRevisionNumber === null || (targetRevisionNumber === undefined && !targetRevisionId)) {
        throw new WorkflowInputError('Specify a target revision ID or positive revision number.');
      }
      const result = await this.revisionService.rollbackRevision(tenantId, workflowId, {
        targetRevisionNumber, targetRevisionId, reason, userId,
      });
      res.status(200).json(result);
    } catch (error) {
      sendFailure(error, req, res, next);
    }
  };
}

export const workflowController = new WorkflowController();
