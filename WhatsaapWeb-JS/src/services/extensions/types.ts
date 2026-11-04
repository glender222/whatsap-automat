import { ProblemDetailsV1 } from '@whatsap-automat/contracts';

/**
 * JSON-RPC 2.0 Envelopes & Types for Extension IPC
 */
export type JsonRpcId = string | number;

export interface JsonRpcRequest<TParams = unknown> {
  readonly jsonrpc: '2.0';
  readonly id: JsonRpcId;
  readonly method: string;
  readonly params?: TParams;
}

export interface JsonRpcNotification<TParams = unknown> {
  readonly jsonrpc: '2.0';
  readonly method: string;
  readonly params?: TParams;
}

export interface JsonRpcSuccess<TResult = unknown> {
  readonly jsonrpc: '2.0';
  readonly id: JsonRpcId;
  readonly result: TResult;
}

export interface JsonRpcErrorObject {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface JsonRpcErrorResponse {
  readonly jsonrpc: '2.0';
  readonly id: JsonRpcId | null;
  readonly error: JsonRpcErrorObject;
}

export type JsonRpcResponse<TResult = unknown> = JsonRpcSuccess<TResult> | JsonRpcErrorResponse;
export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcSuccess
  | JsonRpcErrorResponse;

/**
 * Standard JSON-RPC Error Codes
 */
export const JsonRpcErrorCodes = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  // Custom extension sandbox codes
  EXECUTION_TIMEOUT: -32000,
  GUEST_CRASH: -32001,
  MEMORY_EXCEEDED: -32002,
  SECURITY_VIOLATION: -32003,
} as const;

/**
 * Options for executing an extension in the sandboxed child process
 */
export interface ExtensionInvokeOptions {
  readonly extensionPath: string;
  readonly method?: string;
  readonly params?: unknown;
  readonly timeoutMs?: number;    // Defaults to 5000ms
  readonly maxMemoryMb?: number;  // Defaults to 128MB
  readonly correlationId?: string;
  readonly tenantId?: string;
  readonly guestEnv?: Readonly<Record<string, string>>;
}

/**
 * Extension Execution Result Envelopes
 */
export interface ExtensionExecutionSuccess<T = unknown> {
  readonly success: true;
  readonly result: T;
  readonly durationMs: number;
}

export interface ExtensionExecutionFailure {
  readonly success: false;
  readonly error: ProblemDetailsV1;
  readonly durationMs: number;
}

export type ExtensionExecutionResult<T = unknown> =
  | ExtensionExecutionSuccess<T>
  | ExtensionExecutionFailure;

/**
 * ExtensionSandboxError: Encapsulates RFC 7807 Problem Details
 */
export class ExtensionSandboxError extends Error {
  readonly status: number;
  readonly problemDetails: ProblemDetailsV1;

  constructor(status: number, problemDetails: ProblemDetailsV1) {
    super(problemDetails.detail);
    this.name = 'ExtensionSandboxError';
    this.status = status;
    this.problemDetails = problemDetails;
    Object.setPrototypeOf(this, ExtensionSandboxError.prototype);
  }
}
