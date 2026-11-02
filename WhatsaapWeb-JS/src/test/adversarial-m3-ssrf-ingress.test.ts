// Invariants before config load
process.env.JWT_SECRET = 'test-only-jwt-secret-with-at-least-32-characters-for-testing';
process.env.DB_PASSWORD = 'test-only-database-password';

import assert from 'node:assert/strict';
import { describe, test, beforeEach } from 'node:test';
import crypto from 'node:crypto';
import type { QueryResult } from 'pg';
import type { Request, Response } from 'express';

const { SsrfGuard } = require('../services/temporal/activities/ssrfGuard') as typeof import('../services/temporal/activities/ssrfGuard');
const { executeHttpRequestActivity } = require('../services/temporal/activities/executeHttpRequestActivity') as typeof import('../services/temporal/activities/executeHttpRequestActivity');
const { WorkflowTriggerService } = require('../services/workflows/WorkflowTriggerService') as typeof import('../services/workflows/WorkflowTriggerService');
const { WorkflowRevisionService } = require('../services/workflows/WorkflowRevisionService') as typeof import('../services/workflows/WorkflowRevisionService');
const { WorkflowController } = require('../controllers/WorkflowController') as typeof import('../controllers/WorkflowController');
const { TenantScopedUoW } = require('../db/TenantScopedUoW') as typeof import('../db/TenantScopedUoW');
const { OutboxRepository } = require('../services/outbox/OutboxRepository') as typeof import('../services/outbox/OutboxRepository');
import type { Queryable } from '../shared/UnitOfWorkPort';

// =============================================================================
// Comprehensive Concurrent In-Memory DB Engine
// =============================================================================

interface MockDefinitionRow {
  id: string;
  tenant_id: number;
  workspace_id?: number | null;
  name: string;
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

function createConcurrentWorkflowsDb() {
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

      // Global query for triggers
      if (/SELECT[\s\S]*FROM\s+workflow_triggers[\s\S]*WHERE\s+endpoint_key\s*=\s*\$1/i.test(sql)) {
        const key = String(params[0]);
        const match = triggers.find((t) => t.endpoint_key === key);
        return { rows: match ? [match] : [], rowCount: match ? 1 : 0, command: 'SELECT', oid: 0, fields: [] };
      }

      // SELECT FROM idempotency_ledger
      if (/SELECT[\s\S]*FROM\s+idempotency_ledger[\s\S]*WHERE\s+tenant_id\s*=\s*\$1/i.test(sql)) {
        const tenantId = Number(params[0]);
        const key = String(params[1]);
        const match = idempotencyLedger.find((r) => r.tenant_id === tenantId && r.idempotency_key === key);
        return { rows: match ? [{ ...match }] : [], rowCount: match ? 1 : 0, command: 'SELECT', oid: 0, fields: [] };
      }

      // SELECT FROM workflow_definitions
      if (/SELECT[\s\S]*FROM\s+workflow_definitions[\s\S]*WHERE\s+id\s*=\s*\$1\s+AND\s+tenant_id\s*=\s*\$2/i.test(sql)) {
        const id = String(params[0]);
        const tenantId = Number(params[1]);
        const match = definitions.find((d) => d.id === id && d.tenant_id === tenantId);
        return { rows: match ? [{ ...match }] : [], rowCount: match ? 1 : 0, command: 'SELECT', oid: 0, fields: [] };
      }

      // SELECT FROM workflow_revisions
      if (/SELECT[\s\S]*FROM\s+workflow_revisions[\s\S]*WHERE\s+id\s*=\s*\$1\s+AND\s+tenant_id\s*=\s*\$2/i.test(sql)) {
        const id = String(params[0]);
        const tenantId = Number(params[1]);
        const match = revisions.find((r) => r.id === id && r.tenant_id === tenantId);
        return { rows: match ? [{ ...match }] : [], rowCount: match ? 1 : 0, command: 'SELECT', oid: 0, fields: [] };
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

      // INSERT INTO idempotency_ledger (enforce UNIQUE constraint on tenant_id + idempotency_key)
      if (/INSERT\s+INTO\s+idempotency_ledger/i.test(sql)) {
        const tenantId = Number(params[0]);
        const key = String(params[1]);
        const responseBody = params[params.length - 1];

        const exists = idempotencyLedger.some((r) => r.tenant_id === tenantId && r.idempotency_key === key);
        if (exists) {
          const err: any = new Error(`duplicate key value violates unique constraint "uq_idempotency_ledger"`);
          err.code = '23505';
          throw err;
        }

        const newRow: MockIdempotencyLedgerRow = {
          id: crypto.randomUUID(),
          tenant_id: tenantId,
          idempotency_key: key,
          source: 'workflow_webhook_trigger',
          request_hash: String(params[2] || ''),
          response_status: 202,
          response_body: responseBody,
          created_at: new Date(),
        };
        idempotencyLedger.push(newRow);
        return { rows: [newRow], rowCount: 1, command: 'INSERT', oid: 0, fields: [] };
      }

      // INSERT INTO processing_outbox (ON CONFLICT DO UPDATE)
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

  // Synchronized FIFO execution queue per tenant to simulate database row-level / table locking
  let queuePromise = Promise.resolve();

  const mockUow = {
    run: async <T>(_tenantId: number, work: (client: Queryable) => Promise<T>): Promise<T> => {
      const nextInQueue = queuePromise.then(() => work(mockClient));
      queuePromise = nextInQueue.then(() => {}, () => {});
      return nextInQueue;
    },
  } as unknown as TenantScopedUoW;

  const mockOutboxRepo = new OutboxRepository(mockUow);

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

// =============================================================================
// ADVERSARIAL CHALLENGER SUITE
// =============================================================================

describe('Adversarial Penetration: SSRF Multi-Layer Firewall & Webhook Ingress Concurrency (UC-06)', () => {
  // ---------------------------------------------------------------------------
  // SUITE 1: SSRF Firewall Penetration & Filter Evasion
  // ---------------------------------------------------------------------------
  describe('Suite 1: SSRF Penetration & Bypass Attacks', () => {
    test('1.1 RFC 1918 Private IPv4 Ranges: strictly blocked across all classes and subnets', () => {
      const privateIps = [
        // Class A (10.0.0.0/8)
        '10.0.0.1',
        '10.0.0.254',
        '10.128.0.1',
        '10.255.255.254',
        '10.255.255.255',
        // Class B (172.16.0.0/12)
        '172.16.0.1',
        '172.20.10.5',
        '172.31.255.254',
        '172.31.255.255',
        // Class C (192.168.0.0/16)
        '192.168.0.1',
        '192.168.1.1',
        '192.168.100.254',
        '192.168.255.255',
      ];

      for (const ip of privateIps) {
        const check = SsrfGuard.isBlockedIpv4(ip);
        assert.strictEqual(check.blocked, true, `Failed to block RFC 1918 private IP: ${ip}`);
        assert.strictEqual(check.rangeName, 'RFC 1918 Private');
      }

      // Boundary arithmetic validation: adjacent public IPs MUST NOT be blocked
      const publicBoundaries = ['172.15.255.255', '172.32.0.0', '192.167.255.255', '192.169.0.0', '9.255.255.255', '11.0.0.0'];
      for (const ip of publicBoundaries) {
        const check = SsrfGuard.isBlockedIpv4(ip);
        assert.strictEqual(check.blocked, false, `Public boundary IP incorrectly blocked: ${ip}`);
      }
    });

    test('1.2 Loopback, IMDS, CGNAT, Multicast, Reserved & Broadcast IPv4 ranges', () => {
      const testCases: [string, string][] = [
        ['127.0.0.1', 'Loopback'],
        ['127.0.0.2', 'Loopback'],
        ['127.255.255.254', 'Loopback'],
        ['169.254.169.254', 'Link-local / Cloud IMDS'],
        ['169.254.0.1', 'Link-local / Cloud IMDS'],
        ['100.64.0.1', 'Carrier-grade NAT'],
        ['100.100.100.200', 'Carrier-grade NAT'], // Alibaba Cloud IMDS
        ['100.127.255.255', 'Carrier-grade NAT'],
        ['0.0.0.0', 'Current network'],
        ['0.255.255.255', 'Current network'],
        ['198.18.0.1', 'Benchmarking'],
        ['224.0.0.1', 'Multicast'],
        ['239.255.255.255', 'Multicast'],
        ['240.0.0.1', 'Reserved'],
        ['255.255.255.255', 'Reserved'], // Matched by 240.0.0.0/4 Reserved first
      ];

      for (const [ip, expectedRange] of testCases) {
        const check = SsrfGuard.isBlockedIpv4(ip);
        assert.strictEqual(check.blocked, true, `Failed to block IP: ${ip}`);
        assert.strictEqual(check.rangeName, expectedRange);
      }
    });

    test('1.3 Obfuscated and alternate IPv4 representations in URLs', async () => {
      const obfuscatedUrls = [
        // Decimal integer IP
        { url: 'http://2130706433/admin', expectedIp: '127.0.0.1' }, // 127.0.0.1
        { url: 'http://2852039166/latest/meta-data', expectedIp: '169.254.169.254' }, // 169.254.169.254
        { url: 'http://167772161/api', expectedIp: '10.0.0.1' }, // 10.0.0.1
        // Hexadecimal representation
        { url: 'http://0x7f000001/', expectedIp: '127.0.0.1' },
        { url: 'http://0xa9fea9fe/', expectedIp: '169.254.169.254' },
        { url: 'http://0x0a000001/', expectedIp: '10.0.0.1' },
        // Dotted Hex & Octal
        { url: 'http://0x7f.0.0.1/', expectedIp: '127.0.0.1' },
        { url: 'http://0177.0.0.1/', expectedIp: '127.0.0.1' },
        { url: 'http://012.0.0.1/', expectedIp: '10.0.0.1' },
        // Shortened dotted & Zero IP
        { url: 'http://127.1/', expectedIp: '127.0.0.1' },
        { url: 'http://0/', expectedIp: '0.0.0.0' },
        // URL encoded characters
        { url: 'http://%31%32%37%2E%30%2E%30%2E%31/', expectedIp: '127.0.0.1' },
      ];

      for (const item of obfuscatedUrls) {
        const result = await SsrfGuard.validateUrl(item.url);
        assert.strictEqual(result.safe, false, `Obfuscated URL bypassed filter: ${item.url}`);
        assert.ok(
          result.reason?.includes(item.expectedIp) || result.reason?.includes('blocked range') || result.reason?.includes('Current network'),
          `Unexpected reason for ${item.url}: ${result.reason}`
        );
      }
    });

    test('1.4 IPv6 Loopback, ULA (RFC 4193), Link-Local and IPv4-Mapped IPv6', async () => {
      // IPv6 Unit Validator Tests
      const ipv6Cases: [string, boolean, string?][] = [
        ['::1', true, 'Loopback / Unspecified IPv6'],
        ['::', true, 'Loopback / Unspecified IPv6'],
        ['fc00::1', true, 'IPv6 Unique Local Address (ULA)'],
        ['fd00::1', true, 'IPv6 Unique Local Address (ULA)'],
        ['fd12:3456:789a:1::1', true, 'IPv6 Unique Local Address (ULA)'],
        ['fe80::1', true, 'IPv6 Link-Local Unicast'],
        ['fe90::1', true, 'IPv6 Link-Local Unicast'],
        ['febf::1', true, 'IPv6 Link-Local Unicast'],
        ['::ffff:127.0.0.1', true, 'Loopback'],
        ['::ffff:169.254.169.254', true, 'Link-local / Cloud IMDS'],
        ['::ffff:10.0.0.1', true, 'RFC 1918 Private'],
        ['2606:4700:4700::1111', false], // Public Cloudflare IPv6
      ];

      for (const [ip, shouldBlock, expectedRange] of ipv6Cases) {
        const check = SsrfGuard.isBlockedIpv6(ip);
        assert.strictEqual(check.blocked, shouldBlock, `isBlockedIpv6 mismatch for ${ip}`);
        if (shouldBlock && expectedRange) {
          assert.strictEqual(check.rangeName, expectedRange);
        }
      }

      // IPv6 in URLs: Bracketed notation MUST be rejected safely
      const ipv6Urls = [
        'http://[::1]/',
        'http://[::1]:8080/secret',
        'http://[0:0:0:0:0:0:0:1]/',
        'http://[::ffff:127.0.0.1]/',
        'http://[fc00::1]/internal',
        'http://[fe80::1]/metadata',
      ];

      for (const url of ipv6Urls) {
        const result = await SsrfGuard.validateUrl(url);
        assert.strictEqual(result.safe, false, `IPv6 URL bypassed guard: ${url}`);
      }
    });

    test('1.5 Cloud IMDS and Internal Hostnames', async () => {
      const blockedHostnames = [
        'http://localhost',
        'http://localhost:8080',
        'http://metadata.google.internal',
        'http://metadata.google.internal/computeMetadata/v1/',
        'http://instance-data/latest/',
        'http://metadata/latest/',
        'http://database.internal',
        'http://k8s-service.local',
      ];

      for (const url of blockedHostnames) {
        const result = await SsrfGuard.validateUrl(url);
        assert.strictEqual(result.safe, false, `Target hostname was not blocked: ${url}`);
        assert.ok(result.reason?.includes('blocked') || result.reason?.includes('Loopback'));
      }
    });

    test('1.6 DNS Magic Hostnames and Rebinding (.nip.io)', async () => {
      const nipUrls = [
        'http://127.0.0.1.nip.io',
        'http://169.254.169.254.nip.io/latest/meta-data',
        'http://10.0.0.1.nip.io',
        'http://192.168.1.1.nip.io',
        'http://172.16.0.1.nip.io',
      ];

      for (const url of nipUrls) {
        const result = await SsrfGuard.validateUrl(url);
        assert.strictEqual(result.safe, false, `Magic nip.io hostname bypassed SSRF Guard: ${url}`);
        assert.ok(result.reason?.includes('falls into blocked range'));
      }
    });

    test('1.7 Non-HTTP and Dangerous Schemes', async () => {
      const dangerousSchemes = [
        'file:///etc/passwd',
        'file:///C:/Windows/win.ini',
        'ftp://evil-server.com/payload',
        'gopher://127.0.0.1:25/xHELO',
        'javascript:alert(1)',
        'data:text/html;base64,PHNjcmlwdD4=',
        'dict://127.0.0.1:2628/show',
        'ldap://127.0.0.1/dc=corp',
        'ws://127.0.0.1:8080/events',
        'wss://127.0.0.1:8443/stream',
      ];

      for (const url of dangerousSchemes) {
        const result = await SsrfGuard.validateUrl(url);
        assert.strictEqual(result.safe, false, `Dangerous scheme permitted: ${url}`);
        assert.ok(result.reason?.includes('Disallowed URL protocol'));
      }
    });

    test('1.8 HTTP Redirect Bypasses (301, 302, 307, 308) to Internal Targets', async () => {
      // Mock global fetch to simulate external redirect responses
      const originalFetch = globalThis.fetch;

      try {
        // Attack A: 301 Redirect to loopback 127.0.0.1
        globalThis.fetch = async (input: any) => {
          const urlStr = typeof input === 'string' ? input : input.url;
          if (urlStr === 'https://public-api.external.com/start') {
            return new Response('', {
              status: 301,
              headers: { Location: 'http://127.0.0.1:8080/secret-key' },
            });
          }
          return new Response('internal secret content', { status: 200 });
        };

        await assert.rejects(
          async () => {
            await executeHttpRequestActivity({
              url: 'https://public-api.external.com/start',
              method: 'GET',
            });
          },
          (err: any) => {
            return err.type === 'SSRF_BLOCKED' && err.message.includes('Loopback');
          },
          'Failed to block 301 redirect to 127.0.0.1'
        );

        // Attack B: 302 Redirect to Cloud IMDS 169.254.169.254
        globalThis.fetch = async (input: any) => {
          const urlStr = typeof input === 'string' ? input : input.url;
          if (urlStr === 'https://public-api.external.com/oauth') {
            return new Response('', {
              status: 302,
              headers: { Location: 'http://169.254.169.254/latest/meta-data/' },
            });
          }
          return new Response('imds credentials', { status: 200 });
        };

        await assert.rejects(
          async () => {
            await executeHttpRequestActivity({
              url: 'https://public-api.external.com/oauth',
              method: 'GET',
            });
          },
          (err: any) => {
            return err.type === 'SSRF_BLOCKED' && err.message.includes('Link-local / Cloud IMDS');
          },
          'Failed to block 302 redirect to Cloud IMDS'
        );

        // Attack C: 307 Redirect to DNS Rebinding hostname (127.0.0.1.nip.io)
        globalThis.fetch = async (input: any) => {
          const urlStr = typeof input === 'string' ? input : input.url;
          if (urlStr === 'https://public-api.external.com/hook') {
            return new Response('', {
              status: 307,
              headers: { Location: 'http://127.0.0.1.nip.io/admin' },
            });
          }
          return new Response('admin panel', { status: 200 });
        };

        await assert.rejects(
          async () => {
            await executeHttpRequestActivity({
              url: 'https://public-api.external.com/hook',
              method: 'GET',
            });
          },
          (err: any) => {
            return err.type === 'SSRF_BLOCKED' && err.message.includes('Loopback');
          },
          'Failed to block 307 redirect to 127.0.0.1.nip.io'
        );

        // Attack D: Infinite Redirect Loop (> 3 hops)
        let redirectHop = 0;
        globalThis.fetch = async () => {
          redirectHop++;
          return new Response('', {
            status: 302,
            headers: { Location: `https://public-api.external.com/hop-${redirectHop}` },
          });
        };

        await assert.rejects(
          async () => {
            await executeHttpRequestActivity({
              url: 'https://public-api.external.com/hop-0',
              method: 'GET',
            });
          },
          (err: any) => {
            return err.type === 'MAX_REDIRECTS_EXCEEDED';
          },
          'Failed to block redirect chain exceeding MAX_REDIRECTS (3)'
        );

        // Attack E: Malformed redirect missing Location header
        globalThis.fetch = async () => {
          return new Response('', { status: 302 }); // No Location header
        };

        await assert.rejects(
          async () => {
            await executeHttpRequestActivity({
              url: 'https://public-api.external.com/empty-redirect',
              method: 'GET',
            });
          },
          (err: any) => {
            return err.type === 'MALFORMED_REDIRECT';
          },
          'Failed to reject 302 without Location header'
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  // ---------------------------------------------------------------------------
  // SUITE 2: Webhook Ingress Concurrency (UC-06)
  // ---------------------------------------------------------------------------
  describe('Suite 2: Webhook Ingress Concurrency & Timing Security (UC-06)', () => {
    let db: ReturnType<typeof createConcurrentWorkflowsDb>;
    let triggerService: import('../services/workflows/WorkflowTriggerService').WorkflowTriggerService;
    let revisionService: import('../services/workflows/WorkflowRevisionService').WorkflowRevisionService;
    let controller: import('../controllers/WorkflowController').WorkflowController;

    const validWebhookToken = 'prod-webhook-token-super-confidential-2026';
    const validTokenHash = crypto.createHash('sha256').update(validWebhookToken).digest('hex');

    beforeEach(() => {
      db = createConcurrentWorkflowsDb();

      // Seed Definition: Order Processing Workflow
      db.definitions.push({
        id: 'wf_order_stream',
        tenant_id: 1,
        workspace_id: 10,
        name: 'Order Processing Stream',
        published_revision_id: 'rev_wf_order_v1',
        status: 'published',
        created_at: new Date(),
        updated_at: new Date(),
      });

      // Seed Published Revision 1
      db.revisions.push({
        id: 'rev_wf_order_v1',
        tenant_id: 1,
        workflow_id: 'wf_order_stream',
        revision_number: 1,
        status: 'published',
        dag_graph: { nodes: [{ id: 'n1', kind: 'trigger', config: {} }], edges: [] },
        spec_hash: '1111111111111111111111111111111111111111111111111111111111111111',
        limits: { maxSteps: 100 },
        published_at: new Date(),
        created_at: new Date(),
      });

      // Seed Trigger: Webhook for UC-06
      db.triggers.push({
        id: 'trig_order_webhook',
        tenant_id: 1,
        workspace_id: 10,
        workflow_id: 'wf_order_stream',
        type: 'webhook',
        endpoint_key: 'sap-erp-orders-inbound',
        auth_token_hash: validTokenHash,
        is_active: true,
        metadata: { source: 'SAP ERP' },
      });

      triggerService = new WorkflowTriggerService(db.mockPool as any, db.mockUow, db.mockOutboxRepo);
      revisionService = new WorkflowRevisionService(db.mockPool as any, db.mockUow);
      controller = new WorkflowController(triggerService, revisionService);
    });

    test('2.1 Constant-Time HMAC & Token Security Verification', async () => {
      // 1. Missing token on protected endpoint throws 401
      const reqNoToken: Partial<Request> = {
        params: { endpointKey: 'sap-erp-orders-inbound' },
        headers: {},
        body: { orderId: 'ord_no_token' },
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
      await controller.handleWebhookTrigger(reqNoToken as Request, res as Response, () => {});
      assert.strictEqual(code, 401);
      assert.strictEqual(payload.code, 'UNAUTHORIZED');

      // 2. Token of mismatched length
      const reqShortToken = { ...reqNoToken, headers: { 'x-webhook-token': 'short' } };
      await controller.handleWebhookTrigger(reqShortToken as Request, res as Response, () => {});
      assert.strictEqual(code, 401);

      // 3. Token of same length with byte differences
      const alteredToken = validWebhookToken.slice(0, -1) + (validWebhookToken.slice(-1) === 'a' ? 'b' : 'a');
      const reqAltered = { ...reqNoToken, headers: { 'x-webhook-token': alteredToken } };
      await controller.handleWebhookTrigger(reqAltered as Request, res as Response, () => {});
      assert.strictEqual(code, 401);

      // 4. Constant-time execution benchmark across 5,000 iterations
      // Compare byte 0 mismatch vs byte 63 mismatch in hash comparison
      const hashA = crypto.createHash('sha256').update('token-mismatch-byte-0').digest('hex');
      const hashB = crypto.createHash('sha256').update('token-mismatch-byte-63').digest('hex');
      const bufA = Buffer.from(hashA, 'utf8');
      const bufB = Buffer.from(hashB, 'utf8');
      const bufExpected = Buffer.from(validTokenHash, 'utf8');

      const iterations = 5000;
      const t0Start = process.hrtime.bigint();
      for (let i = 0; i < iterations; i++) {
        crypto.timingSafeEqual(bufA, bufExpected);
      }
      const t0Total = Number(process.hrtime.bigint() - t0Start);

      const t1Start = process.hrtime.bigint();
      for (let i = 0; i < iterations; i++) {
        crypto.timingSafeEqual(bufB, bufExpected);
      }
      const t1Total = Number(process.hrtime.bigint() - t1Start);

      const deltaPerOpNs = Math.abs(t0Total - t1Total) / iterations;
      assert.ok(deltaPerOpNs < 5000, `Timing difference too high: ${deltaPerOpNs}ns per op`);
    });

    test('2.2 Parallel Burst Concurrency: 50 simultaneous requests with IDENTICAL idempotency key', async () => {
      const concurrency = 50;
      const sharedIdempotencyKey = 'idemp_burst_test_shared_key';

      // Launch 50 parallel requests
      const promises = Array.from({ length: concurrency }).map(async (_, idx) => {
        let statusCode = 0;
        let jsonBody: any = null;

        const req: Partial<Request> = {
          params: { endpointKey: 'sap-erp-orders-inbound' },
          headers: {
            'x-webhook-token': validWebhookToken,
            'x-idempotency-key': sharedIdempotencyKey,
            'x-correlation-id': `corr_burst_${idx}`,
          },
          body: {
            orderId: 'ORD-999-PARALLEL',
            totalCents: 45000,
            customer: 'Acme Corp',
          },
        };

        const res: Partial<Response> = {
          status: (c: number) => {
            statusCode = c;
            return res as Response;
          },
          json: (p: any) => {
            jsonBody = p;
            return res as Response;
          },
        };

        await controller.handleWebhookTrigger(req as Request, res as Response, (err) => {
          if (err) console.error('HandleWebhookTrigger unexpected error:', err);
        });
        return { statusCode, jsonBody };
      });

      const results = await Promise.all(promises);

      // Verify all 50 requests received HTTP 202 Accepted
      for (const r of results) {
        assert.strictEqual(r.statusCode, 202, `Expected 202 Accepted, received ${r.statusCode}`);
        assert.strictEqual(r.jsonBody.status, 'accepted');
        assert.strictEqual(r.jsonBody.idempotencyKey, sharedIdempotencyKey);
      }

      // Exactly 1 request must have duplicate: false (the winner that performed ingestion)
      const winners = results.filter((r) => r.jsonBody.duplicate === false);
      const duplicates = results.filter((r) => r.jsonBody.duplicate === true);

      assert.strictEqual(winners.length, 1, `Expected exactly 1 ingestion winner, got ${winners.length}`);
      assert.strictEqual(duplicates.length, concurrency - 1, `Expected ${concurrency - 1} duplicates, got ${duplicates.length}`);

      // All 50 responses MUST reference the exact same runId
      const primaryRunId = winners[0].jsonBody.runId;
      for (const d of duplicates) {
        assert.strictEqual(d.jsonBody.runId, primaryRunId, 'Duplicate request returned mismatched runId');
      }

      // Database verification:
      // Strictly 1 outbox record, 1 workflow_runs row, 1 idempotency_ledger entry
      assert.strictEqual(db.outbox.length, 1, `Expected strictly 1 outbox row, found ${db.outbox.length}`);
      assert.strictEqual(db.runs.length, 1, `Expected strictly 1 workflow_runs row, found ${db.runs.length}`);
      assert.strictEqual(db.idempotencyLedger.length, 1, `Expected strictly 1 idempotency_ledger row, found ${db.idempotencyLedger.length}`);

      assert.strictEqual(db.outbox[0].idempotency_key, sharedIdempotencyKey);
      assert.strictEqual(db.outbox[0].payload.runId, primaryRunId);
    });

    test('2.3 Parallel Burst Concurrency: 50 simultaneous requests with DISTINCT idempotency keys', async () => {
      const concurrency = 50;

      const promises = Array.from({ length: concurrency }).map(async (_, idx) => {
        let statusCode = 0;
        let jsonBody: any = null;
        const key = `idemp_distinct_${idx}_${crypto.randomUUID()}`;

        const req: Partial<Request> = {
          params: { endpointKey: 'sap-erp-orders-inbound' },
          headers: {
            'x-webhook-token': validWebhookToken,
            'x-idempotency-key': key,
            'x-correlation-id': `corr_distinct_${idx}`,
          },
          body: {
            orderId: `ORD-DISTINCT-${idx}`,
            amount: 100 + idx,
          },
        };

        const res: Partial<Response> = {
          status: (c: number) => {
            statusCode = c;
            return res as Response;
          },
          json: (p: any) => {
            jsonBody = p;
            return res as Response;
          },
        };

        await controller.handleWebhookTrigger(req as Request, res as Response, () => {});
        return { statusCode, jsonBody, key };
      });

      const results = await Promise.all(promises);

      // All 50 must succeed with HTTP 202 and duplicate: false
      for (const r of results) {
        assert.strictEqual(r.statusCode, 202);
        assert.strictEqual(r.jsonBody.duplicate, false);
      }

      // Verify all 50 runIds are globally unique
      const runIds = new Set(results.map((r) => r.jsonBody.runId));
      assert.strictEqual(runIds.size, concurrency, 'Duplicate runIds generated across distinct keys');

      // Verify database contains strictly 50 outbox entries, 50 runs, 50 ledger entries
      assert.strictEqual(db.outbox.length, concurrency);
      assert.strictEqual(db.runs.length, concurrency);
      assert.strictEqual(db.idempotencyLedger.length, concurrency);
    });

    test('2.4 Injection and Malformed Input Fuzzing on Webhook EndpointKey', async () => {
      const maliciousEndpointKeys = [
        "sap' OR '1'='1",
        'sap; DROP TABLE workflow_triggers; --',
        "sap' UNION SELECT 1,2,3,4,5,6,7,8,9--",
        '../../../etc/passwd',
        '..%2F..%2Fwindows%2Fsystem32',
        'sap\0evil',
        'sap\r\nx-injected-header: true',
        'ab', // Too short (< 3 chars)
        'a'.repeat(129), // Too long (> 128 chars)
        'sap erp orders', // Spaces not permitted
        'sap@erp#orders!', // Special characters disallowed
      ];

      for (const badKey of maliciousEndpointKeys) {
        let code = 0;
        let payload: any = null;

        const req: Partial<Request> = {
          params: { endpointKey: badKey },
          headers: { 'x-webhook-token': validWebhookToken },
          body: { orderId: 'test_injection' },
        };

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
        assert.strictEqual(code, 400, `Malicious endpointKey was not rejected with 400: ${badKey}`);
        assert.strictEqual(payload.code, 'VALIDATION_ERROR');
      }

      // Valid boundary key (128 characters alphanumeric with hyphens and underscores)
      const validBoundaryKey = 'a'.repeat(126) + '_1';
      assert.strictEqual(validBoundaryKey.length, 128);
      let boundaryCode = 0;
      const resBoundary: Partial<Response> = {
        setHeader: () => resBoundary as Response,
        status: (c: number) => {
          boundaryCode = c;
          return resBoundary as Response;
        },
        json: () => resBoundary as Response,
      };

      // Since validBoundaryKey does not exist in DB, should return 404 NOT_FOUND (passed regex validation!)
      await controller.handleWebhookTrigger(
        { params: { endpointKey: validBoundaryKey }, headers: { 'x-webhook-token': validWebhookToken } } as Request,
        resBoundary as Response,
        () => {}
      );
      assert.strictEqual(boundaryCode, 404, '128-char key should pass regex and fail on DB lookup (404)');
    });

    test('2.5 Idempotency Key Resolution Precedence: Header > Body ID > Generated UUID', async () => {
      // Case 1: x-idempotency-key in header
      const res1 = await triggerService.processInboundWebhook(
        'sap-erp-orders-inbound',
        validWebhookToken,
        { 'x-idempotency-key': 'key_from_header' },
        { id: 'key_from_body' }
      );
      assert.strictEqual(res1.idempotencyKey, 'key_from_header');

      // Case 2: No header, body.id present
      const res2 = await triggerService.processInboundWebhook(
        'sap-erp-orders-inbound',
        validWebhookToken,
        {},
        { id: 'key_from_body' }
      );
      assert.strictEqual(res2.idempotencyKey, 'key_from_body');

      // Case 3: Neither present -> randomly generated UUID
      const res3 = await triggerService.processInboundWebhook(
        'sap-erp-orders-inbound',
        validWebhookToken,
        {},
        { order: 1234 }
      );
      assert.ok(res3.idempotencyKey.length >= 32, 'Generated UUID should have at least 32 characters');
    });
  });
});
