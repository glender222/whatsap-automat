// Invariants before config load
process.env.JWT_SECRET = 'test-only-jwt-secret-with-at-least-32-characters-for-testing';
process.env.DB_PASSWORD = 'test-only-database-password';

import assert from 'node:assert/strict';
import { describe, test, beforeEach } from 'node:test';
import crypto from 'node:crypto';
import type { QueryResult } from 'pg';
import type { Request, Response, NextFunction } from 'express';

const {
  WorkflowTriggerService,
} = require('../services/workflows/WorkflowTriggerService') as typeof import('../services/workflows/WorkflowTriggerService');
const {
  WorkflowRevisionService,
} = require('../services/workflows/WorkflowRevisionService') as typeof import('../services/workflows/WorkflowRevisionService');
const {
  WorkflowController,
} = require('../controllers/WorkflowController') as typeof import('../controllers/WorkflowController');
const {
  TriggerNotFoundError,
  TriggerInactiveError,
  WebhookAuthenticationError,
  WorkflowNotPublishedError,
  WorkflowNotFoundError,
  WorkflowArchivedError,
  RevisionNotFoundError,
} = require('../services/workflows/types') as typeof import('../services/workflows/types');
const { TenantScopedUoW } = require('../db/TenantScopedUoW') as typeof import('../db/TenantScopedUoW');
const { OutboxRepository } = require('../services/outbox/OutboxRepository') as typeof import('../services/outbox/OutboxRepository');
import type { Queryable } from '../shared/UnitOfWorkPort';
import type { JwtRequest } from '../middleware/jwtAuth';

// =============================================================================
// Comprehensive Mock Database Engine for Ingress & Rollback
// =============================================================================

interface MockDefinitionRow {
  id: string;
  tenant_id: number;
  workspace_id?: number | null;
  name: string;
  description?: string | null;
  published_revision_id: string | null;
  status: 'draft' | 'published' | 'archived';
  created_at: Date;
  updated_at: Date;
}

interface MockRevisionRow {
  id: string;
  tenant_id: number;
  workflow_id: string;
  revision_number: number;
  status: 'draft' | 'published' | 'archived';
  dag_graph: any;
  spec_hash: string;
  limits: any;
  published_at?: Date | null;
  created_at: Date;
}

interface MockTriggerRow {
  id: string;
  tenant_id: number;
  workspace_id?: number | null;
  workflow_id: string;
  type: string;
  endpoint_key: string;
  auth_token_hash?: string | null;
  cron_expression?: string | null;
  is_active: boolean;
  metadata: any;
}

interface MockWorkflowRunRow {
  id: string;
  tenant_id: number;
  workspace_id?: number | null;
  workflow_id: string;
  revision_id: string;
  temporal_workflow_id: string;
  correlation_id: string;
  trigger_type: string;
  trigger_payload: any;
  status: string;
  current_step: string;
  step_count: number;
  state_snapshot: any;
  started_at: Date;
  completed_at?: Date | null;
}

interface MockOutboxRow {
  id: string;
  tenant_id: number;
  workspace_id?: number | null;
  event_type: string;
  event_id: string;
  correlation_id: string;
  idempotency_key: string;
  payload: any;
  status: string;
  created_at: Date;
}

interface MockIdempotencyLedgerRow {
  id: string;
  tenant_id: number;
  idempotency_key: string;
  source: string;
  request_hash?: string;
  response_status: number;
  response_body: any;
  created_at: Date;
}

function createMockWorkflowsDb() {
  const definitions: MockDefinitionRow[] = [];
  const revisions: MockRevisionRow[] = [];
  const triggers: MockTriggerRow[] = [];
  const runs: MockWorkflowRunRow[] = [];
  const outbox: MockOutboxRow[] = [];
  const idempotencyLedger: MockIdempotencyLedgerRow[] = [];

  const mockClient: Queryable = {
    query: async (text: string | { text: string; values?: unknown[] }, values?: unknown[]): Promise<QueryResult<any>> => {
      const sql = (typeof text === 'string' ? text : text.text).trim();
      const params = typeof text === 'string' ? values || [] : text.values || [];

      // Global query for triggers: SELECT ... FROM workflow_triggers WHERE endpoint_key = $1
      if (/SELECT[\s\S]*FROM\s+workflow_triggers[\s\S]*WHERE\s+endpoint_key\s*=\s*\$1/i.test(sql)) {
        const key = String(params[0]);
        const match = triggers.find((t) => t.endpoint_key === key);
        return { rows: match ? [match] : [], rowCount: match ? 1 : 0, command: 'SELECT', oid: 0, fields: [] };
      }

      // SELECT FROM idempotency_ledger WHERE tenant_id = $1 AND idempotency_key = $2
      if (/SELECT[\s\S]*FROM\s+idempotency_ledger[\s\S]*WHERE\s+tenant_id\s*=\s*\$1/i.test(sql)) {
        const tenantId = Number(params[0]);
        const key = String(params[1]);
        const match = idempotencyLedger.find((r) => r.tenant_id === tenantId && r.idempotency_key === key);
        return { rows: match ? [match] : [], rowCount: match ? 1 : 0, command: 'SELECT', oid: 0, fields: [] };
      }

      // SELECT FROM workflow_definitions WHERE id = $1 AND tenant_id = $2
      if (/SELECT[\s\S]*FROM\s+workflow_definitions[\s\S]*WHERE\s+id\s*=\s*\$1\s+AND\s+tenant_id\s*=\s*\$2/i.test(sql)) {
        const id = String(params[0]);
        const tenantId = Number(params[1]);
        const match = definitions.find((d) => d.id === id && d.tenant_id === tenantId);
        return { rows: match ? [{ ...match }] : [], rowCount: match ? 1 : 0, command: 'SELECT', oid: 0, fields: [] };
      }

      // SELECT FROM workflow_revisions WHERE id = $1 AND tenant_id = $2
      if (/SELECT[\s\S]*FROM\s+workflow_revisions[\s\S]*WHERE\s+id\s*=\s*\$1\s+AND\s+tenant_id\s*=\s*\$2/i.test(sql)) {
        const id = String(params[0]);
        const tenantId = Number(params[1]);
        const match = revisions.find((r) => r.id === id && r.tenant_id === tenantId);
        return { rows: match ? [{ ...match }] : [], rowCount: match ? 1 : 0, command: 'SELECT', oid: 0, fields: [] };
      }

      // SELECT FROM workflow_revisions WHERE workflow_id = $1 AND tenant_id = $2 AND revision_number = $3
      if (/SELECT[\s\S]*FROM\s+workflow_revisions[\s\S]*WHERE\s+workflow_id\s*=\s*\$1\s+AND\s+tenant_id\s*=\s*\$2\s+AND\s+revision_number\s*=\s*\$3/i.test(sql)) {
        const workflowId = String(params[0]);
        const tenantId = Number(params[1]);
        const revNum = Number(params[2]);
        const match = revisions.find((r) => r.workflow_id === workflowId && r.tenant_id === tenantId && r.revision_number === revNum);
        return { rows: match ? [{ ...match }] : [], rowCount: match ? 1 : 0, command: 'SELECT', oid: 0, fields: [] };
      }

      // SELECT FROM workflow_revisions WHERE workflow_id = $1 AND tenant_id = $2 AND id = $3
      if (/SELECT[\s\S]*FROM\s+workflow_revisions[\s\S]*WHERE\s+workflow_id\s*=\s*\$1\s+AND\s+tenant_id\s*=\s*\$2\s+AND\s+id\s*=\s*\$3/i.test(sql)) {
        const workflowId = String(params[0]);
        const tenantId = Number(params[1]);
        const revId = String(params[2]);
        const match = revisions.find((r) => r.workflow_id === workflowId && r.tenant_id === tenantId && r.id === revId);
        return { rows: match ? [{ ...match }] : [], rowCount: match ? 1 : 0, command: 'SELECT', oid: 0, fields: [] };
      }

      // UPDATE workflow_definitions SET published_revision_id = $1 ...
      if (/UPDATE\s+workflow_definitions\s+SET\s+published_revision_id\s*=\s*\$1/i.test(sql)) {
        const targetRevId = String(params[0]);
        const id = String(params[1]);
        const tenantId = Number(params[2]);
        const match = definitions.find((d) => d.id === id && d.tenant_id === tenantId);
        if (match) {
          match.published_revision_id = targetRevId;
          match.status = 'published';
          match.updated_at = new Date();
          return { rows: [{ id: match.id, published_revision_id: targetRevId, updated_at: match.updated_at }], rowCount: 1, command: 'UPDATE', oid: 0, fields: [] };
        }
        return { rows: [], rowCount: 0, command: 'UPDATE', oid: 0, fields: [] };
      }

      // UPDATE workflow_revisions SET status = 'published' ...
      if (/UPDATE\s+workflow_revisions\s+SET\s+status\s*=\s*'published'/i.test(sql)) {
        const revId = String(params[0]);
        const tenantId = Number(params[1]);
        const match = revisions.find((r) => r.id === revId && r.tenant_id === tenantId);
        if (match) {
          match.status = 'published';
          match.published_at = new Date();
          return { rows: [match], rowCount: 1, command: 'UPDATE', oid: 0, fields: [] };
        }
        return { rows: [], rowCount: 0, command: 'UPDATE', oid: 0, fields: [] };
      }

      // INSERT INTO workflow_runs
      if (/INSERT\s+INTO\s+workflow_runs/i.test(sql)) {
        const runId = String(params[0]);
        const tenantId = Number(params[1]);
        const workspaceId = params[2] !== null ? Number(params[2]) : null;
        const workflowId = String(params[3]);
        const revisionId = String(params[4]);
        const temporalWorkflowId = String(params[5]);
        const correlationId = String(params[6]);
        const triggerPayload = typeof params[7] === 'string' ? JSON.parse(params[7]) : params[7];

        const newRun: MockWorkflowRunRow = {
          id: runId,
          tenant_id: tenantId,
          workspace_id: workspaceId,
          workflow_id: workflowId,
          revision_id: revisionId,
          temporal_workflow_id: temporalWorkflowId,
          correlation_id: correlationId,
          trigger_type: 'webhook',
          trigger_payload: triggerPayload,
          status: 'queued',
          current_step: 'phase_ingestion',
          step_count: 0,
          state_snapshot: {},
          started_at: new Date(),
        };
        runs.push(newRun);
        return { rows: [newRun], rowCount: 1, command: 'INSERT', oid: 0, fields: [] };
      }

      // INSERT INTO idempotency_ledger
      if (/INSERT\s+INTO\s+idempotency_ledger/i.test(sql)) {
        const tenantId = Number(params[0]);
        const key = String(params[1]);
        const newRow: MockIdempotencyLedgerRow = {
          id: crypto.randomUUID(),
          tenant_id: tenantId,
          idempotency_key: key,
          source: 'test',
          response_status: 200,
          response_body: params[params.length - 1],
          created_at: new Date(),
        };
        idempotencyLedger.push(newRow);
        return { rows: [newRow], rowCount: 1, command: 'INSERT', oid: 0, fields: [] };
      }

      // INSERT INTO processing_outbox
      if (/INSERT\s+INTO\s+processing_outbox/i.test(sql)) {
        const tenantId = Number(params[0]);
        const workspaceId = params[1] !== null ? Number(params[1]) : null;
        const eventType = String(params[2]);
        const eventId = String(params[3] || crypto.randomUUID());
        const correlationId = String(params[4]);
        const idempotencyKey = String(params[5]);
        const payload = typeof params[6] === 'string' ? JSON.parse(params[6]) : params[6];

        const existing = outbox.find((o) => o.tenant_id === tenantId && o.idempotency_key === idempotencyKey);
        if (existing) {
          return { rows: [existing], rowCount: 1, command: 'INSERT', oid: 0, fields: [] };
        }

        const newRow: MockOutboxRow = {
          id: crypto.randomUUID(),
          tenant_id: tenantId,
          workspace_id: workspaceId,
          event_type: eventType,
          event_id: eventId,
          correlation_id: correlationId,
          idempotency_key: idempotencyKey,
          payload,
          status: 'pending',
          created_at: new Date(),
        };
        outbox.push(newRow);
        return { rows: [newRow], rowCount: 1, command: 'INSERT', oid: 0, fields: [] };
      }

      return { rows: [], rowCount: 0, command: 'UNKNOWN', oid: 0, fields: [] };
    },
  };

  const mockPool = {
    query: mockClient.query,
    connect: async () => mockClient,
  };

  const mockUow = {
    run: async <T>(tenantId: number, work: (client: Queryable) => Promise<T>): Promise<T> => {
      return await work(mockClient);
    },
  } as unknown as TenantScopedUoW;

  const mockOutboxRepo = new OutboxRepository(mockPool as any, mockUow);

  return {
    definitions,
    revisions,
    triggers,
    runs,
    outbox,
    idempotencyLedger,
    mockPool,
    mockUow,
    mockOutboxRepo,
  };
}

describe('PR-F4-02: Workflow Ingress & Atomic Rollback Engine', { concurrency: 1 }, () => {
  let db: ReturnType<typeof createMockWorkflowsDb>;
  let triggerService: import('../services/workflows/WorkflowTriggerService').WorkflowTriggerService;
  let revisionService: import('../services/workflows/WorkflowRevisionService').WorkflowRevisionService;
  let controller: import('../controllers/WorkflowController').WorkflowController;

  const validToken = 'super-secure-token-2026';
  const validTokenHash = crypto.createHash('sha256').update(validToken).digest('hex');

  beforeEach(() => {
    db = createMockWorkflowsDb();

    // Seed Definition: Order Processing Workflow
    db.definitions.push({
      id: 'wf_order_pipeline',
      tenant_id: 1,
      workspace_id: 10,
      name: 'Order Pipeline',
      description: 'UC-06 business workflow',
      published_revision_id: 'rev_wf_order_2',
      status: 'published',
      created_at: new Date(),
      updated_at: new Date(),
    });

    // Seed Revision 1 (spec v1)
    db.revisions.push({
      id: 'rev_wf_order_1',
      tenant_id: 1,
      workflow_id: 'wf_order_pipeline',
      revision_number: 1,
      status: 'published',
      dag_graph: { nodes: [{ id: 'n1', kind: 'trigger', config: {} }], edges: [] },
      spec_hash: '1111111111111111111111111111111111111111111111111111111111111111',
      limits: { maxSteps: 100 },
      published_at: new Date(),
      created_at: new Date(),
    });

    // Seed Revision 2 (spec v2 - current published)
    db.revisions.push({
      id: 'rev_wf_order_2',
      tenant_id: 1,
      workflow_id: 'wf_order_pipeline',
      revision_number: 2,
      status: 'published',
      dag_graph: { nodes: [{ id: 'n1', kind: 'trigger', config: {} }], edges: [] },
      spec_hash: '2222222222222222222222222222222222222222222222222222222222222222',
      limits: { maxSteps: 100 },
      published_at: new Date(),
      created_at: new Date(),
    });

    // Seed Trigger: Webhook for UC-06
    db.triggers.push({
      id: 'trig_order_webhook',
      tenant_id: 1,
      workspace_id: 10,
      workflow_id: 'wf_order_pipeline',
      type: 'webhook',
      endpoint_key: 'sap-erp-orders-inbound',
      auth_token_hash: validTokenHash,
      is_active: true,
      metadata: { source: 'SAP ERP' },
    });

    // Seed In-Flight Run pinned to Revision 1
    db.runs.push({
      id: 'run_inflight_pinned_to_rev1',
      tenant_id: 1,
      workspace_id: 10,
      workflow_id: 'wf_order_pipeline',
      revision_id: 'rev_wf_order_1',
      temporal_workflow_id: 'wf_1_inflight_rev1',
      correlation_id: 'corr_inflight_1',
      trigger_type: 'webhook',
      trigger_payload: { orderId: 'ord_pinned' },
      status: 'running',
      current_step: 'phase_approval_gate',
      step_count: 2,
      state_snapshot: {},
      started_at: new Date(),
    });

    triggerService = new WorkflowTriggerService(db.mockPool as any, db.mockUow, db.mockOutboxRepo);
    revisionService = new WorkflowRevisionService(db.mockPool as any, db.mockUow);
    controller = new WorkflowController(triggerService, revisionService);
  });

  describe('Suite 1: Inbound Webhook Ingress (UC-06)', { concurrency: 1 }, () => {
    test('accepts valid webhook with token, commits to outbox and returns 202 Accepted', async () => {
      const req: Partial<Request> = {
        params: { endpointKey: 'sap-erp-orders-inbound' },
        headers: {
          'x-webhook-token': validToken,
          'x-correlation-id': 'corr_erp_999',
          'x-idempotency-key': 'idemp_order_123',
        },
        body: { orderId: 'ord_123', amount: 4500, customer: 'Acme Corp' },
      };

      let statusCode = 0;
      let jsonPayload: any = null;

      const res: Partial<Response> = {
        status: (code: number) => {
          statusCode = code;
          return res as Response;
        },
        json: (payload: any) => {
          jsonPayload = payload;
          return res as Response;
        },
      };

      await controller.handleWebhookTrigger(req as Request, res as Response, () => {});

      assert.strictEqual(statusCode, 202);
      assert.strictEqual(jsonPayload.status, 'accepted');
      assert.strictEqual(jsonPayload.workflowId, 'wf_order_pipeline');
      assert.strictEqual(jsonPayload.revisionId, 'rev_wf_order_2');
      assert.strictEqual(jsonPayload.duplicate, false);

      // Verify outbox record
      assert.strictEqual(db.outbox.length, 1);
      assert.strictEqual(db.outbox[0].event_type, 'workflow.trigger.webhook');
      assert.strictEqual(db.outbox[0].idempotency_key, 'idemp_order_123');
      assert.strictEqual(db.outbox[0].payload.workflowType, 'ChannelLessBusinessWorkflow');

      // Verify workflow_runs queued record
      assert.strictEqual(db.runs.length, 2);
      const queuedRun = db.runs.find((r) => r.id === jsonPayload.runId);
      assert.ok(queuedRun);
      assert.strictEqual(queuedRun.revision_id, 'rev_wf_order_2');
      assert.strictEqual(queuedRun.status, 'queued');
    });

    test('rejects missing or invalid token with 401 Unauthorized ProblemDetails', async () => {
      const req: Partial<Request> = {
        params: { endpointKey: 'sap-erp-orders-inbound' },
        headers: { 'x-webhook-token': 'wrong-token' },
        body: { orderId: 'ord_123' },
      };

      let statusCode = 0;
      let jsonPayload: any = null;
      const res: Partial<Response> = {
        setHeader: () => res as Response,
        status: (code: number) => {
          statusCode = code;
          return res as Response;
        },
        json: (payload: any) => {
          jsonPayload = payload;
          return res as Response;
        },
      };

      await controller.handleWebhookTrigger(req as Request, res as Response, () => {});

      assert.strictEqual(statusCode, 401);
      assert.strictEqual(jsonPayload.code, 'UNAUTHORIZED');
      assert.strictEqual(db.outbox.length, 0, 'No outbox record should be created on 401');
    });

    test('returns cached 202 Accepted on duplicate request without creating redundant outbox record', async () => {
      const req: Partial<Request> = {
        params: { endpointKey: 'sap-erp-orders-inbound' },
        headers: {
          'x-webhook-token': validToken,
          'x-idempotency-key': 'idemp_duplicate_test',
        },
        body: { orderId: 'ord_duplicate' },
      };

      const executeRequest = async () => {
        let code = 0;
        let payload: any = null;
        const res: Partial<Response> = {
          status: (c: number) => {
            code = c;
            return res as Response;
          },
          json: (p: any) => {
            payload = p;
            return res as Response;
          },
        };
        await controller.handleWebhookTrigger(req as Request, res as Response, () => {});
        return { code, payload };
      };

      // Call 1
      const res1 = await executeRequest();
      assert.strictEqual(res1.code, 202);
      assert.strictEqual(res1.payload.duplicate, false);

      // Call 2 (duplicate)
      const res2 = await executeRequest();
      assert.strictEqual(res2.code, 202);
      assert.strictEqual(res2.payload.duplicate, true);
      assert.strictEqual(res2.payload.runId, res1.payload.runId);

      // Verify strictly 1 outbox record
      assert.strictEqual(db.outbox.length, 1);
    });

    test('rejects disabled trigger with 403 POLICY_DENIED', async () => {
      db.triggers[0].is_active = false;

      const req: Partial<Request> = {
        params: { endpointKey: 'sap-erp-orders-inbound' },
        headers: { 'x-webhook-token': validToken },
      };

      let code = 0;
      let payload: any = null;
      const res: Partial<Response> = {
        setHeader: () => res as Response,
        status: (c: number) => {
          code = c;
          return res as Response;
        },
        json: (p: any) => {
          payload = p;
          return res as Response;
        },
      };

      await controller.handleWebhookTrigger(req as Request, res as Response, () => {});
      assert.strictEqual(code, 403);
      assert.strictEqual(payload.code, 'POLICY_DENIED');
    });

    test('rejects non-existent endpoint key with 404 NOT_FOUND', async () => {
      const req: Partial<Request> = {
        params: { endpointKey: 'non-existent-endpoint' },
      };

      let code = 0;
      let payload: any = null;
      const res: Partial<Response> = {
        setHeader: () => res as Response,
        status: (c: number) => {
          code = c;
          return res as Response;
        },
        json: (p: any) => {
          payload = p;
          return res as Response;
        },
      };

      await controller.handleWebhookTrigger(req as Request, res as Response, () => {});
      assert.strictEqual(code, 404);
      assert.strictEqual(payload.code, 'NOT_FOUND');
    });
  });

  describe('Suite 2: Sub-Millisecond Atomic Rollback Engine', { concurrency: 1 }, () => {
    test('swaps published_revision_id to target revision number in < 1ms', async () => {
      const req: Partial<JwtRequest> = {
        params: { id: 'wf_order_pipeline' },
        user: { userId: 42, companyId: 1, tenantId: 1 },
        tenantId: 1,
        body: {
          targetRevisionNumber: 1,
          reason: 'Rollback to Revision 1 due to bug in Revision 2',
        },
      };

      let code = 0;
      let payload: any = null;
      const res: Partial<Response> = {
        status: (c: number) => {
          code = c;
          return res as Response;
        },
        json: (p: any) => {
          payload = p;
          return res as Response;
        },
      };

      await controller.rollbackWorkflow(req as JwtRequest, res as Response, () => {});

      assert.strictEqual(code, 200);
      assert.strictEqual(payload.success, true);
      assert.strictEqual(payload.workflowId, 'wf_order_pipeline');
      assert.strictEqual(payload.previousRevisionId, 'rev_wf_order_2');
      assert.strictEqual(payload.publishedRevisionId, 'rev_wf_order_1');
      assert.strictEqual(payload.targetRevisionNumber, 1);
      assert.ok(payload.latencyMs < 50, `Rollback should execute in sub-millisecond range, took ${payload.latencyMs}ms`);

      // Verify database updated
      const def = db.definitions.find((d) => d.id === 'wf_order_pipeline');
      assert.strictEqual(def?.published_revision_id, 'rev_wf_order_1');
    });

    test('in-flight run pinned to Revision 1 is completely untouched by rollback', async () => {
      // In-flight run exists pinned to rev 1
      const preRollback = db.runs.find((r) => r.id === 'run_inflight_pinned_to_rev1');
      assert.strictEqual(preRollback?.revision_id, 'rev_wf_order_1');

      // Execute rollback from rev 2 -> rev 1
      await revisionService.rollbackRevision(1, 'wf_order_pipeline', {
        targetRevisionNumber: 1,
        reason: 'Rollback test for run immutability',
      });

      // Assert in-flight run record is unchanged
      const postRollback = db.runs.find((r) => r.id === 'run_inflight_pinned_to_rev1');
      assert.strictEqual(postRollback?.revision_id, 'rev_wf_order_1');
      assert.strictEqual(postRollback?.status, 'running');
    });

    test('subsequent inbound webhook after rollback dereferences the newly published target revision', async () => {
      // Rollback to Revision 1
      await revisionService.rollbackRevision(1, 'wf_order_pipeline', {
        targetRevisionNumber: 1,
        reason: 'Rollback to rev 1 before new incoming events',
      });

      // Ingest new webhook event
      const result = await triggerService.processInboundWebhook(
        'sap-erp-orders-inbound',
        validToken,
        {},
        { orderId: 'ord_after_rollback' }
      );

      assert.strictEqual(result.revisionId, 'rev_wf_order_1');
      const newRun = db.runs.find((r) => r.id === result.runId);
      assert.strictEqual(newRun?.revision_id, 'rev_wf_order_1');
    });

    test('rejects cross-tenant rollback spoofing attempt with 403 POLICY_DENIED', async () => {
      const req: Partial<JwtRequest> = {
        params: { id: 'wf_order_pipeline' },
        user: { userId: 42, companyId: 1, tenantId: 1 },
        tenantId: 1,
        body: {
          tenantId: 999, // Attempting to spoof Tenant 999
          targetRevisionNumber: 1,
          reason: 'Unauthorized cross-tenant rollback',
        },
      };

      let code = 0;
      let payload: any = null;
      const res: Partial<Response> = {
        setHeader: () => res as Response,
        status: (c: number) => {
          code = c;
          return res as Response;
        },
        json: (p: any) => {
          payload = p;
          return res as Response;
        },
      };

      await controller.rollbackWorkflow(req as JwtRequest, res as Response, () => {});
      assert.strictEqual(code, 403);
      assert.strictEqual(payload.code, 'POLICY_DENIED');
    });

    test('rejects rollback when target revision number does not exist with 404 NOT_FOUND', async () => {
      const req: Partial<JwtRequest> = {
        params: { id: 'wf_order_pipeline' },
        user: { userId: 42, companyId: 1, tenantId: 1 },
        tenantId: 1,
        body: {
          targetRevisionNumber: 999, // Non-existent revision
          reason: 'Rollback to ghost revision',
        },
      };

      let code = 0;
      let payload: any = null;
      const res: Partial<Response> = {
        setHeader: () => res as Response,
        status: (c: number) => {
          code = c;
          return res as Response;
        },
        json: (p: any) => {
          payload = p;
          return res as Response;
        },
      };

      await controller.rollbackWorkflow(req as JwtRequest, res as Response, () => {});
      assert.strictEqual(code, 404);
      assert.strictEqual(payload.code, 'NOT_FOUND');
    });
  });
});
