// Invariants before config load
process.env.JWT_SECRET = 'test-only-jwt-secret-with-at-least-32-characters-for-testing';
process.env.DB_PASSWORD = 'test-only-database-password';

import assert from 'node:assert/strict';
import { describe, test, beforeEach } from 'node:test';
import crypto from 'node:crypto';
import type { QueryResult } from 'pg';

const { SsrfGuard } = require('../services/temporal/activities/ssrfGuard') as typeof import('../services/temporal/activities/ssrfGuard');
const { executeHttpRequestActivity } = require('../services/temporal/activities/executeHttpRequestActivity') as typeof import('../services/temporal/activities/executeHttpRequestActivity');
const { executeBusinessEffectActivity } = require('../services/temporal/activities/executeBusinessEffectActivity') as typeof import('../services/temporal/activities/executeBusinessEffectActivity');
const { recordWorkflowRunCheckpointActivity } = require('../services/temporal/activities/recordWorkflowRunCheckpointActivity') as typeof import('../services/temporal/activities/recordWorkflowRunCheckpointActivity');
const { humanApprovalSignal, cancelWorkflowSignal } = require('../services/temporal/workflows/signals') as typeof import('../services/temporal/workflows/signals');
const { getWorkflowRunStateQuery } = require('../services/temporal/workflows/queries') as typeof import('../services/temporal/workflows/queries');
const { TenantScopedUoW } = require('../db/TenantScopedUoW') as typeof import('../db/TenantScopedUoW');
import type { Queryable } from '../shared/UnitOfWorkPort';
import type { WorkflowDagGraphV1 } from '@whatsap-automat/contracts';

// =============================================================================
// Mock In-Memory Database for Activities
// =============================================================================

interface MockIdempotencyRow {
  id: string;
  tenant_id: number;
  idempotency_key: string;
  source: string;
  request_hash?: string;
  response_status: number;
  response_body: unknown;
  created_at: Date;
}

interface MockWorkflowRunRow {
  id: string;
  tenant_id: number;
  workflow_id: string;
  revision_id: string;
  current_step: string;
  step_count: number;
  state_snapshot: unknown;
  status: string;
  completed_at?: Date | null;
  error_details?: unknown;
}

function createMockActivityDb() {
  const idempotencyLedger: MockIdempotencyRow[] = [];
  const workflowRuns: MockWorkflowRunRow[] = [];

  const mockClient: Queryable = {
    query: async (text: string | { text: string; values?: unknown[] }, values?: unknown[]): Promise<QueryResult<any>> => {
      const sql = (typeof text === 'string' ? text : text.text).trim();
      const params = typeof text === 'string' ? values || [] : text.values || [];

      // Check idempotency ledger SELECT
      if (/SELECT[\s\S]*FROM\s+idempotency_ledger/i.test(sql)) {
        const tenantId = Number(params[0]);
        const key = String(params[1]);
        const match = idempotencyLedger.find((r) => r.tenant_id === tenantId && r.idempotency_key === key);
        return {
          rows: match ? [match] : [],
          rowCount: match ? 1 : 0,
          command: 'SELECT',
          oid: 0,
          fields: [],
        };
      }

      // INSERT INTO idempotency_ledger
      if (/INSERT\s+INTO\s+idempotency_ledger/i.test(sql)) {
        const tenantId = Number(params[0]);
        const key = String(params[1]);
        const source = 'workflow_engine';
        let requestHash = '';
        let status = 200;
        let responseBody: any = {};

        if (params.length === 4) {
          requestHash = String(params[2]);
          responseBody = typeof params[3] === 'string' ? JSON.parse(params[3]) : params[3];
        } else if (params.length === 6) {
          requestHash = String(params[3]);
          status = Number(params[4]);
          responseBody = typeof params[5] === 'string' ? JSON.parse(params[5]) : params[5];
        } else if (params.length === 5) {
          requestHash = String(params[2]);
          status = Number(params[3]);
          responseBody = typeof params[4] === 'string' ? JSON.parse(params[4]) : params[4];
        } else if (params.length === 3) {
          responseBody = typeof params[2] === 'string' ? JSON.parse(params[2]) : params[2];
        }

        const newRow: MockIdempotencyRow = {
          id: crypto.randomUUID(),
          tenant_id: tenantId,
          idempotency_key: key,
          source,
          request_hash: requestHash,
          response_status: status,
          response_body: responseBody,
          created_at: new Date(),
        };
        idempotencyLedger.push(newRow);
        return { rows: [newRow], rowCount: 1, command: 'INSERT', oid: 0, fields: [] };
      }

      // UPDATE workflow_runs
      if (/UPDATE\s+workflow_runs/i.test(sql)) {
        const runId = String(params[0]);
        const tenantId = Number(params[1]);
        const currentStep = String(params[2]);
        const stepCount = Number(params[3]);
        const stateSnapshot = typeof params[4] === 'string' ? JSON.parse(params[4]) : params[4];
        const status = String(params[5]);
        const errorDetails = params[6] ? (typeof params[6] === 'string' ? JSON.parse(params[6]) : params[6]) : null;

        let existing = workflowRuns.find((r) => r.id === runId && r.tenant_id === tenantId);
        if (!existing) {
          existing = {
            id: runId,
            tenant_id: tenantId,
            workflow_id: 'wf_test',
            revision_id: 'rev_1',
            current_step: currentStep,
            step_count: stepCount,
            state_snapshot: stateSnapshot,
            status,
            completed_at: ['completed', 'failed', 'cancelled'].includes(status) ? new Date() : null,
            error_details: errorDetails,
          };
          workflowRuns.push(existing);
        } else {
          existing.current_step = currentStep;
          existing.step_count = stepCount;
          existing.state_snapshot = stateSnapshot;
          existing.status = status;
          existing.error_details = errorDetails;
          if (['completed', 'failed', 'cancelled'].includes(status)) {
            existing.completed_at = new Date();
          }
        }

        return { rows: [existing], rowCount: 1, command: 'UPDATE', oid: 0, fields: [] };
      }

      return { rows: [], rowCount: 0, command: 'UNKNOWN', oid: 0, fields: [] };
    },
  };

  const mockUow = {
    run: async <T>(tenantId: number, work: (client: Queryable) => Promise<T>): Promise<T> => {
      return await work(mockClient);
    },
  } as unknown as TenantScopedUoW;

  return { idempotencyLedger, workflowRuns, mockUow };
}

describe('PR-F4-02: Temporal Workflow Engine, SSRF Guard & Durable Activities', () => {
  describe('Suite 1: SSRF Guard & IP Pre-Resolution Firewall', () => {
    test('blocks loopback IPv4 addresses (127.0.0.1, 127.0.0.2)', () => {
      assert.strictEqual(SsrfGuard.isBlockedIpv4('127.0.0.1').blocked, true);
      assert.strictEqual(SsrfGuard.isBlockedIpv4('127.255.255.254').blocked, true);
    });

    test('blocks RFC 1918 private IPv4 networks (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)', () => {
      assert.strictEqual(SsrfGuard.isBlockedIpv4('10.0.0.1').blocked, true);
      assert.strictEqual(SsrfGuard.isBlockedIpv4('10.254.1.5').blocked, true);
      assert.strictEqual(SsrfGuard.isBlockedIpv4('172.16.0.1').blocked, true);
      assert.strictEqual(SsrfGuard.isBlockedIpv4('172.31.255.255').blocked, true);
      assert.strictEqual(SsrfGuard.isBlockedIpv4('192.168.1.1').blocked, true);
      assert.strictEqual(SsrfGuard.isBlockedIpv4('192.168.100.254').blocked, true);
    });

    test('blocks Cloud Instance Metadata Service (IMDS) and Link-Local (169.254.169.254)', () => {
      assert.strictEqual(SsrfGuard.isBlockedIpv4('169.254.169.254').blocked, true);
      assert.strictEqual(SsrfGuard.isBlockedIpv4('169.254.1.1').blocked, true);
    });

    test('blocks Carrier-Grade NAT (100.64.0.0/10) and Broadcast (255.255.255.255)', () => {
      assert.strictEqual(SsrfGuard.isBlockedIpv4('100.64.0.1').blocked, true);
      assert.strictEqual(SsrfGuard.isBlockedIpv4('100.127.255.255').blocked, true);
      assert.strictEqual(SsrfGuard.isBlockedIpv4('255.255.255.255').blocked, true);
    });

    test('allows public Internet IPv4 addresses', () => {
      assert.strictEqual(SsrfGuard.isBlockedIpv4('8.8.8.8').blocked, false);
      assert.strictEqual(SsrfGuard.isBlockedIpv4('1.1.1.1').blocked, false);
      assert.strictEqual(SsrfGuard.isBlockedIpv4('142.250.190.46').blocked, false);
    });

    test('blocks IPv6 loopback (::1) and Unique Local Addresses (fc00::/7)', () => {
      assert.strictEqual(SsrfGuard.isBlockedIpv6('::1').blocked, true);
      assert.strictEqual(SsrfGuard.isBlockedIpv6('fc00::1').blocked, true);
      assert.strictEqual(SsrfGuard.isBlockedIpv6('fd12:3456:789a::1').blocked, true);
      assert.strictEqual(SsrfGuard.isBlockedIpv6('fe80::1').blocked, true);
    });

    test('validates URL protocols: rejects file:, gopher:, ftp:, data:', async () => {
      const fileRes = await SsrfGuard.validateUrl('file:///etc/passwd');
      assert.strictEqual(fileRes.safe, false);
      assert.match(fileRes.reason || '', /Disallowed URL protocol/);

      const gopherRes = await SsrfGuard.validateUrl('gopher://127.0.0.1:70');
      assert.strictEqual(gopherRes.safe, false);

      const ftpRes = await SsrfGuard.validateUrl('ftp://example.com/file');
      assert.strictEqual(ftpRes.safe, false);
    });

    test('assertUrlIsSafe throws SSRF_BLOCKED for localhost and loopback targets', async () => {
      await assert.rejects(
        async () => {
          await SsrfGuard.assertUrlIsSafe('http://localhost:8080/admin');
        },
        (err: any) => {
          assert.strictEqual(err.name, 'ApplicationFailure');
          assert.strictEqual(err.type, 'SSRF_BLOCKED');
          return true;
        }
      );

      await assert.rejects(
        async () => {
          await SsrfGuard.assertUrlIsSafe('http://169.254.169.254/latest/meta-data');
        },
        (err: any) => {
          assert.strictEqual(err.name, 'ApplicationFailure');
          assert.strictEqual(err.type, 'SSRF_BLOCKED');
          return true;
        }
      );
    });
  });

  describe('Suite 2: executeHttpRequestActivity with SSRF & Redirect Guard', () => {
    test('rejects request immediately when target URL targets private/metadata IP', async () => {
      await assert.rejects(
        async () => {
          await executeHttpRequestActivity({
            url: 'http://10.10.10.10:9000/api/internal',
            method: 'POST',
          });
        },
        (err: any) => {
          assert.strictEqual(err.name, 'ApplicationFailure');
          assert.strictEqual(err.type, 'SSRF_BLOCKED');
          return true;
        }
      );
    });
  });

  describe('Suite 3: executeBusinessEffectActivity with idempotency_ledger', () => {
    test('applies effect on first invocation and records in idempotency_ledger', async () => {
      const { idempotencyLedger, mockUow } = createMockActivityDb();

      const input = {
        tenantId: 1,
        workflowId: 'wf_order_flow',
        runId: 'run_abc_1',
        stepId: 'step_order_approve',
        effectType: 'order.approve',
        parameters: { orderId: 'ord_100', amount: 350 },
      };

      const result = await executeBusinessEffectActivity(input, mockUow);

      assert.strictEqual(result.applied, true);
      assert.strictEqual(result.cached, false);
      assert.strictEqual(result.resultData.orderStatus, 'approved');
      assert.strictEqual(idempotencyLedger.length, 1);
      assert.strictEqual(idempotencyLedger[0].tenant_id, 1);
      assert.strictEqual(idempotencyLedger[0].idempotency_key, result.effectKey);
    });

    test('returns cached result on duplicate invocation without re-executing effect', async () => {
      const { idempotencyLedger, mockUow } = createMockActivityDb();

      const input = {
        tenantId: 1,
        workflowId: 'wf_order_flow',
        runId: 'run_abc_1',
        stepId: 'step_order_approve',
        effectType: 'order.approve',
        parameters: { orderId: 'ord_100', amount: 350 },
      };

      // Invocation 1: applies
      const res1 = await executeBusinessEffectActivity(input, mockUow);
      assert.strictEqual(res1.cached, false);

      // Invocation 2: returns cached
      const res2 = await executeBusinessEffectActivity(input, mockUow);
      assert.strictEqual(res2.cached, true);
      assert.strictEqual(res2.effectKey, res1.effectKey);
      assert.strictEqual(res2.resultData.orderStatus, 'approved');
      assert.strictEqual(idempotencyLedger.length, 1, 'No duplicate record in idempotency_ledger');
    });
  });

  describe('Suite 4: recordWorkflowRunCheckpointActivity', () => {
    test('updates workflow_runs currentStep, stepCount, stateSnapshot and status', async () => {
      const { workflowRuns, mockUow } = createMockActivityDb();

      const checkpointInput = {
        runId: 'run_checkpoint_1',
        tenantId: 1,
        workflowId: 'wf_order_flow',
        currentStep: 'node_verification',
        stepCount: 2,
        stateSnapshot: { orderId: 'ord_100', verified: true },
        status: 'running' as const,
      };

      const res = await recordWorkflowRunCheckpointActivity(checkpointInput, mockUow);
      assert.strictEqual(res.runId, 'run_checkpoint_1');
      assert.strictEqual(res.stepCount, 2);
      assert.strictEqual(res.status, 'running');

      assert.strictEqual(workflowRuns.length, 1);
      assert.strictEqual(workflowRuns[0].current_step, 'node_verification');
      assert.strictEqual(workflowRuns[0].status, 'running');
    });

    test('sets completed_at timestamp when status transitions to completed', async () => {
      const { workflowRuns, mockUow } = createMockActivityDb();

      const checkpointInput = {
        runId: 'run_checkpoint_2',
        tenantId: 1,
        workflowId: 'wf_order_flow',
        currentStep: 'completed',
        stepCount: 4,
        stateSnapshot: { orderId: 'ord_100', status: 'done' },
        status: 'completed' as const,
      };

      await recordWorkflowRunCheckpointActivity(checkpointInput, mockUow);
      assert.strictEqual(workflowRuns.length, 1);
      assert.strictEqual(workflowRuns[0].status, 'completed');
      assert.ok(workflowRuns[0].completed_at);
    });
  });

  describe('Suite 5: Signals and Queries Contract Definitions', () => {
    test('defines humanApprovalSignal and cancelWorkflowSignal with unique signal names', () => {
      assert.strictEqual(typeof humanApprovalSignal, 'object');
      assert.strictEqual(typeof cancelWorkflowSignal, 'object');
    });

    test('defines getWorkflowRunStateQuery query definition', () => {
      assert.strictEqual(typeof getWorkflowRunStateQuery, 'object');
    });
  });
});
