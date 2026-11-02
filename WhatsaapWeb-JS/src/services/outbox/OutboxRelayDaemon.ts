import { OutboxRecord, OutboxRepository, outboxRepository } from './OutboxRepository';
import { getTemporalClient } from '../temporal/TemporalClientFactory';
import { ITemporalClient } from '../temporal/types';

export interface OutboxRelayDaemonOptions {
  outboxRepo?: OutboxRepository;
  temporalClientProvider?: () => Promise<ITemporalClient>;
  pollIntervalMs?: number;
  batchSize?: number;
  tenantIds?: number[];
  defaultTaskQueue?: string;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  onError?: (err: unknown) => void;
}

export interface DaemonMetrics {
  isRunning: boolean;
  totalProcessed: number;
  totalDispatched: number;
  totalDeliveryUnknown: number;
  totalDeadLetter: number;
  lastError: string | null;
  lastPollTimestamp: Date | null;
}

function isAlreadyStartedError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const anyErr = err as any;
  if (
    anyErr.code === 'WORKFLOW_EXECUTION_ALREADY_STARTED' ||
    anyErr.code === 'ALREADY_EXISTS' ||
    anyErr.name === 'WorkflowExecutionAlreadyStartedError'
  ) {
    return true;
  }
  const message = String(anyErr.message || '').toLowerCase();
  return (
    message.includes('already started') ||
    message.includes('already exists') ||
    message.includes('workflow execution already started')
  );
}

function isPermanentError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const anyErr = err as any;
  if (anyErr.code === 'INVALID_ARGUMENT' || anyErr.code === 'PERMANENT_ERROR') {
    return true;
  }
  const message = String(anyErr.message || '').toLowerCase();
  return (
    message.includes('invalid argument') ||
    message.includes('non-deterministic') ||
    message.includes('permanent')
  );
}

export class OutboxRelayDaemon {
  private isRunning = false;
  private isProcessing = false;
  private timer: NodeJS.Timeout | null = null;

  private readonly outboxRepo: OutboxRepository;
  private readonly temporalClientPromise: () => Promise<ITemporalClient>;
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private tenantIds: number[];
  private readonly defaultTaskQueue: string;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly onError?: (err: unknown) => void;

  private metrics: DaemonMetrics = {
    isRunning: false,
    totalProcessed: 0,
    totalDispatched: 0,
    totalDeliveryUnknown: 0,
    totalDeadLetter: 0,
    lastError: null,
    lastPollTimestamp: null,
  };

  constructor(
    outboxRepoOrOptions?: OutboxRepository | OutboxRelayDaemonOptions,
    temporalClientPromise?: () => Promise<ITemporalClient>,
    pollIntervalMs = 500,
    batchSize = 10
  ) {
    if (outboxRepoOrOptions && typeof outboxRepoOrOptions === 'object' && !('enqueue' in outboxRepoOrOptions)) {
      const opts = outboxRepoOrOptions as OutboxRelayDaemonOptions;
      this.outboxRepo = opts.outboxRepo || outboxRepository;
      this.temporalClientPromise = opts.temporalClientProvider || getTemporalClient;
      this.pollIntervalMs = opts.pollIntervalMs ?? 500;
      this.batchSize = opts.batchSize ?? 10;
      this.tenantIds = opts.tenantIds ? [...opts.tenantIds] : [1];
      this.defaultTaskQueue = opts.defaultTaskQueue || 'automation-workflows-v1';
      this.baseBackoffMs = opts.baseBackoffMs ?? 1000;
      this.maxBackoffMs = opts.maxBackoffMs ?? 60_000;
      this.onError = opts.onError;
    } else {
      this.outboxRepo = (outboxRepoOrOptions as OutboxRepository) || outboxRepository;
      this.temporalClientPromise = temporalClientPromise || getTemporalClient;
      this.pollIntervalMs = pollIntervalMs;
      this.batchSize = batchSize;
      this.tenantIds = [1];
      this.defaultTaskQueue = 'automation-workflows-v1';
      this.baseBackoffMs = 1000;
      this.maxBackoffMs = 60_000;
    }
  }

  setTenantIds(tenantIds: number[]): void {
    this.tenantIds = [...tenantIds];
  }

  getMetrics(): Readonly<DaemonMetrics> {
    return { ...this.metrics, isRunning: this.isRunning };
  }

  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    this.metrics.isRunning = true;
    this.scheduleNextTick(0);
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    this.metrics.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    // Await current processing turn if active
    let waitCount = 0;
    while (this.isProcessing && waitCount < 50) {
      await new Promise((r) => setTimeout(r, 100));
      waitCount++;
    }
  }

  private scheduleNextTick(delayMs: number): void {
    if (!this.isRunning) return;
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.tick().catch((err) => {
        this.metrics.lastError = err?.message || String(err);
        if (this.onError) this.onError(err);
      });
    }, delayMs);
  }

  private async tick(): Promise<void> {
    if (!this.isRunning) return;
    this.isProcessing = true;
    try {
      this.metrics.lastPollTimestamp = new Date();
      await this.processBatch();
    } catch (err: any) {
      this.metrics.lastError = err?.message || String(err);
      if (this.onError) this.onError(err);
    } finally {
      this.isProcessing = false;
      if (this.isRunning) {
        this.scheduleNextTick(this.pollIntervalMs);
      }
    }
  }

  /**
   * Processes a batch of claimable outbox records.
   * If tenantId is specified, processes for that tenant only.
   * Otherwise processes for all configured tenantIds.
   */
  async processBatch(specificTenantId?: number): Promise<number> {
    const tenantsToPoll = specificTenantId !== undefined ? [specificTenantId] : this.tenantIds;
    let totalClaimedAndProcessed = 0;

    for (const tenantId of tenantsToPoll) {
      // 1. Claim records using FOR UPDATE SKIP LOCKED
      const claimedRecords = await this.outboxRepo.claimPending(tenantId, this.batchSize);
      if (!claimedRecords || claimedRecords.length === 0) {
        continue;
      }

      totalClaimedAndProcessed += claimedRecords.length;
      this.metrics.totalProcessed += claimedRecords.length;

      // 2. Dispatch each claimed record
      for (const record of claimedRecords) {
        await this.dispatchRecord(tenantId, record);
      }
    }

    return totalClaimedAndProcessed;
  }

  /**
   * Dispatches a single outbox record to Temporal with idempotent handling and ADR-007 delivery_unknown semantics.
   */
  async dispatchRecord(
    tenantId: number,
    record: OutboxRecord
  ): Promise<'dispatched' | 'delivery_unknown' | 'dead_letter'> {
    const idempotencyKey = record.idempotency_key || record.idempotencyKey || record.id;
    const workflowId = `wf_${tenantId}_${idempotencyKey}`;
    const payload = (record.payload as Record<string, unknown>) || {};
    const taskQueue = (payload.taskQueue as string) || this.defaultTaskQueue;
    const workflowType = (payload.workflowType as string) || record.event_type || 'DurableAutomationWorkflow';

    try {
      const client = await this.temporalClientPromise();

      // Trigger workflow execution idempotently
      await client.workflow.start(workflowType, {
        workflowId,
        taskQueue,
        args: [
          {
            tenantId,
            workflowId,
            correlationId: record.correlation_id || record.correlationId,
            eventPayload: payload,
            eventType: record.event_type || record.eventType,
            eventId: record.event_id || record.eventId,
          },
        ],
      });

      // Mark outbox dispatched on successful initiation
      await this.outboxRepo.markDispatched(tenantId, record.id);
      this.metrics.totalDispatched++;
      return 'dispatched';
    } catch (err: any) {
      // 1. Check for idempotent deduplication: workflow already exists in Temporal
      if (isAlreadyStartedError(err)) {
        await this.outboxRepo.markDispatched(tenantId, record.id);
        this.metrics.totalDispatched++;
        return 'dispatched';
      }

      const retryCount = Number(record.retry_count ?? record.retryCount ?? 0) + 1;
      const maxRetries = Number(record.max_retries ?? record.maxRetries ?? 5);
      const isPermanent = isPermanentError(err);

      // 2. Max retries exceeded or permanent failure -> Dead Letter
      if (retryCount >= maxRetries || isPermanent) {
        const errorMsg = `Permanent dispatch failure or max retries exceeded: ${err.message}`;
        await this.outboxRepo.markDeadLetter(tenantId, record.id, errorMsg);
        this.metrics.totalDeadLetter++;
        this.metrics.lastError = errorMsg;
        return 'dead_letter';
      }

      // 3. Transient failure -> ADR-007 delivery_unknown with exponential backoff
      const delayMs = Math.min(this.maxBackoffMs, this.baseBackoffMs * Math.pow(2, retryCount - 1));
      const nextRetryAt = new Date(Date.now() + delayMs);
      const transientErrorMsg = `Temporal dispatch failed (attempt ${retryCount}/${maxRetries}): ${err.message}`;

      await this.outboxRepo.markStatus(tenantId, record.id, 'delivery_unknown', {
        error: transientErrorMsg,
        nextRetryAt,
        incrementRetry: true,
      });

      this.metrics.totalDeliveryUnknown++;
      this.metrics.lastError = transientErrorMsg;
      return 'delivery_unknown';
    }
  }
}
