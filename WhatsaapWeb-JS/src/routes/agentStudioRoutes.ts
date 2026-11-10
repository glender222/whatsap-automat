import {
  agentGraphVersionV1Schema,
  agentSimulationRequestV1Schema,
  evalScenarioV1Schema,
  createProblemDetails,
  type AgentGraphVersionV1,
  type AgentSimulationResultV1,
  type InvalidParamDetail,
  type StandardErrorCode,
} from '@whatsap-automat/contracts';
import { type NextFunction, type Request, type Response, Router } from 'express';
import { TenantScopedUoW } from '../db/TenantScopedUoW';
import { requireJwt } from '../middleware/jwtAuth';
import { type TenantContext, tenantContext } from '../middleware/tenantContext';
import { agentEvalService, SimulationInputError } from '../services/ai/eval/AgentEvalService';
import { compileAgentExecutionProfile, executionProfile } from '../services/ai/studio/AgentExecutionProfile';
import { executionRunIdPattern, listExecutionSuites, saveExecutionSuite } from '../services/ai/studio/AgentExecutionEvidence';
import { AgentPublicationConflict } from '../services/ai/studio/AgentStudioPublications';
import type { StudioVerification } from '../services/ai/studio/StudioVerification';
import { boundedTextCapability, isBoundedText } from '../services/ai/gateway/BoundedTextCompletion';
import { preflightBoundedAgentDispatch } from '../services/ai/studio/BoundedAgentDispatch';
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
const simulationSchema = agentSimulationRequestV1Schema.extend({
  graphId: graphIdSchema.optional(),
  graphVersion: agentSimulationRequestV1Schema.shape.graphVersion.unwrap().max(2_147_483_647).optional(),
  mockInput: agentSimulationRequestV1Schema.shape.mockInput.max(2048),
  assertions: evalScenarioV1Schema.shape.assertions.removeDefault().max(16).optional(),
}).strict();
const runId = graphIdSchema.regex(executionRunIdPattern);
const suiteScenario = evalScenarioV1Schema.pick({ id: true, name: true, mockInput: true, expectedTextPatterns: true }).extend({
  id: graphIdSchema, mockInput: evalScenarioV1Schema.shape.mockInput.refine(isBoundedText),
  expectedTextPatterns: evalScenarioV1Schema.shape.expectedTextPatterns.removeDefault().min(1).max(8),
}).strict();
const suiteInput = createGraphDraftSchema.pick({}).extend({
  id: runId, name: evalScenarioV1Schema.shape.name.trim().min(1).max(120), scenarios: suiteScenario.array().min(1).max(20),
}).strict().refine(({ scenarios }) => new Set(scenarios.map(({ id }) => id)).size === scenarios.length);
const timeoutMs = agentGraphVersionV1Schema.shape.version.max(boundedTextCapability.maxTimeoutMs);
const evaluateInput = createGraphDraftSchema.pick({}).extend({ suiteId: graphIdSchema, runId, timeoutMs }).strict();
const publishInput = createGraphDraftSchema.pick({}).extend({ evaluationId: runId }).strict();
const executeInput = createGraphDraftSchema.pick({}).extend({
  attemptId: runId, timeoutMs, input: evalScenarioV1Schema.shape.mockInput.refine(isBoundedText),
}).strict();

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
      if (error instanceof SimulationInputError || error instanceof AgentPublicationConflict) {
        problem(res, error instanceof AgentPublicationConflict ? 'CONFLICT' : 'VALIDATION_ERROR', error.message);
        return;
      }
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

function withDraft(handler: (res: Response, draft: AgentGraphVersionV1, req: Request, actor: StudioActor) => void | Promise<void>, requireVersion = false) {
  return guarded(async (req, res, actor) => {
    const id = pathId(req, res);
    if (!id) return;
    const rawVersion = req.query.version;
    const version = readPositiveInt(rawVersion, 2_147_483_647);
    if (version === null && (rawVersion !== undefined || requireVersion)) {
      problem(res, 'VALIDATION_ERROR', requireVersion ? 'An explicit valid revision version is required.' : 'Invalid revision version.');
      return;
    }

    const draft = await actor.runInScope((db) => loadDraft(db, actor.tenantId, id, version));
    if (draft) await handler(res, draft, req, actor);
    else notFound(res);
  });
}

const simulateDraft = guarded(async (req, res, actor) => {
  const input = simulationSchema.safeParse(req.body);
  if (!input.success) {
    problem(res, 'VALIDATION_ERROR', 'Invalid agent simulation request.');
    return;
  }

  const pathGraphId = req.params.id === undefined ? undefined : pathId(req, res);
  if (pathGraphId === null) return;
  const { graphId = pathGraphId, graphVersion, mockInput, mockConversationState, assertions } = input.data;
  const queryVersion = readPositiveInt(req.query.version, 2_147_483_647);
  if (!graphId || (pathGraphId !== undefined && graphId !== pathGraphId) ||
      (req.query.version !== undefined && queryVersion === null) ||
      (queryVersion !== null && graphVersion !== undefined && queryVersion !== graphVersion)) {
    problem(res, 'VALIDATION_ERROR', 'Graph or revision identifiers are missing, invalid, or inconsistent.');
    return;
  }

  const graph = await actor.runInScope((db) => loadDraft(db, actor.tenantId, graphId, queryVersion ?? graphVersion ?? null));
  if (!graph) {
    notFound(res);
    return;
  }
  if (!validateDraft(graph).valid) {
    problem(res, 'VALIDATION_ERROR', 'The stored revision has structural errors. Use the validate endpoint for details.');
    return;
  }

  const scenario = evalScenarioV1Schema.parse({
    id: 'fixture', name: 'Fixture simulation', mockInput, mockConversationState, assertions,
  });
  try {
    const result = await agentEvalService.simulateScenario(actor.tenantId, graph, scenario);
    const lastStep = result.traceSteps[result.traceSteps.length - 1];
    const output: AgentSimulationResultV1 = {
      executedNodes: result.traceSteps.map((step) => ({
        nodeId: step.nodeId, kind: step.nodeKind, output: step.outputPayload ?? {}, durationMs: step.durationMs,
      })),
      simulatedMessages: result.traceSteps.flatMap((step) => {
        const text = step.outputPayload?.text;
        return step.nodeKind === 'agent' && typeof text === 'string' ? [{ kind: 'text', text }] : [];
      }),
      approvalsTriggered: result.traceSteps.filter((step) => step.nodeKind === 'approval').map((step) => ({
        nodeId: step.nodeId, risk: 'unclassified', action: 'fixture_approval',
      })),
      finalState: !result.passed ? 'failed' :
        lastStep?.nodeKind === 'handoff' ? 'handed_off' : 'completed',
      totalSteps: result.traceSteps.length,
    };
    res.json({
      ...output, graphId, graphVersion: graph.version, specHash: graph.specHash,
      mode: 'fixture', publicationEvidence: false,
      assertionsResults: result.assertionsResults, failureReasons: result.failureReasons,
    });
  } catch (error) {
    if (!(error instanceof SimulationInputError)) throw error;
    problem(res, 'VALIDATION_ERROR', error.message);
  }
});

export function createAgentSimulationRoutes(uow?: TenantScopedUoW): Router {
  const router = Router();
  router.post('/simulate', requireJwt, tenantContext({ allowSandbox: false, uow }), simulateDraft);
  return router;
}

export default function createAgentStudioRoutes(uow?: TenantScopedUoW, verification?: StudioVerification): Router {
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

  router.post('/:id/simulate', simulateDraft);

  router.post('/:id/validate', withDraft((res, draft) => { res.json(validateDraft(draft)); }));

  router.get('/:id/execution-preflight', withDraft((res, draft) => {
    const result = compileAgentExecutionProfile(draft);
    res.json({
      graphId: draft.graphId, version: draft.version, specHash: draft.specHash,
      scope: 'execution_profile', profile: executionProfile, publicationEvidence: false,
      compatible: result.compatible,
      nodeOrder: result.compatible ? result.plan.nodeOrder : [],
      issues: result.compatible ? [] : result.issues,
    });
  }, true));

  function unavailable(res: Response, draft: AgentGraphVersionV1) {
    res.status(501).json({
      code: 'PUBLICATION_UNAVAILABLE',
      detail: 'Publication requires a server-verified execution evaluation for this immutable revision.',
      graphId: draft.graphId,
      version: draft.version,
      specHash: draft.specHash,
    });
  }

  router.get('/:id/execution', withDraft(async (res, draft, _req, actor) => {
    if (!verification) {
      res.json({ mode: null, suites: [], active: null });
      return;
    }
    const preflight = preflightBoundedAgentDispatch({ tenantId: actor.tenantId, graph: draft, input: 'Verification preflight', timeoutMs: 1000 });
    const status = await actor.runInScope(async (db) => ({
      mode: verification.mode,
      profile: { compatible: preflight.ok, issue: preflight.ok ? null : preflight.code, model: boundedTextCapability.model },
      suites: await listExecutionSuites(db, actor.tenantId, draft.graphId),
      active: (await verification.publications.loadActive(db, actor.tenantId, draft.graphId))?.publication ?? null,
    }));
    res.json(status);
  }, true));

  router.post('/:id/evaluation-suites', withDraft(async (res, draft, req, actor) => {
    if (!verification) return unavailable(res, draft);
    const input = suiteInput.safeParse(req.body);
    if (!input.success) return problem(res, 'VALIDATION_ERROR', 'Invalid bounded text evaluation suite.');
    const suite = await actor.runInScope((db) => saveExecutionSuite(db, {
      ...input.data, tenantId: actor.tenantId, graphId: draft.graphId,
      scenarios: input.data.scenarios.map((scenario) => evalScenarioV1Schema.parse(scenario)),
    }));
    if (!suite) return problem(res, 'CONFLICT', 'The suite ID is already bound to another suite.');
    res.json(suite);
  }, true));

  router.post('/:id/evaluations', withDraft(async (res, draft, req, actor) => {
    if (!verification) return unavailable(res, draft);
    const input = evaluateInput.safeParse(req.body);
    if (!input.success) return problem(res, 'VALIDATION_ERROR', 'Invalid execution evaluation request.');
    const evaluation = await verification.evaluator.evaluate({
      ...input.data, tenantId: actor.tenantId, graphId: draft.graphId, version: draft.version,
    });
    res.status(evaluation.status === 'running' ? 202 : 200).json(evaluation);
  }, true));

  router.get('/:id/evaluations/:runId', withDraft(async (res, draft, req, actor) => {
    if (!verification) return unavailable(res, draft);
    const id = runId.safeParse(req.params.runId);
    if (!id.success) return problem(res, 'VALIDATION_ERROR', 'Invalid evaluation ID.');
    const evaluation = await verification.evaluator.read(actor.tenantId, draft.graphId, draft.version, id.data);
    if (!evaluation) return problem(res, 'NOT_FOUND', 'Evaluation was not found.');
    res.json(evaluation);
  }, true));

  router.post('/:id/publish', withDraft(async (res, draft, req, actor) => {
    if (!verification) return unavailable(res, draft);
    const input = publishInput.safeParse(req.body);
    if (!input.success) return problem(res, 'VALIDATION_ERROR', 'Invalid execution evaluation ID.');
    const publication = await actor.runInScope((db) => verification.publications.publish(db, {
      ...input.data, tenantId: actor.tenantId, actorId: actor.userId, graphId: draft.graphId, version: draft.version,
    }));
    if (!publication) return notFound(res);
    res.json(publication);
  }, Boolean(verification)));

  router.post('/:id/execute', withDraft(async (res, draft, req, actor) => {
    if (!verification) return unavailable(res, draft);
    const input = executeInput.safeParse(req.body);
    if (!input.success) return problem(res, 'VALIDATION_ERROR', 'Invalid verification execution request.');
    const result = await verification.execute({
      ...input.data, tenantId: actor.tenantId, graphId: draft.graphId, version: draft.version,
    });
    if (!result) return problem(res, 'CONFLICT', 'There is no active verification publication.');
    res.json(result);
  }, true));

  return router;
}
