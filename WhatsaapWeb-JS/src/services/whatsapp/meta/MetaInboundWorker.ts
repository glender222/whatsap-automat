import type { Queryable } from '../../../shared/UnitOfWorkPort';
import {
  InvalidMetaInboundWorkError, MetaInboundWorkRepository,
  type MetaInboundClaim, type MetaInboundExecution, type MetaInboundOutcome,
} from './MetaInboundWorkRepository';

export type { MetaInboundExecution, MetaInboundOutcome } from './MetaInboundWorkRepository';
export interface MetaInboundAuthority {
  isCurrent(client?: Queryable): Promise<boolean>;
  signal: AbortSignal;
}

export interface MetaInboundWorkerOptions {
  repository?: MetaInboundWorkRepository;
  execute(work: MetaInboundExecution, authority: MetaInboundAuthority): Promise<MetaInboundOutcome>;
  afterCompleted?(work: MetaInboundExecution, outcome: MetaInboundOutcome): Promise<void>;
  pollIntervalMs?: number;
  leaseMs?: number;
  runtimeTimeoutMs?: number;
  maxConcurrency?: number;
  onError?: (error: unknown) => void;
}

function duration(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > 3_600_000) throw new Error('Invalid inbound worker duration');
  return result;
}

export class MetaInboundWorker {
  private readonly repository: MetaInboundWorkRepository;
  private readonly pollIntervalMs: number;
  private readonly leaseMs: number;
  private readonly runtimeTimeoutMs: number;
  private readonly maxConcurrency: number;
  private running = false;
  private stopping = false;
  private polling = false;
  private timer?: ReturnType<typeof setTimeout>;
  private activeTick?: Promise<unknown>;
  private pollDone?: Promise<void>;
  private readonly controllers = new Set<AbortController>();
  private readonly activeJobs = new Set<Promise<void>>();

  constructor(private readonly options: MetaInboundWorkerOptions) {
    this.repository = options.repository ?? new MetaInboundWorkRepository();
    this.pollIntervalMs = duration(options.pollIntervalMs, 1000);
    this.leaseMs = duration(options.leaseMs, 30_000);
    this.runtimeTimeoutMs = duration(options.runtimeTimeoutMs, 120_000);
    this.maxConcurrency = options.maxConcurrency ?? 4;
    if (!Number.isSafeInteger(this.maxConcurrency) || this.maxConcurrency < 1 || this.maxConcurrency > 32) {
      throw new Error('Inbound worker concurrency must be between 1 and 32');
    }
  }

  start(): void {
    if (this.running) return;
    this.stopping = false;
    this.running = true;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.stopping = true;
    clearTimeout(this.timer);
    await this.activeTick;
    await this.pollDone;
    for (const controller of this.controllers) controller.abort();
    await Promise.all(this.activeJobs);
  }

  private schedule(ms: number): void {
    this.timer = setTimeout(() => {
      this.activeTick = this.fillSlots().catch((error) => this.options.onError?.(error)).finally(() => {
        this.activeTick = undefined;
        if (this.running) this.schedule(this.pollIntervalMs);
      });
    }, ms);
    this.timer.unref();
  }

  async processBatch(companyId?: number): Promise<number> {
    const jobs = await this.fillSlots(companyId);
    await Promise.all(jobs);
    return jobs.length;
  }

  private async fillSlots(companyId?: number): Promise<Promise<void>[]> {
    if (this.polling || this.stopping) return [];
    this.polling = true;
    let finishPoll!: () => void;
    this.pollDone = new Promise<void>((resolve) => { finishPoll = resolve; });
    const started: Promise<void>[] = [];
    try {
      const companies = companyId === undefined ? await this.repository.getTenantIds() : [companyId];
      for (const tenant of companies) await this.repository.recoverExpired(tenant);
      let found = true;
      while (found && !this.stopping && this.activeJobs.size < this.maxConcurrency && started.length < this.maxConcurrency) {
        found = false;
        for (const tenant of companies) {
          if (this.stopping || this.activeJobs.size >= this.maxConcurrency || started.length >= this.maxConcurrency) break;
          const claim = await this.repository.claim(tenant, this.leaseMs);
          if (!claim) continue;
          found = true;
          const job = this.process(claim).catch((error) => this.options.onError?.(error)).finally(() => {
            this.activeJobs.delete(job);
          });
          this.activeJobs.add(job);
          started.push(job);
        }
      }
      return started;
    } finally {
      this.polling = false;
      finishPoll();
      this.pollDone = undefined;
    }
  }

  private async process(claim: MetaInboundClaim): Promise<void> {
    let work: MetaInboundExecution;
    try {
      work = await this.repository.load(claim);
    } catch (error) {
      await this.repository.failBeforeRuntime(claim, error instanceof InvalidMetaInboundWorkError);
      return;
    }
    if (this.stopping) return;
    if (!await this.repository.enterRuntime(claim, this.runtimeTimeoutMs)) return;
    if (this.stopping) {
      await this.repository.finish(claim, { status: 'uncertain', code: 'META_INBOUND_WORKER_STOPPED' });
      return;
    }

    const controller = new AbortController();
    this.controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), this.runtimeTimeoutMs);
    try {
      const interrupted = new Promise<MetaInboundOutcome>((resolve) => controller.signal.addEventListener('abort', () => {
        resolve({ status: 'uncertain', code: 'META_INBOUND_RUNTIME_INTERRUPTED' });
      }, { once: true }));
      const outcome = await Promise.race([
        this.options.execute(work, {
          isCurrent: (client) => this.repository.isCurrent(claim, client), signal: controller.signal,
        }),
        interrupted,
      ]);
      if (!outcome || !['completed', 'skipped', 'uncertain'].includes(outcome.status)) {
        throw new Error('Invalid inbound runtime outcome');
      }
      if (!await this.repository.finish(claim, outcome)) await this.repository.recoverExpired(claim.companyId);
      else if (outcome.status === 'completed') await this.options.afterCompleted?.(work, outcome);
    } catch {
      await this.repository.finish(claim, { status: 'uncertain' });
    } finally {
      clearTimeout(timeout);
      this.controllers.delete(controller);
    }
  }
}
