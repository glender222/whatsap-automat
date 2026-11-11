import { createHash } from 'node:crypto';
import type { Queryable } from '../../../shared/UnitOfWorkPort';
import type { TenantScopedUoW } from '../../../db/TenantScopedUoW';
import { SecretCipher } from '../../security/SecretCipher';
import { boundedTextCapability, isBoundedText } from '../gateway/BoundedTextCompletion';
import { catalogCheckpointRoundPlan, type CatalogRouterCheckpointCommand } from '../runtime/CatalogRouterCheckpointRuntime';
import { StrictCatalogSearchTool } from '../runtime/StrictCatalogSearchTool';
import { parseCatalogRoute, type CatalogRouterExecutionPlan } from './CatalogRouterExecutionProfile';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const digest = (value: unknown) => hash(JSON.stringify(value));

/** Separate namespace from provider reservation IDs; compatible with the durable runtime run UUID contract. */
export function catalogEvaluationScenarioRunId(tenantId: number, evaluationId: string, scenarioId: string) {
  const bytes = createHash('sha256').update(JSON.stringify(['catalog-evaluation-scenario-v1', tenantId, evaluationId, scenarioId])).digest();
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.subarray(0, 16).toString('hex');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

export class CatalogEvidenceIncomplete extends Error {
  readonly code = 'CATALOG_EVIDENCE_INCOMPLETE';
  constructor() { super('The catalog evaluation does not have complete authorized execution evidence'); }
}

/** Reads actual round receipts and local broker snapshots, never a model's claim about tools. */
export class CatalogEvaluationEvidence {
  constructor(private readonly uow: TenantScopedUoW, private readonly cipher = new SecretCipher()) {}

  async inspect(db: Queryable, command: CatalogRouterCheckpointCommand) {
    const { rows: [run] } = await db.query(`SELECT *, expires_at>clock_timestamp() AS live
      FROM catalog_router_runs WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [command.tenantId, command.runId]);
    if (!run || run.graph_id !== command.graphId || run.graph_version !== command.version ||
        run.spec_hash !== command.specHash || run.input_hash !== digest(command.input)) return { run: null, tokens: 0, costMicroUsd: 0, ledgerIds: [] as number[] };
    const { rows } = await db.query(`SELECT checkpoint.slot,checkpoint.ledger_id,ledger.total_tokens,ledger.cost_micro_usd
      FROM catalog_router_rounds checkpoint JOIN ai_token_cost_ledger ledger
        ON ledger.tenant_id=checkpoint.tenant_id AND ledger.id=checkpoint.ledger_id
      WHERE checkpoint.tenant_id=$1 AND checkpoint.run_id=$2 ORDER BY checkpoint.slot DESC`, [command.tenantId, command.runId]);
    return { run, tokens: rows.reduce((sum, row) => sum + Number(row.total_tokens), 0),
      costMicroUsd: rows.reduce((sum, row) => sum + Number(row.cost_micro_usd), 0), ledgerIds: rows.map((row) => Number(row.ledger_id)) };
  }

  async verify(db: Queryable, command: CatalogRouterCheckpointCommand, plan: CatalogRouterExecutionPlan) {
    const receipt = await this.inspect(db, command);
    const { run } = receipt;
    if (!run || !run.live || run.state !== 'active' || run.profile !== plan.profile ||
        run.graph_id !== command.graphId || run.graph_version !== command.version || run.spec_hash !== command.specHash ||
        run.input_hash !== digest(command.input) || Number(run.max_tokens) !== plan.maxTokens ||
        Number(run.max_cost_micro_usd) !== plan.maxCostMicroUsd || run.max_duration_seconds !== plan.limits.maxDurationSeconds ||
        Number(run.tokens_used) !== receipt.tokens || Number(run.cost_micro_usd) !== receipt.costMicroUsd ||
        receipt.tokens > plan.maxTokens || receipt.costMicroUsd > plan.maxCostMicroUsd) throw new CatalogEvidenceIncomplete();
    const tool = new StrictCatalogSearchTool(this.uow, plan);
    if (await tool.assertAuthorized(command.tenantId, db) !== run.authorization_hash) throw new CatalogEvidenceIncomplete();
    const { rows } = await db.query(`SELECT checkpoint.*, reservation.status AS reservation_status,
        reservation.operation AS reservation_operation,reservation.provider AS reservation_provider,reservation.model AS reservation_model,
        reservation.request_hash AS reservation_hash,reservation.max_tokens,reservation.max_cost_micro_usd,
        ledger.status AS ledger_status,ledger.operation,ledger.provider,ledger.model,ledger.total_tokens,
        ledger.cost_micro_usd AS ledger_cost,ledger.prompt_tokens,ledger.completion_tokens
      FROM catalog_router_rounds checkpoint
      JOIN ai_quota_reservations reservation ON reservation.tenant_id=checkpoint.tenant_id AND reservation.id=checkpoint.round_id
        AND reservation.ledger_id=checkpoint.ledger_id
      JOIN ai_token_cost_ledger ledger ON ledger.tenant_id=checkpoint.tenant_id AND ledger.id=checkpoint.ledger_id
      WHERE checkpoint.tenant_id=$1 AND checkpoint.run_id=$2 ORDER BY checkpoint.slot DESC`, [command.tenantId, command.runId]);
    if (rows.length !== 2 || new Set(rows.map((row) => row.ledger_id)).size !== 2) throw new CatalogEvidenceIncomplete();
    const router = rows.find((row) => row.slot === 'router');
    const answer = rows.find((row) => row.slot === 'answer');
    if (!router || !answer) throw new CatalogEvidenceIncomplete();
    const routerText = this.text(router.output_encrypted, router.output_hash);
    const route = parseCatalogRoute(routerText, plan.catalog.maxResults);
    if (!route) throw new CatalogEvidenceIncomplete();
    const { rows: snapshots } = await db.query(`SELECT * FROM catalog_router_tool_checkpoints
      WHERE tenant_id=$1 AND run_id=$2`, [command.tenantId, command.runId]);
    let snapshot: Record<string, unknown> | undefined;
    if (route.route === 'catalog') {
      const saved = snapshots[0];
      if (snapshots.length !== 1 || saved.authorization_hash !== run.authorization_hash ||
          saved.input_hash !== digest({ q: route.query, limit: route.limit }) ||
          saved.created_at < router.updated_at || saved.created_at > answer.updated_at ||
          saved.created_at > run.deadline_at) throw new CatalogEvidenceIncomplete();
      try { snapshot = JSON.parse(this.text(saved.output_encrypted, saved.output_hash)); }
      catch { throw new CatalogEvidenceIncomplete(); }
      if (!snapshot || snapshot.inputHash !== saved.input_hash || snapshot.authorizationHash !== run.authorization_hash) {
        throw new CatalogEvidenceIncomplete();
      }
      await tool.assertSnapshotAuthorized(command.tenantId, snapshot, db);
    } else if (snapshots.length) throw new CatalogEvidenceIncomplete();
    const answerInput = JSON.stringify({ customer: command.input, route: route.route,
      ...(snapshot ? { catalog: { items: snapshot.items } } : {}) });
    for (const [slot, row, input] of [['router', router, command.input], ['answer', answer, answerInput]] as const) {
      const expected = catalogCheckpointRoundPlan(command, plan, slot, input);
      if (row.state !== 'completed' || row.round_id !== expected.roundId || row.request_hash !== expected.requestHash ||
          row.reservation_hash !== expected.requestHash || row.reservation_status !== 'settled' || row.ledger_status !== 'success' ||
          row.operation !== 'eval' || row.reservation_operation !== 'eval' ||
          row.provider !== boundedTextCapability.provider || row.model !== boundedTextCapability.model ||
          row.reservation_provider !== row.provider || row.reservation_model !== row.model ||
          Number(row.max_tokens) !== expected.maxTokens || Number(row.max_cost_micro_usd) !== expected.maxCostMicroUsd ||
          Number(row.tokens_used) !== row.total_tokens || Number(row.cost_micro_usd) !== Number(row.ledger_cost) ||
          row.total_tokens !== row.prompt_tokens + row.completion_tokens || row.completion_tokens > plan[slot].maxTokens ||
          row.prompt_tokens > boundedTextCapability.maxPromptTokens || row.updated_at > run.deadline_at) throw new CatalogEvidenceIncomplete();
    }
    const text = this.text(answer.output_encrypted, answer.output_hash);
    return { ...receipt, text, tools: snapshot ? ['catalog.search'] : [], steps: snapshot ? 4 : 3,
      latencyMs: Math.max(0, Math.ceil(answer.updated_at.getTime() - run.created_at.getTime())),
      rounds: rows.map((row) => ({ slot: row.slot, roundId: row.round_id, requestHash: row.request_hash,
        outputHash: row.output_hash, ledgerId: Number(row.ledger_id) })),
      ...(snapshot ? { tool: { name: 'catalog.search', schemaVersion: 1, nodeId: plan.catalog.nodeId,
        invocationId: digest([router.round_id, plan.catalog.nodeId]), inputHash: snapshots[0].input_hash,
        outputHash: snapshots[0].output_hash, authorizationHash: run.authorization_hash } } : {}) };
  }

  private text(encrypted: unknown, expectedHash: unknown): string {
    if (typeof encrypted !== 'string' || typeof expectedHash !== 'string') throw new CatalogEvidenceIncomplete();
    try {
      const text = this.cipher.decrypt(encrypted);
      if (!isBoundedText(text) || hash(text) !== expectedHash) throw new CatalogEvidenceIncomplete();
      return text;
    } catch { throw new CatalogEvidenceIncomplete(); }
  }
}
