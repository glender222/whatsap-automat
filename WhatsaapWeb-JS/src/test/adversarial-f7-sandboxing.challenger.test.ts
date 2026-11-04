import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ExtensionHost } from '../services/extensions/ExtensionHost';
import { ExtensionSandboxError } from '../services/extensions/types';

describe('CHALLENGER-F7: Adversarial Sandboxing & Security Boundaries Stress Suite', () => {
  let tmpDir: string;
  let host: ExtensionHost;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'challenger-f7-sandbox-'));
    host = new ExtensionHost();
  });

  after(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
  });

  // --------------------------------------------------------------------------
  // Challenge 1: CPU Runaway Loop & Watchdog SIGKILL Termination
  // --------------------------------------------------------------------------
  describe('Challenge 1: CPU Runaway Loop Watchdog & Event-Loop Liveness', () => {
    it('EMPIRICAL: infinite loop terminates within timeout via SIGKILL and returns RFC 7807 504', async () => {
      const runawayScript = path.join(tmpDir, 'infinite-loop.js');
      fs.writeFileSync(
        runawayScript,
        `module.exports = {
          execute() {
            while (true) {}
          }
        };`
      );

      const timeoutMs = 800;
      const t0 = Date.now();
      let caughtError: ExtensionSandboxError | null = null;

      try {
        await host.invoke({
          extensionPath: runawayScript,
          timeoutMs,
          correlationId: 'challenger-corr-cpu-1',
        });
      } catch (err: any) {
        caughtError = err;
      }

      const elapsed = Date.now() - t0;
      assert.ok(caughtError !== null, 'Expected host.invoke to reject on infinite loop');
      assert.ok(caughtError instanceof ExtensionSandboxError, 'Expected ExtensionSandboxError instance');
      assert.equal(caughtError.status, 504);

      const problem = caughtError.problemDetails;
      assert.equal(problem.status, 504);
      assert.equal(problem.title, 'Gateway Timeout');
      assert.equal(problem.code, 'RETRYABLE');
      assert.equal(problem.correlationId, 'challenger-corr-cpu-1');
      assert.ok(problem.detail.includes('SIGKILL'));
      assert.ok(elapsed >= timeoutMs, `Elapsed ${elapsed}ms must be >= timeout ${timeoutMs}ms`);
      assert.ok(elapsed < timeoutMs + 2000, `Elapsed ${elapsed}ms must not excessively delay`);
    });

    it('EMPIRICAL: host event loop remains unblocked during concurrent runaway loops', async () => {
      const runawayScript = path.join(tmpDir, 'concurrent-runaway.js');
      fs.writeFileSync(
        runawayScript,
        `module.exports = {
          execute() {
            while (true) {}
          }
        };`
      );

      // Start a heartbeat timer on the host to monitor event loop latency
      let heartbeatTicks = 0;
      const heartbeatInterval = setInterval(() => {
        heartbeatTicks++;
      }, 50);

      const concurrency = 4;
      const promises = Array.from({ length: concurrency }).map((_, i) =>
        host
          .invoke({
            extensionPath: runawayScript,
            timeoutMs: 600,
            correlationId: `challenger-concurrent-${i}`,
          })
          .catch((err) => err)
      );

      const results = await Promise.all(promises);
      clearInterval(heartbeatInterval);

      // Verify all failed with 504
      for (const res of results) {
        assert.ok(res instanceof ExtensionSandboxError, 'Every runaway invocation must reject with ExtensionSandboxError');
        assert.equal(res.status, 504);
      }

      // Crucial: Heartbeat must have ticked multiple times, proving parent event loop never stalled!
      assert.ok(
        heartbeatTicks >= 5,
        `Parent event loop must remain active (heartbeat ticks: ${heartbeatTicks})`
      );
    });

    it('EMPIRICAL: recursive stack overflow is caught and mapped to 502/504 without crashing host', async () => {
      const stackOverflowScript = path.join(tmpDir, 'stack-overflow.js');
      fs.writeFileSync(
        stackOverflowScript,
        `module.exports = {
          execute() {
            function recurse() {
              return recurse();
            }
            return recurse();
          }
        };`
      );

      let caughtError: ExtensionSandboxError | null = null;
      try {
        await host.invoke({
          extensionPath: stackOverflowScript,
          timeoutMs: 1500,
        });
      } catch (err: any) {
        caughtError = err;
      }

      assert.ok(caughtError !== null, 'Expected recursion bomb to reject');
      assert.ok(caughtError instanceof ExtensionSandboxError);
      // Either 502 (guest runner caught RangeError) or 504 (timed out)
      assert.ok(
        caughtError.status === 502 || caughtError.status === 504,
        `Expected status 502 or 504, got ${caughtError.status}`
      );
    });
  });

  // --------------------------------------------------------------------------
  // Challenge 2: Environment Stripping & Host Secret Protection (SEC-009)
  // --------------------------------------------------------------------------
  describe('Challenge 2: Environment Stripping & Host Secret Protection (SEC-009)', () => {
    it('EMPIRICAL: guest process cannot access parent host secrets or arbitrary unwhitelisted env vars', async () => {
      // Set host secrets and arbitrary unwhitelisted vars in parent
      process.env.MASTER_ENCRYPTION_KEY = 'super-secret-master-key-challenger-32b';
      process.env.DATABASE_URL = 'postgres://admin:topsecret@localhost:5432/whatsap_db';
      process.env.DATABASE_PASSWORD = 'db-password-secret-123';
      process.env.DB_PASSWORD = 'db-password-secret-456';
      process.env.JWT_SECRET = 'jwt-secret-xyz-token-should-not-leak';
      process.env.META_ACCESS_TOKEN = 'meta-access-token-secret-string';
      process.env.META_TOKEN_ENCRYPTION_KEY = '01234567890123456789012345678901';
      process.env.OPENAI_API_KEY = 'sk-super-secret-openai-api-key';
      process.env.CHALLENGER_CUSTOM_SECRET = 'challenger-arbitrary-host-token';
      process.env.AWS_SECRET_ACCESS_KEY = 'aws-secret-access-key-confidential';

      const inspectorScript = path.join(tmpDir, 'env-inspector.js');
      fs.writeFileSync(
        inspectorScript,
        `module.exports = {
          execute() {
            return {
              allEnvKeys: Object.keys(process.env),
              masterKey: process.env.MASTER_ENCRYPTION_KEY,
              dbUrl: process.env.DATABASE_URL,
              dbPass: process.env.DATABASE_PASSWORD,
              dbPassShort: process.env.DB_PASSWORD,
              jwt: process.env.JWT_SECRET,
              metaToken: process.env.META_ACCESS_TOKEN,
              metaEncKey: process.env.META_TOKEN_ENCRYPTION_KEY,
              openAiKey: process.env.OPENAI_API_KEY,
              customSecret: process.env.CHALLENGER_CUSTOM_SECRET,
              awsSecret: process.env.AWS_SECRET_ACCESS_KEY,
              nodeEnv: process.env.NODE_ENV,
              path: process.env.PATH
            };
          }
        };`
      );

      try {
        const res = await host.invoke<any>({
          extensionPath: inspectorScript,
        });

        // 1. Host secrets must be strictly undefined
        assert.equal(res.masterKey, undefined);
        assert.equal(res.dbUrl, undefined);
        assert.equal(res.dbPass, undefined);
        assert.equal(res.dbPassShort, undefined);
        assert.equal(res.jwt, undefined);
        assert.equal(res.metaToken, undefined);
        assert.equal(res.metaEncKey, undefined);
        assert.equal(res.openAiKey, undefined);

        // 2. Arbitrary unwhitelisted parent env vars must be omitted
        assert.equal(res.customSecret, undefined);
        assert.equal(res.awsSecret, undefined);

        // 3. Whitelisted environment vars must be present
        assert.equal(res.nodeEnv, 'production');
        assert.ok(typeof res.path === 'string' && res.path.length > 0);

        // 4. Inspect entire env key set: no secret keys in keys array
        for (const forbidden of [
          'MASTER_ENCRYPTION_KEY',
          'DATABASE_URL',
          'DATABASE_PASSWORD',
          'DB_PASSWORD',
          'JWT_SECRET',
          'META_ACCESS_TOKEN',
          'META_TOKEN_ENCRYPTION_KEY',
          'OPENAI_API_KEY',
          'CHALLENGER_CUSTOM_SECRET',
          'AWS_SECRET_ACCESS_KEY',
        ]) {
          assert.ok(
            !res.allEnvKeys.includes(forbidden),
            `Key "${forbidden}" must not exist in child process.env`
          );
        }
      } finally {
        delete process.env.MASTER_ENCRYPTION_KEY;
        delete process.env.DATABASE_URL;
        delete process.env.DATABASE_PASSWORD;
        delete process.env.DB_PASSWORD;
        delete process.env.JWT_SECRET;
        delete process.env.META_ACCESS_TOKEN;
        delete process.env.META_TOKEN_ENCRYPTION_KEY;
        delete process.env.OPENAI_API_KEY;
        delete process.env.CHALLENGER_CUSTOM_SECRET;
        delete process.env.AWS_SECRET_ACCESS_KEY;
      }
    });

    it('EMPIRICAL: guestEnv cannot inject or override forbidden secret keys', async () => {
      const inspectorScript = path.join(tmpDir, 'env-override-check.js');
      fs.writeFileSync(
        inspectorScript,
        `module.exports = {
          execute() {
            return {
              masterKey: process.env.MASTER_ENCRYPTION_KEY,
              jwtSecret: process.env.JWT_SECRET,
              safeConfig: process.env.SAFE_CONFIG_VALUE
            };
          }
        };`
      );

      const res = await host.invoke<any>({
        extensionPath: inspectorScript,
        guestEnv: {
          MASTER_ENCRYPTION_KEY: 'malicious-injection-attempt',
          JWT_SECRET: 'malicious-jwt-override',
          SAFE_CONFIG_VALUE: 'allowed-safe-value',
        },
      });

      assert.equal(res.masterKey, undefined, 'Sanitizer must strip injected MASTER_ENCRYPTION_KEY');
      assert.equal(res.jwtSecret, undefined, 'Sanitizer must strip injected JWT_SECRET');
      assert.equal(res.safeConfig, 'allowed-safe-value', 'Allowed custom config is passed');
    });
  });

  // --------------------------------------------------------------------------
  // Challenge 3: Crash Resilience & Process Isolation
  // --------------------------------------------------------------------------
  describe('Challenge 3: Crash Resilience & Process Isolation (RFC 7807 502)', () => {
    it('EMPIRICAL: unhandled synchronous throw in guest returns RFC 7807 502 Bad Gateway', async () => {
      const syncThrowScript = path.join(tmpDir, 'sync-throw.js');
      fs.writeFileSync(
        syncThrowScript,
        `module.exports = {
          execute() {
            throw new Error('Fatal unhandled business rule failure');
          }
        };`
      );

      let err: ExtensionSandboxError | null = null;
      try {
        await host.invoke({
          extensionPath: syncThrowScript,
          correlationId: 'corr-throw-sync',
        });
      } catch (e: any) {
        err = e;
      }

      assert.ok(err !== null);
      assert.ok(err instanceof ExtensionSandboxError);
      assert.equal(err.status, 502);
      assert.equal(err.problemDetails.status, 502);
      assert.equal(err.problemDetails.title, 'Bad Gateway');
      assert.ok(err.problemDetails.detail.includes('Fatal unhandled business rule failure'));
      assert.equal(err.problemDetails.correlationId, 'corr-throw-sync');
    });

    it('EMPIRICAL: unhandled promise rejection in guest returns RFC 7807 502 Bad Gateway', async () => {
      const asyncRejectionScript = path.join(tmpDir, 'async-rejection.js');
      fs.writeFileSync(
        asyncRejectionScript,
        `module.exports = {
          execute() {
            return new Promise((_, reject) => {
              setTimeout(() => {
                reject(new Error('Async database connection failure in extension'));
              }, 20);
            });
          }
        };`
      );

      let err: ExtensionSandboxError | null = null;
      try {
        await host.invoke({
          extensionPath: asyncRejectionScript,
          correlationId: 'corr-rejection-async',
        });
      } catch (e: any) {
        err = e;
      }

      assert.ok(err !== null);
      assert.ok(err instanceof ExtensionSandboxError);
      assert.equal(err.status, 502);
      assert.equal(err.problemDetails.title, 'Bad Gateway');
      assert.ok(err.problemDetails.detail.includes('Async database connection failure in extension'));
    });

    it('EMPIRICAL: sudden process.exit(1) returns RFC 7807 502 and keeps host alive', async () => {
      const exitScript = path.join(tmpDir, 'hard-exit.js');
      fs.writeFileSync(
        exitScript,
        `module.exports = {
          execute() {
            process.exit(1);
          }
        };`
      );

      let err: ExtensionSandboxError | null = null;
      try {
        await host.invoke({
          extensionPath: exitScript,
          correlationId: 'corr-hard-exit-1',
        });
      } catch (e: any) {
        err = e;
      }

      assert.ok(err !== null);
      assert.ok(err instanceof ExtensionSandboxError);
      assert.equal(err.status, 502);
      assert.equal(err.problemDetails.status, 502);
      assert.ok(err.problemDetails.detail.includes('1'));

      // Test host is completely unaffected
      const benignScript = path.join(tmpDir, 'benign-post-crash.js');
      fs.writeFileSync(
        benignScript,
        `module.exports = {
          execute(p) { return { ok: true, val: p.v * 2 }; }
        };`
      );
      const okRes = await host.invoke<any>({
        extensionPath: benignScript,
        params: { v: 21 },
      });
      assert.equal(okRes.val, 42);
    });

    it('EMPIRICAL: invokeSafe wrapper captures 502/504 errors in RFC 7807 envelope without throwing', async () => {
      const exitScript = path.join(tmpDir, 'hard-exit.js');
      const safeResult = await host.invokeSafe({
        extensionPath: exitScript,
        correlationId: 'corr-safe-test',
      });

      assert.equal(safeResult.success, false);
      assert.ok('error' in safeResult);
      assert.equal(safeResult.error.status, 502);
      assert.equal(safeResult.error.title, 'Bad Gateway');
      assert.equal(safeResult.error.correlationId, 'corr-safe-test');
      assert.ok(safeResult.durationMs >= 0);
    });

    it('EMPIRICAL: non-existent file path returns RFC 7807 502 Bad Gateway', async () => {
      let err: ExtensionSandboxError | null = null;
      try {
        await host.invoke({
          extensionPath: path.join(tmpDir, 'does-not-exist-at-all-12345.js'),
        });
      } catch (e: any) {
        err = e;
      }

      assert.ok(err !== null);
      assert.ok(err instanceof ExtensionSandboxError);
      assert.equal(err.status, 502);
      assert.ok(err.problemDetails.detail.includes('Failed to load extension module'));
    });

    it('EMPIRICAL: invalid module syntax (broken JS) returns RFC 7807 502 Bad Gateway', async () => {
      const syntaxErrorScript = path.join(tmpDir, 'syntax-error.js');
      fs.writeFileSync(syntaxErrorScript, 'module.exports = { function execute() { broken syntax !!! }}}');

      let err: ExtensionSandboxError | null = null;
      try {
        await host.invoke({
          extensionPath: syntaxErrorScript,
        });
      } catch (e: any) {
        err = e;
      }

      assert.ok(err !== null);
      assert.ok(err instanceof ExtensionSandboxError);
      assert.equal(err.status, 502);
    });

    it('EMPIRICAL: module without exported handler function returns RFC 7807 502 Bad Gateway', async () => {
      const noHandlerScript = path.join(tmpDir, 'no-handler.js');
      fs.writeFileSync(noHandlerScript, 'module.exports = { someOtherFunction() { return 123; } };');

      let err: ExtensionSandboxError | null = null;
      try {
        await host.invoke({
          extensionPath: noHandlerScript,
          method: 'nonExistentHandler',
        });
      } catch (e: any) {
        err = e;
      }

      assert.ok(err !== null);
      assert.ok(err instanceof ExtensionSandboxError);
      assert.equal(err.status, 502);
      assert.ok(err.problemDetails.detail.includes('not found in extension module'));
    });
  });

  // --------------------------------------------------------------------------
  // Challenge 4: Memory Ceiling Enforcement (--max-old-space-size=128)
  // --------------------------------------------------------------------------
  describe('Challenge 4: Memory Ceiling Enforcement (--max-old-space-size=128)', () => {
    it('EMPIRICAL: memory allocation runaway in child triggers OOM termination without exhausting host memory', async () => {
      const memoryBombScript = path.join(tmpDir, 'memory-bomb.js');
      // Rapidly allocate arrays of large buffers to trigger V8 max-old-space-size=128 OOM
      fs.writeFileSync(
        memoryBombScript,
        `module.exports = {
          execute() {
            const buffers = [];
            // Allocate 16MB per iteration -> quickly exceeds 128MB heap
            while (true) {
              buffers.push(Buffer.alloc(16 * 1024 * 1024, 0xff));
            }
          }
        };`
      );

      const hostHeapBefore = process.memoryUsage().heapUsed;

      let caughtError: ExtensionSandboxError | null = null;
      try {
        await host.invoke({
          extensionPath: memoryBombScript,
          timeoutMs: 3000,
          maxMemoryMb: 64, // Low ceiling to quickly trigger OOM
          correlationId: 'corr-mem-bomb',
        });
      } catch (err: any) {
        caughtError = err;
      }

      const hostHeapAfter = process.memoryUsage().heapUsed;

      assert.ok(caughtError !== null, 'Memory bomb must be terminated');
      assert.ok(caughtError instanceof ExtensionSandboxError);
      // Status will be 502 (child crashed from OOM) or 504 (timeout while struggling)
      assert.ok(
        caughtError.status === 502 || caughtError.status === 504,
        `Expected status 502 or 504, got ${caughtError.status}`
      );

      // Verify parent process heap did NOT inflate by 100+ MB!
      const heapDeltaMb = (hostHeapAfter - hostHeapBefore) / (1024 * 1024);
      assert.ok(
        heapDeltaMb < 50,
        `Host heap must not absorb child memory allocations (heap delta: ${heapDeltaMb.toFixed(2)} MB)`
      );
    });
  });

  // --------------------------------------------------------------------------
  // Challenge 5: Host Immunity against IPC Flooding & Global Pollution
  // --------------------------------------------------------------------------
  describe('Challenge 5: Host Immunity against IPC Flooding & Global Pollution', () => {
    it('EMPIRICAL: guest modifying global scope has zero impact on host process', async () => {
      const pollutionScript = path.join(tmpDir, 'global-pollution.js');
      fs.writeFileSync(
        pollutionScript,
        `module.exports = {
          execute() {
            global.MALICIOUS_POLLUTION_FLAG = 'COMPROMISED';
            process.env.POLLUTED_ENV = 'POLLUTED';
            return { ok: true };
          }
        };`
      );

      const result = await host.invoke<any>({
        extensionPath: pollutionScript,
      });

      assert.equal(result.ok, true);
      // Verify host process is pristine
      assert.equal((global as any).MALICIOUS_POLLUTION_FLAG, undefined);
      assert.equal(process.env.POLLUTED_ENV, undefined);
    });

    it('EMPIRICAL: guest IPC message spam settles once and does not crash or flood host', async () => {
      const spamScript = path.join(tmpDir, 'ipc-flood.js');
      fs.writeFileSync(
        spamScript,
        `module.exports = {
          execute() {
            // Attempt to send 500 extra messages before returning
            for (let i = 0; i < 500; i++) {
              try {
                if (process.send) {
                  process.send({ jsonrpc: '2.0', id: 'spam_' + i, result: 'spam' });
                }
              } catch (_) {}
            }
            return { legitimate: true };
          }
        };`
      );

      // Invoke should resolve cleanly without hanging or crashing host
      const res = await host.invoke<any>({
        extensionPath: spamScript,
        timeoutMs: 2000,
      });

      // Either settled with first spam response or legitimate response, both valid
      assert.ok(res !== undefined);
    });
  });
});
