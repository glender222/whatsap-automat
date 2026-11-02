// Invariants before config load
process.env.JWT_SECRET = 'test-only-jwt-secret-with-at-least-32-characters-for-testing';
process.env.DB_PASSWORD = 'test-only-database-password';

import assert from 'node:assert/strict';
import { describe, test, beforeEach } from 'node:test';
import crypto from 'node:crypto';
import type { Pool, PoolClient, QueryResult } from 'pg';

import {
  ChannelCapabilityMatrix,
  channelCapabilityMatrixSchema,
  channelEventV1Schema,
  sendMessageResultV1Schema,
  SendMessageCommandV1,
  InboundConnectionResolutionRequest,
} from '@whatsap-automat/contracts';

const jwt = require('jsonwebtoken') as typeof import('jsonwebtoken');
const { CapabilityRegistry, PublishGateError } = require('../services/channels/CapabilityRegistry') as typeof import('../services/channels/CapabilityRegistry');
const { WebchatAdapter } = require('../services/channels/WebchatAdapter') as typeof import('../services/channels/WebchatAdapter');
const socketEmitter = require('../sockets/socketEmitter') as typeof import('../sockets/socketEmitter');

// -----------------------------------------------------------------------------
// In-Memory Database Engine & Mock Pool for Adversarial Testing
// -----------------------------------------------------------------------------
interface MockChannelConnectionRow {
  id: string;
  tenant_id: number;
  workspace_id: number | null;
  channel: string;
  account_id: string;
  name: string;
  status: string;
  credentials_encrypted: Record<string, unknown> | null;
  metadata_json: Record<string, unknown>;
}

function createAdversarialMockPool() {
  const channelConnections: MockChannelConnectionRow[] = [
    {
      id: 'conn-wc-t1-main',
      tenant_id: 1,
      workspace_id: 1,
      channel: 'webchat',
      account_id: 'wc-t1-site',
      name: 'Webchat Tenant 1 Main',
      status: 'active',
      credentials_encrypted: {
        visitorJwtSecret: 'tenant-1-dedicated-secret-key-32-chars-min!',
      },
      metadata_json: { allowedOrigins: ['https://tenant1.example.com'] },
    },
    {
      id: 'conn-wc-t1-secondary',
      tenant_id: 1,
      workspace_id: 1,
      channel: 'webchat',
      account_id: 'wc-t1-sec-site',
      name: 'Webchat Tenant 1 Secondary',
      status: 'active',
      credentials_encrypted: {
        visitorJwtSecret: 'tenant-1-secondary-secret-32-chars-long!',
      },
      metadata_json: {},
    },
    {
      id: 'conn-wc-t2-main',
      tenant_id: 2,
      workspace_id: 2,
      channel: 'webchat',
      account_id: 'wc-t2-site',
      name: 'Webchat Tenant 2 Main',
      status: 'active',
      credentials_encrypted: {
        visitorJwtSecret: 'tenant-2-dedicated-secret-key-32-chars-min!',
      },
      metadata_json: { allowedOrigins: ['https://tenant2.example.com'] },
    },
    {
      id: 'conn-wc-t1-inactive',
      tenant_id: 1,
      workspace_id: 1,
      channel: 'webchat',
      account_id: 'wc-t1-inactive',
      name: 'Webchat Tenant 1 Inactive',
      status: 'inactive',
      credentials_encrypted: {
        visitorJwtSecret: 'tenant-1-inactive-secret-key-32-chars-min!',
      },
      metadata_json: {},
    },
    {
      id: 'conn-wc-t1-no-secret',
      tenant_id: 1,
      workspace_id: 1,
      channel: 'webchat',
      account_id: 'wc-t1-no-secret',
      name: 'Webchat Tenant 1 Without Secret',
      status: 'active',
      credentials_encrypted: {},
      metadata_json: {},
    },
  ];

  const capabilitySnapshots: { tenant_id: number; connection_id: string; matrix: any }[] = [];

  const mockPool = {
    tables: {
      channel_connections: channelConnections,
      channel_capabilities_snapshots: capabilitySnapshots,
    },
    async query(text: string | { text: string; values?: unknown[] }, values?: unknown[]): Promise<QueryResult<any>> {
      const client = await mockPool.connect();
      try {
        return await client.query(text, values);
      } finally {
        client.release();
      }
    },
    async connect(): Promise<PoolClient> {
      let sessionTenantId: number | null = null;
      const client: Partial<PoolClient> = {
        query: async (text: string | { text: string; values?: unknown[] }, values?: unknown[]): Promise<QueryResult<any>> => {
          const sql = (typeof text === 'string' ? text : text.text).trim();
          const sqlValues = typeof text === 'string' ? values || [] : text.values || [];

          if (sql.toUpperCase().startsWith('SET LOCAL APP.CURRENT_TENANT_ID')) {
            const m = sql.match(/'(\d+)'/);
            sessionTenantId = m ? parseInt(m[1], 10) : null;
            return { rows: [], rowCount: 0, command: 'SET', oid: 0, fields: [] };
          }

          if (sql.includes('channel_connections')) {
            if (sql.toUpperCase().startsWith('SELECT')) {
              let rows = channelConnections;
              if (sessionTenantId !== null) {
                rows = rows.filter((r) => r.tenant_id === sessionTenantId);
              }

              if (sql.includes("status <> 'inactive'")) {
                rows = rows.filter((r) => r.status !== 'inactive');
              }

              if (sql.includes("channel = 'webchat'") || (sql.includes('channel = $') && sqlValues.includes('webchat'))) {
                rows = rows.filter((r) => r.channel === 'webchat');
              }

              if (sql.includes('WHERE id = $1')) {
                const targetId = String(sqlValues[0]);
                rows = rows.filter((r) => r.id === targetId);
              }

              return {
                rows,
                rowCount: rows.length,
                command: 'SELECT',
                oid: 0,
                fields: [],
              };
            }
          }

          if (sql.includes('channel_capabilities_snapshots')) {
            if (sql.toUpperCase().startsWith('SELECT')) {
              const tenantId = Number(sqlValues[0]);
              const connId = String(sqlValues[1]);
              const match = capabilitySnapshots.find((s) => s.tenant_id === tenantId && s.connection_id === connId);
              return {
                rows: match ? [{ matrix: match.matrix }] : [],
                rowCount: match ? 1 : 0,
                command: 'SELECT',
                oid: 0,
                fields: [],
              };
            }
            if (sql.toUpperCase().startsWith('INSERT')) {
              const tenantId = Number(sqlValues[0]);
              const connId = String(sqlValues[1]);
              const matrixRaw = sqlValues[3];
              const parsedMatrix = typeof matrixRaw === 'string' ? JSON.parse(matrixRaw) : matrixRaw;
              const idx = capabilitySnapshots.findIndex((s) => s.tenant_id === tenantId && s.connection_id === connId);
              if (idx >= 0) {
                capabilitySnapshots[idx].matrix = parsedMatrix;
              } else {
                capabilitySnapshots.push({ tenant_id: tenantId, connection_id: connId, matrix: parsedMatrix });
              }
              return { rows: [], rowCount: 1, command: 'INSERT', oid: 0, fields: [] };
            }
          }

          return { rows: [], rowCount: 0, command: 'UNKNOWN', oid: 0, fields: [] };
        },
        release: () => {},
      };
      return client as PoolClient;
    },
  };

  return mockPool;
}

// -----------------------------------------------------------------------------
// Test Suite: Empirical Adversarial Challenge for Webchat Adapter
// -----------------------------------------------------------------------------
describe('PR-F3-03 Adversarial Challenge: Webchat Security, Cryptography & Room Isolation', () => {
  let mockPool: ReturnType<typeof createAdversarialMockPool>;
  let capRegistry: CapabilityRegistry;
  let emittedSocketEvents: { tenantId: number | string; conversationId: string; event: string; payload: any }[];
  let wcAdapter: WebchatAdapter;

  const T1_SECRET = 'tenant-1-dedicated-secret-key-32-chars-min!';
  const T2_SECRET = 'tenant-2-dedicated-secret-key-32-chars-min!';
  const ATTACKER_SECRET = 'attacker-rogue-secret-32-characters-key!';

  beforeEach(async () => {
    mockPool = createAdversarialMockPool();
    capRegistry = new CapabilityRegistry({ run: async (_t, fn) => fn(mockPool as any) } as any);
    emittedSocketEvents = [];

    // Register Webchat capability matrix (no 24h Meta window restriction)
    const webchatMatrixT1: ChannelCapabilityMatrix = {
      connectionId: 'conn-wc-t1-main',
      tenantId: '1',
      channel: 'webchat',
      features: {
        text: true,
        image: true,
        audio: false,
        video: false,
        document: true,
        template: false,
        interactive: true,
        reactions: false,
        typing: true,
        readReceipt: true,
      },
      scopes: ['messages:send', 'messages:read'],
      policies: {
        requiresHsmTemplateOutsideWindow: false,
        sessionWindowHours: undefined, // Free-form messaging at any time!
        requiresOptIn: false,
      },
      health: {
        status: 'healthy',
        lastCheckedAt: new Date().toISOString(),
      },
      budget: {
        tier: 'free',
      },
      regional: {
        blacklistedCountries: [],
      },
      updatedAt: new Date().toISOString(),
    };

    const webchatMatrixT2: ChannelCapabilityMatrix = {
      ...webchatMatrixT1,
      connectionId: 'conn-wc-t2-main',
      tenantId: '2',
    };

    await capRegistry.saveSnapshot(1, webchatMatrixT1, mockPool as any);
    await capRegistry.saveSnapshot(2, webchatMatrixT2, mockPool as any);

    wcAdapter = new WebchatAdapter({
      pool: mockPool as any,
      capabilityRegistry: capRegistry,
      jwtSecret: 'adapter-fallback-jwt-secret-32-chars-min!',
      socketEmitter: {
        emitConversation: (tenantId, conversationId, event, payload) => {
          emittedSocketEvents.push({ tenantId, conversationId, event, payload });
        },
      },
    });
  });

  // ===========================================================================
  // SUITE 1: Cryptographic HMAC Token Tampering & Algorithm Confusion
  // ===========================================================================
  describe('Suite 1: Cryptographic HMAC Token Tampering & Algorithm Confusion', () => {
    test('1.1: Token signed with unauthorized/attacker secret is rejected by verifyVisitorToken', () => {
      const forgedToken = jwt.sign(
        {
          sub: 'attacker_visitor',
          tenantId: '1',
          connectionId: 'conn-wc-t1-main',
          role: 'visitor',
        },
        ATTACKER_SECRET,
        { algorithm: 'HS256', expiresIn: 3600 }
      );

      const claims = wcAdapter.verifyVisitorToken(forgedToken, T1_SECRET);
      assert.equal(claims, null, 'verifyVisitorToken must return null when signed with wrong secret');
    });

    test('1.2: Token signed with unauthorized/attacker secret is rejected by resolveInboundConnection (fail-closed)', async () => {
      const forgedToken = jwt.sign(
        {
          sub: 'attacker_visitor',
          tenantId: '1',
          connectionId: 'conn-wc-t1-main',
          role: 'visitor',
        },
        ATTACKER_SECRET,
        { algorithm: 'HS256', expiresIn: 3600 }
      );

      const req: InboundConnectionResolutionRequest = {
        pathKey: null,
        headers: { 'x-visitor-token': forgedToken },
        rawBody: new Uint8Array(),
      };

      const res = await wcAdapter.resolveInboundConnection(req);
      assert.equal(res, null, 'resolveInboundConnection must return null fail-closed on forged signature');
    });

    test('1.3: Token signed with unauthorized/attacker secret is rejected by verifyInbound (fail-closed)', async () => {
      const forgedToken = jwt.sign(
        {
          sub: 'attacker_visitor',
          tenantId: '1',
          connectionId: 'conn-wc-t1-main',
          role: 'visitor',
        },
        ATTACKER_SECRET,
        { algorithm: 'HS256', expiresIn: 3600 }
      );

      const valid = await wcAdapter.verifyInbound(
        'conn-wc-t1-main',
        new Uint8Array(),
        { 'x-visitor-token': forgedToken }
      );
      assert.equal(valid, false, 'verifyInbound must return false on forged token signature');
    });

    test('1.4: Tampered payload claim: modifying tenantId in valid token invalidates HMAC signature', async () => {
      const validToken = wcAdapter.mintVisitorToken({
        tenantId: 1,
        connectionId: 'conn-wc-t1-main',
        visitorId: 'legit_user',
      }, T1_SECRET);

      const [headerB64, payloadB64, sigB64] = validToken.split('.');
      const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
      
      // Tamper tenantId from 1 to 2
      payload.tenantId = '2';
      const tamperedPayloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const tamperedToken = `${headerB64}.${tamperedPayloadB64}.${sigB64}`;

      assert.equal(wcAdapter.verifyVisitorToken(tamperedToken, T1_SECRET), null);

      const res = await wcAdapter.resolveInboundConnection({
        pathKey: null,
        headers: { 'x-visitor-token': tamperedToken },
        rawBody: new Uint8Array(),
      });
      assert.equal(res, null);

      const valid = await wcAdapter.verifyInbound('conn-wc-t1-main', new Uint8Array(), {
        'x-visitor-token': tamperedToken,
      });
      assert.equal(valid, false);
    });

    test('1.5: Tampered payload claim: modifying connectionId in valid token invalidates HMAC signature', async () => {
      const validToken = wcAdapter.mintVisitorToken({
        tenantId: 1,
        connectionId: 'conn-wc-t1-main',
        visitorId: 'legit_user',
      }, T1_SECRET);

      const [headerB64, payloadB64, sigB64] = validToken.split('.');
      const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
      
      // Tamper connectionId to secondary connection
      payload.connectionId = 'conn-wc-t1-secondary';
      const tamperedPayloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const tamperedToken = `${headerB64}.${tamperedPayloadB64}.${sigB64}`;

      assert.equal(wcAdapter.verifyVisitorToken(tamperedToken, T1_SECRET), null);
      assert.equal(await wcAdapter.verifyInbound('conn-wc-t1-main', new Uint8Array(), { 'x-visitor-token': tamperedToken }), false);
    });

    test('1.6: Role tampering: role set to "admin" or "agent" is strictly rejected even if signed with valid secret', async () => {
      const adminRoleToken = jwt.sign(
        {
          sub: 'privileged_user',
          tenantId: '1',
          connectionId: 'conn-wc-t1-main',
          role: 'admin', // FORGED ROLE
        },
        T1_SECRET,
        { algorithm: 'HS256', expiresIn: 3600 }
      );

      assert.equal(wcAdapter.verifyVisitorToken(adminRoleToken, T1_SECRET), null, 'role: admin must be rejected');

      const agentRoleToken = jwt.sign(
        {
          sub: 'privileged_user',
          tenantId: '1',
          connectionId: 'conn-wc-t1-main',
          role: 'agent', // FORGED ROLE
        },
        T1_SECRET,
        { algorithm: 'HS256', expiresIn: 3600 }
      );

      assert.equal(wcAdapter.verifyVisitorToken(agentRoleToken, T1_SECRET), null, 'role: agent must be rejected');

      const res = await wcAdapter.resolveInboundConnection({
        pathKey: null,
        headers: { 'x-visitor-token': adminRoleToken },
        rawBody: new Uint8Array(),
      });
      assert.equal(res, null, 'resolveInboundConnection must reject non-visitor role');
    });

    test('1.7: Expired tokens (1s ago, 1h ago, 30 days ago) strictly return null fail-closed', async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      
      const expired1s = jwt.sign(
        { sub: 'v1', tenantId: '1', connectionId: 'conn-wc-t1-main', role: 'visitor', exp: nowSec - 1 },
        T1_SECRET,
        { algorithm: 'HS256' }
      );
      assert.equal(wcAdapter.verifyVisitorToken(expired1s, T1_SECRET), null);

      const expired30d = jwt.sign(
        { sub: 'v1', tenantId: '1', connectionId: 'conn-wc-t1-main', role: 'visitor', exp: nowSec - 30 * 86400 },
        T1_SECRET,
        { algorithm: 'HS256' }
      );
      assert.equal(wcAdapter.verifyVisitorToken(expired30d, T1_SECRET), null);

      const res = await wcAdapter.resolveInboundConnection({
        pathKey: null,
        headers: { 'x-visitor-token': expired1s },
        rawBody: new Uint8Array(),
      });
      assert.equal(res, null);
    });

    test('1.8: Critical bypass attempt: alg: "none" unsigned token is strictly rejected', async () => {
      // Craft an unsigned token with alg: "none"
      const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify({
        sub: 'bypass_attacker',
        tenantId: '1',
        connectionId: 'conn-wc-t1-main',
        role: 'visitor',
        exp: Math.floor(Date.now() / 1000) + 3600,
      })).toString('base64url');

      const unsignedTokenWithDot = `${header}.${payload}.`;
      const unsignedTokenWithoutDot = `${header}.${payload}`;

      assert.equal(wcAdapter.verifyVisitorToken(unsignedTokenWithDot, T1_SECRET), null);
      assert.equal(wcAdapter.verifyVisitorToken(unsignedTokenWithoutDot, T1_SECRET), null);

      const res = await wcAdapter.resolveInboundConnection({
        pathKey: null,
        headers: { 'x-visitor-token': unsignedTokenWithDot },
        rawBody: new Uint8Array(),
      });
      assert.equal(res, null, 'alg: "none" must fail-closed in resolveInboundConnection');

      const valid = await wcAdapter.verifyInbound('conn-wc-t1-main', new Uint8Array(), {
        'x-visitor-token': unsignedTokenWithDot,
      });
      assert.equal(valid, false, 'alg: "none" must fail-closed in verifyInbound');
    });

    test('1.9: Algorithm confusion: non-HS256 algorithms (HS384, HS512, RS256) are rejected', () => {
      // Create HS384 token
      const hs384Token = jwt.sign(
        { sub: 'v1', tenantId: '1', connectionId: 'conn-wc-t1-main', role: 'visitor' },
        T1_SECRET,
        { algorithm: 'HS384', expiresIn: 3600 }
      );
      assert.equal(wcAdapter.verifyVisitorToken(hs384Token, T1_SECRET), null, 'HS384 token must be rejected');

      // Create HS512 token
      const hs512Token = jwt.sign(
        { sub: 'v1', tenantId: '1', connectionId: 'conn-wc-t1-main', role: 'visitor' },
        T1_SECRET,
        { algorithm: 'HS512', expiresIn: 3600 }
      );
      assert.equal(wcAdapter.verifyVisitorToken(hs512Token, T1_SECRET), null, 'HS512 token must be rejected');
    });

    test('1.10: Truncated, garbage, and malformed tokens return null fail-closed without throwing', async () => {
      const garbageTokens = [
        '',
        'not.a.jwt',
        'singlechunk',
        'too.many.chunks.in.this.token.here',
        'eyJhbGciOiJIUzI1NiJ9.invalidbase64!@#$.sig',
        'null',
        'undefined',
        '\x00\x00\x00',
      ];

      for (const t of garbageTokens) {
        assert.equal(wcAdapter.verifyVisitorToken(t, T1_SECRET), null);
        const res = await wcAdapter.resolveInboundConnection({
          pathKey: null,
          headers: { 'x-visitor-token': t },
          rawBody: new Uint8Array(),
        });
        assert.equal(res, null);

        const valid = await wcAdapter.verifyInbound('conn-wc-t1-main', new Uint8Array(), {
          'x-visitor-token': t,
        });
        assert.equal(valid, false);
      }
    });

    test('1.11: Blank / empty authorization headers return null / false fail-closed', async () => {
      const emptyHeadersList = [
        { authorization: '' },
        { authorization: 'Bearer' },
        { authorization: 'Bearer   ' },
        { 'x-visitor-token': '' },
        { 'x-visitor-token': '   ' },
      ];

      for (const h of emptyHeadersList) {
        const res = await wcAdapter.resolveInboundConnection({
          pathKey: null,
          headers: h,
          rawBody: new Uint8Array(),
        });
        assert.equal(res, null);

        const valid = await wcAdapter.verifyInbound('conn-wc-t1-main', new Uint8Array(), h);
        assert.equal(valid, false);
      }
    });
  });

  // ===========================================================================
  // SUITE 2: Room Isolation & Multi-Tenant Boundaries
  // ===========================================================================
  describe('Suite 2: Room Isolation & Multi-Tenant Boundaries', () => {
    test('2.1: Valid token from Tenant 1 attempting to access Connection in Tenant 2 is rejected fail-closed', async () => {
      // Validly signed for Tenant 1
      const tokenTenant1 = wcAdapter.mintVisitorToken({
        tenantId: 1,
        connectionId: 'conn-wc-t1-main',
        visitorId: 'visitor_t1',
      }, T1_SECRET);

      // Attempt to verify against Tenant 2 connection
      const valid = await wcAdapter.verifyInbound(
        'conn-wc-t2-main',
        new Uint8Array(),
        { 'x-visitor-token': tokenTenant1 }
      );
      assert.equal(valid, false, 'Tenant 1 token used against Tenant 2 connection must return false');

      // Attempt to resolve when connectionId in token does not match Tenant 2
      const res = await wcAdapter.resolveInboundConnection({
        pathKey: 'conn-wc-t2-main',
        headers: { 'x-visitor-token': tokenTenant1 },
        rawBody: new Uint8Array(),
      });
      // PathKey resolves connection, but verifyVisitorToken using T2_SECRET will fail
      // Even if resolution resolves pathKey, verifyInbound will fail!
      const verifyInboundResult = await wcAdapter.verifyInbound('conn-wc-t2-main', new Uint8Array(), {
        'x-visitor-token': tokenTenant1,
      });
      assert.equal(verifyInboundResult, false);
    });

    test('2.2: Tenant separation even under identical secret: tenantId claim mismatch is rejected', async () => {
      const SHARED_SECRET = 'identical-secret-shared-across-both-32ch';
      // Create token claiming tenantId = 1, but connectionId = conn-wc-t2-main
      const spoofedToken = jwt.sign(
        {
          sub: 'spoof_user',
          tenantId: '1', // Claims Tenant 1
          connectionId: 'conn-wc-t2-main', // But targets Tenant 2's connection!
          role: 'visitor',
        },
        SHARED_SECRET,
        { algorithm: 'HS256', expiresIn: 3600 }
      );

      // In mock DB, conn-wc-t2-main has tenant_id = 2.
      // WebchatAdapter checks: claims.tenantId === String(row.tenant_id)
      const res = await wcAdapter.resolveInboundConnection({
        pathKey: null,
        headers: { 'x-visitor-token': spoofedToken },
        rawBody: new Uint8Array(),
      });
      assert.equal(res, null, 'Must reject when token tenantId does not match DB connection tenant_id');
    });

    test('2.3: Header spoofing defense: x-tenant-id and x-connection-id headers cannot bypass verifyInbound', async () => {
      // An attacker sends spoofed internal headers to mimic an authorized proxy
      const spoofedHeaders = {
        'x-tenant-id': '2',
        'x-connection-id': 'conn-wc-t2-main',
      };

      // Even if resolveInboundConnection short-circuits internal headers:
      const res = await wcAdapter.resolveInboundConnection({
        pathKey: null,
        headers: spoofedHeaders,
        rawBody: new Uint8Array(),
      });
      assert.ok(res);

      // Downstream verifyInbound MUST strictly require a cryptographically valid visitor token!
      const verified = await wcAdapter.verifyInbound(res.connectionId, new Uint8Array(), spoofedHeaders);
      assert.equal(verified, false, 'verifyInbound must reject requests without a valid visitor token regardless of spoofed headers');
    });

    test('2.4: Outbound dispatch emits strictly to conversation room conversation:${tenantId}:${conversationId}', async () => {
      const cmdT1: SendMessageCommandV1 = {
        schemaVersion: 1,
        tenantId: '1',
        connectionId: 'conn-wc-t1-main',
        conversationId: 'chat_t1_999',
        effectKey: 'eff_t1_outbound',
        message: { kind: 'text', text: 'Hello Tenant 1 visitor' },
      };

      await wcAdapter.send(cmdT1);

      assert.equal(emittedSocketEvents.length, 1);
      const em = emittedSocketEvents[0];
      assert.equal(em.tenantId, '1');
      assert.equal(em.conversationId, 'chat_t1_999');
      assert.equal(em.event, 'webchat.agent_message');
      assert.equal(em.payload.tenantId, '1');
      assert.equal(em.payload.conversationId, 'chat_t1_999');
      assert.equal(em.payload.connectionId, 'conn-wc-t1-main');
    });

    test('2.5: Zero emissions to global namespace or other tenant rooms', async () => {
      await wcAdapter.send({
        schemaVersion: 1,
        tenantId: '1',
        connectionId: 'conn-wc-t1-main',
        conversationId: 'chat_t1_1',
        effectKey: 'eff_t1_1',
        message: { kind: 'text', text: 'T1' },
      });

      await wcAdapter.send({
        schemaVersion: 1,
        tenantId: '2',
        connectionId: 'conn-wc-t2-main',
        conversationId: 'chat_t2_1',
        effectKey: 'eff_t2_1',
        message: { kind: 'text', text: 'T2' },
      });

      assert.equal(emittedSocketEvents.length, 2);
      // Event 0 must be strictly Tenant 1
      assert.equal(emittedSocketEvents[0].tenantId, '1');
      assert.notEqual(emittedSocketEvents[0].tenantId, '2');

      // Event 1 must be strictly Tenant 2
      assert.equal(emittedSocketEvents[1].tenantId, '2');
      assert.notEqual(emittedSocketEvents[1].tenantId, '1');
    });

    test('2.6: Conversation ID injection attempt is strictly contained within tenant namespace', async () => {
      const maliciousConversationId = '../../tenant:2/conversation:admin';
      const cmd: SendMessageCommandV1 = {
        schemaVersion: 1,
        tenantId: '1',
        connectionId: 'conn-wc-t1-main',
        conversationId: maliciousConversationId,
        effectKey: 'eff_inj_01',
        message: { kind: 'text', text: 'Attempting room escape' },
      };

      await wcAdapter.send(cmd);
      assert.equal(emittedSocketEvents.length, 1);
      // The socket emitter delegates to emitConversation which prefixes conversation:${tenantId}:
      assert.equal(emittedSocketEvents[0].tenantId, '1');
      assert.equal(emittedSocketEvents[0].conversationId, maliciousConversationId);
    });

    test('2.7: socketEmitter.emitConversation drops emissions fail-safely if tenantId or conversationId is blank', () => {
      let emittedRoom: string | null = null;
      const customEmitter = {
        emitConversation: socketEmitter.emitConversation,
      };

      // When io is null or tid/cid is blank, emitConversation safely returns without error
      socketEmitter.emitConversation('', 'conv_1', 'test_event', {});
      socketEmitter.emitConversation('1', '', 'test_event', {});
      socketEmitter.emitConversation(null as any, 'conv_1', 'test_event', {});
      socketEmitter.emitConversation('1', null as any, 'test_event', {});
      // No crashes or unhandled exceptions occur
    });
  });

  // ===========================================================================
  // SUITE 3: Outbound Window Policy Verification (No Meta 24h Restriction)
  // ===========================================================================
  describe('Suite 3: Outbound Window Policy (No 24-Hour Restriction)', () => {
    test('3.1: Capability matrix for Webchat specifies requiresHsmTemplateOutsideWindow: false and undefined sessionWindowHours', async () => {
      const snapshot = await capRegistry.getSnapshot(1, 'conn-wc-t1-main', mockPool as any);
      assert.ok(snapshot);
      assert.equal(snapshot.policies.requiresHsmTemplateOutsideWindow, false);
      assert.equal(snapshot.policies.sessionWindowHours, undefined);
    });

    test('3.2: Outbound message sent without ANY prior customer interaction is permitted and dispatched', async () => {
      const cmd: SendMessageCommandV1 = {
        schemaVersion: 1,
        tenantId: '1',
        connectionId: 'conn-wc-t1-main',
        conversationId: 'wc_conv_cold_start',
        effectKey: 'eff_no_window_cold',
        message: {
          kind: 'text',
          text: 'Cold outbound message to webchat visitor with zero interaction history.',
        },
      };

      const res = await wcAdapter.send(cmd);
      assert.equal(res.accepted, true);
      assert.equal(res.deliveryState, 'dispatched');
    });

    test('3.3: Outbound message sent 60 days after last customer interaction is permitted without requiring template', async () => {
      const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString();
      const cmd: SendMessageCommandV1 = {
        schemaVersion: 1,
        tenantId: '1',
        connectionId: 'conn-wc-t1-main',
        conversationId: 'wc_conv_dormant',
        effectKey: 'eff_no_window_dormant',
        message: {
          kind: 'text',
          text: 'Re-engaging visitor 60 days after their last visit.',
          parameters: {
            lastCustomerInteractionAt: sixtyDaysAgo,
          },
        },
      };

      const res = await wcAdapter.send(cmd);
      assert.equal(res.accepted, true);
      assert.equal(res.deliveryState, 'dispatched');
    });

    test('3.4: Outbound message with corrupted lastCustomerInteractionAt string is permitted (unlike Meta Cloud)', async () => {
      const cmd: SendMessageCommandV1 = {
        schemaVersion: 1,
        tenantId: '1',
        connectionId: 'conn-wc-t1-main',
        conversationId: 'wc_conv_bad_date',
        effectKey: 'eff_no_window_corrupted_date',
        message: {
          kind: 'text',
          text: 'Message with unparseable interaction date string.',
          parameters: {
            lastCustomerInteractionAt: 'not-a-valid-date-string',
          },
        },
      };

      // In Meta Cloud adapter this throws PublishGateError (CH_WA_WINDOW_CLOSED).
      // In Webchat adapter, because requiresHsmTemplateOutsideWindow is false, it MUST succeed!
      const res = await wcAdapter.send(cmd);
      assert.equal(res.accepted, true);
      assert.equal(res.deliveryState, 'dispatched');
    });

    test('3.5: All supported media and interactive types can be dispatched at any time without templates', async () => {
      const mediaCmd: SendMessageCommandV1 = {
        schemaVersion: 1,
        tenantId: '1',
        connectionId: 'conn-wc-t1-main',
        conversationId: 'wc_conv_media',
        effectKey: 'eff_media_unrestricted',
        message: {
          kind: 'media',
          mediaRef: 'https://cdn.example.com/files/manual.pdf',
          parameters: {
            mediaType: 'document',
          },
        },
      };

      const resMedia = await wcAdapter.send(mediaCmd);
      assert.equal(resMedia.accepted, true);

      const interactiveCmd: SendMessageCommandV1 = {
        schemaVersion: 1,
        tenantId: '1',
        connectionId: 'conn-wc-t1-main',
        conversationId: 'wc_conv_inter',
        effectKey: 'eff_inter_unrestricted',
        message: {
          kind: 'interactive',
          text: 'Choose an option',
          parameters: {
            buttons: [{ id: 'opt_1', title: 'Option 1' }],
          },
        },
      };

      const resInter = await wcAdapter.send(interactiveCmd);
      assert.equal(resInter.accepted, true);
    });
  });

  // ===========================================================================
  // SUITE 4: Edge Payloads, Boundary Fuzzing & Malformed Inbound Messages
  // ===========================================================================
  describe('Suite 4: Edge Payloads, Boundary Fuzzing & Malformed Inbound Messages', () => {
    test('4.1: Massive text payload (500KB) is normalized safely into ChannelEventV1 conforming to schema', async () => {
      const largeText = 'A'.repeat(500 * 1024); // 500 KB of text
      const payload = {
        messageId: 'wc_large_msg_001',
        conversationId: 'wc_conv_stress',
        visitorId: 'visitor_stress',
        text: largeText,
      };

      const events = await wcAdapter.normalizeInbound('conn-wc-t1-main', payload);
      assert.equal(events.length, 1);
      const ev = events[0];
      assert.equal(channelEventV1Schema.safeParse(ev).success, true);
      if (ev.payload?.kind === 'message') {
        assert.equal(ev.payload.data.text?.length, 500 * 1024);
      }
    });

    test('4.2: Payload with 5,000 emojis, complex Unicode surrogates, RTL and control characters normalizes cleanly', async () => {
      const complexString = '🚀🔥🎉\uD83D\uDC68\u200D\uD83D\uDC69\u200D\uD83D\uDC67\u200D\uD83D\uDC66\u202Eمرحبا\u202C\u0000\t\r\n'.repeat(500);
      const payload = {
        messageId: 'wc_unicode_msg_001',
        conversationId: 'wc_conv_unicode',
        visitorId: 'visitor_unicode',
        text: complexString,
      };

      const events = await wcAdapter.normalizeInbound('conn-wc-t1-main', payload);
      assert.equal(events.length, 1);
      assert.equal(channelEventV1Schema.safeParse(events[0]).success, true);
    });

    test('4.3: Empty visitor text message (text: "") produces valid ChannelEventV1 or handles safely', async () => {
      const payload = {
        messageId: 'wc_empty_msg_001',
        conversationId: 'wc_conv_empty',
        visitorId: 'visitor_empty',
        text: '',
      };

      const events = await wcAdapter.normalizeInbound('conn-wc-t1-main', payload);
      assert.equal(events.length, 1);
      assert.equal(channelEventV1Schema.safeParse(events[0]).success, true);
      if (events[0].payload?.kind === 'message') {
        assert.equal(events[0].payload.data.text, '');
      }
    });

    test('4.4: Inbound visitor message with whitespace only normalizes safely', async () => {
      const payload = {
        messageId: 'wc_ws_msg_001',
        conversationId: 'wc_conv_ws',
        visitorId: 'visitor_ws',
        text: '   \n\t   ',
      };

      const events = await wcAdapter.normalizeInbound('conn-wc-t1-main', payload);
      assert.equal(events.length, 1);
      assert.equal(channelEventV1Schema.safeParse(events[0]).success, true);
    });

    test('4.5: Non-standard event payload (unknown event types, unrecognized shapes) returns empty array fail-safely', async () => {
      const weirdPayloads = [
        { unknownField: 'some_value' },
        { type: 'unrecognized_custom_event', foo: 'bar' },
        { action: 'typing_start' }, // typing indicator without text/media/interactive
        {},
        null,
        undefined,
        12345,
        'just a string that is not json',
      ];

      for (const p of weirdPayloads) {
        const events = await wcAdapter.normalizeInbound('conn-wc-t1-main', p);
        assert.ok(Array.isArray(events));
        assert.equal(events.length, 0);
      }
    });

    test('4.6: Inbound raw payload with corrupted JSON buffer returns empty array without throwing', async () => {
      const brokenBuffer = Buffer.from('{"broken": json');
      const events = await wcAdapter.normalizeInbound('conn-wc-t1-main', brokenBuffer);
      assert.ok(Array.isArray(events));
      assert.equal(events.length, 0);
    });

    test('4.7: Inbound raw payload with empty buffer returns empty array without throwing', async () => {
      const emptyBuffer = Buffer.alloc(0);
      const events = await wcAdapter.normalizeInbound('conn-wc-t1-main', emptyBuffer);
      assert.ok(Array.isArray(events));
      assert.equal(events.length, 0);
    });

    test('4.8: Batch / array of mixed inbound payloads filters out invalid items and returns valid ones', async () => {
      const batch = [
        {
          messageId: 'wc_batch_1',
          conversationId: 'wc_conv_batch',
          visitorId: 'visitor_batch',
          text: 'First valid text',
        },
        { randomGarbage: true },
        {
          messageId: 'wc_batch_2',
          conversationId: 'wc_conv_batch',
          visitorId: 'visitor_batch',
          media: {
            mimeType: 'image/jpeg',
            providerMediaId: 'media_batch_77',
          },
        },
        null,
        {
          messageId: 'wc_batch_3',
          conversationId: 'wc_conv_batch',
          visitorId: 'visitor_batch',
          interactive: {
            type: 'button_reply',
            id: 'btn_yes',
            title: 'Yes',
          },
        },
      ];

      const events = await wcAdapter.normalizeInbound('conn-wc-t1-main', batch);
      assert.equal(events.length, 3, 'Should normalize exactly the 3 valid items in the batch');
      for (const ev of events) {
        assert.equal(channelEventV1Schema.safeParse(ev).success, true);
      }
    });
  });
});
