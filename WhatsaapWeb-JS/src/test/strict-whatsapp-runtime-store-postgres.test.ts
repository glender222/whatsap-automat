import './fixtures/testEnv';
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import type { AgentGraphVersionV1 } from '@whatsap-automat/contracts';
import { TenantScopedUoW } from '../db/TenantScopedUoW';
import { AgentRepositoryPg } from '../modules/ai/infra/db/AgentRepositoryPg';
import { AiQuotaReservationStore, type AiQuotaSettlement } from '../services/ai/gateway/AiQuotaReservationStore';
import { boundedTextCapability } from '../services/ai/gateway/BoundedTextCompletion';
import { TenantAiDispatchPolicy } from '../services/ai/gateway/TenantAiDispatchPolicy';
import { BoundedAgentDispatch, preflightBoundedAgentDispatch } from '../services/ai/studio/BoundedAgentDispatch';
import { AgentExecutionEvaluator } from '../services/ai/studio/AgentExecutionEvaluator';
import { AgentStudioPublications } from '../services/ai/studio/AgentStudioPublications';
import { saveDraft } from '../services/ai/studio/AgentStudioDrafts';
import { MetaInboxStore } from '../services/whatsapp/meta/MetaInboxStore';
import { SecretCipher } from '../services/security/SecretCipher';
import {
  StrictWhatsappBindingConflictError, StrictWhatsappBindingError, StrictWhatsappRunConflictError,
  StrictWhatsappRuntimeStore, type StrictWhatsappRun,
} from '../services/ai/runtime/StrictWhatsappRuntimeStore';

const databaseUrl = process.env.STRICT_AGENT_RUNTIME_TEST_DATABASE_URL;

test('strict WhatsApp persistence pins published revisions and atomically retains encrypted completion output', {
  skip: !databaseUrl && 'STRICT_AGENT_RUNTIME_TEST_DATABASE_URL must select a local _smoke database',
  timeout: 30_000,
}, async (t) => {
  const connection = new URL(databaseUrl!);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(connection.hostname));
  assert.match(connection.pathname, /_smoke$/);
  const pool = new Pool({ connectionString: databaseUrl });
  t.after(() => pool.end());
  const uow = new TenantScopedUoW(pool);
  const store = new StrictWhatsappRuntimeStore(uow);
  const quota = new AiQuotaReservationStore(uow);
  const { rows: [role] } = await pool.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
  assert.deepEqual(role, { rolsuper: false, rolbypassrls: false });
  const { rows: [rls] } = await pool.query(`SELECT count(*)::integer AS tables,
    bool_and(relrowsecurity AND relforcerowsecurity) AS enforced FROM pg_class
    WHERE oid IN ('strict_whatsapp_bindings'::regclass, 'strict_whatsapp_runs'::regclass)`);
  assert.deepEqual(rls, { tables: 2, enforced: true });
  t.mock.method(globalThis, 'fetch', async () => assert.fail('Persistence tests must never contact a provider'));

  async function tenant() {
    const id = randomInt(500_000_000, 900_000_000);
    await uow.run(id, async (db) => {
      await db.query("INSERT INTO companies (id, name) VALUES ($1, 'Strict store fixture')", [id]);
      await db.query("INSERT INTO tenants (id, name, slug) VALUES ($1, 'Strict store fixture', $2)", [id, randomUUID()]);
      await db.query(`INSERT INTO tenant_ai_quotas (tenant_id, monthly_token_limit, monthly_cost_limit_micro_usd)
        VALUES ($1, 10000000, 10000000)`, [id]);
    });
    return id;
  }
  const alpha = await tenant();
  const bravo = await tenant();
  const graphId = `strict-${randomUUID()}`;

  async function revision(tenantId: number, id = graphId, create = true, prompt = 'Synthetic published prompt') {
    return uow.run(tenantId, async (db) => {
      const graph = await saveDraft(db, tenantId, 1, id, {
        entryNodeId: 'model', policyRef: 'strict-fixture',
        nodes: [
          { id: 'model', kind: 'agent', config: { provider: 'openai', model: boundedTextCapability.model, prompt, maxTokens: 40 } },
          { id: 'end', kind: 'end', config: {} },
        ],
        edges: [{ id: 'finish', from: 'model', to: 'end' }],
        limits: { maxSteps: 2, maxDelegations: 0, maxParallelNodes: 1, maxDurationSeconds: 3,
          maxModelTokens: 400_040, maxCostMicroUsd: 300_180 },
      }, create);
      assert.ok(graph);
      return graph;
    });
  }

  async function publish(tenantId: number, graph: AgentGraphVersionV1, mode: 'provider' | 'verification' = 'provider') {
    const suiteId = randomUUID();
    const runId = randomUUID();
    await uow.run(tenantId, (db) => db.query(`
      INSERT INTO agent_eval_suites (id, tenant_id, agent_graph_id, name, scenarios) VALUES ($1, $2, $3, $4, $5)
    `, [suiteId, tenantId, graph.graphId, 'Synthetic publication evidence', JSON.stringify([
      { id: 'case', name: 'Case', mockInput: 'Synthetic evaluation input', expectedTextPatterns: ['^Fixture output$'] },
    ])]));
    const dispatcher = new BoundedAgentDispatch(quota, {
      capabilityId: boundedTextCapability.id,
      complete: async () => ({ usage: { promptTokens: 12, completionTokens: 4, cachedTokens: 0 },
        output: { text: 'Fixture output', finishReason: 'stop' } }),
    }, false);
    const result = await new AgentExecutionEvaluator(uow, dispatcher, mode).evaluate({
      tenantId, graphId: graph.graphId, version: graph.version, suiteId, runId, timeoutMs: 1000,
    });
    assert.equal(result.passed, true);
    return uow.run(tenantId, (db) => new AgentStudioPublications(mode).publish(db, {
      tenantId, actorId: 1, graphId: graph.graphId, version: graph.version, evaluationId: runId,
    }));
  }

  async function bind(graph: AgentGraphVersionV1, mode: 'suggest' | 'auto' = 'suggest') {
    const current = await store.getBinding(alpha);
    return store.bind(alpha, { actorId: 1, graphId: graph.graphId, version: graph.version, specHash: graph.specHash, mode },
      current?.revision ?? null);
  }

  async function inbound(tenantId = alpha, inputText = `Synthetic inbound ${randomUUID()}`, ageSeconds = 0) {
    const providerId = `wamid.strict-store-${randomUUID()}`;
    await new MetaInboxStore({ db: pool, companyId: tenantId }).persistInboundMessage({
      message: { id: providerId, from: '12025550123', type: 'text',
        timestamp: String(Math.floor(Date.now() / 1000) - ageSeconds), text: { body: inputText } },
      metadata: { phone_number_id: '177000000000001' }, contact: null, value: {},
    });
    const { rows: [job] } = await uow.run(tenantId, (db) => db.query(`
      SELECT id, payload FROM processing_outbox WHERE tenant_id = $1 AND event_type = 'whatsapp.inbound.received'
        AND correlation_id = $2
    `, [tenantId, providerId]));
    assert.ok(job);
    return { jobId: job.id as string, messageId: job.payload.messageId as string,
      conversationId: job.payload.conversationId as string, inputText, timeoutMs: 30000 };
  }

  async function claimed(run: StrictWhatsappRun, inputText: string): Promise<AiQuotaSettlement> {
    const plan = preflightBoundedAgentDispatch({ tenantId: alpha, graph: run.graph, input: inputText, timeoutMs: run.timeoutMs });
    assert.ok(plan.ok);
    assert.equal(plan.requestHash, run.requestHash);
    await quota.reserve(alpha, { id: run.attemptId, requestHash: run.requestHash, operation: 'completion',
      provider: boundedTextCapability.provider, model: boundedTextCapability.model,
      maxCostMicroUsd: plan.maxCostMicroUsd, maxTokens: plan.maxTokens });
    const claim = await quota.claim(alpha, run.attemptId, run.requestHash);
    assert.ok(claim);
    return { id: run.attemptId, claimToken: claim.token, promptTokens: 12, completionTokens: 4,
      costMicroUsd: 27, status: 'success', isByok: false, latencyMs: 4 };
  }

  const graph = await revision(alpha);
  const command = { actorId: 1, graphId, version: graph.version, specHash: graph.specHash, mode: 'suggest' as const };

  await t.test('only exact provider publications bind and revisions prevent stale writes', async () => {
    await assert.rejects(store.bind(alpha, command, null), StrictWhatsappBindingError);
    const verification = await revision(alpha, `verify-${randomUUID()}`);
    await publish(alpha, verification, 'verification');
    await assert.rejects(store.bind(alpha, { ...command, graphId: verification.graphId, specHash: verification.specHash }, null),
      StrictWhatsappBindingError);
    await publish(alpha, graph);
    await assert.rejects(store.bind(alpha, { ...command, specHash: '0'.repeat(64) }, null), StrictWhatsappBindingError);
    await assert.rejects(store.bind(bravo, command, null), StrictWhatsappBindingError);
    const first = await store.bind(alpha, command, null);
    const writes = await Promise.allSettled([
      store.bind(alpha, { ...command, mode: 'auto' }, first.revision),
      store.bind(alpha, command, first.revision),
    ]);
    assert.equal(writes.filter(({ status }) => status === 'fulfilled').length, 1);
    assert.ok(writes.some((result) => result.status === 'rejected' && result.reason instanceof StrictWhatsappBindingConflictError));
    await assert.rejects(store.unbind(alpha, first.revision), StrictWhatsappBindingConflictError);
    assert.equal(await store.getBinding(bravo), null);
    assert.equal((await pool.query('SELECT * FROM strict_whatsapp_bindings')).rowCount, 0);
    await bind(graph);
  });

  await t.test('an unavailable execution profile cannot prevent reading and revoking its binding snapshot', async (context) => {
    const snapshot = await store.getBinding(alpha);
    assert.ok(snapshot);
    const unavailableProfile = new StrictWhatsappRuntimeStore(uow);
    context.mock.method(unavailableProfile as unknown as { loadPin: () => Promise<AgentGraphVersionV1> }, 'loadPin', async () => {
      throw new StrictWhatsappBindingError();
    });
    assert.deepEqual(await unavailableProfile.getBinding(alpha), snapshot);
    await assert.rejects(unavailableProfile.bind(alpha, command, snapshot.revision), StrictWhatsappBindingError);
    await assert.rejects(unavailableProfile.prepare(alpha, await inbound()), StrictWhatsappBindingError);
    assert.equal(await unavailableProfile.unbind(alpha, snapshot.revision), true);
    assert.equal(await unavailableProfile.getBinding(alpha), null);
    await bind(graph);
  });

  const source = await inbound();
  let prepared!: StrictWhatsappRun;
  await t.test('duplicate work keeps one attempt and its original pin after publication and binding changes', async () => {
    const runs = await Promise.all(Array.from({ length: 6 }, () => store.prepare(alpha, source)));
    assert.ok(runs[0]);
    prepared = runs[0];
    assert.equal(new Set(runs.map((run) => run?.id)).size, 1);
    assert.equal(new Set(runs.map((run) => run?.attemptId)).size, 1);
    assert.equal(prepared.timeoutMs, 3000);
    assert.ok(new Date(prepared.outputExpiresAt).getTime() <= Date.now() + 60 * 60 * 1000);
    const next = await revision(alpha, graphId, false, 'Synthetic revised prompt');
    await publish(alpha, next);
    assert.equal((await store.getBinding(alpha))?.version, 1);
    await bind(next, 'auto');
    assert.deepEqual(await store.prepare(alpha, source), prepared);
    const fresh = await store.prepare(alpha, await inbound());
    assert.equal(fresh?.binding.version, 2);
    assert.equal(fresh?.binding.mode, 'auto');
    await assert.rejects(store.prepare(alpha, { ...source, inputText: 'Different input' }), StrictWhatsappRunConflictError);
    await assert.rejects(store.prepare(alpha, { ...source, jobId: randomUUID() }), StrictWhatsappRunConflictError);
    await assert.rejects(store.prepare(alpha, { ...source, timeoutMs: 2000 }), StrictWhatsappRunConflictError);
    assert.equal(await store.getRun(bravo, prepared.id), null);
    await assert.rejects(store.prepare(bravo, source), StrictWhatsappRunConflictError);
    assert.equal((await pool.query('SELECT * FROM strict_whatsapp_runs')).rowCount, 0);
    const current = (await store.getBinding(alpha))!;
    assert.equal(await store.unbind(alpha, current.revision), true);
    assert.deepEqual(await store.prepare(alpha, source), prepared);
    assert.equal(await store.prepare(alpha, await inbound()), null);
    await bind(graph);
  });

  await t.test('settlement and encrypted output commit together, replay once, and never revive consumed output', async () => {
    const settlement = await claimed(prepared, source.inputText);
    const output = `Private synthetic answer ${randomUUID()}`;
    await assert.rejects(quota.settle(alpha, settlement, async (db, result) => {
      await store.recordCompletion(db, alpha, prepared.id, result.ledgerId, output);
      assert.equal((await store.getRun(alpha, prepared.id, db))?.output, output,
        'Existing transactions read their own checkpoint without opening a second connection');
      throw new Error('Synthetic transaction interruption');
    }), /Synthetic transaction interruption/);
    assert.equal((await store.getRun(alpha, prepared.id))?.state, 'prepared');
    const completionCount = () => uow.run(alpha, async (db) => Number((await db.query(`
      SELECT count(*) FROM ai_token_cost_ledger WHERE tenant_id = $1 AND operation = 'completion'
    `, [alpha])).rows[0].count));
    assert.equal(await completionCount(), 0);
    const hook = (db: Parameters<StrictWhatsappRuntimeStore['recordCompletion']>[0], result: { ledgerId: number }) =>
      store.recordCompletion(db, alpha, prepared.id, result.ledgerId, output);
    const settled = await quota.settle(alpha, settlement, hook);
    assert.deepEqual(await quota.settle(alpha, settlement, hook), settled);
    assert.equal(await completionCount(), 1);
    const ready = await store.getRun(alpha, prepared.id);
    assert.equal(ready?.state, 'ready');
    assert.equal(ready?.output, output);
    const { rows: [storage] } = await uow.run(alpha, (db) => db.query(`
      SELECT run.output_encrypted, row_to_json(ledger)::text AS ledger_json
      FROM strict_whatsapp_runs run JOIN ai_token_cost_ledger ledger ON ledger.id = run.ledger_id
      WHERE run.tenant_id = $1 AND run.id = $2
    `, [alpha, prepared.id]));
    assert.match(storage.output_encrypted, /^v1:/);
    assert.ok(!storage.output_encrypted.includes(output));
    assert.ok(!storage.ledger_json.includes(output));
    await assert.rejects(quota.settle(alpha, settlement, (db, result) =>
      store.recordCompletion(db, alpha, prepared.id, result.ledgerId, 'Changed answer')), StrictWhatsappRunConflictError);
    await assert.rejects(uow.run(bravo, (db) =>
      store.recordCompletion(db, bravo, prepared.id, settled.ledgerId, output)), StrictWhatsappRunConflictError);
    assert.equal(await store.finish(alpha, prepared.id, 'completed'), true);
    assert.equal(await store.finish(alpha, prepared.id, 'completed'), true);
    assert.equal(await store.finish(alpha, prepared.id, 'uncertain'), false);
    await quota.settle(alpha, settlement, hook);
    const consumed = await store.getRun(alpha, prepared.id);
    assert.equal(consumed?.state, 'completed');
    assert.equal(consumed?.output, undefined);
    const { rows: [erased] } = await uow.run(alpha, (db) => db.query(
      'SELECT output_encrypted FROM strict_whatsapp_runs WHERE tenant_id = $1 AND id = $2', [alpha, prepared.id]));
    assert.equal(erased.output_encrypted, null);
  });

  await t.test('expired output is erased on read or bounded cleanup and cannot be used beyond the inbound window', async () => {
    const source = await inbound();
    const run = (await store.prepare(alpha, source))!;
    const settlement = await claimed(run, source.inputText);
    await quota.settle(alpha, settlement, (db, result) => store.recordCompletion(db, alpha, run.id, result.ledgerId, 'Expiring output'));
    await uow.run(alpha, (db) => db.query(`UPDATE strict_whatsapp_runs SET output_expires_at = clock_timestamp() - interval '1 second'
      WHERE tenant_id = $1 AND id = $2`, [alpha, run.id]));
    assert.equal((await store.getRun(alpha, run.id))?.state, 'uncertain');
    assert.equal((await store.getRun(alpha, run.id))?.output, undefined);
    const old = await store.prepare(alpha, await inbound(alpha, 'Old inbound source', 24 * 60 * 60 + 1));
    assert.equal(old?.state, 'uncertain');
    const cleanup = (await store.prepare(alpha, await inbound()))!;
    await uow.run(alpha, (db) => db.query(`UPDATE strict_whatsapp_runs SET output_expires_at = clock_timestamp() - interval '1 second'
      WHERE tenant_id = $1 AND id = $2`, [alpha, cleanup.id]));
    assert.equal(await store.eraseExpired(alpha), 1);
    assert.equal(await store.eraseExpired(alpha), 0);
    assert.equal((await store.getRun(alpha, cleanup.id))?.state, 'uncertain');
  });

  await t.test('unreadable or mismatched encrypted checkpoints stop recovery and preserve their accounting identity', async () => {
    for (const corruption of ['ciphertext', 'key', 'hash'] as const) {
      const source = await inbound();
      const run = (await store.prepare(alpha, source))!;
      const settlement = await claimed(run, source.inputText);
      const receipt = await quota.settle(alpha, settlement, (db, result) =>
        store.recordCompletion(db, alpha, run.id, result.ledgerId, `Synthetic integrity ${corruption}`));
      if (corruption === 'ciphertext') {
        await uow.run(alpha, (db) => db.query(`UPDATE strict_whatsapp_runs SET output_encrypted = 'v1:invalid'
          WHERE tenant_id = $1 AND id = $2`, [alpha, run.id]));
      } else if (corruption === 'hash') {
        await uow.run(alpha, (db) => db.query(`UPDATE strict_whatsapp_runs SET output_hash = $3
          WHERE tenant_id = $1 AND id = $2`, [alpha, run.id, '0'.repeat(64)]));
      }
      const reader = corruption === 'key' ? new StrictWhatsappRuntimeStore(uow,
        new SecretCipher('different-synthetic-checkpoint-key-00000000')) : store;
      const failed = await reader.getRun(alpha, run.id);
      assert.equal(failed?.state, 'uncertain');
      assert.equal(failed?.output, undefined);
      assert.equal(failed?.ledgerId, receipt.ledgerId);
      const { rows: [erased] } = await uow.run(alpha, (db) => db.query(`
        SELECT state, output_encrypted, output_hash, ledger_id FROM strict_whatsapp_runs WHERE tenant_id = $1 AND id = $2
      `, [alpha, run.id]));
      assert.equal(erased.output_encrypted, null);
      assert.equal(erased.state, 'uncertain');
      assert.match(erased.output_hash, /^[a-f0-9]{64}$/);
      assert.equal(Number(erased.ledger_id), receipt.ledgerId);
    }
  });

  await t.test('assisted suggestions require completed work, live output, strict policy and the current binding revision', async () => {
    const policy = new TenantAiDispatchPolicy(uow);
    await policy.transition(alpha, 'draining');
    await policy.transition(alpha, 'strict');
    // An auto-capable binding still produces suggestions in company mixed mode.
    await bind(graph, 'auto');
    await new AgentRepositoryPg(pool).setAutomatorMode(alpha, 'mixed');
    const source = await inbound();
    await uow.run(alpha, (db) => db.query(`UPDATE conversations SET owner_type = 'ai_agent'
      WHERE company_id = $1 AND id = $2`, [alpha, source.conversationId]));
    const run = (await store.prepare(alpha, source))!;
    const settlement = await claimed(run, source.inputText);
    await quota.settle(alpha, settlement, (db, result) =>
      store.recordCompletion(db, alpha, run.id, result.ledgerId, 'Private assisted suggestion'));
    assert.equal(await store.getSuggestion(alpha, source.conversationId), null);
    const completeWork = (code: string, jobId = source.jobId) => uow.run(alpha, (db) => db.query(`
      UPDATE processing_outbox SET status = 'completed', payload = payload || jsonb_build_object('outcome', jsonb_build_object('code', $3::text))
      WHERE tenant_id = $1 AND id = $2
    `, [alpha, jobId, code]));
    await completeWork('AI_STRICT_OTHER_OUTCOME');
    assert.equal(await store.getSuggestion(alpha, source.conversationId), null);
    await completeWork('AI_STRICT_SUGGESTION_READY');
    assert.deepEqual(await store.getSuggestion(alpha, source.conversationId), {
      runId: run.id, graphId: run.binding.graphId, version: run.binding.version, specHash: run.binding.specHash,
      inboundMessageId: run.messageId, conversationId: run.conversationId, reply: 'Private assisted suggestion',
      expiresAt: run.outputExpiresAt,
    });
    assert.equal(await store.getSuggestion(bravo, source.conversationId), null);
    const conversationState = (owner: string, paused: boolean, status = 'open', archived: Date | null = null) =>
      uow.run(alpha, (db) => db.query(`UPDATE conversations SET owner_type = $3, ia_paused = $4, ia_resume_at = NULL,
        status = $5, archived_at = $6 WHERE company_id = $1 AND id = $2`,
      [alpha, source.conversationId, owner, paused, status, archived]));
    for (const [owner, paused, status, archived] of [
      ['human', false, 'open', null], ['ai_agent', true, 'open', null],
      ['ai_agent', false, 'closed', null], ['ai_agent', false, 'open', new Date()],
    ] as const) {
      await conversationState(owner, paused, status, archived);
      assert.equal(await store.getSuggestion(alpha, source.conversationId), null);
    }
    await conversationState('ai_agent', true);
    await uow.run(alpha, (db) => db.query(`UPDATE conversations SET ia_resume_at = clock_timestamp() - interval '1 second'
      WHERE company_id = $1 AND id = $2`, [alpha, source.conversationId]));
    assert.equal((await store.getSuggestion(alpha, source.conversationId))?.runId, run.id);
    await conversationState('ai_agent', false);
    await policy.transition(alpha, 'paused');
    assert.equal(await store.getSuggestion(alpha, source.conversationId), null);
    await policy.transition(alpha, 'strict');
    assert.equal((await store.getSuggestion(alpha, source.conversationId))?.runId, run.id);
    await bind(graph);
    assert.equal(await store.getSuggestion(alpha, source.conversationId), null);
    await store.finish(alpha, run.id, 'completed');
    assert.equal((await store.getRun(alpha, run.id))?.output, undefined);
    const laterSource = await inbound();
    const laterRun = (await store.prepare(alpha, laterSource))!;
    const laterSettlement = await claimed(laterRun, laterSource.inputText);
    await quota.settle(alpha, laterSettlement, (db, result) =>
      store.recordCompletion(db, alpha, laterRun.id, result.ledgerId, 'Expiring assisted suggestion'));
    await completeWork('AI_STRICT_SUGGESTION_READY', laterSource.jobId);
    assert.equal((await store.getSuggestion(alpha, laterSource.conversationId))?.runId, laterRun.id);
    const newestSource = await inbound();
    assert.equal(newestSource.conversationId, laterSource.conversationId);
    assert.equal(await store.getSuggestion(alpha, laterSource.conversationId), null,
      'A new inbound message hides the previous answer even before its own runtime starts');
    assert.equal((await store.getRun(alpha, laterRun.id))?.output, 'Expiring assisted suggestion');
    await uow.run(alpha, (db) => db.query(`UPDATE strict_whatsapp_runs SET output_expires_at = clock_timestamp() - interval '1 second'
      WHERE tenant_id = $1 AND id = $2`, [alpha, laterRun.id]));
    assert.equal(await store.getSuggestion(alpha, laterSource.conversationId), null);
    const { rows: [erased] } = await uow.run(alpha, (db) => db.query(
      'SELECT output_encrypted FROM strict_whatsapp_runs WHERE tenant_id = $1 AND id = $2', [alpha, laterRun.id]));
    assert.equal(erased.output_encrypted, null);
  });
});
