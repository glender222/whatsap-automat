import type { OrchestratorInput, OrchestratorResult } from '../../../modules/ai/application/AiRuntimeOrchestrator';
import { tenantScopedUoW, type TenantScopedUoW } from '../../../db/TenantScopedUoW';
import type { Queryable } from '../../../shared/UnitOfWorkPort';
import { AiDispatchUnavailableError } from '../gateway/TenantAiDispatchPolicy';
import { createTenantBoundedModelExecution } from '../gateway/TenantBoundedModelExecution';
import { isBoundedText, type BoundedTextResult } from '../gateway/BoundedTextCompletion';
import { BoundedAgentDispatch } from '../studio/BoundedAgentDispatch';
import { StrictWhatsappRuntimeStore, type StrictWhatsappRun } from './StrictWhatsappRuntimeStore';

/** One canonical inbound, with its explicitly bound profile. Text bindings never acquire tools implicitly. */
export class StrictWhatsappRuntime {
  private readonly execution;
  constructor(
    private readonly uow: TenantScopedUoW = tenantScopedUoW,
    private readonly store = new StrictWhatsappRuntimeStore(uow),
  ) { this.execution = createTenantBoundedModelExecution(uow); }

  async processInbound(input: OrchestratorInput): Promise<OrchestratorResult> {
    const source = input.strictSource;
    if (!source || !input.conversationId || source.messageType !== 'text' || !isBoundedText(input.message)) {
      throw new AiDispatchUnavailableError();
    }
    input.signal?.throwIfAborted();
    await this.assertAuthorized(input, undefined, false);
    let run = await this.store.prepare(input.companyId, {
      jobId: source.jobId, messageId: source.messageId, conversationId: String(input.conversationId),
      inputText: input.message, timeoutMs: 30_000,
    });
    if (!run) throw new AiDispatchUnavailableError();
    await this.assertAuthorized(input, run, false);
    if (run.state === 'completed') return this.result(run, 'none', '', 'strict_already_completed');
    if (run.state === 'prepared' && run.binding.profile === 'catalog-router-v1') {
      const { CatalogRouterCheckpointRuntime } = await import('./CatalogRouterCheckpointRuntime');
      const pinned = run;
      const guard = async (db: Queryable) => {
        await this.assertAuthorized(input,pinned,false,db);
        const { rowCount } = await db.query(`SELECT id FROM strict_whatsapp_runs WHERE tenant_id=$1 AND id=$2
          AND execution_profile='catalog-router-v1' AND state IN ('prepared','ready') AND output_expires_at>clock_timestamp()`,
        [input.companyId,pinned.id]);
        if (rowCount !== 1) throw new AiDispatchUnavailableError();
      };
      const outcome = await new CatalogRouterCheckpointRuntime(this.uow,undefined,undefined,this.execution).execute({
        tenantId:input.companyId,runId:run.id,graphId:run.binding.graphId,version:run.binding.version,
        specHash:run.binding.specHash,input:input.message,operation:'completion',signal:input.signal,
      },guard);
      if (outcome.status === 'completed') {
        await this.store.recordCatalogCompletion(input.companyId,run.id,guard);
        run = (await this.store.getRun(input.companyId,run.id))!;
      } else if (outcome.status === 'uncertain' || outcome.status === 'in_progress') {
        return this.result(run,'none','','strict_model_unconfirmed','uncertain');
      } else {
        throw new AiDispatchUnavailableError();
      }
    } else if (run.state === 'prepared') {
      const { adapter, isByok } = await this.execution.resolveTransport({ tenantId: input.companyId });
      let captured: BoundedTextResult | undefined;
      const quota = this.execution.quota;
      const dispatcher = new BoundedAgentDispatch({
        reserve: (tenant, command) => quota.reserve(tenant, command),
        claim: (tenant, id, hash) => quota.claim(tenant, id, hash),
        settle: (tenant, settlement) => quota.settle(tenant, settlement, async (db, receipt) => {
          if (settlement.status === 'success' && !receipt.overrun && captured?.output && isBoundedText(captured.output.text)) {
            await this.store.recordCompletion(db, tenant, run!.id, receipt.ledgerId, captured.output.text);
          }
        }),
      }, {
        capabilityId: adapter.capabilityId,
        complete: async (request, signal) => {
          await this.assertAuthorized(input, run!, false);
          const linked = input.signal ? AbortSignal.any([signal, input.signal]) : signal;
          linked.throwIfAborted();
          captured = await adapter.complete(request, linked);
          // WhatsApp text and reloadable suggestions have the same bounded text contract.
          if (captured.output && !isBoundedText(captured.output.text)) captured = { ...captured, output: null };
          return captured;
        },
      }, isByok);
      const outcome = await dispatcher.dispatch({ tenantId: input.companyId, attemptId: run.attemptId,
        graph: run.graph, input: input.message, timeoutMs: run.timeoutMs, operation: 'completion' });
      run = (await this.store.getRun(input.companyId, run.id))!;
      if (outcome.status !== 'completed' && run.state !== 'ready') {
        // A claimed model request cannot be retried without provider reconciliation.
        // Another owner may still settle it; do not erase that possible checkpoint here.
        return this.result(run, 'none', '', 'strict_model_unconfirmed', 'uncertain');
      }
    }
    if (run.state !== 'ready' || !run.output) return this.result(run, 'none', '', 'strict_model_unconfirmed', 'uncertain');
    const mode = await this.uow.run(input.companyId,async (db) => {
      const mode = await this.assertAuthorized(input,run,false,db);
      await this.store.verifyCatalogResult(db,input.companyId,run!);
      return mode;
    });
    const action = mode === 'automator' && run.binding.mode === 'auto' ? 'auto_reply' : 'suggest';
    return this.result(run, action, run.output, 'strict_published_agent');
  }

  /** Also used by the canonical send transaction, so a pause, unbind or mode change fences an automatic send. */
  async canDeliver(input: OrchestratorInput, runId: string, db?: Queryable): Promise<boolean> {
    const check = async (client: Queryable) => {
      const run = await this.store.getRun(input.companyId,runId,client);
      if (!run || run.state !== 'ready') return false;
      await this.assertAuthorized(input,run,true,client);
      await this.store.verifyCatalogResult(client,input.companyId,run);
      return true;
    };
    try { return db ? await check(db) : await this.uow.run(input.companyId,check); } catch { return false; }
  }

  async finish(tenantId: number, runId: string, outcome: 'completed' | 'uncertain') {
    return this.store.finish(tenantId, runId, outcome);
  }

  suggestionFor(tenantId: number, conversationId: string) {
    return this.store.getSuggestion(tenantId, conversationId);
  }

  private async assertAuthorized(input: OrchestratorInput, run: StrictWhatsappRun | undefined, automatic: boolean, client?: Queryable) {
    input.signal?.throwIfAborted();
    const check = async (db: Queryable) => {
      if (!await input.strictSource?.isCurrent(db)) throw new AiDispatchUnavailableError();
      await this.execution.policy.assertStrict(db, input.companyId);
      const { rows: [binding] } = await db.query(`SELECT revision, mode FROM strict_whatsapp_bindings
        WHERE tenant_id = $1 FOR SHARE`, [input.companyId]);
      const { rows: [settings] } = await db.query(`SELECT automator_mode FROM company_settings
        WHERE company_id = $1 FOR SHARE`, [input.companyId]);
      const { rows: [conversation] } = await db.query(`
        SELECT owner_type, status, archived_at,
          ia_paused AND (ia_resume_at IS NULL OR ia_resume_at > clock_timestamp()) AS paused
        FROM conversations conversation WHERE company_id = $1 AND id = $2
          AND ($3::uuid IS NULL OR EXISTS (
            SELECT 1 FROM strict_whatsapp_runs run
            WHERE run.tenant_id = conversation.company_id AND run.conversation_id = conversation.id
              AND run.id = $3 AND run.ownership_epoch = conversation.ownership_epoch
              AND run.ia_paused_at IS NOT DISTINCT FROM conversation.ia_paused_at
          ))
        FOR SHARE`, [input.companyId, input.conversationId, run?.id ?? null]);
      const { rows: newerWork } = await db.query(`
        SELECT later.id FROM processing_outbox source JOIN processing_outbox later
          ON later.tenant_id = source.tenant_id AND later.event_type = source.event_type
          AND later.payload->>'conversationId' = source.payload->>'conversationId'
          AND (later.created_at, later.id) > (source.created_at, source.id)
        WHERE source.tenant_id = $1 AND source.id = $2
          AND later.status IN ('processing', 'dispatched', 'completed', 'delivery_unknown') LIMIT 1
      `, [input.companyId, input.strictSource?.jobId]);
      const mode = settings?.automator_mode;
      if (!binding || (run && binding.revision !== run.binding.revision) || !['mixed', 'automator'].includes(mode) ||
          !conversation || conversation.owner_type !== 'ai_agent' || conversation.paused || conversation.archived_at ||
          conversation.status === 'closed' || newerWork.length ||
          (automatic && (mode !== 'automator' || binding.mode !== 'auto'))) {
        throw new AiDispatchUnavailableError();
      }
      return mode as 'mixed' | 'automator';
    };
    return client ? check(client) : this.uow.run(input.companyId, check);
  }

  private result(run: StrictWhatsappRun, action: OrchestratorResult['action'], reply: string, reason: string,
    strictOutcome?: 'uncertain'): OrchestratorResult {
    return { routerMissing: false, route: 'published_agent', agentId: null, action, reply,
      confidence: 1, reason, handoffTicketId: null, toolResults: [],
      rounds: run.binding.profile === 'catalog-router-v1' ? 2 : 1, strictRunId: run.id, strictOutcome };
  }
}

let instance: StrictWhatsappRuntime | undefined;
const runtime = () => instance ??= new StrictWhatsappRuntime();

// Legacy-only processes do not need to initialize encrypted strict storage.
export const strictWhatsappRuntime: Pick<StrictWhatsappRuntime, 'processInbound' | 'canDeliver' | 'finish' | 'suggestionFor'> = {
  processInbound: (input) => runtime().processInbound(input),
  canDeliver: (input, runId, db) => runtime().canDeliver(input, runId, db),
  finish: (tenantId, runId, outcome) => runtime().finish(tenantId, runId, outcome),
  suggestionFor: (tenantId, conversationId) => runtime().suggestionFor(tenantId, conversationId),
};
