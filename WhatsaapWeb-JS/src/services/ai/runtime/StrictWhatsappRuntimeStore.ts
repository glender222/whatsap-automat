import { createHash, randomUUID } from 'node:crypto';
import type { AgentGraphVersionV1 } from '@whatsap-automat/contracts';
import { tenantScopedUoW, type TenantScopedUoW } from '../../../db/TenantScopedUoW';
import type { Queryable } from '../../../shared/UnitOfWorkPort';
import { SecretCipher } from '../../security/SecretCipher';
import { boundedTextCapability, isBoundedText } from '../gateway/BoundedTextCompletion';
import { loadDraft } from '../studio/AgentStudioDrafts';
import { preflightBoundedAgentDispatch } from '../studio/BoundedAgentDispatch';

const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const positive = (value: number) => Number.isSafeInteger(value) && value > 0;
const sourceId = (value: string) => /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n;

export interface StrictWhatsappBinding {
  revision: string;
  graphId: string;
  version: number;
  specHash: string;
  mode: 'suggest' | 'auto';
  boundBy: number;
  boundAt: string;
}

export interface StrictWhatsappRun {
  id: string;
  attemptId: string;
  jobId: string;
  messageId: string;
  conversationId: string;
  binding: StrictWhatsappBinding;
  graph: AgentGraphVersionV1;
  requestHash: string;
  inputHash: string;
  timeoutMs: number;
  state: 'prepared' | 'ready' | 'completed' | 'uncertain';
  output?: string;
  ledgerId?: number;
  outputExpiresAt: string;
}

export interface StrictWhatsappSuggestion {
  runId: string;
  graphId: string;
  version: number;
  specHash: string;
  inboundMessageId: string;
  conversationId: string;
  reply: string;
  expiresAt: string;
}

interface PrepareCommand {
  jobId: string;
  messageId: string;
  conversationId: string;
  inputText: string;
  timeoutMs: number;
}

export class StrictWhatsappBindingError extends Error {
  readonly code = 'STRICT_WHATSAPP_BINDING_INVALID';
  readonly statusCode = 409;
  constructor() { super('An exact, compatible provider publication is required for the WhatsApp binding'); }
}

export class StrictWhatsappRunConflictError extends Error {
  readonly code = 'STRICT_WHATSAPP_RUN_CONFLICT';
  readonly statusCode = 409;
  constructor() { super('The WhatsApp run does not match the bound source or completion'); }
}

export class StrictWhatsappBindingConflictError extends Error {
  readonly code = 'STRICT_WHATSAPP_BINDING_CONFLICT';
  readonly statusCode = 409;
  constructor() { super('The WhatsApp binding changed; read the current revision before editing it'); }
}

function binding(row: Record<string, any>): StrictWhatsappBinding {
  return { revision: row.binding_revision ?? row.revision, graphId: row.graph_id, version: row.graph_version, specHash: row.spec_hash,
    mode: row.binding_mode ?? row.mode, boundBy: Number(row.bound_by), boundAt: row.bound_at.toISOString() };
}

/** Stores durable identity and short-lived encrypted output; callers authorize the actor and provider dispatch. */
export class StrictWhatsappRuntimeStore {
  constructor(private readonly uow: TenantScopedUoW = tenantScopedUoW, private readonly cipher = new SecretCipher()) {}

  async bind(tenantId: number, command: Pick<StrictWhatsappBinding, 'graphId' | 'version' | 'specHash' | 'mode'> & { actorId: number },
    expectedRevision: string | null) {
    if (!positive(command.actorId) || !positive(command.version) || command.version > 2_147_483_647 ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(command.graphId) || !/^[0-9a-f]{64}$/.test(command.specHash) ||
        !['suggest', 'auto'].includes(command.mode)) throw new TypeError('Invalid WhatsApp binding');
    return this.uow.run(tenantId, async (db) => {
      await this.assertBindingRevision(db, tenantId, expectedRevision);
      await this.loadPin(db, tenantId, command);
      const { rows: [row] } = await db.query(`
        INSERT INTO strict_whatsapp_bindings (tenant_id, graph_id, graph_version, spec_hash, mode, bound_by, revision)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (tenant_id) DO UPDATE SET graph_id = EXCLUDED.graph_id, graph_version = EXCLUDED.graph_version,
          spec_hash = EXCLUDED.spec_hash, mode = EXCLUDED.mode, bound_by = EXCLUDED.bound_by, bound_at = clock_timestamp(),
          revision = EXCLUDED.revision
        RETURNING *
      `, [tenantId, command.graphId, command.version, command.specHash, command.mode, command.actorId, randomUUID()]);
      return binding(row);
    });
  }

  async getBinding(tenantId: number): Promise<StrictWhatsappBinding | null> {
    return this.uow.run(tenantId, async (db) => {
      const { rows: [row] } = await db.query('SELECT * FROM strict_whatsapp_bindings WHERE tenant_id = $1', [tenantId]);
      // Operators must still be able to inspect and revoke a pin after its execution profile becomes unavailable.
      return row ? binding(row) : null;
    });
  }

  async unbind(tenantId: number, expectedRevision: string | null): Promise<boolean> {
    return this.uow.run(tenantId, async (db) => {
      await this.assertBindingRevision(db, tenantId, expectedRevision);
      return (await db.query('DELETE FROM strict_whatsapp_bindings WHERE tenant_id = $1', [tenantId])).rowCount === 1;
    });
  }

  async prepare(tenantId: number, command: PrepareCommand): Promise<StrictWhatsappRun | null> {
    if (!uuid.test(command.jobId) || !sourceId(command.messageId) || !sourceId(command.conversationId) ||
        !isBoundedText(command.inputText) || !positive(command.timeoutMs) || command.timeoutMs > 30000) {
      throw new TypeError('Invalid WhatsApp run');
    }
    return this.uow.run(tenantId, async (db) => {
      // Lock the durable source to serialize duplicate prepares, including callers with different job IDs.
      const { rows: [source] } = await db.query(`
        SELECT m.occurred_at, m.raw_payload_json #>> '{text,body}' AS input_text,
          conversation.ownership_epoch, conversation.ia_paused_at::text AS ia_paused_at
        FROM messages m JOIN conversations conversation ON conversation.company_id = m.company_id
          AND conversation.id = m.conversation_id
        JOIN processing_outbox work ON work.tenant_id = m.company_id
          AND work.id = $4 AND work.event_type = 'whatsapp.inbound.received'
          AND work.payload->>'messageId' = m.id::text AND work.payload->>'conversationId' = m.conversation_id::text
        WHERE m.company_id = $1 AND m.id = $2 AND m.conversation_id = $3
          AND m.direction = 'inbound' AND m.provider = 'meta-cloud' AND m.channel = 'whatsapp'
          AND m.raw_payload_json->>'type' = 'text'
        FOR UPDATE OF m, work
      `, [tenantId, command.messageId, command.conversationId, command.jobId]);
      if (!source || source.input_text !== command.inputText || !source.occurred_at) throw new StrictWhatsappRunConflictError();
      const { rows: [existing] } = await db.query(`
        SELECT * FROM strict_whatsapp_runs WHERE tenant_id = $1 AND (job_id = $2 OR inbound_message_id = $3) FOR UPDATE
      `, [tenantId, command.jobId, command.messageId]);
      if (existing) {
        const run = await this.asRun(db, tenantId, existing);
        const timeoutMs = Math.min(command.timeoutMs, run.graph.limits.maxDurationSeconds * 1000, 30000);
        if (run.jobId !== command.jobId || run.messageId !== command.messageId || run.conversationId !== command.conversationId ||
            run.inputHash !== hash(command.inputText) || run.timeoutMs !== timeoutMs) throw new StrictWhatsappRunConflictError();
        return run;
      }
      const { rows: [selected] } = await db.query('SELECT * FROM strict_whatsapp_bindings WHERE tenant_id = $1 FOR SHARE', [tenantId]);
      if (!selected) return null;
      const pin = binding(selected);
      const graph = await this.loadPin(db, tenantId, pin);
      const timeoutMs = Math.min(command.timeoutMs, graph.limits.maxDurationSeconds * 1000, 30000);
      const plan = preflightBoundedAgentDispatch({ tenantId, graph, input: command.inputText, timeoutMs });
      if (!plan.ok) throw new StrictWhatsappBindingError();
      const { rows: [row] } = await db.query(`
        INSERT INTO strict_whatsapp_runs (tenant_id, id, job_id, inbound_message_id, conversation_id, attempt_id,
          graph_id, graph_version, spec_hash, binding_mode, bound_by, bound_at, input_hash, request_hash, timeout_ms,
          output_expires_at, created_at, binding_revision, ownership_epoch, ia_paused_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
          LEAST($16::timestamptz + interval '24 hours', statement_timestamp() + interval '1 hour'), statement_timestamp(), $17, $18, $19)
        RETURNING *
      `, [tenantId, randomUUID(), command.jobId, command.messageId, command.conversationId, randomUUID(),
        pin.graphId, pin.version, pin.specHash, pin.mode, pin.boundBy, pin.boundAt, hash(command.inputText),
        plan.requestHash, timeoutMs, source.occurred_at, pin.revision, source.ownership_epoch, source.ia_paused_at]);
      return this.asRun(db, tenantId, row);
    });
  }

  async getRun(tenantId: number, runId: string, client?: Queryable): Promise<StrictWhatsappRun | null> {
    if (!uuid.test(runId)) throw new TypeError('Invalid WhatsApp run ID');
    return this.uow.run(tenantId, async (db) => {
      const { rows: [row] } = await db.query('SELECT * FROM strict_whatsapp_runs WHERE tenant_id = $1 AND id = $2 FOR UPDATE',
        [tenantId, runId]);
      return row ? this.asRun(db, tenantId, row) : null;
    }, client ? { client, activeTenantId: tenantId } : undefined);
  }

  async getSuggestion(tenantId: number, conversationId: string): Promise<StrictWhatsappSuggestion | null> {
    if (!sourceId(conversationId)) throw new TypeError('Invalid WhatsApp conversation ID');
    await this.eraseExpired(tenantId);
    return this.uow.run(tenantId, async (db) => {
      const { rows: [row] } = await db.query(`
        SELECT run.* FROM strict_whatsapp_runs run
        JOIN strict_whatsapp_bindings binding ON binding.tenant_id = run.tenant_id
          AND binding.revision = run.binding_revision
        JOIN tenant_ai_dispatch_policies policy ON policy.tenant_id = run.tenant_id AND policy.mode = 'strict'
        JOIN company_settings settings ON settings.company_id = run.tenant_id AND settings.automator_mode IN ('mixed', 'automator')
        JOIN conversations conversation ON conversation.company_id = run.tenant_id AND conversation.id = run.conversation_id
          AND conversation.ownership_epoch = run.ownership_epoch
          AND conversation.ia_paused_at IS NOT DISTINCT FROM run.ia_paused_at
          AND conversation.owner_type = 'ai_agent' AND conversation.status <> 'closed' AND conversation.archived_at IS NULL
          AND NOT (conversation.ia_paused AND (conversation.ia_resume_at IS NULL OR conversation.ia_resume_at > clock_timestamp()))
        JOIN processing_outbox work ON work.tenant_id = run.tenant_id AND work.id = run.job_id
          AND work.status = 'completed' AND work.payload #>> '{outcome,code}' = 'AI_STRICT_SUGGESTION_READY'
        WHERE run.tenant_id = $1 AND run.conversation_id = $2 AND run.state = 'ready'
          AND run.output_expires_at > clock_timestamp()
          AND NOT EXISTS (
            SELECT 1 FROM messages newer WHERE newer.company_id = run.tenant_id
              AND newer.conversation_id = run.conversation_id AND newer.direction = 'inbound'
              AND newer.id > run.inbound_message_id
          )
        ORDER BY run.created_at DESC, run.id DESC LIMIT 1
        FOR UPDATE OF run FOR SHARE OF binding, policy
      `, [tenantId, conversationId]);
      if (!row) return null;
      const run = await this.asRun(db, tenantId, row);
      if (!run.output) return null;
      return { runId: run.id, graphId: run.binding.graphId, version: run.binding.version, specHash: run.binding.specHash,
        inboundMessageId: run.messageId, conversationId: run.conversationId, reply: run.output, expiresAt: run.outputExpiresAt };
    });
  }

  /** Called by quota settlement with its tenant transaction; failure rolls back output and accounting together. */
  async recordCompletion(db: Queryable, tenantId: number, runId: string, ledgerId: number, output: string): Promise<void> {
    if (!uuid.test(runId) || !positive(ledgerId) || !isBoundedText(output)) throw new TypeError('Invalid WhatsApp completion');
    const { rows: [run] } = await db.query(`
      SELECT run.*, run.output_expires_at > clock_timestamp() AS output_live
      FROM strict_whatsapp_runs run
      JOIN ai_quota_reservations reservation ON reservation.tenant_id = run.tenant_id AND reservation.id = run.attempt_id
        AND reservation.request_hash = run.request_hash AND reservation.status = 'settled' AND reservation.ledger_id = $3
      JOIN ai_token_cost_ledger ledger ON ledger.tenant_id = run.tenant_id AND ledger.id = reservation.ledger_id
        AND ledger.operation = 'completion' AND ledger.status = 'success' AND ledger.provider = $4 AND ledger.model = $5
      WHERE run.tenant_id = $1 AND run.id = $2 FOR UPDATE OF run
    `, [tenantId, runId, ledgerId, boundedTextCapability.provider, boundedTextCapability.model]);
    if (!run) throw new StrictWhatsappRunConflictError();
    const outputHash = hash(output);
    if (run.ledger_id !== null) {
      if (Number(run.ledger_id) !== ledgerId || run.output_hash !== outputHash) throw new StrictWhatsappRunConflictError();
      return;
    }
    const ready = run.state === 'prepared' && run.output_live;
    await db.query(`
      UPDATE strict_whatsapp_runs SET ledger_id = $3, output_hash = $4, output_encrypted = $5,
        state = $6, updated_at = clock_timestamp() WHERE tenant_id = $1 AND id = $2
    `, [tenantId, runId, ledgerId, outputHash, ready ? this.cipher.encrypt(output) : null,
      ready ? 'ready' : run.state === 'prepared' ? 'uncertain' : run.state]);
  }

  async finish(tenantId: number, runId: string, outcome: 'completed' | 'uncertain'): Promise<boolean> {
    if (!uuid.test(runId) || !['completed', 'uncertain'].includes(outcome)) throw new TypeError('Invalid WhatsApp outcome');
    return this.uow.run(tenantId, async (db) => (await db.query(`
      UPDATE strict_whatsapp_runs SET state = $3, output_encrypted = NULL, updated_at = clock_timestamp()
      WHERE tenant_id = $1 AND id = $2 AND state IN ('prepared', 'ready', $3)
    `, [tenantId, runId, outcome])).rowCount === 1);
  }

  /** Bounded tenant cleanup for the worker; reads also erase an expired run before returning it. */
  async eraseExpired(tenantId: number): Promise<number> {
    return this.uow.run(tenantId, async (db) => (await db.query(`
      WITH expired AS (
        SELECT id FROM strict_whatsapp_runs WHERE tenant_id = $1 AND state IN ('prepared', 'ready')
          AND output_expires_at <= clock_timestamp() ORDER BY output_expires_at, id LIMIT 100 FOR UPDATE SKIP LOCKED
      ) UPDATE strict_whatsapp_runs run SET output_encrypted = NULL, state = 'uncertain', updated_at = clock_timestamp()
        FROM expired WHERE run.tenant_id = $1 AND run.id = expired.id
    `, [tenantId])).rowCount ?? 0);
  }

  private async loadPin(db: Queryable, tenantId: number, pin: Pick<StrictWhatsappBinding, 'graphId' | 'version' | 'specHash'>) {
    const { rows } = await db.query(`
      SELECT graph_id FROM agent_studio_publications WHERE tenant_id = $1 AND graph_id = $2
        AND version = $3 AND spec_hash = $4 AND execution_mode = 'provider'
    `, [tenantId, pin.graphId, pin.version, pin.specHash]);
    const graph = rows.length ? await loadDraft(db, tenantId, pin.graphId, pin.version) : null;
    if (!graph || graph.specHash !== pin.specHash || !preflightBoundedAgentDispatch({
      tenantId, graph, input: 'WhatsApp binding validation', timeoutMs: Math.min(1000, graph.limits.maxDurationSeconds * 1000),
    }).ok) throw new StrictWhatsappBindingError();
    return { ...graph, status: 'published' as const };
  }

  private async assertBindingRevision(db: Queryable, tenantId: number, expectedRevision: string | null) {
    if (expectedRevision !== null && (typeof expectedRevision !== 'string' || !uuid.test(expectedRevision))) {
      throw new TypeError('An explicit expected WhatsApp binding revision is required');
    }
    // The lock also covers initial creation, when there is no binding row to lock.
    await db.query('SELECT pg_advisory_xact_lock(1691204, $1::integer)', [tenantId]);
    const { rows: [current] } = await db.query('SELECT revision FROM strict_whatsapp_bindings WHERE tenant_id = $1 FOR UPDATE', [tenantId]);
    if ((current?.revision ?? null) !== expectedRevision) throw new StrictWhatsappBindingConflictError();
  }

  private async asRun(db: Queryable, tenantId: number, row: Record<string, any>): Promise<StrictWhatsappRun> {
    if (['prepared', 'ready'].includes(row.state)) {
      const { rows: [expired] } = await db.query(`
        UPDATE strict_whatsapp_runs SET state = 'uncertain', output_encrypted = NULL, updated_at = clock_timestamp()
        WHERE tenant_id = $1 AND id = $2 AND output_expires_at <= clock_timestamp() RETURNING *
      `, [tenantId, row.id]);
      if (expired) row = expired;
    }
    const pin = binding(row);
    const graph = await this.loadPin(db, tenantId, pin);
    let output: string | undefined;
    if (row.state === 'ready' && row.output_encrypted) {
      try {
        const decrypted = this.cipher.decrypt(row.output_encrypted);
        if (!isBoundedText(decrypted) || hash(decrypted) !== row.output_hash) throw new Error('Invalid checkpoint');
        output = decrypted;
      } catch {
        // Unreadable or mismatched ciphertext cannot authorize a delivery retry.
        // Keep its accounting identity, but erase the unusable temporary output.
        await db.query(`UPDATE strict_whatsapp_runs SET state = 'uncertain', output_encrypted = NULL,
          updated_at = clock_timestamp() WHERE tenant_id = $1 AND id = $2 AND state = 'ready'`, [tenantId, row.id]);
        row.state = 'uncertain';
      }
    }
    return { id: row.id, attemptId: row.attempt_id, jobId: row.job_id, messageId: String(row.inbound_message_id),
      conversationId: String(row.conversation_id), binding: pin, graph, requestHash: row.request_hash, inputHash: row.input_hash,
      timeoutMs: row.timeout_ms, state: row.state, outputExpiresAt: row.output_expires_at.toISOString(),
      ...(row.ledger_id !== null ? { ledgerId: Number(row.ledger_id) } : {}),
      ...(output !== undefined ? { output } : {}) };
  }
}
