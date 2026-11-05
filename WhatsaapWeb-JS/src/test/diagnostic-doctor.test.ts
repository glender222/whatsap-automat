/**
 * Test Suite: DiagnosticDoctor SRE Engine (Phase F8)
 *
 * Verifies check battery, secret redaction, error tolerance, and report formatting.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  DiagnosticDoctor,
  redactDiagnosticSecrets,
  DiagnosticReport,
} from '../services/diagnostics/DiagnosticDoctor';

describe('Phase F8 SRE DiagnosticDoctor Engine', () => {
  let tempMigrationsDir: string;

  beforeEach(() => {
    process.env.MASTER_ENCRYPTION_KEY = '12345678901234567890123456789012';
    process.env.JWT_SECRET = 'a_very_secure_test_jwt_secret_with_more_than_32_characters';
    delete process.env.REDIS_URL;

    tempMigrationsDir = path.join(
      os.tmpdir(),
      `test_mig_${Date.now()}_${Math.random().toString(36).substring(7)}`
    );
    fs.mkdirSync(tempMigrationsDir, { recursive: true });
    fs.writeFileSync(path.join(tempMigrationsDir, '000_core.sql'), '-- core migration');
    fs.writeFileSync(path.join(tempMigrationsDir, '031_audit_events.sql'), '-- audit migration');
  });

  test('1. Secret Redactor scrubs database credentials, Bearer tokens, and JWTs', () => {
    const raw =
      'Connect to postgresql://postgres:supersecretpass@db.internal:5432/whatsap_db with Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.doNotLeakThis';
    const redacted = redactDiagnosticSecrets(raw);

    assert.ok(!redacted.includes('supersecretpass'), 'Database password must be scrubbed');
    assert.ok(redacted.includes('postgresql://postgres:[REDACTED]@db.internal:5432/whatsap_db'));
    assert.ok(!redacted.includes('doNotLeakThis'), 'JWT signature must be scrubbed');
    assert.ok(redacted.includes('[REDACTED_JWT]'));
  });

  test('2. NODE-001 checks Node runtime version (>= 20) and memory usage', async () => {
    const doctor = new DiagnosticDoctor({ skipDatabase: true, skipNetwork: true });
    const result = await doctor.checkNodeRuntime();

    assert.equal(result.code, 'NODE-001');
    assert.equal(result.status, 'PASS');
    assert.ok(result.details.includes('Node.js v'));
    assert.ok(result.latencyMs >= 0);
  });

  test('3. SANDBOX-001 tests child process isolation with memory caps', async () => {
    const doctor = new DiagnosticDoctor({ skipDatabase: true, skipNetwork: true });
    const result = await doctor.checkChildProcessSandbox();

    assert.equal(result.code, 'SANDBOX-001');
    assert.equal(result.status, 'PASS');
    assert.ok(result.details.includes('--max-old-space-size'));
  });

  test('4. DISK-001 verifies filesystem write capability and free space', async () => {
    const doctor = new DiagnosticDoctor({ skipDatabase: true, skipNetwork: true });
    const result = await doctor.checkDiskWritableAndSpace();

    assert.equal(result.code, 'DISK-001');
    assert.equal(result.status, 'PASS');
    assert.ok(result.details.includes('Filesystem read/write verified'));
  });

  test('5. SEC-ENC-001 passes when MASTER_ENCRYPTION_KEY is valid 32 bytes and cipher works', async () => {
    process.env.MASTER_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'; // 64 hex chars
    const doctor = new DiagnosticDoctor({ skipDatabase: true, skipNetwork: true });
    const result = await doctor.checkMasterEncryptionKey();

    assert.equal(result.code, 'SEC-ENC-001');
    assert.equal(result.status, 'PASS');
    assert.ok(result.details.includes('AES-256-GCM operational'));
  });

  test('6. SEC-ENC-001 fails when MASTER_ENCRYPTION_KEY is missing or too short without leaking key', async () => {
    process.env.MASTER_ENCRYPTION_KEY = 'too-short';
    const doctor = new DiagnosticDoctor({ skipDatabase: true, skipNetwork: true });
    const result = await doctor.checkMasterEncryptionKey();

    assert.equal(result.code, 'SEC-ENC-001');
    assert.equal(result.status, 'FAIL');
    assert.ok(result.details.includes('too short'));
    assert.ok(!result.details.includes('too-short'), 'Raw key must never appear in details');
    assert.ok(result.remediationGuide?.includes('openssl rand -hex 32'));
  });

  test('7. SEC-JWT-001 checks minimum 32 chars and flags default development secrets', async () => {
    process.env.JWT_SECRET = 'short';
    const doctor = new DiagnosticDoctor({ skipDatabase: true, skipNetwork: true });
    const shortResult = await doctor.checkJwtSecret();
    assert.equal(shortResult.status, 'FAIL');

    process.env.JWT_SECRET = 'a_very_secure_test_jwt_secret_with_more_than_32_characters';
    const passResult = await doctor.checkJwtSecret();
    assert.equal(passResult.status, 'PASS');
  });

  test('8. CACHE-001 / REDIS-001 handles absent Redis gracefully as PASS with in-memory notice', async () => {
    delete process.env.REDIS_URL;
    const doctor = new DiagnosticDoctor({ skipDatabase: true, skipNetwork: true });
    const result = await doctor.checkCacheAvailability();

    assert.equal(result.code, 'CACHE-001');
    assert.equal(result.status, 'PASS');
    assert.ok(result.details.includes('in-memory state store'));
  });

  test('9. DB-PG-001 passes with simulated pool response and records latency', async () => {
    const mockPool: any = {
      connect: async () => ({
        query: async () => ({
          rows: [
            {
              alive: 1,
              server_time: new Date(),
              db_name: 'whatsap_test',
              db_user: 'pg_tester',
              pg_version: 'PostgreSQL 16.1',
            },
          ],
        }),
        release: () => {},
      }),
    };

    const doctor = new DiagnosticDoctor({ pool: mockPool, skipDatabase: false, skipNetwork: true });
    const result = await doctor.checkDatabaseLiveness(mockPool);

    assert.equal(result.code, 'DB-PG-001');
    assert.equal(result.status, 'PASS');
    assert.ok(result.details.includes('whatsap_test'));
    assert.ok(result.latencyMs >= 0);
  });

  test('10. DB-PG-001 fails gracefully when pool connection errors without unhandled rejection', async () => {
    const failingPool: any = {
      connect: async () => {
        const err: any = new Error('password authentication failed for user "postgres"');
        err.code = '28P01';
        throw err;
      },
    };

    const doctor = new DiagnosticDoctor({ pool: failingPool, skipDatabase: false, skipNetwork: true });
    const result = await doctor.checkDatabaseLiveness(failingPool);

    assert.equal(result.code, 'DB-PG-001');
    assert.equal(result.status, 'FAIL');
    assert.ok(result.details.includes('password authentication failed'));
    assert.ok(result.remediationGuide?.includes('DB_PASSWORD'));
  });

  test('11. DB-MIG-001 passes when all disk migrations are recorded in schema_migrations', async () => {
    const mockPool: any = {
      query: async (sql: string) => {
        if (sql.includes('to_regclass')) {
          return { rows: [{ exists: 'schema_migrations' }] };
        }
        return {
          rows: [{ version: '000_core' }, { version: '031_audit_events' }],
        };
      },
    };

    const doctor = new DiagnosticDoctor({
      pool: mockPool,
      skipDatabase: false,
      skipNetwork: true,
      migrationsDir: tempMigrationsDir,
    });
    const result = await doctor.checkMigrationStatus(mockPool, tempMigrationsDir);

    assert.equal(result.code, 'DB-MIG-001');
    assert.equal(result.status, 'PASS');
    assert.ok(result.details.includes('All 2 migrations applied cleanly'));
  });

  test('12. DB-MIG-001 fails when pending migrations are detected', async () => {
    const mockPool: any = {
      query: async (sql: string) => {
        if (sql.includes('to_regclass')) {
          return { rows: [{ exists: 'schema_migrations' }] };
        }
        return { rows: [{ version: '000_core' }] }; // 031_audit_events missing
      },
    };

    const doctor = new DiagnosticDoctor({
      pool: mockPool,
      skipDatabase: false,
      skipNetwork: true,
      migrationsDir: tempMigrationsDir,
    });
    const result = await doctor.checkMigrationStatus(mockPool, tempMigrationsDir);

    assert.equal(result.code, 'DB-MIG-001');
    assert.equal(result.status, 'FAIL');
    assert.ok(result.details.includes('1 pending migration(s)'));
    assert.ok(result.remediationGuide?.includes('npm run db:migrate'));
  });

  test('13. runAll aggregates summary stats and overall status accurately', async () => {
    const doctor = new DiagnosticDoctor({ skipDatabase: true, skipNetwork: true });
    const report: DiagnosticReport = await doctor.runAll();

    assert.ok(report.total >= 5);
    assert.equal(report.failed, 0);
    assert.equal(report.overallStatus, 'PASS');
    assert.ok(report.executionDurationMs >= 0);
    assert.ok(Array.isArray(report.checks));
  });
});
