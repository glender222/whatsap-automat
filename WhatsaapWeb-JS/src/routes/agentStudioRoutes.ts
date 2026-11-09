import {
  agentGraphVersionV1Schema,
  createProblemDetails,
  type AgentGraphVersionV1,
  type InvalidParamDetail,
  type StandardErrorCode,
} from '@whatsap-automat/contracts';
import { type NextFunction, type Request, type Response, Router } from 'express';
import { TenantScopedUoW } from '../db/TenantScopedUoW';
import { requireJwt } from '../middleware/jwtAuth';
import { type TenantContext, tenantContext } from '../middleware/tenantContext';
import {
  listDrafts,
  loadDraft,
  saveDraft,
  validateDraft,
} from '../services/ai/studio/AgentStudioDrafts';

const graphIdSchema = agentGraphVersionV1Schema.shape.graphId.regex(/^[A-Za-z0-9_-]{1,128}$/);
const { entryNodeId, nodes, edges, policyRef, limits } = agentGraphVersionV1Schema.shape;
const graphDraftSchema = agentGraphVersionV1Schema.pick({
  entryNodeId: true, nodes: true, edges: true, policyRef: true, limits: true,
}).extend({
  entryNodeId: entryNodeId.max(128),
  nodes: nodes.max(128),
  edges: edges.max(512),
  policyRef: policyRef.max(255),
  limits: limits.refine((values) => Object.values(values).every(Number.isSafeInteger), {
    message: 'Limits must be safe integers',
  }),
}).strict();
const createGraphDraftSchema = graphDraftSchema.extend({ graphId: graphIdSchema });

type StudioActor = TenantContext & { userId: number };
type StudioHandler = (req: Request, res: Response, actor: StudioActor) => Promise<void>;

function problem(res: Response, code: StandardErrorCode, detail: string, invalidParams?: InvalidParamDetail[]) {
  const req = res.req;
  const requestId = req.get('x-correlation-id') ?? req.get('x-request-id') ?? '';
  const body = createProblemDetails({
    code,
    detail,
    instance: req.originalUrl.split('?')[0],
    correlationId: /^[A-Za-z0-9_.:-]{1,128}$/.test(requestId) ? requestId : 'none',
    invalidParams,
  });
  res.status(body.status).type('application/problem+json').json(body);
}

function guarded(handler: StudioHandler) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const actor = req.tenantContext;
    if (!actor?.userId || !Number.isSafeInteger(actor.userId) ||
        actor.tenantId > 2_147_483_647 || actor.role !== 'ADMIN') {
      problem(res, 'POLICY_DENIED', 'Tenant administrator access is required.');
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    handler(req, res, { ...actor, userId: actor.userId }).catch((error: unknown) => {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      console.error('Agent Studio request failed', { code });
      next(new Error('The Agent Studio request could not be completed.'));
    });
  };
}

function notFound(res: Response) {
  problem(res, 'NOT_FOUND', 'Agent graph revision was not found.');
}

function pathId(req: Request, res: Response) {
  const id = graphIdSchema.safeParse(req.params.id);
  if (!id.success) {
    problem(res, 'VALIDATION_ERROR', 'Invalid agent graph ID.');
    return null;
  }
  return id.data;
}

function readPositiveInt(value: unknown, max: number): number | null {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) return null;
  const number = Number(value);
  return number <= max ? number : null;
}

function withDraft(handler: (res: Response, draft: AgentGraphVersionV1) => void) {
  return guarded(async (req, res, actor) => {
    const id = pathId(req, res);
    if (!id) return;
    const rawVersion = req.query.version;
    const version = readPositiveInt(rawVersion, 2_147_483_647);
    if (rawVersion !== undefined && version === null) {
      problem(res, 'VALIDATION_ERROR', 'Invalid revision version.');
      return;
    }

    const draft = await actor.runInScope((db) => loadDraft(db, actor.tenantId, id, version));
    if (draft) handler(res, draft);
    else notFound(res);
  });
}

export default function createAgentStudioRoutes(uow?: TenantScopedUoW): Router {
  const router = Router();
  router.use(requireJwt, tenantContext({ allowSandbox: false, uow }));

  router.get('/', guarded(async (req, res, actor) => {
    const rawAfter = req.query.after;
    const after = rawAfter === undefined ? '' : graphIdSchema.safeParse(rawAfter);
    const limit = req.query.limit === undefined ? 20 : readPositiveInt(req.query.limit, 50);
    if ((after !== '' && !after.success) || limit === null) {
      problem(res, 'VALIDATION_ERROR', 'Invalid graph page parameters.');
      return;
    }
    const page = await actor.runInScope((db) => listDrafts(db, actor.tenantId, after === '' ? after : after.data, limit));
    res.json(page);
  }));

  router.post('/', guarded(async (req, res, actor) => {
    const input = createGraphDraftSchema.safeParse(req.body);
    if (!input.success) {
      problem(res, 'VALIDATION_ERROR', 'Invalid graph draft.', input.error.issues.map(issue => ({
        name: issue.path.join('.') || 'body', reason: issue.message,
      })));
      return;
    }
    const { graphId, ...spec } = input.data;
    const draft = await actor.runInScope((db) => saveDraft(db, actor.tenantId, actor.userId, graphId, spec, true));
    if (draft) res.status(201).json(draft);
    else problem(res, 'CONFLICT', 'An agent graph with this ID already exists.');
  }));

  router.get('/:id', withDraft((res, draft) => { res.json(draft); }));

  router.post('/:id/revisions', guarded(async (req, res, actor) => {
    const id = pathId(req, res);
    if (!id) return;
    const input = graphDraftSchema.safeParse(req.body);
    if (!input.success) {
      problem(res, 'VALIDATION_ERROR', 'Invalid graph revision.', input.error.issues.map(issue => ({
        name: issue.path.join('.') || 'body', reason: issue.message,
      })));
      return;
    }
    const draft = await actor.runInScope((db) => saveDraft(db, actor.tenantId, actor.userId, id, input.data, false));
    if (draft) res.status(201).json(draft);
    else notFound(res);
  }));

  router.post('/:id/validate', withDraft((res, draft) => { res.json(validateDraft(draft)); }));

  router.post('/:id/publish', withDraft((res, draft) => {
    res.status(501).json({
      code: 'PUBLICATION_UNAVAILABLE',
      detail: 'Publication requires a server-verified execution evaluation for this immutable revision.',
      graphId: draft.graphId,
      version: draft.version,
      specHash: draft.specHash,
    });
  }));

  return router;
}
