import { Router, Request, Response } from 'express';
import { JwtRequest, requireJwt } from '../middleware/jwtAuth';
import { tenantContext } from '../middleware/tenantContext';
import {
  ByokService,
  QuotaManager,
  TokenCostLedger,
  ModelGateway,
  modelGateway as defaultGateway,
} from '../services/ai/gateway';
import {
  registerByokCredentialCommandV1Schema,
  testByokConnectionRequestV1Schema,
  tokenLedgerQueryV1Schema,
  modelGatewayRequestSchema,
  toolExecutionRequestV1Schema,
  createKnowledgeCollectionCommandV1Schema,
  ingestDocumentCommandV1Schema,
  knowledgeQueryRequestV1Schema,
  ragPurgeRequestV1Schema,
  evalSimulateRequestV1Schema,
} from '@whatsap-automat/contracts';
import {
  ToolBroker,
  ToolRegistry,
  HitlApprovalService,
  toolBroker as defaultToolBroker,
  toolRegistry as defaultToolRegistry,
  hitlApprovalService as defaultHitlApprovalService,
} from '../services/ai/broker';
import {
  KnowledgeBaseService,
  knowledgeBaseService as defaultKbService,
} from '../services/ai/rag/KnowledgeBaseService';
import {
  AgentEvalService,
  agentEvalService as defaultEvalService,
} from '../services/ai/eval/AgentEvalService';

function resolveActor(req: JwtRequest) {
  const user = req.user;
  const identity = user?.userId ?? user?.id ?? user?.sub;
  const id = typeof identity === 'string' || typeof identity === 'number' ? String(identity).trim() : '';
  const roles = [user?.rol, user?.role, ...(Array.isArray(user?.roles) ? user.roles : [])]
    .filter((role): role is string => typeof role === 'string' && role.trim().length > 0)
    .map((role) => role.trim().toLowerCase());
  return { id, roles: [...new Set(roles)] };
}

function approverRole(roles: string[]): string | undefined {
  return roles.find((role) => ['admin', 'owner', 'supervisor'].includes(role));
}

export interface AiRoutesOptions {
  gateway?: ModelGateway;
  byokService?: ByokService;
  quotaManager?: QuotaManager;
  ledger?: TokenCostLedger;
  toolBroker?: ToolBroker;
  toolRegistry?: ToolRegistry;
  hitlApprovalService?: HitlApprovalService;
  knowledgeBaseService?: KnowledgeBaseService;
  evalService?: AgentEvalService;
}

export default function createAiRoutes(options: AiRoutesOptions = {}): Router {
  const router = Router();
  const gateway = options.gateway || defaultGateway;
  const byok = options.byokService || new ByokService();
  const quota = options.quotaManager || new QuotaManager();
  const ledger = options.ledger || new TokenCostLedger();
  const broker = options.toolBroker || defaultToolBroker;
  const registry = options.toolRegistry || defaultToolRegistry;
  const hitl = options.hitlApprovalService || defaultHitlApprovalService;
  const kbService = options.knowledgeBaseService || defaultKbService;
  const evalService = options.evalService || defaultEvalService;

  function resolveTenantId(req: Request): number {
    const id = req.tenantId ?? req.tenantContext?.tenantId ?? req.whatsappCompanyId;
    if (!id || id <= 0) {
      const err = new Error('Tenant context is required for AI operations') as any;
      err.statusCode = 401;
      err.code = 'UNAUTHORIZED';
      throw err;
    }
    return Number(id);
  }

  // 1. GET /api/v1/ai/providers - List configured BYOK providers with masked fingerprints
  router.get('/providers', requireJwt, tenantContext(), async (req: Request, res: Response) => {
    try {
      const tenantId = resolveTenantId(req);
      const providers = await byok.listCredentialSummaries(tenantId);
      res.status(200).json({ success: true, data: providers });
    } catch (err: any) {
      res.status(err.statusCode || 500).json({
        success: false,
        error: err.code || 'INTERNAL_ERROR',
        message: err.message,
      });
    }
  });

  // 2. POST /api/v1/ai/providers - Save or update BYOK credentials
  router.post('/providers', requireJwt, tenantContext(), async (req: Request, res: Response) => {
    try {
      const tenantId = resolveTenantId(req);
      const parsed = registerByokCredentialCommandV1Schema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: 'VALIDATION_ERROR',
          message: 'Invalid BYOK configuration',
          details: parsed.error.issues,
        });
        return;
      }

      const { provider, apiKey, baseUrl, defaultModel } = parsed.data;
      const result = await byok.saveCredential(
        tenantId,
        provider,
        apiKey,
        baseUrl || null,
        defaultModel || null
      );

      res.status(200).json({
        success: true,
        message: 'Provider credential saved securely',
        keyFingerprint: result.keyFingerprint,
      });
    } catch (err: any) {
      if (err.code === 'POLICY_DENIED' || err.statusCode === 403) {
        res.status(403).json({
          success: false,
          error: 'POLICY_DENIED',
          code: 'SSRF_BLOCKED',
          message: err.message,
        });
        return;
      }
      res.status(err.statusCode || 500).json({
        success: false,
        error: err.code || 'INTERNAL_ERROR',
        message: err.message,
      });
    }
  });

  // 3. POST /api/v1/ai/providers/test - Test connection to provider
  router.post('/providers/test', requireJwt, tenantContext(), async (req: Request, res: Response) => {
    try {
      const tenantId = resolveTenantId(req);
      const parsed = testByokConnectionRequestV1Schema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: 'VALIDATION_ERROR',
          message: 'Invalid test connection request',
          details: parsed.error.issues,
        });
        return;
      }

      const result = await gateway.testConnection(tenantId, parsed.data);
      res.status(result.ok ? 200 : 400).json({
        success: result.ok,
        data: result,
      });
    } catch (err: any) {
      res.status(err.statusCode || 500).json({
        success: false,
        error: err.code || 'INTERNAL_ERROR',
        message: err.message,
      });
    }
  });

  // 4. GET /api/v1/ai/usage/summary - Monthly spend, tokens, and quota summary
  router.get('/usage/summary', requireJwt, tenantContext(), async (req: Request, res: Response) => {
    try {
      const tenantId = resolveTenantId(req);
      const summary = await quota.getSummary(tenantId);
      res.status(200).json({ success: true, data: summary });
    } catch (err: any) {
      res.status(err.statusCode || 500).json({
        success: false,
        error: err.code || 'INTERNAL_ERROR',
        message: err.message,
      });
    }
  });

  // 5. GET /api/v1/ai/usage/ledger - Paginated immutable token cost ledger
  router.get('/usage/ledger', requireJwt, tenantContext(), async (req: Request, res: Response) => {
    try {
      const tenantId = resolveTenantId(req);
      const parsed = tokenLedgerQueryV1Schema.safeParse({
        cursor: req.query.cursor,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        agentRunId: req.query.agentRunId,
        provider: req.query.provider,
        model: req.query.model,
        startDate: req.query.startDate,
        endDate: req.query.endDate,
      });

      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: 'VALIDATION_ERROR',
          message: 'Invalid query parameters',
          details: parsed.error.issues,
        });
        return;
      }

      const result = await ledger.query(tenantId, parsed.data);
      res.status(200).json({
        success: true,
        data: result.items,
        nextCursor: result.nextCursor,
      });
    } catch (err: any) {
      res.status(err.statusCode || 500).json({
        success: false,
        error: err.code || 'INTERNAL_ERROR',
        message: err.message,
      });
    }
  });

  // 6. POST /api/v1/ai/completions - Provider-neutral ModelGateway completion endpoint
  router.post('/completions', requireJwt, tenantContext(), async (req: Request, res: Response) => {
    try {
      const tenantId = resolveTenantId(req);
      const requestPayload = {
        ...req.body,
        tenantId,
        workspaceId: req.body.workspaceId ?? req.workspaceId ?? req.tenantContext?.workspaceId,
      };

      const parsed = modelGatewayRequestSchema.safeParse(requestPayload);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: 'VALIDATION_ERROR',
          message: 'Invalid completion request',
          details: parsed.error.issues,
        });
        return;
      }

      const result = await gateway.complete(parsed.data);
      res.status(200).json({ success: true, data: result });
    } catch (err: any) {
      if (err.code === 'RATE_LIMITED' || err.statusCode === 429) {
        res.status(429).json({
          success: false,
          error: 'RATE_LIMITED',
          message: err.message,
        });
        return;
      }
      res.status(err.statusCode || 500).json({
        success: false,
        error: err.code || 'INTERNAL_ERROR',
        message: err.message,
      });
    }
  });

  // 7. GET /api/v1/ai/tools - List tool catalog with 5-tier risk taxonomy
  router.get('/tools', requireJwt, tenantContext(), async (req: Request, res: Response) => {
    try {
      const tenantId = resolveTenantId(req);
      const tools = await registry.listTools(tenantId);
      res.status(200).json({ success: true, data: tools.map((t) => t.definition) });
    } catch (err: any) {
      res.status(err.statusCode || 500).json({
        success: false,
        error: err.code || 'INTERNAL_ERROR',
        message: err.message,
      });
    }
  });

  // 8. POST /api/v1/ai/tools/execute - Intercepted tool execution endpoint
  router.post('/tools/execute', requireJwt, tenantContext(), async (req: Request, res: Response) => {
    try {
      const tenantId = resolveTenantId(req);
      const actor = resolveActor(req);
      if (!actor.id || actor.roles.length === 0) {
        res.status(403).json({ success: false, error: 'POLICY_DENIED', message: 'Tool execution requires an authenticated actor and role' });
        return;
      }
      const parsed = toolExecutionRequestV1Schema.safeParse({
        ...req.body,
        tenantId,
        actorId: actor.id,
        actorRoles: actor.roles,
      });

      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: 'VALIDATION_ERROR',
          message: 'Invalid tool execution request',
          details: parsed.error.issues,
        });
        return;
      }

      const result = await broker.execute(parsed.data);
      const statusCode =
        result.status === 'unauthorized'
          ? 403
          : result.status === 'budget_exhausted'
          ? 429
          : result.status === 'cas_conflict'
          ? 409
          : result.status === 'ssrf_blocked'
          ? 403
          : 200;

      res.status(statusCode).json({ success: result.success, data: result });
    } catch (err: any) {
      res.status(err.statusCode || 500).json({
        success: false,
        error: err.code || 'INTERNAL_ERROR',
        message: err.message,
      });
    }
  });

  // 9. GET /api/v1/ai/approvals - List pending HITL approvals for tenant
  router.get('/approvals', requireJwt, tenantContext(), async (req: Request, res: Response) => {
    try {
      const tenantId = resolveTenantId(req);
      const actor = resolveActor(req);
      if (!actor.id || !approverRole(actor.roles)) {
        res.status(403).json({ success: false, error: 'POLICY_DENIED', message: 'Approval access requires an authorized reviewer' });
        return;
      }
      const limit = req.query.limit ? Number(req.query.limit) : 50;
      const offset = req.query.offset ? Number(req.query.offset) : 0;

      const approvals = await hitl.listPendingApprovals(tenantId, { limit, offset });
      res.status(200).json({ success: true, data: approvals });
    } catch (err: any) {
      res.status(err.statusCode || 500).json({
        success: false,
        error: err.code || 'INTERNAL_ERROR',
        message: err.message,
      });
    }
  });

  // 10. POST /api/v1/ai/approvals/:id/decision - Approve or reject with CAS expected version
  router.post('/approvals/:id/decision', requireJwt, tenantContext(), async (req: Request, res: Response) => {
    try {
      const tenantId = resolveTenantId(req);
      const approvalId = String(req.params.id);
      const actor = resolveActor(req);
      const actorRole = approverRole(actor.roles);
      if (!actor.id || !actorRole) {
        res.status(403).json({ success: false, error: 'POLICY_DENIED', message: 'Approval decisions require an authorized reviewer' });
        return;
      }
      const { decision, reason, expectedVersion } = req.body;

      if (!decision || (decision !== 'approved' && decision !== 'rejected')) {
        res.status(400).json({
          success: false,
          error: 'VALIDATION_ERROR',
          message: "Field 'decision' must be either 'approved' or 'rejected'",
        });
        return;
      }

      if (!Number.isSafeInteger(Number(expectedVersion)) || Number(expectedVersion) < 1) {
        res.status(400).json({
          success: false,
          error: 'VALIDATION_ERROR',
          message: "Field 'expectedVersion' is required and must be a positive integer",
        });
        return;
      }

      const result = await hitl.decideApproval({
        tenantId,
        approvalId,
        decision,
        reason,
        expectedVersion: Number(expectedVersion),
        actorId: actor.id,
        actorRole,
      });

      res.status(200).json({ success: true, data: result });
    } catch (err: any) {
      res.status(err.statusCode || 500).json({
        success: false,
        error: err.code || 'INTERNAL_ERROR',
        message: err.message,
      });
    }
  });

  // 11. GET /api/v1/ai/rag/collections - List tenant RAG collections
  router.get('/rag/collections', requireJwt, tenantContext(), async (req: Request, res: Response) => {
    try {
      const tenantId = resolveTenantId(req);
      const collections = await kbService.listCollections(tenantId);
      res.status(200).json({ success: true, data: collections });
    } catch (err: any) {
      res.status(err.statusCode || 500).json({
        success: false,
        error: err.code || 'INTERNAL_ERROR',
        message: err.message,
      });
    }
  });

  // 12. POST /api/v1/ai/rag/collections - Create new RAG collection
  router.post('/rag/collections', requireJwt, tenantContext(), async (req: Request, res: Response) => {
    try {
      const tenantId = resolveTenantId(req);
      const parsed = createKnowledgeCollectionCommandV1Schema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: 'VALIDATION_ERROR',
          message: 'Invalid knowledge collection configuration',
          details: parsed.error.issues,
        });
        return;
      }
      const collection = await kbService.createCollection(tenantId, parsed.data);
      res.status(201).json({ success: true, data: collection });
    } catch (err: any) {
      res.status(err.statusCode || 500).json({
        success: false,
        error: err.code || 'INTERNAL_ERROR',
        message: err.message,
      });
    }
  });

  // 13. GET /api/v1/ai/rag/collections/:id - Get collection by ID
  router.get('/rag/collections/:id', requireJwt, tenantContext(), async (req: Request, res: Response) => {
    try {
      const tenantId = resolveTenantId(req);
      const collection = await kbService.getCollection(tenantId, String(req.params.id));
      if (!collection) {
        res.status(404).json({
          success: false,
          error: 'COLLECTION_NOT_FOUND',
          message: `Collection '${req.params.id}' not found`,
        });
        return;
      }
      res.status(200).json({ success: true, data: collection });
    } catch (err: any) {
      res.status(err.statusCode || 500).json({
        success: false,
        error: err.code || 'INTERNAL_ERROR',
        message: err.message,
      });
    }
  });

  // 14. DELETE /api/v1/ai/rag/collections/:id - Delete collection and its chunks
  router.delete('/rag/collections/:id', requireJwt, tenantContext(), async (req: Request, res: Response) => {
    try {
      const tenantId = resolveTenantId(req);
      const deleted = await kbService.deleteCollection(tenantId, String(req.params.id));
      if (!deleted) {
        res.status(404).json({
          success: false,
          error: 'COLLECTION_NOT_FOUND',
          message: `Collection '${req.params.id}' not found or already deleted`,
        });
        return;
      }
      res.status(200).json({ success: true, message: 'Collection and chunks deleted successfully' });
    } catch (err: any) {
      res.status(err.statusCode || 500).json({
        success: false,
        error: err.code || 'INTERNAL_ERROR',
        message: err.message,
      });
    }
  });

  // 15. POST /api/v1/ai/rag/collections/:id/documents - Ingest document into collection
  router.post('/rag/collections/:id/documents', requireJwt, tenantContext(), async (req: Request, res: Response) => {
    try {
      const tenantId = resolveTenantId(req);
      const collectionId = String(req.params.id);
      const parsed = ingestDocumentCommandV1Schema.safeParse({
        ...req.body,
        collectionId,
      });
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: 'VALIDATION_ERROR',
          message: 'Invalid document ingestion payload',
          details: parsed.error.issues,
        });
        return;
      }
      const result = await kbService.ingestDocument(tenantId, parsed.data);
      res.status(201).json({ success: true, data: result });
    } catch (err: any) {
      res.status(err.statusCode || 500).json({
        success: false,
        error: err.code || 'INTERNAL_ERROR',
        message: err.message,
      });
    }
  });

  // 16. POST /api/v1/ai/rag/query - Semantic vector search
  router.post('/rag/query', requireJwt, tenantContext(), async (req: Request, res: Response) => {
    try {
      const tenantId = resolveTenantId(req);
      const parsed = knowledgeQueryRequestV1Schema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: 'VALIDATION_ERROR',
          message: 'Invalid knowledge query request',
          details: parsed.error.issues,
        });
        return;
      }
      const results = await kbService.queryKnowledge(tenantId, parsed.data);
      res.status(200).json({ success: true, data: results });
    } catch (err: any) {
      res.status(err.statusCode || 500).json({
        success: false,
        error: err.code || 'INTERNAL_ERROR',
        message: err.message,
      });
    }
  });

  // 17. DELETE & POST /api/v1/ai/rag/purge - GDPR Right-to-be-Forgotten purge
  const purgeHandler = async (req: Request, res: Response) => {
    try {
      const tenantId = resolveTenantId(req);
      const parsed = ragPurgeRequestV1Schema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: 'VALIDATION_ERROR',
          message: 'Invalid purge request payload',
          details: parsed.error.issues,
        });
        return;
      }
      const result = await kbService.purgeKnowledge(tenantId, parsed.data);
      res.status(200).json({ success: true, data: result });
    } catch (err: any) {
      res.status(err.statusCode || 500).json({
        success: false,
        error: err.code || 'INTERNAL_ERROR',
        message: err.message,
      });
    }
  };
  router.delete('/rag/purge', requireJwt, tenantContext(), purgeHandler);
  router.post('/rag/purge', requireJwt, tenantContext(), purgeHandler);

  // 18. POST /api/v1/ai/eval/simulate - Dry-run sandbox regression simulator
  router.post('/eval/simulate', requireJwt, tenantContext({ allowSandbox: false }), async (req: Request, res: Response) => {
    try {
      const tenantId = resolveTenantId(req);
      if (!req.tenantContext?.userId || req.tenantContext.role !== 'ADMIN') {
        res.status(403).json({ success: false, error: 'POLICY_DENIED', message: 'Simulation requires a tenant administrator' });
        return;
      }
      const parsed = evalSimulateRequestV1Schema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: 'VALIDATION_ERROR',
          message: 'Invalid simulation payload',
          details: parsed.error.issues,
        });
        return;
      }

      const { graph, suite, scenarios, baselineVersion } = parsed.data;
      const targetSuite = suite || {
        id: `suite_${graph.graphId}`,
        tenantId,
        agentGraphId: graph.graphId,
        name: `Benchmark Suite for ${graph.graphId}`,
        scenarios: scenarios && scenarios.length > 0 ? scenarios : [
          {
            id: 'scen_default_1',
            name: 'Verificación de Stock Básica',
            mockInput: 'Hola, tienen stock del producto PROD-4091?',
            mockConversationState: {},
            expectedTools: ['inventory.check_stock'],
            forbiddenTools: ['order.cancel'],
            expectedTextPatterns: ['stock'],
            forbiddenTextPatterns: ['password', 'secret_key'],
            assertions: [],
          },
        ],
        passThresholdPercent: 95.0,
        baselineVersion,
      };

      const scorecard = await evalService.simulateSuite(tenantId, graph, targetSuite);
      res.status(200).json({ success: true, mode: 'simulation', publicationEvidence: false, data: scorecard });
    } catch (err: any) {
      res.status(err.statusCode || 500).json({
        success: false,
        error: err.code || 'INTERNAL_ERROR',
        message: err.message,
      });
    }
  });

  router.post('/agents/:id/publish', requireJwt, tenantContext(), (_req: Request, res: Response) => {
    res.status(501).json({
      success: false,
      error: 'PUBLICATION_UNAVAILABLE',
      message: 'Agent publication requires a persisted revision and a server-verified evaluation',
    });
  });

  return router;
}

