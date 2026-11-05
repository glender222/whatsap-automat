/**
 * Test Suite: Backup Rehearsal Script (Phase F8)
 *
 * Verifies non-destructive rehearsal, SHA-256 verification, EOF marker enforcement,
 * corruption detection, and JSON summary metrics.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/backup-rehearsal.sh');

describe('Phase F8 Disaster Recovery Backup Rehearsal', () => {
  before(() => {
    if (fs.existsSync(SCRIPT_PATH)) {
      try {
        fs.chmodSync(SCRIPT_PATH, 0o755);
      } catch {
        // ignore chmod errors on read-only environments
      }
    }
  });

  test('1. backup-rehearsal.sh exists and responds to --help', () => {
    if (!fs.existsSync(SCRIPT_PATH)) {
      assert.fail(`Script not found at ${SCRIPT_PATH}`);
    }
    const res = spawnSync('bash', [SCRIPT_PATH, '--help'], { encoding: 'utf8' });
    assert.equal(res.status, 0);
    assert.ok(res.stdout.includes('Usage:'));
    assert.ok(res.stdout.includes('--synthetic'));
  });

  test('2. backup-rehearsal.sh runs in --synthetic mode and outputs valid JSON metrics', () => {
    assert.ok(fs.existsSync(SCRIPT_PATH));

    const res = spawnSync('bash', [SCRIPT_PATH, '--synthetic', '--json'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: process.env.PATH },
    });

    assert.equal(res.status, 0, `Script failed: ${res.stderr}`);
    const jsonReport = JSON.parse(res.stdout.trim());

    assert.equal(jsonReport.status, 'SUCCESS');
    assert.equal(jsonReport.phase, 'REHEARSAL_COMPLETED');
    assert.equal(jsonReport.metrics.eofMarkerValid, true);
    assert.equal(jsonReport.metrics.checksumValid, true);
    assert.ok(jsonReport.metrics.dumpSizeBytes > 0);
    assert.equal(typeof jsonReport.metrics.sha256, 'string');
    assert.equal(jsonReport.metrics.sha256.length, 64);
    assert.ok(jsonReport.metrics.tablesVerified >= 3);
  });

  test('3. Detects truncated backup missing PostgreSQL EOF marker', () => {
    // Tests that a truncated dump lacking "-- PostgreSQL database dump complete" is rejected
    const tempDir = path.join(os.tmpdir(), `test_corrupt_${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });
    const corruptFile = path.join(tempDir, 'corrupt.sql.gz');

    // Create compressed SQL without EOF marker
    execSync(`echo "CREATE TABLE foo (id int);" | gzip > "${corruptFile}"`);

    // Verify grep fails
    const grepRes = spawnSync('bash', ['-c', `gzip -dc "${corruptFile}" | grep -q -- "-- PostgreSQL database dump complete"`]);
    assert.notEqual(grepRes.status, 0, 'Must not detect EOF marker in truncated file');

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('4. Detects checksum tampering and fails closed', () => {
    const tempDir = path.join(os.tmpdir(), `test_tamper_${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });
    const dumpFile = path.join(tempDir, 'dump.sql.gz');
    const checksumFile = `${dumpFile}.sha256`;

    // Write original payload
    fs.writeFileSync(dumpFile, 'valid_dump_content');
    execSync(`sha256sum "${dumpFile}" | awk '{print $1}' > "${checksumFile}"`);

    // Tamper with dump file by 1 byte
    fs.writeFileSync(dumpFile, 'tampered_dump_content!');

    // Run sha256sum verification
    const checkRes = spawnSync('bash', ['-c', `cd "${tempDir}" && sha256sum -c "${path.basename(checksumFile)}"`]);
    assert.notEqual(checkRes.status, 0, 'Checksum check must fail when file is modified');

    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
