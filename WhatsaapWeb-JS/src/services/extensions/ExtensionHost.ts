import { fork, ChildProcess } from 'node:child_process';
import path from 'node:path';
import crypto from 'node:crypto';
import { ProblemDetailsV1 } from '@whatsap-automat/contracts';
import {
  ExtensionInvokeOptions,
  ExtensionExecutionResult,
  ExtensionSandboxError,
  JsonRpcRequest,
  JsonRpcResponse,
} from './types';

export class ExtensionHost {
  private readonly defaultTimeoutMs: number = 5000;
  private readonly defaultMaxMemoryMb: number = 128;
  private readonly runnerScriptPath: string;

  constructor(runnerPath?: string) {
    this.runnerScriptPath = runnerPath || path.resolve(__dirname, 'ExtensionRunner.js');
  }

  /**
   * Invokes an extension in an isolated, memory-bounded, stripped-environment child process.
   * Throws ExtensionSandboxError with RFC 7807 ProblemDetails on timeout (504) or crash (502).
   */
  async invoke<T = unknown>(options: ExtensionInvokeOptions): Promise<T> {
    const startTime = Date.now();
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const maxMemoryMb = options.maxMemoryMb ?? this.defaultMaxMemoryMb;
    const correlationId = options.correlationId || crypto.randomUUID();
    const requestId = crypto.randomUUID();

    // Enforce memory bound: --max-old-space-size=128
    const execArgv = [`--max-old-space-size=${maxMemoryMb}`];

    // Enforce stripped environment (SEC-009):
    // Only PATH and NODE_ENV: 'production' are passed to guest.
    // Master encryption keys, database passwords, and JWT secrets are strictly withheld.
    const sanitizedEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH || '',
      NODE_ENV: 'production',
      ...(options.guestEnv || {}),
    };

    // Explicitly delete sensitive host keys in case guestEnv tried to inject them
    delete sanitizedEnv.MASTER_ENCRYPTION_KEY;
    delete sanitizedEnv.DATABASE_URL;
    delete sanitizedEnv.DATABASE_PASSWORD;
    delete sanitizedEnv.DB_PASSWORD;
    delete sanitizedEnv.JWT_SECRET;
    delete sanitizedEnv.META_ACCESS_TOKEN;
    delete sanitizedEnv.META_TOKEN_ENCRYPTION_KEY;
    delete sanitizedEnv.OPENAI_API_KEY;

    return new Promise<T>((resolve, reject) => {
      let child: ChildProcess | null = null;
      let timedOut = false;
      let settled = false;
      let timeoutTimer: NodeJS.Timeout | null = null;

      const cleanup = () => {
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
          timeoutTimer = null;
        }
        if (child && !child.killed) {
          try {
            child.kill('SIGKILL');
          } catch (_) {}
        }
      };

      try {
        child = fork(this.runnerScriptPath, [], {
          execArgv,
          env: sanitizedEnv,
          silent: true,
          stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        });
      } catch (spawnErr: any) {
        cleanup();
        const problem: ProblemDetailsV1 = {
          type: 'https://api.whatsap-automat.internal/errors/bad-gateway',
          title: 'Bad Gateway',
          status: 502,
          detail: `Failed to fork extension runner process: ${spawnErr?.message || String(spawnErr)}`,
          instance: `/extensions/execution/${correlationId}`,
          code: 'INTERNAL_ERROR' as any,
          correlationId,
          metadata: {
            extensionPath: options.extensionPath,
          },
        };
        return reject(new ExtensionSandboxError(502, problem));
      }

      // CPU/Execution timeout guard: 5000ms sending SIGKILL on runaway loops
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        if (child && !child.killed) {
          try {
            child.kill('SIGKILL');
          } catch (_) {}
        }
      }, timeoutMs);

      child.on('message', (msg: JsonRpcResponse<T>) => {
        if (settled) return;
        settled = true;
        cleanup();

        if ('error' in msg && msg.error) {
          const problem: ProblemDetailsV1 = {
            type: 'https://api.whatsap-automat.internal/errors/bad-gateway',
            title: 'Bad Gateway',
            status: 502,
            detail: msg.error.message || 'Extension returned an error',
            instance: `/extensions/execution/${correlationId}`,
            code: 'INTERNAL_ERROR' as any,
            correlationId,
            metadata: {
              code: msg.error.code,
              data: msg.error.data,
              extensionPath: options.extensionPath,
            },
          };
          return reject(new ExtensionSandboxError(502, problem));
        }

        if ('result' in msg) {
          return resolve(msg.result);
        }

        const problem: ProblemDetailsV1 = {
          type: 'https://api.whatsap-automat.internal/errors/bad-gateway',
          title: 'Bad Gateway',
          status: 502,
          detail: 'Invalid JSON-RPC response format received from extension runner',
          instance: `/extensions/execution/${correlationId}`,
          code: 'INTERNAL_ERROR' as any,
          correlationId,
        };
        return reject(new ExtensionSandboxError(502, problem));
      });

      child.on('error', (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();

        const problem: ProblemDetailsV1 = {
          type: 'https://api.whatsap-automat.internal/errors/bad-gateway',
          title: 'Bad Gateway',
          status: 502,
          detail: `Extension child process error: ${err.message}`,
          instance: `/extensions/execution/${correlationId}`,
          code: 'INTERNAL_ERROR' as any,
          correlationId,
        };
        return reject(new ExtensionSandboxError(502, problem));
      });

      child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return;
        settled = true;
        cleanup();

        // 1. Timeout detection: SIGKILL triggered by timer -> RFC 7807 504 Gateway Timeout
        if (timedOut || signal === 'SIGKILL') {
          const problem: ProblemDetailsV1 = {
            type: 'https://api.whatsap-automat.internal/errors/gateway-timeout',
            title: 'Gateway Timeout',
            status: 504,
            detail: `Extension execution exceeded timeout of ${timeoutMs}ms and was terminated via SIGKILL`,
            instance: `/extensions/timeout/${correlationId}`,
            code: 'RETRYABLE' as any,
            correlationId,
            metadata: {
              timeoutMs,
              signal: 'SIGKILL',
              extensionPath: options.extensionPath,
              durationMs: Date.now() - startTime,
            },
          };
          return reject(new ExtensionSandboxError(504, problem));
        }

        // 2. Crash resilience: Intercepts process exit / unhandled exceptions -> RFC 7807 502 Bad Gateway
        const problem: ProblemDetailsV1 = {
          type: 'https://api.whatsap-automat.internal/errors/bad-gateway',
          title: 'Bad Gateway',
          status: 502,
          detail: `Extension process crashed unexpectedly with exit code ${code !== null ? code : 'null'} (${signal || 'none'})`,
          instance: `/extensions/crash/${correlationId}`,
          code: 'UNKNOWN_DELIVERY' as any,
          correlationId,
          metadata: {
            exitCode: code,
            signal,
            extensionPath: options.extensionPath,
            durationMs: Date.now() - startTime,
          },
        };
        return reject(new ExtensionSandboxError(502, problem));
      });

      // Dispatch execution request over IPC channel
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: requestId,
        method: 'execute',
        params: {
          extensionPath: options.extensionPath,
          method: options.method || 'execute',
          params: options.params ?? {},
        },
      };

      try {
        child.send(request);
      } catch (sendErr: any) {
        if (settled) return;
        settled = true;
        cleanup();
        const problem: ProblemDetailsV1 = {
          type: 'https://api.whatsap-automat.internal/errors/bad-gateway',
          title: 'Bad Gateway',
          status: 502,
          detail: `Failed to send IPC request to extension runner: ${sendErr?.message || String(sendErr)}`,
          instance: `/extensions/execution/${correlationId}`,
          code: 'INTERNAL_ERROR' as any,
          correlationId,
        };
        return reject(new ExtensionSandboxError(502, problem));
      }
    });
  }

  /**
   * Safe execution wrapper returning unified ExtensionExecutionResult
   */
  async invokeSafe<T = unknown>(options: ExtensionInvokeOptions): Promise<ExtensionExecutionResult<T>> {
    const startTime = Date.now();
    try {
      const result = await this.invoke<T>(options);
      return {
        success: true,
        result,
        durationMs: Date.now() - startTime,
      };
    } catch (err: any) {
      if (err instanceof ExtensionSandboxError) {
        return {
          success: false,
          error: err.problemDetails,
          durationMs: Date.now() - startTime,
        };
      }
      return {
        success: false,
        error: {
          type: 'https://api.whatsap-automat.internal/errors/internal-error',
          title: 'Internal Error',
          status: 500,
          detail: err?.message || 'Unexpected failure executing extension',
          instance: `/extensions/error/${options.correlationId || 'none'}`,
          code: 'INTERNAL_ERROR' as any,
          correlationId: options.correlationId || 'none',
        },
        durationMs: Date.now() - startTime,
      };
    }
  }
}

export const extensionHost = new ExtensionHost();
