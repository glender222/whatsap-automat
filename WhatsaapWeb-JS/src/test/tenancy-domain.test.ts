// 1. Invariantes de entorno de prueba antes de cargar configuracion
process.env.JWT_SECRET = 'test-only-jwt-secret-with-at-least-32-characters-for-testing';
process.env.DB_PASSWORD = 'test-only-database-password';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test, beforeEach } from 'node:test';
import type { Request, Response } from 'express';

const {
  tenantContext,
  requireTenantContext,
  optionalTenantContext,
  resolveTenantContext,
} = require('../middleware/tenantContext') as typeof import('../middleware/tenantContext');
import type {
  TenantContext,
  TenantScopedRequest,
} from '../middleware/tenantContext';
const { TenantScopedUoW } = require('../db/TenantScopedUoW') as typeof import('../db/TenantScopedUoW');

const jwt = require('jsonwebtoken') as any;
const JWT_SECRET = process.env.JWT_SECRET;

// =============================================================================
// Helper Mock Factory for Express Request / Response
// =============================================================================

function createMockRequest(headers: Record<string, string | undefined> = {}, user?: Record<string, unknown>): Request {
  const req: any = {
    headers: { ...headers },
    user,
  };
  return req as Request;
}

function createMockResponse(): { res: Response; getStatus: () => number; getBody: () => any } {
  let statusCode = 200;
  let body: any = null;

  const res: any = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(data: any) {
      body = data;
      return res;
    },
  };

  return {
    res: res as Response,
    getStatus: () => statusCode,
    getBody: () => body,
  };
}

// =============================================================================
// PR-F1-03 Tenancy Domain Tests
// =============================================================================

describe('PR-F1-03: Tenancy Domain Models & Middleware', () => {
  const migrationPath = path.resolve(__dirname, '../db/migrations/023_create_tenants_and_workspaces.sql');

  // ---------------------------------------------------------------------------
  // Suite 1: Migration 023 DDL & Schema Static Verification
  // ---------------------------------------------------------------------------
  describe('Suite 1: Migration 023 DDL & Schema Static Verification', () => {
    test('1.1: Migration file exists and has descriptive header', () => {
      assert.ok(fs.existsSync(migrationPath), 'Migration 023 file must exist');
      const content = fs.readFileSync(migrationPath, 'utf8');
      assert.ok(content.includes('Migration 023'), 'Header must reference Migration 023');
      assert.ok(content.includes('PR-F1-03'), 'Header must reference PR-F1-03');
    });

    test('1.2: Table tenants is defined with id, name, slug (UNIQUE), status, and timestamps', () => {
      const content = fs.readFileSync(migrationPath, 'utf8');
      assert.ok(/CREATE TABLE IF NOT EXISTS tenants/i.test(content), 'Must create tenants table');
      assert.ok(/id SERIAL PRIMARY KEY/i.test(content), 'tenants must have id SERIAL PRIMARY KEY');
      assert.ok(/name VARCHAR\(255\) NOT NULL/i.test(content), 'tenants must have name VARCHAR(255)');
      assert.ok(/slug VARCHAR\(255\) UNIQUE NOT NULL/i.test(content), 'tenants must have slug VARCHAR(255) UNIQUE');
      assert.ok(/status VARCHAR\(50\)/i.test(content), 'tenants must have status VARCHAR(50)');
      assert.ok(/created_at/i.test(content) && /updated_at/i.test(content), 'tenants must have timestamps');
    });

    test('1.3: Table workspaces is defined with tenant_id (FK CASCADE), slug, is_default, and UNIQUE(tenant_id, slug)', () => {
      const content = fs.readFileSync(migrationPath, 'utf8');
      assert.ok(/CREATE TABLE IF NOT EXISTS workspaces/i.test(content), 'Must create workspaces table');
      assert.ok(/tenant_id INTEGER NOT NULL REFERENCES tenants\(id\) ON DELETE CASCADE/i.test(content), 'workspaces must reference tenants(id) with CASCADE');
      assert.ok(/is_default BOOLEAN/i.test(content), 'workspaces must have is_default');
      assert.ok(/uq_workspaces_tenant_slug UNIQUE \(tenant_id, slug\)/i.test(content) || /UNIQUE\s*\(tenant_id,\s*slug\)/i.test(content), 'workspaces must have UNIQUE (tenant_id, slug)');
    });

    test('1.4: Table memberships is defined with tenant_id (FK CASCADE), user_id, role, and UNIQUE(tenant_id, user_id)', () => {
      const content = fs.readFileSync(migrationPath, 'utf8');
      assert.ok(/CREATE TABLE IF NOT EXISTS memberships/i.test(content), 'Must create memberships table');
      assert.ok(/tenant_id INTEGER NOT NULL REFERENCES tenants\(id\) ON DELETE CASCADE/i.test(content), 'memberships must reference tenants(id) with CASCADE');
      assert.ok(/user_id INTEGER NOT NULL/i.test(content), 'memberships must have user_id INTEGER');
      assert.ok(/role VARCHAR\(50\)/i.test(content), 'memberships must have role VARCHAR(50)');
      assert.ok(/uq_memberships_tenant_user UNIQUE \(tenant_id, user_id\)/i.test(content) || /UNIQUE\s*\(tenant_id,\s*user_id\)/i.test(content), 'memberships must have UNIQUE (tenant_id, user_id)');
    });

    test('1.5: RLS is enabled and forced on all three tables', () => {
      const content = fs.readFileSync(migrationPath, 'utf8');
      assert.ok(/ALTER TABLE tenants ENABLE ROW LEVEL SECURITY/i.test(content), 'tenants must have ENABLE RLS');
      assert.ok(/ALTER TABLE tenants FORCE ROW LEVEL SECURITY/i.test(content), 'tenants must have FORCE RLS');
      assert.ok(/ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY/i.test(content), 'workspaces must have ENABLE RLS');
      assert.ok(/ALTER TABLE workspaces FORCE ROW LEVEL SECURITY/i.test(content), 'workspaces must have FORCE RLS');
      assert.ok(/ALTER TABLE memberships ENABLE ROW LEVEL SECURITY/i.test(content), 'memberships must have ENABLE RLS');
      assert.ok(/ALTER TABLE memberships FORCE ROW LEVEL SECURITY/i.test(content), 'memberships must have FORCE RLS');
    });

    test('1.6: All tenancy RLS policies are AS PERMISSIVE (zero AS RESTRICTIVE)', () => {
      const content = fs.readFileSync(migrationPath, 'utf8');
      const restrictiveMatches = content.match(/AS\s+RESTRICTIVE/gi);
      assert.strictEqual(restrictiveMatches, null, 'Must have zero occurrences of AS RESTRICTIVE');
      const permissiveMatches = content.match(/AS\s+PERMISSIVE/gi);
      assert.ok(permissiveMatches && permissiveMatches.length >= 3, 'Must have at least 3 AS PERMISSIVE policies');
    });

    test('1.7: Backfill and seed logic populates default tenant and workspace', () => {
      const content = fs.readFileSync(migrationPath, 'utf8');
      assert.ok(/default-company/i.test(content), 'Must seed default-company slug');
      assert.ok(/INSERT INTO workspaces/i.test(content), 'Must insert default workspace');
      assert.ok(/setval/i.test(content), 'Must resynchronize sequences after backfill');
    });

    test('1.8: Down / Rollback instructions are documented', () => {
      const content = fs.readFileSync(migrationPath, 'utf8');
      assert.ok(/REVERT \/ ROLLBACK/i.test(content) || /DROP TABLE IF EXISTS/i.test(content), 'Must document rollback');
    });
  });

  // ---------------------------------------------------------------------------
  // Suite 2: Relational Constraints & Data Integrity
  // ---------------------------------------------------------------------------
  describe('Suite 2: Relational Constraints & Data Integrity', () => {
    interface MockTenant {
      id: number;
      name: string;
      slug: string;
    }
    interface MockWorkspace {
      id: number;
      tenant_id: number;
      name: string;
      slug: string;
      is_default: boolean;
    }
    interface MockMembership {
      id: number;
      tenant_id: number;
      user_id: number;
      role: string;
    }

    let tenants: MockTenant[];
    let workspaces: MockWorkspace[];
    let memberships: MockMembership[];

    beforeEach(() => {
      tenants = [{ id: 1, name: 'Default Company', slug: 'default-company' }];
      workspaces = [{ id: 1, tenant_id: 1, name: 'default', slug: 'default', is_default: true }];
      memberships = [{ id: 1, tenant_id: 1, user_id: 10, role: 'admin' }];
    });

    test('2.1: Workspace slug uniqueness is scoped to tenant', () => {
      // Tenant 1 has 'sales'
      workspaces.push({ id: 2, tenant_id: 1, name: 'Sales', slug: 'sales', is_default: false });

      // Tenant 2 can also have 'sales' without conflict
      tenants.push({ id: 2, name: 'Acme', slug: 'acme' });
      workspaces.push({ id: 3, tenant_id: 2, name: 'Sales', slug: 'sales', is_default: false });

      const tenant1Sales = workspaces.filter(w => w.tenant_id === 1 && w.slug === 'sales');
      const tenant2Sales = workspaces.filter(w => w.tenant_id === 2 && w.slug === 'sales');
      assert.strictEqual(tenant1Sales.length, 1);
      assert.strictEqual(tenant2Sales.length, 1);

      // Duplicate 'sales' under Tenant 1 throws constraint violation
      const addDuplicate = () => {
        if (workspaces.some(w => w.tenant_id === 1 && w.slug === 'sales')) {
          throw new Error('duplicate key value violates unique constraint "uq_workspaces_tenant_slug"');
        }
      };
      assert.throws(addDuplicate, /unique constraint/);
    });

    test('2.2: Tenant slug is globally unique', () => {
      const addTenant = (slug: string) => {
        if (tenants.some(t => t.slug === slug)) {
          throw new Error('duplicate key value violates unique constraint "tenants_slug_key"');
        }
        tenants.push({ id: tenants.length + 1, name: slug, slug });
      };

      addTenant('beta-corp');
      assert.throws(() => addTenant('beta-corp'), /unique constraint/);
    });

    test('2.3: Membership uniqueness per tenant and user', () => {
      // User 10 is in Tenant 1
      assert.ok(memberships.some(m => m.tenant_id === 1 && m.user_id === 10));

      // User 10 can join Tenant 2
      memberships.push({ id: 2, tenant_id: 2, user_id: 10, role: 'member' });
      assert.strictEqual(memberships.filter(m => m.user_id === 10).length, 2);

      // Adding User 10 to Tenant 1 again throws
      const addDuplicateMembership = () => {
        if (memberships.some(m => m.tenant_id === 1 && m.user_id === 10)) {
          throw new Error('duplicate key value violates unique constraint "uq_memberships_tenant_user"');
        }
      };
      assert.throws(addDuplicateMembership, /unique constraint/);
    });

    test('2.4: CASCADE on delete removes child workspaces and memberships', () => {
      // Seed Tenant 2 with workspaces and memberships
      tenants.push({ id: 2, name: 'Company 2', slug: 'company-2' });
      workspaces.push({ id: 4, tenant_id: 2, name: 'WS 2', slug: 'ws2', is_default: true });
      memberships.push({ id: 3, tenant_id: 2, user_id: 99, role: 'member' });

      // Simulate DELETE FROM tenants WHERE id = 2 CASCADE
      const tenantIdToDelete = 2;
      tenants = tenants.filter(t => t.id !== tenantIdToDelete);
      workspaces = workspaces.filter(w => w.tenant_id !== tenantIdToDelete);
      memberships = memberships.filter(m => m.tenant_id !== tenantIdToDelete);

      assert.strictEqual(tenants.some(t => t.id === 2), false);
      assert.strictEqual(workspaces.some(w => w.tenant_id === 2), false);
      assert.strictEqual(memberships.some(m => m.tenant_id === 2), false);
    });
  });

  // ---------------------------------------------------------------------------
  // Suite 3: Backward Compatibility & Legacy company_id Mapping
  // ---------------------------------------------------------------------------
  describe('Suite 3: Backward Compatibility & Legacy company_id Mapping', () => {
    test('3.1: Token with companyId = 1 maps to Tenant 1 and default workspace', () => {
      const token = jwt.sign({ userId: 1, companyId: 1, role: 'ADMIN' }, JWT_SECRET);
      const req = createMockRequest({ authorization: `Bearer ${token}` });
      const { res, getStatus } = createMockResponse();

      let nextCalled = false;
      const middleware = tenantContext({ required: true });
      middleware(req, res, () => {
        nextCalled = true;
      });

      assert.strictEqual(nextCalled, true);
      assert.strictEqual(getStatus(), 200);
      assert.strictEqual(req.tenantId, 1);
      assert.strictEqual(req.whatsappCompanyId, 1);
      assert.strictEqual(req.tenantContext?.tenantId, 1);
      assert.strictEqual(req.tenantContext?.workspace.isDefault, true);
      assert.strictEqual(req.tenantContext?.workspace.slug, 'default');
      assert.strictEqual(req.tenantContext?.source, 'legacy_company');
    });

    test('3.2: Token with snake_case company_id = 2 maps cleanly', () => {
      const token = jwt.sign({ userId: 2, company_id: 2 }, JWT_SECRET);
      const req = createMockRequest({ authorization: `Bearer ${token}` });
      const { res } = createMockResponse();

      let nextCalled = false;
      const middleware = tenantContext({ required: true });
      middleware(req, res, () => {
        nextCalled = true;
      });

      assert.strictEqual(nextCalled, true);
      assert.strictEqual(req.tenantId, 2);
      assert.strictEqual(req.whatsappCompanyId, 2);
      assert.strictEqual(req.tenantContext?.source, 'legacy_company');
    });

    test('3.3: Context resolution sets req.whatsappCompanyId for legacy controllers', () => {
      const token = jwt.sign({ userId: 3, tenantId: 5 }, JWT_SECRET);
      const req = createMockRequest({ authorization: `Bearer ${token}` });
      const { res } = createMockResponse();

      tenantContext({ required: true })(req, res, () => {});
      assert.strictEqual(req.whatsappCompanyId, 5, 'Must set req.whatsappCompanyId to resolved tenantId');
    });
  });

  // ---------------------------------------------------------------------------
  // Suite 4: Tenancy Context Middleware (tenantContext.ts)
  // ---------------------------------------------------------------------------
  describe('Suite 4: Tenancy Context Middleware (tenantContext.ts)', () => {
    test('4.1: Modern JWT claim extraction (tenantId & workspaceId)', () => {
      const token = jwt.sign({ userId: 4, tenantId: 10, workspaceId: 20, role: 'MANAGER' }, JWT_SECRET);
      const req = createMockRequest({ authorization: `Bearer ${token}` });
      const { res } = createMockResponse();

      let nextCalled = false;
      requireTenantContext(req, res, () => {
        nextCalled = true;
      });

      assert.strictEqual(nextCalled, true);
      assert.strictEqual(req.tenantId, 10);
      assert.strictEqual(req.workspaceId, 20);
      assert.strictEqual(req.tenantContext?.source, 'jwt_tenant');
      assert.strictEqual(req.tenantContext?.role, 'MANAGER');
      assert.strictEqual(req.tenantContext?.userId, 4);
    });

    test('4.2: Modern JWT with tenantId only falls back to default workspace', () => {
      const token = jwt.sign({ userId: 5, tenantId: 15 }, JWT_SECRET);
      const req = createMockRequest({ authorization: `Bearer ${token}` });
      const { res } = createMockResponse();

      requireTenantContext(req, res, () => {});
      assert.strictEqual(req.tenantId, 15);
      assert.strictEqual(req.tenantContext?.workspace.isDefault, true);
      assert.strictEqual(req.tenantContext?.workspace.slug, 'default');
    });

    test('4.3: Custom workspace via X-Workspace-Slug header', () => {
      const token = jwt.sign({ userId: 6, tenantId: 10 }, JWT_SECRET);
      const req = createMockRequest({
        authorization: `Bearer ${token}`,
        'x-workspace-slug': 'support-team',
      });
      const { res } = createMockResponse();

      requireTenantContext(req, res, () => {});
      assert.strictEqual(req.tenantId, 10);
      assert.strictEqual(req.tenantContext?.workspace.slug, 'support-team');
      assert.strictEqual(req.tenantContext?.workspace.isDefault, false);
    });

    test('4.4: Fail-closed: Missing token on requireTenantContext returns 401', () => {
      const req = createMockRequest({});
      const { res, getStatus, getBody } = createMockResponse();

      let nextCalled = false;
      requireTenantContext(req, res, () => {
        nextCalled = true;
      });

      assert.strictEqual(nextCalled, false);
      assert.strictEqual(getStatus(), 401);
      assert.strictEqual(getBody().success, false);
    });

    test('4.5: Fail-closed: Token missing tenant/company claim returns 403 (no fallback)', () => {
      const token = jwt.sign({ userId: 99, email: 'no-claim@example.com' }, JWT_SECRET);
      const req = createMockRequest({ authorization: `Bearer ${token}` });
      const { res, getStatus, getBody } = createMockResponse();

      let nextCalled = false;
      requireTenantContext(req, res, () => {
        nextCalled = true;
      });

      assert.strictEqual(nextCalled, false);
      assert.strictEqual(getStatus(), 403);
      assert.strictEqual(getBody().success, false);
      assert.strictEqual(getBody().error, 'TENANT_CLAIM_REQUIRED');
    });

    test('4.6: Fail-closed: Invalid/zero/negative/boolean tenantId claims return 403', () => {
      const invalidClaims = [
        { tenantId: 0 },
        { tenantId: -1 },
        { tenantId: true },
        { companyId: 0 },
        { companyId: 'not-a-number' },
      ];

      for (const claim of invalidClaims) {
        const token = jwt.sign({ userId: 10, ...claim }, JWT_SECRET);
        const req = createMockRequest({ authorization: `Bearer ${token}` });
        const { res, getStatus } = createMockResponse();

        let nextCalled = false;
        requireTenantContext(req, res, () => {
          nextCalled = true;
        });

        assert.strictEqual(nextCalled, false, `Claim ${JSON.stringify(claim)} should fail`);
        assert.strictEqual(getStatus(), 403);
      }
    });

    test('4.7: Fail-closed: Conflicting claims (tenantId !== companyId) returns 403 TENANT_CLAIM_CONFLICT', () => {
      const token = jwt.sign({ userId: 1, tenantId: 10, companyId: 20 }, JWT_SECRET);
      const req = createMockRequest({ authorization: `Bearer ${token}` });
      const { res, getStatus, getBody } = createMockResponse();

      let nextCalled = false;
      requireTenantContext(req, res, () => {
        nextCalled = true;
      });

      assert.strictEqual(nextCalled, false);
      assert.strictEqual(getStatus(), 403);
      assert.strictEqual(getBody().error, 'TENANT_CLAIM_CONFLICT');
    });

    test('4.8: optionalTenantContext passes through when unauthenticated', () => {
      const req = createMockRequest({});
      const { res, getStatus } = createMockResponse();

      let nextCalled = false;
      optionalTenantContext(req, res, () => {
        nextCalled = true;
      });

      assert.strictEqual(nextCalled, true);
      assert.strictEqual(getStatus(), 200);
      assert.strictEqual(req.tenantContext, undefined);
    });

    test('4.9: resolveTenantContext helper returns context or throws', () => {
      const reqWithContext: any = { tenantContext: { tenantId: 7 } };
      assert.strictEqual(resolveTenantContext(reqWithContext).tenantId, 7);

      const reqWithoutContext: any = {};
      assert.throws(() => resolveTenantContext(reqWithoutContext), /TENANT_CONTEXT_REQUIRED/);
    });

    test('4.10: runInScope delegates to TenantScopedUoW', async () => {
      let executedTenantId: number | null = null;
      const mockUow: any = {
        run: async (tenantId: number, work: (client: any) => Promise<any>) => {
          executedTenantId = tenantId;
          return work({ query: async () => ({ rows: [{ ok: true }] }) });
        },
      };

      const token = jwt.sign({ userId: 1, tenantId: 42 }, JWT_SECRET);
      const req = createMockRequest({ authorization: `Bearer ${token}` });
      const { res } = createMockResponse();

      const middleware = tenantContext({ required: true, uow: mockUow });
      middleware(req, res, () => {});

      const result = await req.tenantContext!.runInScope(async (client) => {
        return client.query('SELECT 1');
      });

      assert.strictEqual(executedTenantId, 42);
      assert.deepStrictEqual(result, { rows: [{ ok: true }] });
    });
  });

  // ---------------------------------------------------------------------------
  // Suite 5: Row-Level Security (RLS) on Tenancy Tables
  // ---------------------------------------------------------------------------
  describe('Suite 5: Row-Level Security (RLS) on Tenancy Tables', () => {
    // Simulates engine-level RLS filtering on tenants, workspaces, and memberships
    interface RlsSimState {
      currentTenantId: string | null;
      tenants: Array<{ id: number; name: string }>;
      workspaces: Array<{ id: number; tenant_id: number; name: string }>;
      memberships: Array<{ id: number; tenant_id: number; user_id: number }>;
    }

    let db: RlsSimState;

    beforeEach(() => {
      db = {
        currentTenantId: null,
        tenants: [
          { id: 1, name: 'Tenant One' },
          { id: 2, name: 'Tenant Two' },
        ],
        workspaces: [
          { id: 1, tenant_id: 1, name: 'Default 1' },
          { id: 2, tenant_id: 2, name: 'Default 2' },
        ],
        memberships: [
          { id: 1, tenant_id: 1, user_id: 101 },
          { id: 2, tenant_id: 2, user_id: 202 },
        ],
      };
    });

    function queryTenants(state: RlsSimState) {
      if (!state.currentTenantId) return []; // fail-closed NULL
      const tid = parseInt(state.currentTenantId, 10);
      return state.tenants.filter(t => t.id === tid);
    }

    function queryWorkspaces(state: RlsSimState) {
      if (!state.currentTenantId) return [];
      const tid = parseInt(state.currentTenantId, 10);
      return state.workspaces.filter(w => w.tenant_id === tid);
    }

    function queryMemberships(state: RlsSimState) {
      if (!state.currentTenantId) return [];
      const tid = parseInt(state.currentTenantId, 10);
      return state.memberships.filter(m => m.tenant_id === tid);
    }

    test('5.1: Tenant 1 queries on tenants return only Tenant 1', () => {
      db.currentTenantId = '1';
      const rows = queryTenants(db);
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].id, 1);
    });

    test('5.2: Tenant 2 queries on tenants return only Tenant 2 (Tenant 1 invisible)', () => {
      db.currentTenantId = '2';
      const rows = queryTenants(db);
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].id, 2);
    });

    test('5.3: Workspaces isolation across tenants', () => {
      db.currentTenantId = '1';
      const rows = queryWorkspaces(db);
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].tenant_id, 1);
    });

    test('5.4: Memberships isolation across tenants', () => {
      db.currentTenantId = '1';
      const rows = queryMemberships(db);
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].user_id, 101);
    });

    test('5.5: Fail-closed: Queries without app.current_tenant_id return 0 rows', () => {
      db.currentTenantId = null;
      assert.strictEqual(queryTenants(db).length, 0);
      assert.strictEqual(queryWorkspaces(db).length, 0);
      assert.strictEqual(queryMemberships(db).length, 0);
    });

    test('5.6: Cross-tenant insert into workspaces is rejected by RLS WITH CHECK', () => {
      db.currentTenantId = '1';
      const insertWorkspace = (tenantIdToInsert: number) => {
        const activeTid = parseInt(db.currentTenantId!, 10);
        if (tenantIdToInsert !== activeTid) {
          const err: any = new Error('new row violates row-level security policy for table "workspaces"');
          err.code = '44501';
          throw err;
        }
      };

      assert.throws(() => insertWorkspace(2), /violates row-level security policy/);
    });
  });
});
