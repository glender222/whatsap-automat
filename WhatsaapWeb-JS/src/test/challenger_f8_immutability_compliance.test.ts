/**
 * Challenger Adversarial Stress Test Suite: Phase F8 Immutability & Compliance
 * 
 * Empirically stress-tests:
 * 1. Database audit immutability triggers (UPDATE/DELETE/TRUNCATE on audit_events raising SQLSTATE 23000).
 * 2. Multi-row mutations, TRUNCATE CASCADE, and transaction rollback atomicity.
 * 3. AuditLogger buffer resilience during database outage and reconnection behavior.
 * 4. License compliance scanner adversarial fixtures (detecting AGPL/GPL/SSPL, electing permissive branch on dual licenses).
 * 5. CycloneDX 1.5 JSON SBOM validity, component coverage, PURL format, and dependency graph integrity.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Pool, type PoolClient } from 'pg';

import { AuditLogger } from '../services/audit/AuditLogger';
import { SecretVault } from '../services/security/SecretVault';
import { TenantScopedUoW } from '../db/TenantScopedUoW';

describe('CHALLENGER-F8-2: Database Immutability & Compliance Adversarial Suite', () => {
  const rootDir = path.resolve(__dirname, '../../..');
  const migrationSqlPath = path.resolve(__dirname, '../db/migrations/031_create_audit_events_and_secrets.sql');
  const auditDatabaseUrl = process.env.AUDIT_IMMUTABILITY_TEST_DATABASE_URL;

  // =========================================================================
  // SUITE 1: Database Audit Immutability Triggers against Live PostgreSQL
  // =========================================================================
  describe('Suite 1: Live PostgreSQL Engine Immutability Enforcement (SQLSTATE 23000)', {
    skip: !auditDatabaseUrl && 'AUDIT_IMMUTABILITY_TEST_DATABASE_URL must identify an isolated local smoke database',
  }, () => {
    let pool: Pool;
    let client: PoolClient;
    const schemaName = `challenger_immutability_${randomUUID().replaceAll('-', '')}`;
    let testEventId: string;

    before(async () => {
      const database = new URL(auditDatabaseUrl!);
      assert.equal(database.hostname, '127.0.0.1');
      assert.match(database.pathname, /^\/[a-z0-9_]+_smoke$/);
      pool = new Pool({ connectionString: auditDatabaseUrl });
      client = await pool.connect();
      const { rows: [role] } = await client.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
      assert.deepEqual(role, { rolsuper: false, rolbypassrls: false });

      // Setup clean isolated test schema
      await client.query(`CREATE SCHEMA ${schemaName};`);
      await client.query(`SET search_path TO ${schemaName}, public;`);

      // Create prerequisite tables
      await client.query('CREATE TABLE tenants (id SERIAL PRIMARY KEY, name VARCHAR(255) NOT NULL);');
      await client.query("INSERT INTO tenants (id, name) VALUES (1, 'Tenant Alpha'), (2, 'Tenant Beta');");

      // Apply Migration 031 DDL
      const migrationSql = fs.readFileSync(migrationSqlPath, 'utf8');
      await client.query(migrationSql);

      // Set tenant context for RLS
      await client.query("SET app.current_tenant_id = '1';");

      // Insert baseline audit event
      const insertRes = await client.query(
        "INSERT INTO audit_events (tenant_id, action, resource_type, resource_id, payload) VALUES (1, 'system.baseline', 'system', 'sys_01', '{\"baseline\": true}') RETURNING id;"
      );
      testEventId = insertRes.rows[0].id;
    });

    after(async () => {
      try {
        await client?.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE;`);
      } finally {
        client?.release();
        await pool?.end();
      }
    });

    test('1.1: UPDATE on audit_events MUST fail with trigger exception raising SQLSTATE 23000', async () => {
      let threw = false;
      let errCode = '';
      let errMsg = '';

      try {
        await client.query('UPDATE audit_events SET action = $1 WHERE id = $2;', ['tampered_action', testEventId]);
      } catch (err: any) {
        threw = true;
        errCode = err.code;
        errMsg = err.message;
      }

      assert.equal(threw, true, 'UPDATE on audit_events must be blocked by trigger');
      assert.equal(errCode, '23000', 'SQLSTATE must be 23000 (integrity_constraint_violation)');
      assert.ok(errMsg.includes('audit_events table is immutable'), 'Error message must specify immutability');
    });

    test('1.2: DELETE on audit_events MUST fail with trigger exception raising SQLSTATE 23000', async () => {
      let threw = false;
      let errCode = '';
      let errMsg = '';

      try {
        await client.query('DELETE FROM audit_events WHERE id = $1;', [testEventId]);
      } catch (err: any) {
        threw = true;
        errCode = err.code;
        errMsg = err.message;
      }

      assert.equal(threw, true, 'DELETE on audit_events must be blocked by trigger');
      assert.equal(errCode, '23000', 'SQLSTATE must be 23000');
      assert.ok(errMsg.includes('audit_events table is immutable'));
    });

    test('1.3: TRUNCATE audit_events MUST fail with trigger exception raising SQLSTATE 23000', async () => {
      let threw = false;
      let errCode = '';

      try {
        await client.query('TRUNCATE audit_events;');
      } catch (err: any) {
        threw = true;
        errCode = err.code;
      }

      assert.equal(threw, true, 'TRUNCATE must be blocked');
      assert.equal(errCode, '23000');
    });

    test('1.4: TRUNCATE audit_events CASCADE MUST also fail with SQLSTATE 23000', async () => {
      let threw = false;
      let errCode = '';

      try {
        await client.query('TRUNCATE audit_events CASCADE;');
      } catch (err: any) {
        threw = true;
        errCode = err.code;
      }

      assert.equal(threw, true, 'TRUNCATE CASCADE must be blocked');
      assert.equal(errCode, '23000');
    });

    test('1.5: Multi-row mass UPDATE MUST fail with SQLSTATE 23000 and leave rows untouched', async () => {
      // Insert another event
      await client.query("INSERT INTO audit_events (tenant_id, action, resource_type, resource_id) VALUES (1, 'second.event', 'item', 'item_2');");

      let threw = false;
      let errCode = '';
      try {
        await client.query("UPDATE audit_events SET payload = '{\"hacked\": true}'::jsonb;");
      } catch (err: any) {
        threw = true;
        errCode = err.code;
      }

      assert.equal(threw, true);
      assert.equal(errCode, '23000');

      // Verify row data remains intact
      const checkRes = await client.query('SELECT action FROM audit_events WHERE id = $1;', [testEventId]);
      assert.equal(checkRes.rows[0].action, 'system.baseline');
    });

    test('1.6: Transaction rollback on mutation attempt rolls back atomic changes completely', async () => {
      let txAborted = false;

      try {
        await client.query('BEGIN;');
        await client.query("INSERT INTO audit_events (tenant_id, action, resource_type, resource_id) VALUES (1, 'tx.transient', 'tx', 'tx_01');");
        await client.query("UPDATE audit_events SET action = 'trigger.fail' WHERE action = 'tx.transient';");
        await client.query('COMMIT;');
      } catch (err) {
        await client.query('ROLLBACK;');
        txAborted = true;
      }

      assert.equal(txAborted, true);
      const countRes = await client.query("SELECT COUNT(*)::int as count FROM audit_events WHERE action = 'tx.transient';");
      assert.equal(countRes.rows[0].count, 0, 'Rolled back event must not exist in table');
    });
  });

  // =========================================================================
  // SUITE 2: AuditLogger Buffer Resilience & Reconnection Analysis
  // =========================================================================
  describe('Suite 2: AuditLogger Buffer Resilience during Database Outage', () => {
    const vault = new SecretVault({ masterKey: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' });

    test('2.1: AuditLogger does not crash caller during database outage; buffers event in memory', async () => {
      const outageUow: any = {
        run: async () => {
          const err: any = new Error('getaddrinfo ENOTFOUND pg-cluster.internal');
          err.code = 'ENOTFOUND';
          throw err;
        },
      };

      const logger = new AuditLogger(outageUow, vault);

      const event = await logger.log({
        tenantId: 1,
        action: 'user.login.during.outage',
        resourceType: 'session',
        resourceId: 'sess_outage',
        payload: {
          clientIp: '10.0.0.1',
          token: 'sk-secret-token-should-be-redacted',
        },
      });

      assert.ok(event.id);
      assert.equal(event.action, 'user.login.during.outage');
      assert.equal(event.payload.token, '[REDACTED]', 'Sensitive data must be redacted even during outage');

      // Query during outage retrieves buffered event
      const queryRes = await logger.query(1, { action: 'user.login.during.outage' });
      assert.equal(queryRes.total, 1);
      assert.equal(queryRes.events[0].id, event.id);
    });

    test('2.2: Reconnection observation: buffered events remain in memory without automated flush', async () => {
      let isDown = true;
      const dbRows: any[] = [];

      const simulatedUow: any = {
        run: async (tenantId: number, fn: any) => {
          if (isDown) throw new Error('DB DOWN');
          const mockClient = {
            query: async (sql: string, params: any[]) => {
              if (sql.includes('INSERT INTO audit_events')) {
                const row = {
                  id: params[0],
                  tenant_id: params[1],
                  actor_id: params[2],
                  actor_type: params[3],
                  action: params[4],
                  resource_type: params[5],
                  resource_id: params[6],
                  payload: JSON.parse(params[7]),
                  ip_address: params[8],
                  user_agent: params[9],
                  trace_id: params[10],
                  decision: params[11],
                  created_at: params[12],
                };
                dbRows.push(row);
                return { rows: [row] };
              }
              if (sql.includes('SELECT COUNT(*)')) {
                return { rows: [{ total: dbRows.length }] };
              }
              if (sql.includes('SELECT * FROM audit_events')) {
                return { rows: dbRows };
              }
              return { rows: [] };
            },
          };
          return fn(mockClient);
        },
      };

      const logger = new AuditLogger(simulatedUow, vault);

      // Event 1 during outage
      const ev1 = await logger.log({ tenantId: 1, action: 'event.offline', resourceType: 'item' });

      // DB recovers
      isDown = false;

      // Event 2 after recovery
      const ev2 = await logger.log({ tenantId: 1, action: 'event.online', resourceType: 'item' });

      // DB query only returns ev2 because ev1 was never flushed to DB
      const result = await logger.query(1);
      assert.equal(result.total, 1, 'DB query returns only the row in DB');
      assert.equal(result.events[0].id, ev2.id);

      // Documented caveat: ev1 was preserved in memoryEvents but un-flushed to DB
      assert.notEqual(ev1.id, ev2.id);
    });
  });

  // =========================================================================
  // SUITE 3: License Compliance Adversarial Fixtures Stress
  // =========================================================================
  describe('Suite 3: License Compliance Scanner Adversarial Fixtures', () => {
    let fixtureRoot: string;

    before(() => {
      fixtureRoot = fs.mkdtempSync(path.join(tmpdir(), 'whatsap-license-challenge-'));
      fs.mkdirSync(path.join(fixtureRoot, 'scripts'));
      fs.copyFileSync(path.join(rootDir, 'scripts/license-audit.sh'), path.join(fixtureRoot, 'scripts/license-audit.sh'));
    });

    function setFixturePackage(name: string, license: string) {
      const fixtureDir = path.join(fixtureRoot, 'packages/contracts/node_modules/challenger-license-fixture');
      fs.mkdirSync(fixtureDir, { recursive: true });
      fs.writeFileSync(
        path.join(fixtureDir, 'package.json'),
        JSON.stringify({ name, version: '1.0.0', license }, null, 2)
      );
    }

    function runAudit(): { exitCode: number; parsed: any } {
      const result = spawnSync('bash', ['scripts/license-audit.sh', '--json'], {
        cwd: fixtureRoot, encoding: 'utf8',
      });
      assert.ifError(result.error);
      assert.notEqual(result.status, null);
      return { exitCode: result.status!, parsed: JSON.parse(result.stdout) };
    }

    after(() => {
      if (fixtureRoot) fs.rmSync(fixtureRoot, { recursive: true, force: true });
    });

    test('3.1: Copyleft AGPL-3.0-only is detected and rejected with exit code 1', () => {
      setFixturePackage('challenger-agpl', 'AGPL-3.0-only');
      const res = runAudit();
      const pkg = res.parsed.packages.find((p: any) => p.name === 'challenger-agpl');

      assert.equal(res.exitCode, 1, 'Must exit with code 1 on AGPL violation');
      assert.equal(res.parsed.violations, 1);
      assert.equal(pkg?.status, 'FAIL');
      assert.ok(pkg?.reason?.includes('Viral copyleft'));
    });

    test('3.2: Copyleft GPL-2.0-only is detected and rejected with exit code 1', () => {
      setFixturePackage('challenger-gpl', 'GPL-2.0-only');
      const res = runAudit();
      const pkg = res.parsed.packages.find((p: any) => p.name === 'challenger-gpl');

      assert.equal(res.exitCode, 1, 'Must exit with code 1 on GPL violation');
      assert.equal(res.parsed.violations, 1);
      assert.equal(pkg?.status, 'FAIL');
      assert.ok(pkg?.reason?.includes('Viral copyleft'));
    });

    test('3.3: Copyleft SSPL-1.0 is detected and rejected with exit code 1', () => {
      setFixturePackage('challenger-sspl', 'SSPL-1.0');
      const res = runAudit();
      const pkg = res.parsed.packages.find((p: any) => p.name === 'challenger-sspl');

      assert.equal(res.exitCode, 1, 'Must exit with code 1 on SSPL violation');
      assert.equal(res.parsed.violations, 1);
      assert.equal(pkg?.status, 'FAIL');
      assert.ok(pkg?.reason?.includes('Viral copyleft'));
    });

    test('3.4: Dual-licensed package (MIT OR GPL-3.0) elects permissive branch and exits with code 0', () => {
      setFixturePackage('challenger-dual-mit-gpl', '(MIT OR GPL-3.0)');
      const res = runAudit();
      const pkg = res.parsed.packages.find((p: any) => p.name === 'challenger-dual-mit-gpl');

      assert.equal(res.exitCode, 0, 'Must exit with code 0 under permissive election');
      assert.equal(res.parsed.violations, 0);
      assert.equal(pkg?.status, 'PASS');
    });

    test('3.5: Dual-copyleft package (GPL-2.0 OR AGPL-3.0) is rejected with exit code 1', () => {
      setFixturePackage('challenger-dual-copyleft', '(GPL-2.0 OR AGPL-3.0)');
      const res = runAudit();
      const pkg = res.parsed.packages.find((p: any) => p.name === 'challenger-dual-copyleft');

      assert.equal(res.exitCode, 1);
      assert.equal(res.parsed.violations, 1);
      assert.equal(pkg?.status, 'FAIL');
    });

    test('3.6: Compound license (MIT AND GPL-3.0) is rejected with exit code 1', () => {
      setFixturePackage('challenger-compound-gpl', '(MIT AND GPL-3.0)');
      const res = runAudit();
      const pkg = res.parsed.packages.find((p: any) => p.name === 'challenger-compound-gpl');

      assert.equal(res.exitCode, 1);
      assert.equal(res.parsed.violations, 1);
      assert.equal(pkg?.status, 'FAIL');
    });

    test('3.7: Compound license (MIT AND Apache-2.0) passes with exit code 0', () => {
      setFixturePackage('challenger-compound-permissive', '(MIT AND Apache-2.0)');
      const res = runAudit();
      const pkg = res.parsed.packages.find((p: any) => p.name === 'challenger-compound-permissive');

      assert.equal(res.exitCode, 0);
      assert.equal(res.parsed.violations, 0);
      assert.equal(pkg?.status, 'PASS');
    });

    test('3.8: An OR nested inside an AND cannot bypass a required copyleft license', () => {
      setFixturePackage('challenger-nested', '((MIT OR GPL-3.0-only)AND(AGPL-3.0-only))');
      const result = runAudit();
      assert.equal(result.exitCode, 1);
      assert.equal(result.parsed.violations, 1);
    });

    test('3.9: AND precedence allows choosing a complete permissive alternative', () => {
      setFixturePackage('challenger-precedence', 'MIT OR GPL-3.0-only AND Apache-2.0');
      const result = runAudit();
      assert.equal(result.exitCode, 0);
      assert.equal(result.parsed.packages.find((pkg: { name: string }) => pkg.name === 'challenger-precedence').elected, 'MIT');
    });

    test('3.10: Scans a nested dependency installed under a permissive package', () => {
      setFixturePackage('challenger-parent', 'MIT');
      const nested = path.join(fixtureRoot,
        'packages/contracts/node_modules/challenger-license-fixture/node_modules/challenger-nested-copy');
      fs.mkdirSync(nested, { recursive: true });
      fs.writeFileSync(path.join(nested, 'package.json'),
        JSON.stringify({ name: 'challenger-nested-copy', version: '1.0.0', license: 'GPL-3.0-only' }));
      const result = runAudit();
      assert.equal(result.exitCode, 1);
      assert.equal(result.parsed.violations, 1);
    });
  });

  // =========================================================================
  // SUITE 4: CycloneDX 1.5 JSON SBOM Validity & Schema Verification
  // =========================================================================
  describe('Suite 4: CycloneDX 1.5 JSON SBOM Validation', () => {
    const sbomPath = path.resolve(rootDir, 'sbom.json');
    const workspaces = ['WhatsaapWeb-JS', 'Frontend_py_whatsaapweb', 'apps/mobile', 'packages/contracts', 'packages/sdk', 'packages/cli'];

    test('4.1: sbom.json exists and adheres to CycloneDX 1.5 specification', () => {
      assert.ok(fs.existsSync(sbomPath), 'sbom.json must exist');
      const sbom = JSON.parse(fs.readFileSync(sbomPath, 'utf8'));

      assert.equal(sbom.bomFormat, 'CycloneDX');
      assert.equal(sbom.specVersion, '1.5');
      assert.ok(sbom.version >= 1);
      assert.equal(sbom.metadata?.component?.name, 'whatsap-automat');
      assert.equal(sbom.metadata?.component?.type, 'application');
    });

    test('4.2: Components have valid PURLs and license records when declared', () => {
      const sbom = JSON.parse(fs.readFileSync(sbomPath, 'utf8'));
      assert.ok(Array.isArray(sbom.components) && sbom.components.length > 500);

      for (const comp of sbom.components) {
        assert.ok(comp['bom-ref'], `Component ${comp.name} missing bom-ref`);
        assert.ok(comp.purl, `Component ${comp.name} missing purl`);
        assert.ok(
          comp.purl.startsWith('pkg:npm/') || comp.purl.startsWith('pkg:generic/'),
          `Invalid purl format in ${comp.name}: ${comp.purl}`
        );
        if (comp.licenses !== undefined) {
          assert.ok(Array.isArray(comp.licenses) && comp.licenses.length > 0, `Component ${comp.name} has empty licenses`);
          assert.ok(comp.licenses.every((entry: { license?: { id?: string; name?: string }; expression?: string }) =>
            entry.license?.id || entry.license?.name || entry.expression));
        }
      }
    });

    test('4.3: Catalogs each workspace package under its manifest name and version', () => {
      const sbom = JSON.parse(fs.readFileSync(sbomPath, 'utf8'));
      for (const workspace of workspaces) {
        const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, workspace, 'package.json'), 'utf8'));
        const found = sbom.components.some((component: { name: string; version: string }) =>
          component.name === manifest.name && component.version === manifest.version);
        assert.ok(found, `Workspace package ${manifest.name} missing from sbom.json`);
      }
    });

    test('4.4: Dependency graph root links to workspace packages', () => {
      const sbom = JSON.parse(fs.readFileSync(sbomPath, 'utf8'));
      assert.ok(Array.isArray(sbom.dependencies) && sbom.dependencies.length > 0);

      const rootDep = sbom.dependencies.find((d: any) => d.ref === 'pkg:generic/whatsap-automat@0.4.0');
      assert.ok(rootDep, 'Root dependency node missing');
      assert.equal(rootDep.dependsOn.length, workspaces.length, 'Root must depend on every workspace package');
    });
  });
});
