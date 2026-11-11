import { createProblemDetails, type StandardErrorCode } from '@whatsap-automat/contracts';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { TenantScopedUoW } from '../db/TenantScopedUoW';
import { requireJwt } from '../middleware/jwtAuth';
import { tenantContext } from '../middleware/tenantContext';
import {
  StrictWhatsappBindingConflictError,
  StrictWhatsappBindingError,
  StrictWhatsappRuntimeStore,
} from '../services/ai/runtime/StrictWhatsappRuntimeStore';

type BindingInput = {
  graphId: string;
  version: number;
  specHash: string;
  mode: 'suggest' | 'auto';
  expectedRevision: string | null;
  profile?: 'catalog-router-v1';
  evidenceVersion?: string;
  evidenceHash?: string;
};

function problem(req: Request, res: Response, code: StandardErrorCode, detail: string, bindingConflict = false) {
  const requestId = req.get('x-correlation-id') ?? req.get('x-request-id') ?? '';
  const body = createProblemDetails({
    code, detail, instance: req.originalUrl.split('?')[0],
    correlationId: /^[A-Za-z0-9_.:-]{1,128}$/.test(requestId) ? requestId : 'none',
  });
  return res.status(body.status).type('application/problem+json')
    .json(bindingConflict ? { ...body, code: 'BINDING_CONFLICT' } : body);
}

function readExpectedRevision(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === 'string' && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value)
    ? value.toLowerCase() : undefined;
}

function readBindingInput(body: unknown): BindingInput | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const value = body as Record<string, unknown>;
  const expectedRevision = readExpectedRevision(value.expectedRevision);
  if (expectedRevision === undefined ||
      Object.keys(value).some((key) => !['graphId', 'version', 'specHash', 'mode', 'expectedRevision', 'profile', 'evidenceVersion', 'evidenceHash'].includes(key)) ||
      typeof value.graphId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.graphId) ||
      typeof value.version !== 'number' || !Number.isSafeInteger(value.version) ||
      value.version < 1 || value.version > 2_147_483_647 ||
      typeof value.specHash !== 'string' || !/^[0-9a-f]{64}$/.test(value.specHash) ||
      (value.mode !== 'suggest' && value.mode !== 'auto')) return null;
  if (value.profile === undefined && (value.evidenceVersion !== undefined || value.evidenceHash !== undefined) ||
      value.profile !== undefined && (value.profile !== 'catalog-router-v1' || value.evidenceVersion !== 'catalog-publication-v1' ||
        typeof value.evidenceHash !== 'string' || !/^[0-9a-f]{64}$/.test(value.evidenceHash))) return null;
  return { graphId: value.graphId, version: value.version, specHash: value.specHash, mode: value.mode, expectedRevision,
    ...(value.profile === 'catalog-router-v1' ? { profile: value.profile, evidenceVersion: value.evidenceVersion as string,
      evidenceHash: value.evidenceHash as string } : {}) };
}

export default function createStrictWhatsappBindingRoutes(uow?: TenantScopedUoW): Router {
  const router = Router();
  const store = new StrictWhatsappRuntimeStore(uow);
  router.use(requireJwt, tenantContext({ allowSandbox: false, uow }));
  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    const actor = req.tenantContext;
    if (!actor?.userId || !Number.isSafeInteger(actor.userId) ||
        actor.tenantId > 2_147_483_647 || actor.role !== 'ADMIN') {
      problem(req, res, 'POLICY_DENIED', 'Tenant administrator access is required.');
      return;
    }
    if (Object.keys(req.query).length || (req.method === 'GET' && req.body !== undefined &&
        (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length))) {
      problem(req, res, 'VALIDATION_ERROR', 'This operation does not accept query parameters or ownership fields.');
      return;
    }
    next();
  });

  router.get('/', async (req, res) => {
    res.json({ binding: await store.getBinding(req.tenantContext!.tenantId) });
  });

  router.put('/', async (req, res) => {
    const input = readBindingInput(req.body);
    if (!input) {
      problem(req, res, 'VALIDATION_ERROR', 'An explicit graph ID, version, SHA-256 spec hash, suggest or auto mode and expectedRevision are required.');
      return;
    }
    const actor = req.tenantContext!;
    const { expectedRevision, ...pin } = input;
    const binding = await store.bind(actor.tenantId, { ...pin, actorId: actor.userId! }, expectedRevision);
    res.json({ binding });
  });

  router.delete('/', async (req, res) => {
    const expectedRevision = readExpectedRevision(req.body?.expectedRevision);
    if (expectedRevision === undefined || !req.body || typeof req.body !== 'object' ||
        Array.isArray(req.body) || Object.keys(req.body).some((key) => key !== 'expectedRevision')) {
      problem(req, res, 'VALIDATION_ERROR', 'An explicit expectedRevision is required to disable the binding.');
      return;
    }
    await store.unbind(req.tenantContext!.tenantId, expectedRevision);
    res.status(204).end();
  });

  router.use((error: unknown, req: Request, res: Response, next: NextFunction) => {
    if (error instanceof StrictWhatsappBindingConflictError) {
      problem(req, res, 'CONFLICT', 'The WhatsApp binding changed. Reload it before making another change.', true);
      return;
    }
    if (error instanceof StrictWhatsappBindingError) {
      problem(req, res, 'CONFLICT', 'A matching provider publication with the supported execution profile is required.');
      return;
    }
    next(new Error('The WhatsApp agent binding request could not be completed.'));
  });
  return router;
}

export function createStrictWhatsappSuggestionRoutes(uow?: TenantScopedUoW): Router {
  const router = Router();
  const store = new StrictWhatsappRuntimeStore(uow);
  router.use(requireJwt, tenantContext({ allowSandbox: false, uow }));
  router.get('/', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const actor = req.tenantContext;
    if (!actor?.userId || !Number.isSafeInteger(actor.userId) || actor.tenantId > 2_147_483_647 ||
        (actor.role !== 'ADMIN' && actor.role !== 'EMPLEADO')) {
      problem(req, res, 'POLICY_DENIED', 'Tenant administrator or employee access is required.');
      return;
    }
    const conversationId = req.query.conversationId;
    if (Object.keys(req.query).length !== 1 || typeof conversationId !== 'string' ||
        !/^[1-9]\d{0,18}$/.test(conversationId) || BigInt(conversationId) > 9_223_372_036_854_775_807n ||
        (req.body !== undefined && (!req.body || typeof req.body !== 'object' ||
          Array.isArray(req.body) || Object.keys(req.body).length))) {
      problem(req, res, 'VALIDATION_ERROR', 'A single positive conversationId is required.');
      return;
    }
    res.json({ suggestion: await store.getSuggestion(actor.tenantId, conversationId) });
  });
  router.use((_error: unknown, _req: Request, _res: Response, next: NextFunction) => {
    next(new Error('The WhatsApp suggestion request could not be completed.'));
  });
  return router;
}
