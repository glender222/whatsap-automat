import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ExtensionHost } from '../services/extensions/ExtensionHost';
import { ExtensionSandboxError } from '../services/extensions/types';

describe('PR-F7-03: Extension Sandboxing & Security Boundaries', () => {
  let tmpDir: string;
  let benignScriptPath: string;
  let runawayScriptPath: string;
  let secretLeakScriptPath: string;
  let crashScriptPath: string;
  let host: ExtensionHost;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-sandbox-test-'));

    // 1. Benign script
    benignScriptPath = path.join(tmpDir, 'benign.js');
    fs.writeFileSync(
      benignScriptPath,
      `
      module.exports = {
        execute(params) {
          return {
            echo: params.message,
            calculated: (params.a || 0) * (params.b || 0),
            timestamp: Date.now()
          };
        }
      };
      `
    );

    // 2. Runaway script (infinite loop)
    runawayScriptPath = path.join(tmpDir, 'runaway.js');
    fs.writeFileSync(
      runawayScriptPath,
      `
      module.exports = {
        execute() {
          while (true) {}
        }
      };
      `
    );

    // 3. Secret leak attempt script
    secretLeakScriptPath = path.join(tmpDir, 'secret-leak.js');
    fs.writeFileSync(
      secretLeakScriptPath,
      `
      module.exports = {
        execute() {
          return {
            masterKey: process.env.MASTER_ENCRYPTION_KEY,
            databaseUrl: process.env.DATABASE_URL,
            jwtSecret: process.env.JWT_SECRET,
            nodeEnv: process.env.NODE_ENV,
            hasPath: typeof process.env.PATH === 'string'
          };
        }
      };
      `
    );

    // 4. Crash script
    crashScriptPath = path.join(tmpDir, 'crash.js');
    fs.writeFileSync(
      crashScriptPath,
      `
      module.exports = {
        execute() {
          process.exit(42);
        }
      };
      `
    );

    host = new ExtensionHost();
  });

  after(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
  });

  describe('Suite 1: Benign Extension Invocation', () => {
    it('executes benign extension returning successful JSON-RPC result', async () => {
      const result = await host.invoke<any>({
        extensionPath: benignScriptPath,
        params: { message: 'hello sandbox', a: 6, b: 7 },
      });

      assert.equal(result.echo, 'hello sandbox');
      assert.equal(result.calculated, 42);
      assert.ok(typeof result.timestamp === 'number');
    });
  });

  describe('Suite 2: CPU/Execution Timeout & SIGKILL Guard (RFC 7807 504)', () => {
    it('terminates runaway infinite loop via SIGKILL and returns RFC 7807 504 Gateway Timeout', async () => {
      const startTime = Date.now();
      let errorThrown: ExtensionSandboxError | null = null;

      try {
        await host.invoke({
          extensionPath: runawayScriptPath,
          timeoutMs: 1200, // Short timeout for test speed
          correlationId: 'test-timeout-corr-1',
        });
      } catch (err: any) {
        errorThrown = err;
      }

      const durationMs = Date.now() - startTime;
      assert.ok(errorThrown !== null, 'Expected host.invoke to reject');
      assert.ok(errorThrown instanceof ExtensionSandboxError);
      assert.equal(errorThrown.status, 504);

      // Verify RFC 7807 problem details
      const problem = errorThrown.problemDetails;
      assert.equal(problem.status, 504);
      assert.equal(problem.title, 'Gateway Timeout');
      assert.equal(problem.correlationId, 'test-timeout-corr-1');
      assert.ok(problem.detail.includes('SIGKILL'));
      assert.ok(durationMs >= 1100, `Expected duration >= 1100ms, got ${durationMs}ms`);
      assert.ok(durationMs < 4000, `Expected duration < 4000ms, got ${durationMs}ms`);
    });
  });

  describe('Suite 3: Secret Leakage Prevention & Environment Stripping (SEC-009)', () => {
    it('verifies process.env.MASTER_ENCRYPTION_KEY and DB credentials are not leaked to guest process', async () => {
      // Inject sensitive host secrets into parent process.env
      process.env.MASTER_ENCRYPTION_KEY = 'super-secret-master-encryption-key-xyz-32b';
      process.env.DATABASE_URL = 'postgres://postgres:supersecretpassword@localhost:5432/whatsap_db';
      process.env.JWT_SECRET = 'jwt-super-confidential-secret-key';

      try {
        const result = await host.invoke<any>({
          extensionPath: secretLeakScriptPath,
        });

        // STRICT ASSERTIONS:
        assert.equal(result.masterKey, undefined, 'MASTER_ENCRYPTION_KEY MUST NOT leak into guest');
        assert.equal(result.databaseUrl, undefined, 'DATABASE_URL MUST NOT leak into guest');
        assert.equal(result.jwtSecret, undefined, 'JWT_SECRET MUST NOT leak into guest');
        assert.equal(result.nodeEnv, 'production', 'NODE_ENV must be production');
        assert.equal(result.hasPath, true, 'PATH must be preserved');
      } finally {
        delete process.env.MASTER_ENCRYPTION_KEY;
        delete process.env.DATABASE_URL;
        delete process.env.JWT_SECRET;
      }
    });
  });

  describe('Suite 4: Crash Resilience & Host Process Protection (RFC 7807 502)', () => {
    it('intercepts guest process exit(42) and returns RFC 7807 502 Bad Gateway while keeping host alive', async () => {
      let errorThrown: ExtensionSandboxError | null = null;

      try {
        await host.invoke({
          extensionPath: crashScriptPath,
          correlationId: 'test-crash-corr-1',
        });
      } catch (err: any) {
        errorThrown = err;
      }

      assert.ok(errorThrown !== null, 'Expected crash script to reject');
      assert.ok(errorThrown instanceof ExtensionSandboxError);
      assert.equal(errorThrown.status, 502);

      const problem = errorThrown.problemDetails;
      assert.equal(problem.status, 502);
      assert.equal(problem.title, 'Bad Gateway');
      assert.equal(problem.correlationId, 'test-crash-corr-1');
      assert.ok(problem.detail.includes('42'));

      // Verify host process is alive and can immediately execute benign calls
      const benignResult = await host.invoke<any>({
        extensionPath: benignScriptPath,
        params: { message: 'alive after crash', a: 1, b: 2 },
      });
      assert.equal(benignResult.echo, 'alive after crash');
    });
  });
});
