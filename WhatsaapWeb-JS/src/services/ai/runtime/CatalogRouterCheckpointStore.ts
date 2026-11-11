import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { TOOL_BROKER_BUDGET_LIMITS } from '@whatsap-automat/contracts';
import { tenantScopedUoW, type TenantScopedUoW } from '../../../db/TenantScopedUoW';
import type { Queryable } from '../../../shared/UnitOfWorkPort';
import { SecretCipher } from '../../security/SecretCipher';
import { boundedTextCapability, isBoundedText } from '../gateway/BoundedTextCompletion';
import { executionRunIdPattern } from '../studio/AgentExecutionEvidence';
import { catalogReadTimeoutMs } from '../studio/CatalogRouterExecutionProfile';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sha256 = /^[0-9a-f]{64}$/;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const positive = (value: number) => Number.isSafeInteger(value) && value > 0;

export type CatalogRouterCheckpointCode = 'CHECKPOINT_CONFLICT' | 'CHECKPOINT_EXPIRED' | 'CHECKPOINT_BUDGET' | 'CHECKPOINT_INVALID';
export class CatalogRouterCheckpointError extends Error {
  constructor(readonly code: CatalogRouterCheckpointCode) { super('The catalog checkpoint is unavailable for this operation'); }
}
export type CatalogRouterCheckpointAuthorize = (db: Queryable, expectedAuthorizationHash: string) => Promise<void>;
export type CatalogRouterRoundSlot = 'router' | 'answer';
export type CatalogRouterToolOutput = Record<string, unknown>;

export interface CatalogRouterPrepareCommand {
  operation?: 'eval' | 'completion';
  id: string;
  graphId: string;
  version: number;
  specHash: string;
  inputHash: string;
  authorizationHash: string;
  maxTokens: number;
  maxCostMicroUsd: number;
  maxDurationSeconds: number;
}
export interface CatalogRouterCheckpointRun extends CatalogRouterPrepareCommand {
  deadlineAt: string;
  expiresAt: string;
  state: 'active' | 'blocked' | 'expired';
  tokensUsed: number;
  costMicroUsd: number;
}
export interface CatalogRouterRoundIntent {
  slot: CatalogRouterRoundSlot;
  roundId: string;
  requestHash: string;
}
export interface CatalogRouterRound extends CatalogRouterRoundIntent {
  state: 'prepared' | 'completed' | 'terminal';
  output?: string;
  outputHash?: string;
  ledgerId?: number;
  tokensUsed: number;
  costMicroUsd: number;
  reservationStatus?: 'reserved' | 'claimed' | 'settled' | 'released';
  claimedAt?: string;
}
export interface CatalogRouterToolCheckpoint {
  inputHash: string;
  authorizationHash: string;
  outputHash: string;
  output: CatalogRouterToolOutput;
}
type RunRow = {
  operation: 'eval' | 'completion';
  id: string; graph_id: string; graph_version: number; spec_hash: string; input_hash: string; authorization_hash: string;
  max_tokens: string; max_cost_micro_usd: string; max_duration_seconds: number; tokens_used: string; cost_micro_usd: string;
  deadline_at: Date; expires_at: Date; state: CatalogRouterCheckpointRun['state'];
};
type RoundRow = {
  slot: CatalogRouterRoundSlot; round_id: string; request_hash: string; state: CatalogRouterRound['state'];
  output_encrypted: string | null; output_hash: string | null; ledger_id: string | null;
  tokens_used: string; cost_micro_usd: string; reservation_status?: CatalogRouterRound['reservationStatus']; claimed_at?: Date | null;
};
type ToolRow = { input_hash: string; authorization_hash: string; output_hash: string; output_encrypted: string | null };

function requireId(id: string): void {
  if (!executionRunIdPattern.test(id)) throw new CatalogRouterCheckpointError('CHECKPOINT_INVALID');
}
function requireSlot(slot: CatalogRouterRoundSlot): void {
  if (slot !== 'router' && slot !== 'answer') throw new CatalogRouterCheckpointError('CHECKPOINT_INVALID');
}
function requireIntent(command: CatalogRouterRoundIntent): void {
  requireSlot(command.slot);
  if (!uuid.test(command.roundId) || !sha256.test(command.requestHash)) throw new CatalogRouterCheckpointError('CHECKPOINT_INVALID');
}
function asRun(row: RunRow): CatalogRouterCheckpointRun {
  return {
    ...(row.operation === 'completion' ? { operation: row.operation } : {}),
    id: row.id, graphId: row.graph_id, version: row.graph_version, specHash: row.spec_hash,
    inputHash: row.input_hash, authorizationHash: row.authorization_hash, maxTokens: Number(row.max_tokens),
    maxCostMicroUsd: Number(row.max_cost_micro_usd), maxDurationSeconds: row.max_duration_seconds,
    deadlineAt: row.deadline_at.toISOString(), expiresAt: row.expires_at.toISOString(), state: row.state,
    tokensUsed: Number(row.tokens_used), costMicroUsd: Number(row.cost_micro_usd),
  };
}
function asRound(row: RoundRow): CatalogRouterRound {
  return { slot: row.slot, roundId: row.round_id, requestHash: row.request_hash, state: row.state,
    tokensUsed: Number(row.tokens_used), costMicroUsd: Number(row.cost_micro_usd),
    ...(row.output_hash === null ? {} : { outputHash: row.output_hash }),
    ...(row.ledger_id === null ? {} : { ledgerId: Number(row.ledger_id) }),
    ...(row.reservation_status ? { reservationStatus: row.reservation_status } : {}),
    ...(row.claimed_at ? { claimedAt: row.claimed_at.toISOString() } : {}),
  };
}
function serializeTool(value: CatalogRouterToolOutput): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CatalogRouterCheckpointError('CHECKPOINT_INVALID');
  try {
    const text = JSON.stringify(value, (_key, item) => {
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint' ||
          typeof item === 'number' && !Number.isFinite(item)) throw new Error('Invalid JSON value');
      return item;
    });
    const parsed: unknown = JSON.parse(text);
    if (text.length > 4096 || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid bounded JSON object');
    return text;
  } catch { throw new CatalogRouterCheckpointError('CHECKPOINT_INVALID'); }
}

/** Identity and accounting are durable. Plaintext access always requires authorization in the same transaction. */
export class CatalogRouterCheckpointStore {
  constructor(private readonly uow: TenantScopedUoW = tenantScopedUoW, private cipher?: SecretCipher) {}

  private payloadCipher(): SecretCipher {
    return this.cipher ??= new SecretCipher();
  }

  async prepare(tenantId: number, command: CatalogRouterPrepareCommand): Promise<CatalogRouterCheckpointRun> {
    requireId(command.id);
    if (!['eval','completion'].includes(command.operation ?? 'eval') || !/^[A-Za-z0-9_-]{1,128}$/.test(command.graphId) || !positive(command.version) || command.version > 2_147_483_647 ||
        ![command.specHash, command.inputHash, command.authorizationHash].every((value) => sha256.test(value)) ||
        !positive(command.maxTokens) || !positive(command.maxCostMicroUsd) ||
        !positive(command.maxDurationSeconds) || command.maxDurationSeconds > 60) throw new CatalogRouterCheckpointError('CHECKPOINT_INVALID');
    return this.transaction(tenantId, async (db) => {
      await db.query(`WITH instant AS (SELECT clock_timestamp() AS now)
        INSERT INTO catalog_router_runs (tenant_id,id,graph_id,graph_version,spec_hash,input_hash,authorization_hash,
          max_tokens,max_cost_micro_usd,max_duration_seconds,created_at,deadline_at,expires_at,operation,strict_whatsapp_run_id)
        SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::integer,now,now+$10::integer*interval '1 second',now+interval '1 hour',$11,CASE WHEN $11='completion' THEN $2::uuid ELSE NULL END FROM instant
        ON CONFLICT (tenant_id,id) DO NOTHING`, [tenantId,command.id,command.graphId,command.version,command.specHash,
        command.inputHash,command.authorizationHash,command.maxTokens,command.maxCostMicroUsd,command.maxDurationSeconds,command.operation ?? 'eval']);
      const row = await this.lockRun(db, tenantId, command.id);
      if (!row || row.operation !== (command.operation ?? 'eval') || row.graph_id !== command.graphId || row.graph_version !== command.version || row.spec_hash !== command.specHash ||
          row.input_hash !== command.inputHash || row.authorization_hash !== command.authorizationHash ||
          BigInt(row.max_tokens) !== BigInt(command.maxTokens) || BigInt(row.max_cost_micro_usd) !== BigInt(command.maxCostMicroUsd) ||
          row.max_duration_seconds !== command.maxDurationSeconds) throw new CatalogRouterCheckpointError('CHECKPOINT_CONFLICT');
      return asRun(row);
    });
  }

  async get(tenantId: number, id: string): Promise<CatalogRouterCheckpointRun | null> {
    requireId(id);
    return this.transaction(tenantId, async (db) => {
      const run = await this.lockRun(db, tenantId, id);
      return run ? asRun(run) : null;
    });
  }

  /** Preparing or inspecting an intent never returns plaintext and never resets its persisted deadline. */
  async ensureRound(tenantId: number, id: string, command: CatalogRouterRoundIntent): Promise<CatalogRouterRound> {
    requireId(id); requireIntent(command);
    return this.transaction(tenantId, async (db) => {
      const run = await this.lockRun(db, tenantId, id);
      this.requireActive(run);
      const existing = await this.loadRound(db, tenantId, id, command.slot);
      if (existing) {
        this.matchRound(existing, command);
        if (existing.state === 'prepared') {
          await this.requireDeadline(db, run);
          this.requireBudget(run);
        }
        return asRound(existing);
      }
      await this.requireDeadline(db, run);
      this.requireBudget(run);
      if (command.slot === 'answer') await this.requireRouter(db, tenantId, id);
      const duplicate = await db.query('SELECT 1 FROM catalog_router_rounds WHERE tenant_id=$1 AND round_id=$2', [tenantId, command.roundId]);
      if (duplicate.rowCount) throw new CatalogRouterCheckpointError('CHECKPOINT_CONFLICT');
      await db.query(`INSERT INTO catalog_router_rounds(tenant_id,run_id,slot,round_id,request_hash)
        VALUES($1,$2,$3,$4,$5)`, [tenantId,id,command.slot,command.roundId,command.requestHash]);
      return asRound((await this.loadRound(db, tenantId, id, command.slot))!);
    });
  }

  async getRound(tenantId: number, id: string, slot: CatalogRouterRoundSlot,
    authorize: CatalogRouterCheckpointAuthorize): Promise<CatalogRouterRound | null> {
    requireId(id); requireSlot(slot);
    return this.transaction(tenantId, async (db) => {
      const run = await this.lockRun(db, tenantId, id);
      if (!run) return null;
      if (run.state === 'active') await authorize(db, run.authorization_hash);
      await this.expireRun(db, tenantId, run);
      const round = await this.loadRound(db, tenantId, id, slot);
      if (!round) return null;
      const result = asRound(round);
      if (run.state === 'active' && round.state === 'completed' && round.output_encrypted) {
        const output = this.decrypt(round.output_encrypted, round.output_hash!);
        if (!isBoundedText(output)) throw new CatalogRouterCheckpointError('CHECKPOINT_INVALID');
        result.output = output;
      }
      return result;
    });
  }

  /** Called only by the quota settlement hook, with its transaction client; never starts a separate transaction. */
  async recordRound(db: Queryable, tenantId: number, id: string,
    command: CatalogRouterRoundIntent & { ledgerId: number; output?: string }): Promise<void> {
    requireId(id); requireIntent(command);
    if (!positive(command.ledgerId)) throw new CatalogRouterCheckpointError('CHECKPOINT_INVALID');
    const run = await this.lockRun(db, tenantId, id);
    if (!run) throw new CatalogRouterCheckpointError('CHECKPOINT_CONFLICT');
    const round = await this.loadRound(db, tenantId, id, command.slot);
    if (!round) throw new CatalogRouterCheckpointError('CHECKPOINT_CONFLICT');
    this.matchRound(round, command);
    const { rows: [ledger] } = await db.query(`
      SELECT ledger.status,ledger.total_tokens,ledger.prompt_tokens,ledger.completion_tokens,ledger.cost_micro_usd,
        reservation.max_tokens,reservation.max_cost_micro_usd
      FROM ai_quota_reservations reservation
      JOIN ai_token_cost_ledger ledger ON ledger.tenant_id=reservation.tenant_id AND ledger.id=reservation.ledger_id
      WHERE reservation.tenant_id=$1 AND reservation.id=$2 AND reservation.request_hash=$3
        AND reservation.status='settled' AND reservation.ledger_id=$4
        AND reservation.operation=$7 AND reservation.provider=$5 AND reservation.model=$6
        AND ledger.operation=$7 AND ledger.provider=$5 AND ledger.model=$6`,
    [tenantId,command.roundId,command.requestHash,command.ledgerId,boundedTextCapability.provider,boundedTextCapability.model,run.operation]);
    if (!ledger || ledger.total_tokens !== ledger.prompt_tokens + ledger.completion_tokens) {
      throw new CatalogRouterCheckpointError('CHECKPOINT_CONFLICT');
    }
    const outputHash = typeof command.output === 'string' ? hash(command.output) : null;
    if (round.ledger_id !== null) {
      if (Number(round.ledger_id) !== command.ledgerId || round.output_hash !== outputHash) {
        throw new CatalogRouterCheckpointError('CHECKPOINT_CONFLICT');
      }
      return;
    }
    const tokens = BigInt(run.tokens_used) + BigInt(ledger.total_tokens);
    const cost = BigInt(run.cost_micro_usd) + BigInt(ledger.cost_micro_usd);
    const withinBudget = tokens <= BigInt(run.max_tokens) && cost <= BigInt(run.max_cost_micro_usd) &&
      BigInt(ledger.total_tokens) <= BigInt(ledger.max_tokens) && BigInt(ledger.cost_micro_usd) <= BigInt(ledger.max_cost_micro_usd);
    const eligible = run.state === 'active' && withinBudget && ledger.status === 'success' && isBoundedText(command.output);
    const { rows: [recorded] } = await db.query(`WITH eligibility AS MATERIALIZED (
        SELECT $4::boolean AND clock_timestamp() < $10 AS completed
      ) UPDATE catalog_router_rounds round SET state=CASE WHEN eligibility.completed THEN 'completed' ELSE 'terminal' END,
        ledger_id=$5,output_hash=$6,output_encrypted=CASE WHEN eligibility.completed THEN $7 ELSE NULL END,
        tokens_used=$8,cost_micro_usd=$9,updated_at=clock_timestamp()
      FROM eligibility WHERE round.tenant_id=$1 AND round.run_id=$2 AND round.slot=$3 RETURNING round.state`,
    [tenantId,id,command.slot,eligible,command.ledgerId,outputHash,
      eligible?this.payloadCipher().encrypt(command.output!):null,ledger.total_tokens,ledger.cost_micro_usd,run.deadline_at]);
    await db.query(`UPDATE catalog_router_runs SET tokens_used=$3,cost_micro_usd=$4,updated_at=clock_timestamp()
      WHERE tenant_id=$1 AND id=$2`, [tenantId,id,tokens.toString(),cost.toString()]);
    // A late/failed/over-budget result still commits its accounting, but cannot authorize another step.
    if (recorded.state !== 'completed') await this.erasePayloads(db, tenantId, id, run.state === 'expired' ? 'expired' : 'blocked');
  }

  async withToolCheckpoint(tenantId: number, id: string, command: { inputHash: string; authorizationHash: string },
    work: (db: Queryable) => Promise<CatalogRouterToolOutput>, authorize: CatalogRouterCheckpointAuthorize): Promise<CatalogRouterToolOutput> {
    // Includes connection/lock waits: the broker timeout does not cancel an already running SELECT.
    const began = performance.now();
    requireId(id);
    if (![command.inputHash,command.authorizationHash].every((value) => sha256.test(value))) throw new CatalogRouterCheckpointError('CHECKPOINT_INVALID');
    return this.transaction(tenantId, async (db) => {
      const remaining = Math.floor(catalogReadTimeoutMs - (performance.now() - began));
      if (remaining <= 0) throw new CatalogRouterCheckpointError('CHECKPOINT_EXPIRED');
      const { rows: [timing] } = await db.query("SELECT clock_timestamp()+$1::integer*interval '1 millisecond' AS deadline", [remaining]);
      const toolDeadline: Date = timing.deadline;
      const run = await this.lockRun(db, tenantId, id);
      this.requireActive(run);
      if (run.authorization_hash !== command.authorizationHash) throw new CatalogRouterCheckpointError('CHECKPOINT_CONFLICT');
      await authorize(db, run.authorization_hash);
      await this.expireRun(db, tenantId, run);
      this.requireActive(run);
      const existing = await this.loadTool(db, tenantId, id);
      if (existing) {
        if (existing.input_hash !== command.inputHash || existing.authorization_hash !== command.authorizationHash || !existing.output_encrypted) {
          throw new CatalogRouterCheckpointError('CHECKPOINT_CONFLICT');
        }
        return this.decodeTool(existing).output;
      }
      await this.requireDeadline(db, run);
      await this.requireRouter(db, tenantId, id);
      if (BigInt(run.tokens_used) >= BigInt(TOOL_BROKER_BUDGET_LIMITS.MAX_MODEL_TOKENS_PER_RUN) ||
          BigInt(run.tokens_used) > BigInt(run.max_tokens) || BigInt(run.cost_micro_usd) > BigInt(run.max_cost_micro_usd)) {
        throw new CatalogRouterCheckpointError('CHECKPOINT_BUDGET');
      }
      const text = serializeTool(await work(db));
      await this.requireDeadline(db, run);
      const saved = await db.query(`INSERT INTO catalog_router_tool_checkpoints
        (tenant_id,run_id,input_hash,authorization_hash,output_hash,output_encrypted)
        SELECT $1,$2,$3,$4,$5,$6 FROM catalog_router_runs
        WHERE tenant_id=$1 AND id=$2 AND state='active' AND deadline_at>clock_timestamp()
          AND clock_timestamp()<$7::timestamptz RETURNING run_id`,
      [tenantId,id,command.inputHash,command.authorizationHash,hash(text),this.payloadCipher().encrypt(text),toolDeadline]);
      if (saved.rowCount !== 1) throw new CatalogRouterCheckpointError('CHECKPOINT_EXPIRED');
      return JSON.parse(text) as CatalogRouterToolOutput;
    });
  }

  async getTool(tenantId: number, id: string, authorize: CatalogRouterCheckpointAuthorize): Promise<CatalogRouterToolCheckpoint | null> {
    requireId(id);
    return this.transaction(tenantId, async (db) => {
      const run = await this.lockRun(db, tenantId, id);
      if (!run || run.state !== 'active') return null;
      await authorize(db, run.authorization_hash);
      await this.expireRun(db, tenantId, run);
      if (run.state !== 'active') return null;
      const tool = await this.loadTool(db, tenantId, id);
      if (tool && tool.authorization_hash !== run.authorization_hash) throw new CatalogRouterCheckpointError('CHECKPOINT_CONFLICT');
      return tool?.output_encrypted ? this.decodeTool(tool) : null;
    });
  }

  async invalidate(tenantId: number, id: string): Promise<void> {
    requireId(id);
    await this.transaction(tenantId, async (db) => {
      if (await this.lockRun(db, tenantId, id)) await this.erasePayloads(db, tenantId, id, 'blocked');
    });
  }

  async eraseExpired(tenantId: number): Promise<number> {
    return this.transaction(tenantId, async (db) => {
      const { rows } = await db.query(`SELECT id FROM catalog_router_runs WHERE tenant_id=$1
        AND state<>'expired' AND expires_at<=clock_timestamp() ORDER BY expires_at,id LIMIT 100 FOR UPDATE SKIP LOCKED`, [tenantId]);
      const ids = rows.map((row) => row.id);
      if (!ids.length) return 0;
      await db.query('UPDATE catalog_router_rounds SET output_encrypted=NULL WHERE tenant_id=$1 AND run_id=ANY($2::uuid[])', [tenantId,ids]);
      await db.query('UPDATE catalog_router_tool_checkpoints SET output_encrypted=NULL WHERE tenant_id=$1 AND run_id=ANY($2::uuid[])', [tenantId,ids]);
      await db.query("UPDATE catalog_router_runs SET state='expired',updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=ANY($2::uuid[])", [tenantId,ids]);
      return ids.length;
    });
  }

  private transaction<T>(tenantId: number, work: (db: Queryable) => Promise<T>): Promise<T> {
    if (!positive(tenantId) || tenantId > 2_147_483_647) throw new CatalogRouterCheckpointError('CHECKPOINT_INVALID');
    return this.uow.run(tenantId, async (db) => {
      await db.query("SET LOCAL statement_timeout='1000ms'");
      return work(db);
    }).catch((error: unknown) => {
      const code = (error as { code?: string } | null)?.code;
      if (code === '23505' || code === '23503') throw new CatalogRouterCheckpointError('CHECKPOINT_CONFLICT');
      if (code === '23514' || code === '22003' || code === '22P02') throw new CatalogRouterCheckpointError('CHECKPOINT_INVALID');
      throw error;
    });
  }

  private async lockRun(db: Queryable, tenantId: number, id: string): Promise<RunRow | null> {
    const { rows: [run] } = await db.query('SELECT * FROM catalog_router_runs WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [tenantId,id]);
    if (!run) return null;
    await this.expireRun(db, tenantId, run);
    return run;
  }
  private async expireRun(db: Queryable, tenantId: number, run: RunRow): Promise<void> {
    const { rows: [timing] } = await db.query('SELECT clock_timestamp() >= $1 AS expired', [run.expires_at]);
    if (timing.expired && run.state !== 'expired') {
      await this.erasePayloads(db, tenantId, run.id, 'expired');
      run.state = 'expired';
    }
  }
  private requireActive(run: RunRow | null): asserts run is RunRow {
    if (!run || run.state === 'blocked') throw new CatalogRouterCheckpointError('CHECKPOINT_CONFLICT');
    if (run.state === 'expired') throw new CatalogRouterCheckpointError('CHECKPOINT_EXPIRED');
  }
  private async requireDeadline(db: Queryable, run: RunRow): Promise<void> {
    const { rows: [timing] } = await db.query('SELECT clock_timestamp() < $1 AS live', [run.deadline_at]);
    if (!timing.live) throw new CatalogRouterCheckpointError('CHECKPOINT_EXPIRED');
  }
  private requireBudget(run: RunRow): void {
    if (BigInt(run.tokens_used) >= BigInt(run.max_tokens) || BigInt(run.cost_micro_usd) >= BigInt(run.max_cost_micro_usd)) {
      throw new CatalogRouterCheckpointError('CHECKPOINT_BUDGET');
    }
  }
  private async requireRouter(db: Queryable, tenantId: number, id: string): Promise<void> {
    const router = await this.loadRound(db, tenantId, id, 'router');
    if (router?.state !== 'completed' || !router.output_encrypted) throw new CatalogRouterCheckpointError('CHECKPOINT_CONFLICT');
  }
  private async loadRound(db: Queryable, tenantId: number, id: string, slot: CatalogRouterRoundSlot): Promise<RoundRow | null> {
    const { rows: [round] } = await db.query(`SELECT round.*,reservation.status AS reservation_status,reservation.claimed_at
      FROM catalog_router_rounds round LEFT JOIN ai_quota_reservations reservation
        ON reservation.tenant_id=round.tenant_id AND reservation.id=round.round_id
      WHERE round.tenant_id=$1 AND round.run_id=$2 AND round.slot=$3`, [tenantId,id,slot]);
    return round ?? null;
  }
  private matchRound(round: RoundRow, command: CatalogRouterRoundIntent): void {
    if (round.round_id !== command.roundId || round.request_hash !== command.requestHash) throw new CatalogRouterCheckpointError('CHECKPOINT_CONFLICT');
  }
  private async loadTool(db: Queryable, tenantId: number, id: string): Promise<ToolRow | null> {
    const { rows: [row] } = await db.query('SELECT * FROM catalog_router_tool_checkpoints WHERE tenant_id=$1 AND run_id=$2', [tenantId,id]);
    return row ?? null;
  }
  private decrypt(encrypted: string, expectedHash: string): string {
    try {
      const text = this.payloadCipher().decrypt(encrypted);
      if (text.length > 4096 || hash(text) !== expectedHash) throw new Error('Invalid checkpoint');
      return text;
    } catch { throw new CatalogRouterCheckpointError('CHECKPOINT_INVALID'); }
  }
  private decodeTool(row: ToolRow): CatalogRouterToolCheckpoint {
    const text = this.decrypt(row.output_encrypted!, row.output_hash);
    let output: CatalogRouterToolOutput;
    try { output = JSON.parse(text); } catch { throw new CatalogRouterCheckpointError('CHECKPOINT_INVALID'); }
    if (serializeTool(output) !== text) throw new CatalogRouterCheckpointError('CHECKPOINT_INVALID');
    return { inputHash: row.input_hash, authorizationHash: row.authorization_hash, outputHash: row.output_hash, output };
  }
  private async erasePayloads(db: Queryable, tenantId: number, id: string, state: 'blocked' | 'expired'): Promise<void> {
    await db.query('UPDATE catalog_router_rounds SET output_encrypted=NULL,updated_at=clock_timestamp() WHERE tenant_id=$1 AND run_id=$2', [tenantId,id]);
    await db.query('UPDATE catalog_router_tool_checkpoints SET output_encrypted=NULL WHERE tenant_id=$1 AND run_id=$2', [tenantId,id]);
    await db.query('UPDATE catalog_router_runs SET state=$3,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2', [tenantId,id,state]);
  }
}
