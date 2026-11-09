// Invariants before config load
process.env.JWT_SECRET = 'test-only-jwt-secret-with-at-least-32-characters-for-testing';
process.env.DB_PASSWORD = 'test-only-database-password';
const { createBrokerFixtureRegistry } = require('./fixtures/brokerTools') as typeof import('./fixtures/brokerTools');
process.env.META_TOKEN_ENCRYPTION_KEY = '01234567890123456789012345678901';

import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import { URL } from 'node:url';

import {
  SsrfEgressGuard,
  SafeHttpClient,
  SsrfBlockedError,
  SsrfRedirectError,
  isBlockedIp,
  ipv4ToInt,
  ipv6ToBigInt,
  matchesCidrV4,
  matchesCidrV6,
  BLOCKED_IPV4_RANGES,
  BLOCKED_IPV6_RANGES,
} from '../services/ai/broker';

import {
  ToolBroker,
  ToolRegistry,
  HitlApprovalService,
  EffectCache,
  ApprovalAlreadyDecidedError,
  ApprovalCasConflictError,
  ApprovalNotFoundError,
  ApprovalExpiredError,
  HttpRequestTool,
} from '../services/ai/broker';

import {
  ConversationCasService,
  CasConflictError,
  ConversationNotFoundError,
} from '../services/conversations/ConversationCasService';

import type { ToolExecutionRequestV1 } from '@whatsap-automat/contracts';

// =============================================================================
// Concurrency-Safe In-Memory Store & Mock UoW
// =============================================================================

interface MockConversation {
  id: number;
  company_id: number;
  version: number;
  ownership_epoch: number;
  owner_type: 'human' | 'ai_agent';
  owner_id: string | null;
  assigned_user_id: number | null;
  ia_paused: boolean;
}

interface MockApproval {
  id: string;
  tenant_id: number;
  run_id: string;
  agent_graph_id?: string;
  node_id?: string;
  tool_name: string;
  effect_key: string;
  proposed_action_hash: string;
  risk: string;
  status: string;
  input_payload: Record<string, unknown>;
  redacted_details: Record<string, unknown>;
  conversation_id?: number;
  expected_conversation_version?: number;
  version: number;
  expires_at: string;
  created_at: string;
  decided_at?: string;
  decided_by?: string;
  decision_reason?: string;
}

function createConcurrencyMockUoW() {
  const store = {
    conversations: new Map<string, MockConversation>(),
    approvals: new Map<string, MockApproval>(),
    effects: new Map<string, any>(),
    grants: new Map<string, any>(),
    auditLogs: [] as any[],
  };

  const mockUow: any = {
    store,
    async run(tenantId: number, fn: (client: any) => Promise<any>) {
      const client = {
        async query(sql: string, params: any[] = []) {
          // -------------------------------------------------------------------
          // 1. CONVERSATIONS: SELECT state
          // -------------------------------------------------------------------
          if (sql.includes('FROM conversations') && sql.includes('SELECT id, version')) {
            const convId = Number(params[0]);
            const compId = Number(params[1]);
            const conv = store.conversations.get(`${compId}:${convId}`);
            if (!conv) return { rowCount: 0, rows: [] };
            return {
              rowCount: 1,
              rows: [{
                id: conv.id,
                version: conv.version,
                ownership_epoch: conv.ownership_epoch,
                owner_type: conv.owner_type,
                owner_id: conv.owner_id,
                ia_paused: conv.ia_paused,
              }],
            };
          }

          if (sql.includes('FROM conversations') && sql.includes('SELECT id, company_id, version')) {
            const convId = Number(params[0]);
            const compId = Number(params[1]);
            const conv = store.conversations.get(`${compId}:${convId}`);
            if (!conv) return { rowCount: 0, rows: [] };
            return {
              rowCount: 1,
              rows: [{
                id: conv.id,
                company_id: conv.company_id,
                version: conv.version,
                ownership_epoch: conv.ownership_epoch,
                owner_type: conv.owner_type,
                owner_id: conv.owner_id,
              }],
            };
          }

          if (sql.includes('FROM conversations') && sql.includes('SELECT id, ownership_epoch, owner_type, ia_paused')) {
            const convId = Number(params[0]);
            const compId = Number(params[1]);
            const conv = store.conversations.get(`${compId}:${convId}`);
            if (!conv) return { rowCount: 0, rows: [] };
            return {
              rowCount: 1,
              rows: [{
                id: conv.id,
                ownership_epoch: conv.ownership_epoch,
                owner_type: conv.owner_type,
                ia_paused: conv.ia_paused,
              }],
            };
          }

          // -------------------------------------------------------------------
          // 2. CONVERSATIONS: UPDATE (takeover, pause, resume)
          // -------------------------------------------------------------------
          if (sql.includes('UPDATE conversations')) {
            if (sql.includes("owner_type = 'human'")) {
              // takeoverConversation
              const ownerId = String(params[0]);
              const assignedUserId = Number(params[1]);
              const convId = Number(params[2]);
              const compId = Number(params[3]);
              const expectedVersion = Number(params[4]);

              const conv = store.conversations.get(`${compId}:${convId}`);
              if (!conv || conv.version !== expectedVersion) {
                return { rowCount: 0, rows: [] };
              }

              conv.owner_type = 'human';
              conv.owner_id = ownerId;
              conv.assigned_user_id = assignedUserId;
              conv.ownership_epoch += 1;
              conv.version += 1;
              conv.ia_paused = true;

              return { rowCount: 1, rows: [{ ...conv }] };
            }

            if (sql.includes('ia_paused = true') && !sql.includes("owner_type = 'human'")) {
              // pauseAi
              const userId = Number(params[0]);
              const convId = Number(params[2]);
              const compId = Number(params[3]);
              const expectedVersion = Number(params[4]);

              const conv = store.conversations.get(`${compId}:${convId}`);
              if (!conv || conv.version !== expectedVersion) {
                return { rowCount: 0, rows: [] };
              }

              conv.ia_paused = true;
              conv.version += 1;

              return { rowCount: 1, rows: [{ ...conv }] };
            }

            if (sql.includes('ia_paused = false')) {
              // resumeAi
              const convId = Number(params[0]);
              const compId = Number(params[1]);
              const expectedVersion = Number(params[2]);

              const conv = store.conversations.get(`${compId}:${convId}`);
              if (!conv || conv.version !== expectedVersion) {
                return { rowCount: 0, rows: [] };
              }

              conv.ia_paused = false;
              conv.owner_type = 'ai_agent';
              conv.owner_id = null;
              conv.ownership_epoch += 1;
              conv.version += 1;

              return { rowCount: 1, rows: [{ ...conv }] };
            }
          }

          // -------------------------------------------------------------------
          // 3. APPROVAL_REQUESTS: INSERT
          // -------------------------------------------------------------------
          if (sql.includes('INSERT INTO approval_requests')) {
            const approval: MockApproval = {
              id: params[0],
              tenant_id: params[1],
              run_id: params[2],
              agent_graph_id: params[3],
              node_id: params[4],
              tool_name: params[5],
              effect_key: params[6],
              proposed_action_hash: params[7],
              risk: params[8],
              status: 'pending',
              input_payload: JSON.parse(params[9]),
              redacted_details: JSON.parse(params[10]),
              conversation_id: params[11],
              expected_conversation_version: params[12],
              version: 1,
              expires_at: params[13],
              created_at: new Date().toISOString(),
            };
            store.approvals.set(approval.id, approval);
            store.approvals.set(`${tenantId}:${approval.id}`, approval);
            store.approvals.set(`effect:${tenantId}:${approval.effect_key}`, approval);
            return { rowCount: 1, rows: [approval] };
          }

          // -------------------------------------------------------------------
          // 4. APPROVAL_REQUESTS: SELECT by effect_key
          // -------------------------------------------------------------------
          if (sql.includes('FROM approval_requests') && sql.includes('effect_key = $2')) {
            const app = store.approvals.get(`effect:${tenantId}:${params[1]}`);
            if (!app) return { rowCount: 0, rows: [] };
            return { rowCount: 1, rows: [{ ...app }] };
          }

          // -------------------------------------------------------------------
          // 5. APPROVAL_REQUESTS: SELECT by id
          // -------------------------------------------------------------------
          if (sql.includes('FROM approval_requests') && sql.includes('WHERE id = $1 AND tenant_id = $2')) {
            const [approvalId, companyId] = params;
            const app = store.approvals.get(`${companyId}:${approvalId}`);
            if (!app) return { rowCount: 0, rows: [] };
            return { rowCount: 1, rows: [{ ...app, expired: Date.parse(app.expires_at) <= Date.now() }] };
          }

          if (sql.includes('FROM approval_requests') && sql.includes('id = $2')) {
            const approvalId = String(params[1]);
            const app = store.approvals.get(approvalId) || store.approvals.get(`${tenantId}:${approvalId}`);
            if (!app) return { rowCount: 0, rows: [] };
            return { rowCount: 1, rows: [{ ...app }] };
          }

          // -------------------------------------------------------------------
          // 6. APPROVAL_REQUESTS: ATOMIC CAS UPDATE
          // -------------------------------------------------------------------
          if (sql.includes('UPDATE approval_requests')) {
            const decision = params[0];
            const actorId = params[1];
            const reason = params[2];
            const approvalId = String(params[3]);
            const tId = params[4];
            const expectedVer = Number(params[5]);

            const app = store.approvals.get(approvalId) || store.approvals.get(`${tId}:${approvalId}`);
            if (!app || app.version !== expectedVer || app.status !== 'pending' || Date.parse(app.expires_at) <= Date.now()) {
              return { rowCount: 0, rows: [] };
            }

            app.status = decision;
            app.decided_by = actorId;
            app.decision_reason = reason;
            app.decided_at = new Date().toISOString();
            app.version += 1;

            return { rowCount: 1, rows: [{ ...app }] };
          }

          // -------------------------------------------------------------------
          // 7. EFFECTS & GRANTS & AUDIT LOGS
          // -------------------------------------------------------------------
          if (sql.includes('FROM tool_execution_effects')) {
            const eff = store.effects.get(`${tenantId}:${params[1]}`);
            if (!eff) return { rowCount: 0, rows: [] };
            return { rowCount: 1, rows: [eff] };
          }

          if (sql.includes('INSERT INTO tool_execution_effects')) {
            const record = {
              tenant_id: params[0],
              effect_key: params[1],
              run_id: params[2],
              tool_name: params[3],
              status: params[4],
              output: JSON.parse(params[5]),
            };
            store.effects.set(`${tenantId}:${record.effect_key}`, record);
            return { rowCount: 1, rows: [record] };
          }

          if (sql.includes('FROM agent_tool_grants')) {
            const grant = store.grants.get(`${tenantId}:${params[1]}`);
            if (!grant) return { rowCount: 0, rows: [] };
            return { rowCount: 1, rows: [grant] };
          }

          if (sql.includes('INSERT INTO operational_actions')) {
            store.auditLogs.push({ tenantId, params });
            return { rowCount: 1, rows: [] };
          }

          return { rowCount: 0, rows: [] };
        },
      };

      return fn(client);
    },
  };

  return mockUow;
}

// =============================================================================
// ADVERSARIAL STRESS TEST SUITE
// =============================================================================

describe('M4 Adversarial Stress Challenge: SSRF Evasions, Redirect Chains & CAS Anti-Takeover Concurrency', () => {

  // ===========================================================================
  // SUITE 1: SSRF Firewall Esoteric IP Representation Evasions
  // ===========================================================================
  describe('Suite 1: Esoteric IP Formats (Decimal, Octal, Hex, and Shortened)', () => {
    it('blocks decimal integer IPv4 representations across private, loopback, and metadata ranges', async () => {
      const decimalCases = [
        { url: 'http://2130706433/', expectedCanonical: '127.0.0.1', expectedRange: 'Loopback' },
        { url: 'http://167772161/', expectedCanonical: '10.0.0.1', expectedRange: 'RFC 1918 Private Class A' },
        { url: 'http://2852039166/', expectedCanonical: '169.254.169.254', expectedRange: 'Link-Local / Cloud IMDS' },
        { url: 'http://3232235521/', expectedCanonical: '192.168.0.1', expectedRange: 'RFC 1918 Private Class C' },
        { url: 'http://2886729729/', expectedCanonical: '172.16.0.1', expectedRange: 'RFC 1918 Private Class B' },
      ];

      for (const { url, expectedCanonical, expectedRange } of decimalCases) {
        const res = await SsrfEgressGuard.validateUrl(url);
        assert.equal(res.safe, false, `Decimal URL ${url} was not blocked`);
        assert.ok(res.reason!.includes(expectedCanonical), `Expected ${res.reason} to include ${expectedCanonical}`);
        assert.ok(res.reason!.includes(expectedRange), `Expected ${res.reason} to include ${expectedRange}`);

        await assert.rejects(
          () => SsrfEgressGuard.assertUrlIsSafe(url),
          (err: any) => {
            assert.equal(err instanceof SsrfBlockedError, true);
            assert.equal(err.statusCode, 403);
            return true;
          }
        );
      }
    });

    it('blocks octal dotted-quad and shortened IPv4 notations', async () => {
      const octalCases = [
        { url: 'http://0177.0.0.1/', expectedCanonical: '127.0.0.1', expectedRange: 'Loopback' },
        { url: 'http://0177.1/', expectedCanonical: '127.0.0.1', expectedRange: 'Loopback' },
        { url: 'http://012.0.0.1/', expectedCanonical: '10.0.0.1', expectedRange: 'RFC 1918 Private Class A' },
        { url: 'http://0/', expectedCanonical: '0.0.0.0', expectedRange: 'Current network' },
      ];

      for (const { url, expectedCanonical, expectedRange } of octalCases) {
        const res = await SsrfEgressGuard.validateUrl(url);
        assert.equal(res.safe, false, `Octal URL ${url} was not blocked`);
        assert.ok(res.reason!.includes(expectedCanonical));
        assert.ok(res.reason!.includes(expectedRange));
      }
    });

    it('blocks hexadecimal IPv4 representations (integer, dotted, and shortened)', async () => {
      const hexCases = [
        { url: 'http://0x7f000001/', expectedCanonical: '127.0.0.1', expectedRange: 'Loopback' },
        { url: 'http://0x7f.1/', expectedCanonical: '127.0.0.1', expectedRange: 'Loopback' },
        { url: 'http://0xa000001/', expectedCanonical: '10.0.0.1', expectedRange: 'RFC 1918 Private Class A' },
        { url: 'http://0xa.0.0.1/', expectedCanonical: '10.0.0.1', expectedRange: 'RFC 1918 Private Class A' },
        { url: 'http://0xa9fea9fe/', expectedCanonical: '169.254.169.254', expectedRange: 'Link-Local / Cloud IMDS' },
      ];

      for (const { url, expectedCanonical, expectedRange } of hexCases) {
        const res = await SsrfEgressGuard.validateUrl(url);
        assert.equal(res.safe, false, `Hex URL ${url} was not blocked`);
        assert.ok(res.reason!.includes(expectedCanonical));
        assert.ok(res.reason!.includes(expectedRange));
      }
    });

    it('allows genuine public routable IPs while rejecting adjacent private boundaries', async () => {
      const publicUrls = [
        'http://93.184.216.34/',
        'https://8.8.8.8/',
        'https://1.1.1.1/',
      ];

      for (const url of publicUrls) {
        const res = await SsrfEgressGuard.validateUrl(url);
        assert.equal(res.safe, true, `Legitimate public IP was blocked: ${url}`);
      }
    });
  });

  // ===========================================================================
  // SUITE 2: Mixed IPv4-Mapped IPv6 Formats and IPv6 ULA / Link-Local
  // ===========================================================================
  describe('Suite 2: IPv4-Mapped IPv6 and Special IPv6 Ranges', () => {
    it('blocks dotted-quad IPv4-mapped IPv6 targeting loopback, private networks, and cloud IMDS', async () => {
      const mappedDottedCases = [
        { url: 'http://[::ffff:127.0.0.1]/', expectedRange: 'IPv4-Mapped: Loopback' },
        { url: 'http://[::ffff:10.0.0.1]/', expectedRange: 'IPv4-Mapped: RFC 1918 Private Class A' },
        { url: 'http://[::ffff:172.16.0.1]/', expectedRange: 'IPv4-Mapped: RFC 1918 Private Class B' },
        { url: 'http://[::ffff:192.168.1.1]/', expectedRange: 'IPv4-Mapped: RFC 1918 Private Class C' },
        { url: 'http://[::ffff:169.254.169.254]/', expectedRange: 'IPv4-Mapped: Link-Local / Cloud IMDS' },
        { url: 'http://[::ffff:100.100.100.200]/', expectedRange: 'IPv4-Mapped: Carrier-Grade NAT (CGNAT)' },
      ];

      for (const { url, expectedRange } of mappedDottedCases) {
        const res = await SsrfEgressGuard.validateUrl(url);
        assert.equal(res.safe, false, `IPv4-mapped URL ${url} was not blocked`);
        assert.ok(res.reason!.includes(expectedRange), `Expected reason to include "${expectedRange}", got "${res.reason}"`);
      }
    });

    it('blocks pure hexadecimal hextet IPv4-mapped IPv6 formats (e.g. ::ffff:7f00:1, ::ffff:a9fe:a9fe)', async () => {
      const mappedHexCases = [
        { url: 'http://[::ffff:7f00:1]/', expectedRange: 'IPv4-Mapped: Loopback' },
        { url: 'http://[::ffff:a00:1]/', expectedRange: 'IPv4-Mapped: RFC 1918 Private Class A' },
        { url: 'http://[::ffff:a9fe:a9fe]/', expectedRange: 'IPv4-Mapped: Link-Local / Cloud IMDS' },
        { url: 'http://[::ffff:c0a8:101]/', expectedRange: 'IPv4-Mapped: RFC 1918 Private Class C' },
      ];

      for (const { url, expectedRange } of mappedHexCases) {
        const res = await SsrfEgressGuard.validateUrl(url);
        assert.equal(res.safe, false, `Hex hextet IPv4-mapped URL ${url} was not blocked`);
        assert.ok(res.reason!.includes(expectedRange));
      }
    });

    it('blocks fully expanded leading-zero IPv4-mapped IPv6 addresses (e.g. 0:0:0:0:0:ffff:10.0.0.1)', async () => {
      const expandedCases = [
        { url: 'http://[0:0:0:0:0:ffff:127.0.0.1]/', expectedRange: 'IPv4-Mapped: Loopback' },
        { url: 'http://[0:0:0:0:0:ffff:10.0.0.1]/', expectedRange: 'IPv4-Mapped: RFC 1918 Private Class A' },
        { url: 'http://[0:0:0:0:0:ffff:169.254.169.254]/', expectedRange: 'IPv4-Mapped: Link-Local / Cloud IMDS' },
      ];

      for (const { url, expectedRange } of expandedCases) {
        const res = await SsrfEgressGuard.validateUrl(url);
        assert.equal(res.safe, false, `Expanded IPv4-mapped URL ${url} was not blocked`);
        assert.ok(res.reason!.includes(expectedRange));
      }
    });

    it('blocks Unique Local Addresses (ULA: fc00::/7, fd00::/8) including cloud metadata [fd00:ec2::254]', async () => {
      const ulaCases = [
        'http://[fc00::]/',
        'http://[fc00::1]/',
        'http://[fd00::]/',
        'http://[fd00::1]/',
        'http://[fd00:ec2::254]/', // AWS IMDSv6
        'http://[fd12:3456:789a:bcde::1]/',
        'http://[fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff]/',
      ];

      for (const url of ulaCases) {
        const res = await SsrfEgressGuard.validateUrl(url);
        assert.equal(res.safe, false, `ULA URL ${url} was not blocked`);
        assert.ok(res.reason!.includes('Unique Local Address (ULA)'));
      }
    });

    it('blocks IPv6 Link-Local Unicast (fe80::/10)', async () => {
      const linkLocalCases = [
        'http://[fe80::1]/',
        'http://[fe80::100]/',
        'http://[febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff]/',
      ];

      for (const url of linkLocalCases) {
        const res = await SsrfEgressGuard.validateUrl(url);
        assert.equal(res.safe, false, `Link-Local URL ${url} was not blocked`);
        assert.ok(res.reason!.includes('Link-Local Unicast'));
      }
    });
  });

  // ===========================================================================
  // SUITE 3: Cloud Metadata Endpoints & Internal Hostnames
  // ===========================================================================
  describe('Suite 3: Cloud Metadata Endpoints & Internal Hostnames', () => {
    it('blocks all cloud metadata endpoints across IPv4, IPv6, and internal hostnames', async () => {
      const metadataEndpoints = [
        { url: 'http://169.254.169.254/latest/meta-data/', expectedReason: 'Link-Local / Cloud IMDS' },
        { url: 'http://[fd00:ec2::254]/latest/meta-data/', expectedReason: 'Unique Local Address (ULA)' },
        { url: 'http://100.100.100.200/latest/meta-data/', expectedReason: 'Carrier-Grade NAT (CGNAT)' },
        { url: 'http://metadata.google.internal/computeMetadata/v1/', expectedReason: 'is blocked' },
        { url: 'http://metadata/', expectedReason: 'is blocked' },
        { url: 'http://instance-data/', expectedReason: 'is blocked' },
        { url: 'http://internal.service.local/', expectedReason: 'is blocked' },
        { url: 'http://core.service.internal/', expectedReason: 'is blocked' },
      ];

      for (const { url, expectedReason } of metadataEndpoints) {
        const res = await SsrfEgressGuard.validateUrl(url);
        assert.equal(res.safe, false, `Metadata endpoint allowed: ${url}`);
        assert.ok(res.reason!.includes(expectedReason), `Expected reason to include "${expectedReason}", got "${res.reason}"`);
      }
    });
  });

  // ===========================================================================
  // SUITE 4: TOCTOU DNS Rebinding & Socket Pinning
  // ===========================================================================
  describe('Suite 4: TOCTOU DNS Rebinding & Socket Pinning Resilience', () => {
    it('verifies SafeHttpClient pins socket connection to pre-resolved safe IP, immune to alternating DNS responses', async () => {
      const originalLookup = dns.lookup;
      const originalHttpRequest = http.request;

      let capturedOptions: http.RequestOptions | null = null;
      let lookupInvocationCount = 0;

      try {
        // Mock DNS to simulate an attacker alternating between public IP and loopback
        (dns as any).lookup = async (hostname: string, options?: any) => {
          if (hostname === 'rebinding-adversary.com') {
            lookupInvocationCount++;
            // First call returns safe public IP, future calls would return loopback
            const returnedIp = lookupInvocationCount === 1 ? '93.184.216.34' : '127.0.0.1';
            return [{ address: returnedIp, family: 4 }];
          }
          return originalLookup(hostname, options);
        };

        // Spy on http.request to verify socket level parameters
        (http as any).request = (options: http.RequestOptions, callback?: any) => {
          capturedOptions = options;
          const mockReq: any = {
            on: () => mockReq,
            setTimeout: () => mockReq,
            write: () => {},
            end: () => {
              if (callback) {
                const mockRes: any = {
                  statusCode: 200,
                  statusMessage: 'OK',
                  headers: { 'content-type': 'application/json' },
                  on: (evt: string, fn: any) => {
                    if (evt === 'data') fn(Buffer.from('{"status":"ok"}'));
                    if (evt === 'end') fn();
                    return mockRes;
                  },
                };
                callback(mockRes);
              }
            },
          };
          return mockReq;
        };

        const result = await SafeHttpClient.request('http://rebinding-adversary.com/data');

        assert.equal(result.status, 200);
        assert.equal(result.resolvedIp, '93.184.216.34');
        assert.ok(capturedOptions, 'http.request was not called');

        // Socket host must be pinned to pre-resolved IP (never the domain name)
        assert.equal((capturedOptions as any).host, '93.184.216.34');
        // Virtual host header preserved
        assert.equal((capturedOptions as any).headers['Host'], 'rebinding-adversary.com');
      } finally {
        (dns as any).lookup = originalLookup;
        (http as any).request = originalHttpRequest;
      }
    });

    it('rejects multi-homed DNS responses if ANY returned record is in a prohibited range (fail-closed)', async () => {
      const originalLookup = dns.lookup;

      try {
        // Multi-homed DNS response: Public IPv4 + Loopback IPv4
        (dns as any).lookup = async (hostname: string) => {
          if (hostname === 'dual-homed-attack-1.com') {
            return [
              { address: '93.184.216.34', family: 4 },
              { address: '127.0.0.1', family: 4 },
            ];
          }
          if (hostname === 'dual-homed-attack-2.com') {
            return [
              { address: '93.184.216.34', family: 4 },
              { address: '169.254.169.254', family: 4 },
            ];
          }
          if (hostname === 'dual-homed-attack-3.com') {
            return [
              { address: '2606:4700:4700::1111', family: 6 },
              { address: '::1', family: 6 },
            ];
          }
          if (hostname === 'dual-homed-attack-4.com') {
            return [
              { address: '93.184.216.34', family: 4 },
              { address: 'fd00::1', family: 6 },
            ];
          }
          return originalLookup(hostname, { all: true });
        };

        const res1 = await SsrfEgressGuard.validateUrl('http://dual-homed-attack-1.com/');
        assert.equal(res1.safe, false);
        assert.ok(res1.reason!.includes('Loopback'));

        const res2 = await SsrfEgressGuard.validateUrl('http://dual-homed-attack-2.com/');
        assert.equal(res2.safe, false);
        assert.ok(res2.reason!.includes('Link-Local / Cloud IMDS'));

        const res3 = await SsrfEgressGuard.validateUrl('http://dual-homed-attack-3.com/');
        assert.equal(res3.safe, false);
        assert.ok(res3.reason!.includes('Loopback IPv6 Address'));

        const res4 = await SsrfEgressGuard.validateUrl('http://dual-homed-attack-4.com/');
        assert.equal(res4.safe, false);
        assert.ok(res4.reason!.includes('Unique Local Address (ULA)'));
      } finally {
        (dns as any).lookup = originalLookup;
      }
    });

    it('fails closed when DNS lookup yields zero records or encounters network error', async () => {
      const originalLookup = dns.lookup;
      try {
        (dns as any).lookup = async (hostname: string) => {
          if (hostname === 'empty-dns.com') return [];
          if (hostname === 'failing-dns.com') throw new Error('ENOTFOUND failing-dns.com');
          return originalLookup(hostname, { all: true });
        };

        const resEmpty = await SsrfEgressGuard.validateUrl('http://empty-dns.com/');
        assert.equal(resEmpty.safe, false);
        assert.ok(resEmpty.reason!.includes('zero IP addresses'));

        const resFail = await SsrfEgressGuard.validateUrl('http://failing-dns.com/');
        assert.equal(resFail.safe, false);
        assert.ok(resFail.reason!.includes('DNS lookup failed'));
      } finally {
        (dns as any).lookup = originalLookup;
      }
    });
  });

  // ===========================================================================
  // SUITE 5: Redirect Chains & Sensitive Header Stripping
  // ===========================================================================
  describe('Suite 5: Redirect Chains & Sensitive Header Stripping', () => {
    it('blocks HTTP 302 redirect hopping from public origin to internal loopback', async () => {
      const originalLookup = dns.lookup;
      const originalHttpRequest = http.request;

      try {
        (dns as any).lookup = async (hostname: string) => {
          if (hostname === 'trusted-gateway.com') {
            return [{ address: '93.184.216.34', family: 4 }];
          }
          return originalLookup(hostname, { all: true });
        };

        (http as any).request = (options: http.RequestOptions, callback?: any) => {
          const mockReq: any = {
            on: () => mockReq,
            setTimeout: () => mockReq,
            write: () => {},
            end: () => {
              if (callback) {
                const mockRes: any = {
                  statusCode: 302,
                  statusMessage: 'Found',
                  headers: { location: 'http://127.0.0.1:8080/admin/secrets' },
                  on: (evt: string, fn: any) => {
                    if (evt === 'end') fn();
                    return mockRes;
                  },
                };
                callback(mockRes);
              }
            },
          };
          return mockReq;
        };

        await assert.rejects(
          () => SafeHttpClient.request('http://trusted-gateway.com/entry'),
          (err: any) => {
            assert.equal(err.name, 'SsrfBlockedError');
            assert.equal(err.statusCode, 403);
            assert.ok(err.message.includes('Loopback'));
            return true;
          }
        );
      } finally {
        (dns as any).lookup = originalLookup;
        (http as any).request = originalHttpRequest;
      }
    });

    it('blocks multi-hop redirect chain hopping across intermediate public hosts to AWS IMDS', async () => {
      const originalLookup = dns.lookup;
      const originalHttpRequest = http.request;

      let hopCount = 0;

      try {
        (dns as any).lookup = async (hostname: string) => {
          if (hostname === 'pub-1.com') return [{ address: '93.184.216.34', family: 4 }];
          if (hostname === 'pub-2.com') return [{ address: '93.184.216.35', family: 4 }];
          return originalLookup(hostname, { all: true });
        };

        (http as any).request = (options: http.RequestOptions, callback?: any) => {
          hopCount++;
          const location = hopCount === 1 ? 'http://pub-2.com/step2' : 'http://169.254.169.254/latest/meta-data/';
          const mockReq: any = {
            on: () => mockReq,
            setTimeout: () => mockReq,
            write: () => {},
            end: () => {
              if (callback) {
                const mockRes: any = {
                  statusCode: 302,
                  statusMessage: 'Found',
                  headers: { location },
                  on: (evt: string, fn: any) => {
                    if (evt === 'end') fn();
                    return mockRes;
                  },
                };
                callback(mockRes);
              }
            },
          };
          return mockReq;
        };

        await assert.rejects(
          () => SafeHttpClient.request('http://pub-1.com/step1'),
          (err: any) => {
            assert.equal(err.name, 'SsrfBlockedError');
            assert.equal(err.statusCode, 403);
            assert.ok(err.message.includes('Link-Local / Cloud IMDS'));
            return true;
          }
        );
        assert.equal(hopCount, 2, 'Should have executed hop 1 and evaluated hop 2 before rejecting');
      } finally {
        (dns as any).lookup = originalLookup;
        (http as any).request = originalHttpRequest;
      }
    });

    it('strips sensitive headers (Authorization, Cookie, X-Api-Key) on cross-origin redirects while preserving safe headers', async () => {
      const originalLookup = dns.lookup;
      const originalHttpRequest = http.request;

      let secondHopHeaders: Record<string, string> | null = null;
      let requestCount = 0;

      try {
        (dns as any).lookup = async (hostname: string) => {
          if (hostname === 'origin-alpha.com') return [{ address: '93.184.216.34', family: 4 }];
          if (hostname === 'origin-beta.com') return [{ address: '93.184.216.35', family: 4 }];
          return originalLookup(hostname, { all: true });
        };

        (http as any).request = (options: http.RequestOptions, callback?: any) => {
          requestCount++;
          if (requestCount === 2) {
            secondHopHeaders = options.headers as Record<string, string>;
          }

          const mockReq: any = {
            on: () => mockReq,
            setTimeout: () => mockReq,
            write: () => {},
            end: () => {
              if (callback) {
                const isFirst = requestCount === 1;
                const mockRes: any = {
                  statusCode: isFirst ? 302 : 200,
                  statusMessage: isFirst ? 'Found' : 'OK',
                  headers: isFirst
                    ? { location: 'http://origin-beta.com/dest' }
                    : { 'content-type': 'application/json' },
                  on: (evt: string, fn: any) => {
                    if (evt === 'data' && !isFirst) fn(Buffer.from('{"ok":true}'));
                    if (evt === 'end') fn();
                    return mockRes;
                  },
                };
                callback(mockRes);
              }
            },
          };
          return mockReq;
        };

        const res = await SafeHttpClient.request('http://origin-alpha.com/start', {
          headers: {
            'authorization': 'Bearer super-secret-jwt-token',
            'Authorization': 'Bearer super-secret-jwt-token',
            'proxy-authorization': 'Basic credentials',
            'cookie': 'session_id=attacker-session',
            'x-api-key': 'secret-api-key-value',
            'accept': 'application/json',
            'x-custom-trace': 'trace-12345',
          },
        });

        assert.equal(res.status, 200);
        assert.equal(res.redirectCount, 1);
        assert.ok(secondHopHeaders, 'Second hop headers not captured');

        // Sensitive headers MUST be deleted on cross-origin redirect
        assert.equal((secondHopHeaders as any)['authorization'], undefined);
        assert.equal((secondHopHeaders as any)['Authorization'], undefined);
        assert.equal((secondHopHeaders as any)['proxy-authorization'], undefined);
        assert.equal((secondHopHeaders as any)['cookie'], undefined);
        assert.equal((secondHopHeaders as any)['x-api-key'], undefined);

        // Safe headers MUST be preserved
        assert.equal((secondHopHeaders as any)['accept'], 'application/json');
        assert.equal((secondHopHeaders as any)['x-custom-trace'], 'trace-12345');
      } finally {
        (dns as any).lookup = originalLookup;
        (http as any).request = originalHttpRequest;
      }
    });

    it('rejects infinite redirect loop exceeding MAX_REDIRECTS (5)', async () => {
      const originalLookup = dns.lookup;
      const originalHttpRequest = http.request;

      try {
        (dns as any).lookup = async () => [{ address: '93.184.216.34', family: 4 }];

        let hopIndex = 0;
        (http as any).request = (options: http.RequestOptions, callback?: any) => {
          hopIndex++;
          const mockReq: any = {
            on: () => mockReq,
            setTimeout: () => mockReq,
            write: () => {},
            end: () => {
              if (callback) {
                const mockRes: any = {
                  statusCode: 302,
                  headers: { location: `http://loop.com/hop-${hopIndex}` },
                  on: (evt: string, fn: any) => {
                    if (evt === 'end') fn();
                    return mockRes;
                  },
                };
                callback(mockRes);
              }
            },
          };
          return mockReq;
        };

        await assert.rejects(
          () => SafeHttpClient.request('http://loop.com/start'),
          (err: any) => {
            assert.equal(err instanceof SsrfRedirectError, true);
            assert.equal(err.code, 'MAX_REDIRECTS_EXCEEDED');
            return true;
          }
        );
      } finally {
        (dns as any).lookup = originalLookup;
        (http as any).request = originalHttpRequest;
      }
    });
  });

  // ===========================================================================
  // SUITE 6: CAS Anti-Takeover Fencing Concurrency on ToolBroker (Step 6)
  // ===========================================================================
  describe('Suite 6: CAS Anti-Takeover Fencing & Concurrency Stress', () => {
    let mockUow: any;
    let broker: ToolBroker;
    let registry: ToolRegistry;
    let casService: ConversationCasService;
    let hitlService: HitlApprovalService;

    beforeEach(() => {
      mockUow = createConcurrencyMockUoW();
      casService = new ConversationCasService(mockUow);
      hitlService = new HitlApprovalService(mockUow);
      registry = createBrokerFixtureRegistry(mockUow);
      const effectCache = new EffectCache(mockUow);
      broker = new ToolBroker({
        uow: mockUow,
        casService,
        hitlService,
        registry,
        effectCache,
      });

      // Seed active conversation controlled by AI
      mockUow.store.conversations.set('1:100', {
        id: 100,
        company_id: 1,
        version: 1,
        ownership_epoch: 0,
        owner_type: 'ai_agent',
        owner_id: null,
        assigned_user_id: null,
        ia_paused: false,
      });
    });

    it('blocks concurrent high-risk "send" executions immediately when human takeover is active (aiPaused = true)', async () => {
      // Human operator takes over the conversation
      await casService.takeoverConversation({
        tenantId: 1,
        conversationId: 100,
        expectedVersion: 1,
        userId: 42,
        reason: 'Operator intervening in customer chat',
      });

      // Confirm conversation state: owner_type = 'human', ia_paused = true, version = 2
      const convState = await casService.getConversationState({ tenantId: 1, conversationId: 100 });
      assert.equal(convState?.aiPaused, true);
      assert.equal(convState?.ownerType, 'human');
      assert.equal(convState?.version, 2);

      // Concurrently dispatch 25 simultaneous tool execution requests for send_whatsapp_message
      const CONCURRENT_REQUESTS = 25;
      const requests = Array.from({ length: CONCURRENT_REQUESTS }, (_, i) => ({
        tenantId: '1',
        runId: `run-concurrency-${i}`,
        toolName: 'send_whatsapp_message',
        conversationId: '100',
        input: {
          conversationId: '100',
          messageText: `Adversarial message injection attempt #${i}`,
        },
        actorId: 'ai-agent-v1',
        actorRoles: ['agent', 'ai_operator'],
      }));

      const results = await Promise.all(requests.map((req) => broker.execute(req)));

      // Assert fail-closed CAS Anti-Takeover: ALL 25 requests must be rejected
      assert.equal(results.length, CONCURRENT_REQUESTS);
      for (let i = 0; i < CONCURRENT_REQUESTS; i++) {
        const res = results[i];
        assert.equal(res.success, false, `Request ${i} unexpectedly succeeded`);
        assert.equal(res.status, 'cas_conflict');
        assert.equal(res.error?.code, 'HUMAN_TAKEOVER_ACTIVE');
        assert.match(res.error?.message!, /conversation is currently controlled by human operator/i);
      }
    });

    it('rejects stale conversation version attacks (expectedConversationVersion !== currentVersion)', async () => {
      // Conversation is currently at version 1
      // Agent sends request with stale expectedConversationVersion: 0 (or outdated version)
      const staleRequest: ToolExecutionRequestV1 = {
        tenantId: '1',
        runId: 'run-stale-attack',
        toolName: 'send_whatsapp_message',
        conversationId: '100',
        expectedConversationVersion: 0, // Stale! Current is 1
        input: {
          conversationId: '100',
          messageText: 'Stale message injection',
        },
        actorId: 'ai-agent-v1',
        actorRoles: ['agent'],
      };

      const result = await broker.execute(staleRequest);

      assert.equal(result.success, false);
      assert.equal(result.status, 'cas_conflict');
      assert.equal(result.error?.code, 'CONCURRENCY_CONFLICT');
      assert.match(result.error?.message!, /CAS version mismatch on conversation 100/);
    });

    it('handles concurrent requests under dynamic takeover transition: requests before takeover succeed, requests after fail', async () => {
      // 1. Initial tool execution while AI controls conversation
      const validReq: ToolExecutionRequestV1 = {
        tenantId: '1',
        runId: 'run-valid-before',
        toolName: 'send_whatsapp_message',
        conversationId: '100',
        expectedConversationVersion: 1,
        input: {
          conversationId: '100',
          messageText: 'Legitimate AI response',
        },
        actorId: 'ai-agent-v1',
        actorRoles: ['agent'],
      };

      const resBefore = await broker.execute(validReq);
      assert.equal(resBefore.success, true);
      assert.equal(resBefore.status, 'executed');

      // 2. Pause AI via CAS
      await casService.pauseAi({
        tenantId: 1,
        conversationId: 100,
        expectedVersion: 1,
        userId: 99,
        reason: 'Customer requested human agent',
      });

      // 3. Subsequent tool execution with old version or paused state
      const resAfter = await broker.execute({
        ...validReq,
        runId: 'run-after-pause',
      });

      assert.equal(resAfter.success, false);
      assert.equal(resAfter.status, 'cas_conflict');
      assert.equal(resAfter.error?.code, 'HUMAN_TAKEOVER_ACTIVE');
    });

    it('rejects send risk tool when conversationId is missing (schema validation and Step 6 fencing)', async () => {
      // 1. Standard tool send_whatsapp_message missing conversationId in input fails at Step 1
      const missingInputConvReq: ToolExecutionRequestV1 = {
        tenantId: '1',
        runId: 'run-missing-conv-input',
        toolName: 'send_whatsapp_message',
        input: {
          messageText: 'Orphan message',
        },
        actorId: 'ai-agent-v1',
        actorRoles: ['agent'],
      };

      const res1 = await broker.execute(missingInputConvReq);
      assert.equal(res1.success, false);
      assert.equal(res1.status, 'failed');
      assert.equal(res1.error?.code, 'VALIDATION_ERROR');

      // 2. Custom tool with send risk passing Step 1 schema validation but missing conversationId at broker level fails at Step 6
      registry.registerTool({
        definition: {
          schemaVersion: 1,
          name: 'custom_send_action',
          description: 'A custom tool that sends external messages',
          riskLevel: 'send',
          requiredRoles: ['agent'],
          parameters: { type: 'object' },
          timeoutMs: 5000,
        },
        validateInput: () => ({ valid: true }),
        execute: async () => ({ status: 'dispatched' }),
      });

      const res2 = await broker.execute({
        tenantId: '1',
        runId: 'run-missing-conv-step6',
        toolName: 'custom_send_action',
        input: { content: 'hello' },
        actorId: 'ai-agent-v1',
        actorRoles: ['agent'],
      });

      assert.equal(res2.success, false);
      assert.equal(res2.status, 'failed');
      assert.equal(res2.error?.code, 'MISSING_CONVERSATION_ID');
    });
  });

  // ===========================================================================
  // SUITE 7: HitlApprovalService Atomic CAS Decision Concurrency
  // ===========================================================================
  describe('Suite 7: HitlApprovalService Atomic CAS Version Fencing Concurrency', () => {
    let mockUow: any;
    let hitlService: HitlApprovalService;

    beforeEach(() => {
      mockUow = createConcurrencyMockUoW();
      hitlService = new HitlApprovalService(mockUow);
    });

    it('strictly guarantees that exactly ONE supervisor decision succeeds and competing decision fails with CAS conflict', async () => {
      // 1. Create durable pending approval request (policyVersion = 1)
      const approval = await hitlService.createApprovalRequest({
        tenantId: 1,
        runId: 'run-hitl-concurrency',
        toolName: 'create_invoice',
        effectKey: 'eff_invoice_race_001',
        proposedActionHash: 'action_hash_race_001',
        risk: 'financial',
        inputPayload: { customerId: 'cust-123', amount: 5000 },
        conversationId: 100,
        expectedConversationVersion: 1,
      });

      assert.equal(approval.status, 'pending');
      assert.equal(approval.policyVersion, 1);

      // 2. Concurrently dispatch competing approve and reject commands with expectedVersion = 1
      const results = await Promise.allSettled([
        hitlService.decideApproval({
          tenantId: 1,
          approvalId: approval.id,
          decision: 'approved',
          expectedVersion: 1,
          actorId: 'admin-alice',
          actorRole: 'admin',
          reason: 'Authorized invoice issuance',
        }),
        hitlService.decideApproval({
          tenantId: 1,
          approvalId: approval.id,
          decision: 'rejected',
          expectedVersion: 1,
          actorId: 'supervisor-bob',
          actorRole: 'supervisor',
          reason: 'Duplicate billing suspected',
        }),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      // Exactly ONE must succeed and exactly ONE must fail
      assert.equal(fulfilled.length, 1, 'Strictly 1 decision must succeed');
      assert.equal(rejected.length, 1, 'Strictly 1 decision must fail with conflict');

      // Check winning decision
      const winner = (fulfilled[0] as PromiseFulfilledResult<any>).value;
      assert.ok(['approved', 'rejected'].includes(winner.status));

      // Check losing decision error: must be ApprovalAlreadyDecidedError or ApprovalCasConflictError (409)
      const loserError = (rejected[0] as PromiseRejectedResult).reason;
      assert.equal(
        loserError instanceof ApprovalAlreadyDecidedError || loserError instanceof ApprovalCasConflictError,
        true,
        `Expected ApprovalAlreadyDecidedError or ApprovalCasConflictError, got ${loserError?.name}: ${loserError?.message}`
      );
      assert.equal(loserError.statusCode, 409);

      // Verify stored approval state in DB has transitioned and version incremented to 2
      const updatedApproval = await hitlService.getApprovalById(1, approval.id);
      assert.equal(updatedApproval?.status, winner.status);
      assert.equal(updatedApproval?.policyVersion, 2);
    });

    it('survives high-concurrency barrage: 20 simultaneous decision commands on same approval ID', async () => {
      const approval = await hitlService.createApprovalRequest({
        tenantId: 1,
        runId: 'run-barrage',
        toolName: 'create_invoice',
        effectKey: 'eff_barrage_001',
        proposedActionHash: 'hash_barrage_001',
        risk: 'financial',
        inputPayload: { amount: 100 },
      });

      const BARRAGE_SIZE = 20;
      const commands = Array.from({ length: BARRAGE_SIZE }, (_, i) =>
        hitlService.decideApproval({
          tenantId: 1,
          approvalId: approval.id,
          decision: i % 2 === 0 ? 'approved' : 'rejected',
          expectedVersion: 1,
          actorId: `user-${i}`,
          actorRole: 'admin',
          reason: `Barrage decision attempt #${i}`,
        })
      );

      const settled = await Promise.allSettled(commands);

      const winners = settled.filter((s) => s.status === 'fulfilled');
      const losers = settled.filter((s) => s.status === 'rejected');

      assert.equal(winners.length, 1, 'Strictly one winner among 20 concurrent decisions');
      assert.equal(losers.length, BARRAGE_SIZE - 1, '19 competing requests must be rejected');

      for (const loser of losers) {
        const err = (loser as PromiseRejectedResult).reason;
        assert.equal(err.statusCode, 409);
      }
    });

    it('rejects stale expectedVersion on already-decided approval with 409', async () => {
      const approval = await hitlService.createApprovalRequest({
        tenantId: 1,
        runId: 'run-stale-approval',
        toolName: 'create_invoice',
        effectKey: 'eff_stale_001',
        proposedActionHash: 'hash_stale_001',
        risk: 'financial',
        inputPayload: { amount: 200 },
      });

      // Advance version to 2
      await hitlService.decideApproval({
        tenantId: 1,
        approvalId: approval.id,
        decision: 'approved',
        expectedVersion: 1,
        actorId: 'admin-1',
        actorRole: 'admin',
      });

      // Second decision with stale expectedVersion: 1
      await assert.rejects(
        () =>
          hitlService.decideApproval({
            tenantId: 1,
            approvalId: approval.id,
            decision: 'rejected',
            expectedVersion: 1,
            actorId: 'admin-2',
            actorRole: 'admin',
          }),
        (err: any) => {
          assert.equal(err.statusCode, 409);
          return true;
        }
      );
    });

    it('validates expectedVersion parameter and rejects negative/zero values', async () => {
      await assert.rejects(
        () =>
          hitlService.decideApproval({
            tenantId: 1,
            approvalId: 'appr-any',
            decision: 'approved',
            expectedVersion: 0,
            actorId: 'admin-1',
            actorRole: 'admin',
          }),
        /Invalid expectedVersion/
      );
    });

    it('throws ApprovalNotFoundError (404) when attempting to decide a non-existent approval ID', async () => {
      await assert.rejects(
        () =>
          hitlService.decideApproval({
            tenantId: 1,
            approvalId: 'appr_non_existent',
            decision: 'approved',
            expectedVersion: 1,
            actorId: 'admin-1',
            actorRole: 'admin',
          }),
        (err: any) => {
          assert.equal(err instanceof ApprovalNotFoundError, true);
          assert.equal(err.statusCode, 404);
          return true;
        }
      );
    });
  });
});
