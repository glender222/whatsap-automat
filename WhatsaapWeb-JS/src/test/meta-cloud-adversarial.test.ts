// Invariants before config load
process.env.JWT_SECRET = 'test-only-jwt-secret-with-at-least-32-characters-for-testing';
process.env.DB_PASSWORD = 'test-only-database-password';

import assert from 'node:assert/strict';
import { describe, test, beforeEach } from 'node:test';
import type { Pool, PoolClient, QueryResult } from 'pg';

import {
  ChannelCapabilityMatrix,
  SendMessageCommandV1,
  InboundConnectionResolutionRequest,
} from '@whatsap-automat/contracts';

const { CapabilityRegistry, PublishGateError } = require('../services/channels/CapabilityRegistry') as typeof import('../services/channels/CapabilityRegistry');
const { MetaCloudAdapter } = require('../services/channels/MetaCloudAdapter') as typeof import('../services/channels/MetaCloudAdapter');

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
      id: 'conn-wa-tenant-1',
      tenant_id: 1,
      workspace_id: 1,
      channel: 'whatsapp-cloud',
      account_id: 'wa-phone-t1-100',
      name: 'WhatsApp Tenant 1',
      status: 'active',
      credentials_encrypted: { accessToken: 'token-t1', appSecret: 'secret-t1' },
      metadata_json: { wabaId: 'waba-1' },
    },
    {
      id: 'conn-wa-tenant-2',
      tenant_id: 2,
      workspace_id: 2,
      channel: 'whatsapp-cloud',
      account_id: 'wa-phone-t2-200',
      name: 'WhatsApp Tenant 2',
      status: 'active',
      credentials_encrypted: { accessToken: 'token-t2', appSecret: 'secret-t2' },
      metadata_json: { wabaId: 'waba-2' },
    },
    {
      id: 'conn-ig-tenant-1',
      tenant_id: 1,
      workspace_id: 1,
      channel: 'instagram',
      account_id: 'ig-account-t1-300',
      name: 'Instagram Tenant 1',
      status: 'active',
      credentials_encrypted: { accessToken: 'token-ig-t1', appSecret: 'secret-ig-t1' },
      metadata_json: { igUserId: 'ig-account-t1-300' },
    },
    {
      id: 'conn-ig-tenant-2',
      tenant_id: 2,
      workspace_id: 2,
      channel: 'instagram',
      account_id: 'ig-account-t2-400',
      name: 'Instagram Tenant 2',
      status: 'active',
      credentials_encrypted: { accessToken: 'token-ig-t2', appSecret: 'secret-ig-t2' },
      metadata_json: { igUserId: 'ig-account-t2-400' },
    },
    {
      id: 'conn-wa-inactive',
      tenant_id: 1,
      workspace_id: 1,
      channel: 'whatsapp-cloud',
      account_id: 'wa-phone-inactive-999',
      name: 'WhatsApp Inactive',
      status: 'inactive',
      credentials_encrypted: { accessToken: 'token-inactive', appSecret: 'secret-inactive' },
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
              if (sql.includes('account_id = $') || sql.includes('account_id =')) {
                const targetAccount = String(sqlValues[0]);
                rows = rows.filter((r) => r.account_id === targetAccount);
              } else if (sql.includes('WHERE id = $') || sql.includes('id = $')) {
                const targetId = String(sqlValues[0]);
                rows = rows.filter((r) => r.id === targetId);
              }
              return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] };
            }
          }

          if (sql.includes('channel_capabilities_snapshots')) {
            if (sql.toUpperCase().startsWith('INSERT')) {
              const parsedMatrix = typeof sqlValues[3] === 'string' ? JSON.parse(sqlValues[3]) : sqlValues[3];
              const existingIdx = capabilitySnapshots.findIndex(
                (s) => s.tenant_id === Number(sqlValues[0]) && s.connection_id === String(sqlValues[1])
              );
              if (existingIdx >= 0) {
                capabilitySnapshots[existingIdx] = {
                  tenant_id: Number(sqlValues[0]),
                  connection_id: String(sqlValues[1]),
                  matrix: parsedMatrix,
                };
              } else {
                capabilitySnapshots.push({
                  tenant_id: Number(sqlValues[0]),
                  connection_id: String(sqlValues[1]),
                  matrix: parsedMatrix,
                });
              }
              return { rows: [], rowCount: 1, command: 'INSERT', oid: 0, fields: [] };
            }
            if (sql.toUpperCase().startsWith('SELECT')) {
              const targetTenant = Number(sqlValues[0]);
              const targetConn = String(sqlValues[1]);
              const found = capabilitySnapshots.filter(
                (r) => r.tenant_id === targetTenant && r.connection_id === targetConn
              );
              return { rows: found, rowCount: found.length, command: 'SELECT', oid: 0, fields: [] };
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

const baseWaMatrixTenant1: ChannelCapabilityMatrix = {
  connectionId: 'conn-wa-tenant-1',
  tenantId: '1',
  channel: 'whatsapp-cloud',
  features: {
    text: true,
    image: true,
    audio: true,
    video: true,
    document: true,
    template: true,
    interactive: true,
    reactions: true,
    typing: true,
    readReceipt: true,
  },
  scopes: ['whatsapp_business_messaging'],
  policies: {
    sessionWindowHours: 24,
    requiresHsmTemplateOutsideWindow: true,
    rateLimitPerMinute: 300,
    requiresOptIn: false,
  },
  health: {
    status: 'healthy',
    lastCheckedAt: new Date().toISOString(),
    latencyMs: 50,
  },
  budget: {
    tier: 'standard',
    costPerMessageCents: 5,
    monthlyBudgetLimitCents: 50000,
    currentMonthSpendCents: 1000,
  },
  regional: {
    blacklistedCountries: ['KP', 'SY', 'IR'],
  },
  updatedAt: new Date().toISOString(),
};

const baseIgMatrixTenant1: ChannelCapabilityMatrix = {
  connectionId: 'conn-ig-tenant-1',
  tenantId: '1',
  channel: 'instagram',
  features: {
    text: true,
    image: true,
    audio: true,
    video: true,
    document: false,
    template: false,
    interactive: true,
    reactions: true,
    typing: true,
    readReceipt: true,
  },
  scopes: ['instagram_basic', 'instagram_manage_messages'],
  policies: {
    sessionWindowHours: 24,
    requiresHsmTemplateOutsideWindow: true,
    rateLimitPerMinute: 300,
    requiresOptIn: false,
  },
  health: {
    status: 'healthy',
    lastCheckedAt: new Date().toISOString(),
    latencyMs: 65,
  },
  budget: {
    tier: 'standard',
    costPerMessageCents: 0,
    monthlyBudgetLimitCents: 50000,
    currentMonthSpendCents: 500,
  },
  regional: {
    blacklistedCountries: ['KP', 'SY', 'IR'],
  },
  updatedAt: new Date().toISOString(),
};

describe('ADVERSARIAL SUITE: MetaCloudAdapter Empirical Stress & Vulnerability Probing', () => {
  let mockPool: ReturnType<typeof createAdversarialMockPool>;
  let registry: CapabilityRegistry;
  let waAdapter: MetaCloudAdapter;
  let igAdapter: MetaCloudAdapter;
  let outboundRequests: { url: string; opts: any }[] = [];

  const mockFetch: typeof fetch = async (input, init) => {
    outboundRequests.push({ url: String(input), opts: init });
    return {
      ok: true,
      status: 200,
      json: async () => ({ messages: [{ id: 'wamid.adversarial_test' }] }),
    } as any;
  };

  beforeEach(async () => {
    outboundRequests = [];
    mockPool = createAdversarialMockPool();

    const mockUow = {
      run: async (tenantId: number, fn: (client: any) => Promise<any>) => {
        const client = await mockPool.connect();
        try {
          await client.query(`SET LOCAL app.current_tenant_id = '${tenantId}'`);
          return await fn(client);
        } finally {
          client.release();
        }
      },
    } as any;

    registry = new CapabilityRegistry(mockUow);
    await registry.saveSnapshot(1, baseWaMatrixTenant1);
    await registry.saveSnapshot(1, baseIgMatrixTenant1);

    waAdapter = new MetaCloudAdapter({
      kind: 'whatsapp-cloud',
      pool: mockPool,
      capabilityRegistry: registry,
      fetchFn: mockFetch,
    });

    igAdapter = new MetaCloudAdapter({
      kind: 'instagram',
      pool: mockPool,
      capabilityRegistry: registry,
      fetchFn: mockFetch,
    });
  });

  // ===========================================================================
  // 1. Tenancy Isolation & Invariant MSG-05 Probing
  // ===========================================================================
  describe('1. Tenancy Isolation & Invariant MSG-05 Probing', () => {
    test('1.1: Inbound request spoofing Tenant 2 WhatsApp phone_number_id against Tenant 1 client resolves to null', async () => {
      const clientT1 = await mockPool.connect();
      try {
        await clientT1.query("SET LOCAL app.current_tenant_id = '1'");
        const spoofReq: InboundConnectionResolutionRequest = {
          headers: {},
          pathKey: null,
          rawBody: Buffer.from(
            JSON.stringify({
              object: 'whatsapp_business_account',
              entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'wa-phone-t2-200' } } }] }],
            })
          ),
        };

        const res = await waAdapter.resolveInboundConnection(spoofReq, clientT1);
        assert.strictEqual(res, null, 'Cross-tenant account ID must strictly resolve to null');
      } finally {
        clientT1.release();
      }
    });

    test('1.2: Inbound request spoofing Tenant 1 WhatsApp phone_number_id against Tenant 2 client resolves to null', async () => {
      const clientT2 = await mockPool.connect();
      try {
        await clientT2.query("SET LOCAL app.current_tenant_id = '2'");
        const spoofReq: InboundConnectionResolutionRequest = {
          headers: {},
          pathKey: null,
          rawBody: Buffer.from(
            JSON.stringify({
              object: 'whatsapp_business_account',
              entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'wa-phone-t1-100' } } }] }],
            })
          ),
        };

        const res = await waAdapter.resolveInboundConnection(spoofReq, clientT2);
        assert.strictEqual(res, null, 'Cross-tenant account ID must strictly resolve to null');
      } finally {
        clientT2.release();
      }
    });

    test('1.3: Unmapped WhatsApp phone_number_id against unscoped pool strictly resolves to null (never leaks to default tenant)', async () => {
      const unmappedReq: InboundConnectionResolutionRequest = {
        headers: {},
        pathKey: null,
        rawBody: Buffer.from(
          JSON.stringify({
            object: 'whatsapp_business_account',
            entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'wa-phone-unmapped-999' } } }] }],
          })
        ),
      };

      const res = await waAdapter.resolveInboundConnection(unmappedReq);
      assert.strictEqual(res, null, 'Unmapped phone number must never resolve to default tenant 1');
    });

    test('1.4: Inbound request spoofing Tenant 2 Instagram account against Tenant 1 client resolves to null', async () => {
      const clientT1 = await mockPool.connect();
      try {
        await clientT1.query("SET LOCAL app.current_tenant_id = '1'");
        const igSpoofReq: InboundConnectionResolutionRequest = {
          headers: {},
          pathKey: null,
          rawBody: Buffer.from(
            JSON.stringify({
              object: 'instagram',
              entry: [{ id: 'ig-account-t2-400' }],
            })
          ),
        };

        const res = await igAdapter.resolveInboundConnection(igSpoofReq, clientT1);
        assert.strictEqual(res, null, 'Cross-tenant Instagram account must strictly resolve to null');
      } finally {
        clientT1.release();
      }
    });

    test('1.5: Inactive connection account ID strictly resolves to null', async () => {
      const inactiveReq: InboundConnectionResolutionRequest = {
        headers: {},
        pathKey: null,
        rawBody: Buffer.from(
          JSON.stringify({
            object: 'whatsapp_business_account',
            entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'wa-phone-inactive-999' } } }] }],
          })
        ),
      };

      const res = await waAdapter.resolveInboundConnection(inactiveReq);
      assert.strictEqual(res, null, 'Inactive connection account must strictly resolve to null');
    });

    test('1.6: Malicious SQL injection in phone_number_id is parameterized safely', async () => {
      const sqlInjectionReq: InboundConnectionResolutionRequest = {
        headers: {},
        pathKey: null,
        rawBody: Buffer.from(
          JSON.stringify({
            object: 'whatsapp_business_account',
            entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: "wa-phone-t1-100' OR '1'='1" } } }] }],
          })
        ),
      };

      const res = await waAdapter.resolveInboundConnection(sqlInjectionReq);
      assert.strictEqual(res, null);
    });

    test('1.7: Non-JSON and empty raw bodies fail-closed to null', async () => {
      const emptyReq: InboundConnectionResolutionRequest = {
        headers: {},
        pathKey: null,
        rawBody: new Uint8Array(0),
      };
      assert.strictEqual(await waAdapter.resolveInboundConnection(emptyReq), null);

      const invalidJsonReq: InboundConnectionResolutionRequest = {
        headers: {},
        pathKey: null,
        rawBody: Buffer.from('NOT_VALID_JSON_AT_ALL'),
      };
      assert.strictEqual(await waAdapter.resolveInboundConnection(invalidJsonReq), null);

      const primitiveJsonReq: InboundConnectionResolutionRequest = {
        headers: {},
        pathKey: null,
        rawBody: Buffer.from('"just_a_string"'),
      };
      assert.strictEqual(await waAdapter.resolveInboundConnection(primitiveJsonReq), null);
    });
  });

  // ===========================================================================
  // 2. 24h Window Enforcement & Capability Gating Attacks
  // ===========================================================================
  describe('2. 24h Window Enforcement & Capability Gating Attacks', () => {
    test('2.1: Outbound free-form text with 25h expired timestamp rejected with CH_WA_WINDOW_CLOSED', async () => {
      const cmd: SendMessageCommandV1 = {
        schemaVersion: 1,
        tenantId: '1',
        connectionId: 'conn-wa-tenant-1',
        conversationId: '573001234567',
        effectKey: 'eff-25h',
        message: {
          kind: 'text',
          text: 'Attempt outside window',
          parameters: {
            lastCustomerInteractionAt: new Date(Date.now() - 25 * 3600 * 1000).toISOString(),
          },
        },
        expectedConversationVersion: 1,
        causedBy: { type: 'human', id: 'usr-1' },
      };

      await assert.rejects(
        async () => waAdapter.send(cmd),
        (err: any) => {
          assert.strictEqual(err.name, 'PublishGateError');
          assert.strictEqual(err.code, 'CH_WA_WINDOW_CLOSED');
          return true;
        }
      );
      assert.strictEqual(outboundRequests.length, 0, 'No outbound HTTP request must be sent when gate denies');
    });

    test('2.2: Outbound free-form text with 100h expired timestamp rejected with CH_WA_WINDOW_CLOSED', async () => {
      const cmd: SendMessageCommandV1 = {
        schemaVersion: 1,
        tenantId: '1',
        connectionId: 'conn-wa-tenant-1',
        conversationId: '573001234567',
        effectKey: 'eff-100h',
        message: {
          kind: 'text',
          text: 'Attempt 100h outside window',
          parameters: {
            lastCustomerInteractionAt: new Date(Date.now() - 100 * 3600 * 1000).toISOString(),
          },
        },
        expectedConversationVersion: 1,
        causedBy: { type: 'human', id: 'usr-1' },
      };

      await assert.rejects(
        async () => waAdapter.send(cmd),
        (err: any) => {
          assert.strictEqual(err.name, 'PublishGateError');
          assert.strictEqual(err.code, 'CH_WA_WINDOW_CLOSED');
          return true;
        }
      );
      assert.strictEqual(outboundRequests.length, 0);
    });

    test('2.3: Outbound free-form text with undefined lastCustomerInteractionAt rejected with CH_WA_WINDOW_CLOSED', async () => {
      const cmd: SendMessageCommandV1 = {
        schemaVersion: 1,
        tenantId: '1',
        connectionId: 'conn-wa-tenant-1',
        conversationId: '573001234567',
        effectKey: 'eff-undef-interaction',
        message: {
          kind: 'text',
          text: 'Attempt with undefined interaction',
        },
        expectedConversationVersion: 1,
        causedBy: { type: 'system', id: 'sys-1' },
      };

      await assert.rejects(
        async () => waAdapter.send(cmd),
        (err: any) => {
          assert.strictEqual(err.name, 'PublishGateError');
          assert.strictEqual(err.code, 'CH_WA_WINDOW_CLOSED');
          return true;
        }
      );
      assert.strictEqual(outboundRequests.length, 0);
    });

    test('2.4: Outbound free-form text with null lastCustomerInteractionAt rejected with CH_WA_WINDOW_CLOSED', async () => {
      const cmd: SendMessageCommandV1 = {
        schemaVersion: 1,
        tenantId: '1',
        connectionId: 'conn-wa-tenant-1',
        conversationId: '573001234567',
        effectKey: 'eff-null-interaction',
        message: {
          kind: 'text',
          text: 'Attempt with null interaction',
          parameters: {
            lastCustomerInteractionAt: null,
          },
        },
        expectedConversationVersion: 1,
        causedBy: { type: 'system', id: 'sys-1' },
      };

      await assert.rejects(
        async () => waAdapter.send(cmd),
        (err: any) => {
          assert.strictEqual(err.name, 'PublishGateError');
          assert.strictEqual(err.code, 'CH_WA_WINDOW_CLOSED');
          return true;
        }
      );
      assert.strictEqual(outboundRequests.length, 0);
    });

    test('2.5: Outbound free-form text with empty string lastCustomerInteractionAt rejected with CH_WA_WINDOW_CLOSED', async () => {
      const cmd: SendMessageCommandV1 = {
        schemaVersion: 1,
        tenantId: '1',
        connectionId: 'conn-wa-tenant-1',
        conversationId: '573001234567',
        effectKey: 'eff-empty-interaction',
        message: {
          kind: 'text',
          text: 'Attempt with empty string interaction',
          parameters: {
            lastCustomerInteractionAt: '',
          },
        },
        expectedConversationVersion: 1,
        causedBy: { type: 'system', id: 'sys-1' },
      };

      await assert.rejects(
        async () => waAdapter.send(cmd),
        (err: any) => {
          assert.strictEqual(err.name, 'PublishGateError');
          assert.strictEqual(err.code, 'CH_WA_WINDOW_CLOSED');
          return true;
        }
      );
      assert.strictEqual(outboundRequests.length, 0);
    });

    test('2.6: Instagram outbound document strictly rejected with CAPABILITY_UNSUPPORTED', async () => {
      const cmd: SendMessageCommandV1 = {
        schemaVersion: 1,
        tenantId: '1',
        connectionId: 'conn-ig-tenant-1',
        conversationId: 'ig-user-123',
        effectKey: 'eff-ig-doc',
        message: {
          kind: 'media',
          mediaRef: 'doc_123',
          parameters: { mediaType: 'document' },
        },
        expectedConversationVersion: 1,
        causedBy: { type: 'system', id: 'sys-1' },
      };

      await assert.rejects(
        async () => igAdapter.send(cmd),
        (err: any) => {
          assert.strictEqual(err.name, 'PublishGateError');
          assert.strictEqual(err.code, 'CAPABILITY_UNSUPPORTED');
          return true;
        }
      );
      assert.strictEqual(outboundRequests.length, 0);
    });

    test('2.7: Instagram outbound template strictly rejected with CAPABILITY_UNSUPPORTED', async () => {
      const cmd: SendMessageCommandV1 = {
        schemaVersion: 1,
        tenantId: '1',
        connectionId: 'conn-ig-tenant-1',
        conversationId: 'ig-user-123',
        effectKey: 'eff-ig-tpl',
        message: {
          kind: 'template',
          templateId: 'some_template',
        },
        expectedConversationVersion: 1,
        causedBy: { type: 'system', id: 'sys-1' },
      };

      await assert.rejects(
        async () => igAdapter.send(cmd),
        (err: any) => {
          assert.strictEqual(err.name, 'PublishGateError');
          assert.strictEqual(err.code, 'CAPABILITY_UNSUPPORTED');
          return true;
        }
      );
      assert.strictEqual(outboundRequests.length, 0);
    });

    test('2.8: Cross-tenant outbound dispatch blocked when tenantId does not match connectionId', async () => {
      const crossTenantCmd: SendMessageCommandV1 = {
        schemaVersion: 1,
        tenantId: '1', // Tenant 1 trying to dispatch through Tenant 2's connection!
        connectionId: 'conn-wa-tenant-2',
        conversationId: '573001234567',
        effectKey: 'eff-cross-tenant-send',
        message: {
          kind: 'text',
          text: 'Cross tenant spoofed outbound message',
          parameters: {
            lastCustomerInteractionAt: new Date().toISOString(),
          },
        },
        expectedConversationVersion: 1,
        causedBy: { type: 'human', id: 'usr-attacker' },
      };

      await assert.rejects(
        async () => waAdapter.send(crossTenantCmd),
        (err: any) => {
          assert.strictEqual(err.name, 'PublishGateError');
          assert.strictEqual(err.code, 'CAPABILITY_UNSUPPORTED');
          return true;
        }
      );
      assert.strictEqual(outboundRequests.length, 0);
    });

    // -------------------------------------------------------------------------
    // VULNERABILITY INVESTIGATION TESTS:
    // -------------------------------------------------------------------------
    test('2.9 [VULNERABILITY PROBE]: Malformed non-date string in lastCustomerInteractionAt must be rejected', async () => {
      const cmd: SendMessageCommandV1 = {
        schemaVersion: 1,
        tenantId: '1',
        connectionId: 'conn-wa-tenant-1',
        conversationId: '573001234567',
        effectKey: 'eff-invalid-date-probe',
        message: {
          kind: 'text',
          text: 'Bypassing window with invalid date string',
          parameters: {
            lastCustomerInteractionAt: 'not_a_valid_date_at_all',
          },
        },
        expectedConversationVersion: 1,
        causedBy: { type: 'system', id: 'sys-1' },
      };

      await assert.rejects(
        async () => waAdapter.send(cmd),
        (err: any) => {
          assert.strictEqual(err.name, 'PublishGateError');
          assert.strictEqual(err.code, 'CH_WA_WINDOW_CLOSED');
          return true;
        },
        'Non-date or malformed string in lastCustomerInteractionAt must not bypass 24h window'
      );
    });

    test('2.10 [VULNERABILITY PROBE]: Template spoofing with kind text and templateId parameter must be rejected or not bypass window', async () => {
      const cmd: SendMessageCommandV1 = {
        schemaVersion: 1,
        tenantId: '1',
        connectionId: 'conn-wa-tenant-1',
        conversationId: '573001234567',
        effectKey: 'eff-spoofed-tpl-probe',
        message: {
          kind: 'text',
          text: 'Raw free-form text bypassing 24h window via template spoofing',
          templateId: 'spoofed_template_bypass',
          parameters: {
            lastCustomerInteractionAt: new Date(Date.now() - 48 * 3600 * 1000).toISOString(),
          },
        },
        expectedConversationVersion: 1,
        causedBy: { type: 'system', id: 'sys-1' },
      };

      await assert.rejects(
        async () => waAdapter.send(cmd),
        (err: any) => {
          assert.strictEqual(err.name, 'PublishGateError');
          assert.strictEqual(err.code, 'CH_WA_WINDOW_CLOSED');
          return true;
        },
        'Supplying templateId on kind: text must not bypass the 24h window for free-form text'
      );
    });

    test('2.11 [VULNERABILITY PROBE]: Template dispatch without templateId must be rejected fail-fast', async () => {
      const cmd: SendMessageCommandV1 = {
        schemaVersion: 1,
        tenantId: '1',
        connectionId: 'conn-wa-tenant-1',
        conversationId: '573001234567',
        effectKey: 'eff-empty-tpl-probe',
        message: {
          kind: 'template',
          // templateId missing
          parameters: {
            lastCustomerInteractionAt: new Date(Date.now() - 48 * 3600 * 1000).toISOString(),
          },
        },
        expectedConversationVersion: 1,
        causedBy: { type: 'system', id: 'sys-1' },
      };

      await assert.rejects(
        async () => waAdapter.send(cmd),
        (err: any) => {
          assert.ok(err, 'Expected send to fail when templateId is missing');
          return true;
        },
        'Template message with missing/empty templateId must fail-fast before HTTP dispatch'
      );
    });
  });
});
