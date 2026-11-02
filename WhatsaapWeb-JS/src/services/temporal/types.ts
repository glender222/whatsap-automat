/**
 * Types and Contracts for Temporal OSS Integration Bridge
 * Specification: Fase F4 (PR-F4-01, WAA-011, ADR-006, PROD-001)
 */

export interface TemporalConnectionOptions {
  /**
   * Address of the Temporal gRPC Frontend service (e.g., 'localhost:7233').
   */
  address?: string;

  /**
   * Optional TLS credentials configuration or boolean flag.
   */
  tls?: boolean | Record<string, unknown> | null;

  /**
   * Optional connection timeout in milliseconds.
   */
  connectTimeoutMs?: number;
}

export interface TemporalClientOptions extends TemporalConnectionOptions {
  /**
   * Target Temporal namespace (e.g., 'default' or tenant-scoped).
   */
  namespace?: string;

  /**
   * Client identity reported in Temporal history and audit logs.
   */
  identity?: string;

  /**
   * Reusable underlying connection instance.
   */
  connection?: unknown;
}

export interface WorkflowExecutionInput<TPayload = unknown> {
  tenantId: string | number;
  workflowId: string;
  revisionId?: string;
  triggerType: string;
  triggerPayload: TPayload;
  correlationId: string;
  endpointKey?: string;
}

export interface WorkflowStartOptions {
  /**
   * Unique business workflow execution identifier.
   * Format: wf_{tenantId}_{idempotencyKey}
   */
  workflowId: string;

  /**
   * Target worker task queue (e.g. 'automation-workflows-v1', 'channel-less-workflows-v1').
   */
  taskQueue: string;

  /**
   * Arguments passed to the workflow function.
   */
  args?: unknown[];

  /**
   * Optional timeouts in duration string (e.g., '1h', '30s') or milliseconds.
   */
  workflowExecutionTimeout?: string | number;
  workflowRunTimeout?: string | number;
  workflowTaskTimeout?: string | number;

  /**
   * Optional custom retry policy for workflow task execution.
   */
  retry?: {
    initialInterval?: string | number;
    backoffCoefficient?: number;
    maximumAttempts?: number;
    nonRetryableErrorTypes?: string[];
  };

  /**
   * Optional search attributes indexed in Temporal Elastic/SQL.
   */
  searchAttributes?: Record<string, unknown>;
}

export interface WorkflowHandle<TResult = unknown> {
  readonly workflowId: string;
  readonly firstExecutionRunId?: string;
  readonly signaller?: unknown;

  result(): Promise<TResult>;
  terminate(reason?: string): Promise<void>;
  signal(signalDef: unknown, ...args: unknown[]): Promise<void>;
  query<T = unknown>(queryDef: unknown, ...args: unknown[]): Promise<T>;
}

export interface ITemporalWorkflowClient {
  start<TWorkflow = unknown>(
    workflowType: string | TWorkflow,
    options: WorkflowStartOptions
  ): Promise<WorkflowHandle>;

  execute<TWorkflow = unknown, TResult = unknown>(
    workflowType: string | TWorkflow,
    options: WorkflowStartOptions
  ): Promise<TResult>;

  getHandle(workflowId: string, runId?: string): WorkflowHandle;
}

export interface ITemporalClient {
  readonly workflow: ITemporalWorkflowClient;
  readonly options?: TemporalClientOptions;
  readonly connection?: unknown;
  close?(): Promise<void>;
}

export class TemporalConnectionError extends Error {
  readonly code = 'TEMPORAL_CONNECTION_ERROR';
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'TemporalConnectionError';
  }
}

export class WorkflowExecutionAlreadyStartedError extends Error {
  readonly code = 'WORKFLOW_EXECUTION_ALREADY_STARTED';
  constructor(
    message: string,
    public readonly workflowId: string,
    public readonly runId?: string
  ) {
    super(message);
    this.name = 'WorkflowExecutionAlreadyStartedError';
  }
}
