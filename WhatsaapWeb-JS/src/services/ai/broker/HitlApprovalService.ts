import { createHash, randomUUID } from 'node:crypto';
import { TenantScopedUoW, tenantScopedUoW } from '../../../db/TenantScopedUoW';
import {
  ApprovalRequestV1,
  ApprovalDecisionResultV1,
} from '@whatsap-automat/contracts';
import { toPositiveInt } from '../../../middleware/jwtAuth';
import type { Queryable } from '../../../shared/UnitOfWorkPort';
import { readCurrentWorkspace } from '../../workspaces/WorkspaceQueryService';

const { comparePassword } = require('../../../utils/password') as {
  comparePassword: (password: string, hash: string) => Promise<boolean>;
};

type ApprovalDecision = {
  tenantId: number;
  approvalId: string;
  decision: 'approved' | 'rejected';
  expectedVersion: number;
  actorId: string;
  actorRole: string;
  reason?: string;
  idempotencyKey?: string;
};

const sensitiveApprovalRisks = new Set(['high', 'send', 'financial', 'destructive']);

export class ApprovalReviewError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
    this.name = 'ApprovalReviewError';
  }
}

export class ApprovalNotFoundError extends Error {
  readonly code = 'APPROVAL_NOT_FOUND';
  readonly statusCode = 404;
  constructor(id: string, tenantId: number) {
    super(`Approval request '${id}' not found in tenant ${tenantId}`);
    this.name = 'ApprovalNotFoundError';
  }
}

export class ApprovalAlreadyDecidedError extends Error {
  readonly code = 'APPROVAL_ALREADY_DECIDED';
  readonly statusCode = 409;
  constructor(id: string, currentStatus: string) {
    super(`Approval request '${id}' has already been decided with status: ${currentStatus}`);
    this.name = 'ApprovalAlreadyDecidedError';
  }
}

export class ApprovalCasConflictError extends Error {
  readonly code = 'CONCURRENCY_CONFLICT';
  readonly statusCode = 409;
  constructor(id: string, expectedVersion: number, currentVersion: number) {
    super(`Approval request '${id}' CAS conflict: expected version ${expectedVersion}, but current is ${currentVersion}`);
    this.name = 'ApprovalCasConflictError';
  }
}

export class ApprovalExpiredError extends Error {
  readonly code = 'APPROVAL_EXPIRED';
  readonly statusCode = 410;
  constructor(id: string) {
    super(`Approval request '${id}' has expired`);
    this.name = 'ApprovalExpiredError';
  }
}

export class ApprovalIdempotencyConflictError extends Error {
  constructor() {
    super('Idempotency-Key is already associated with another approval decision');
    this.name = 'ApprovalIdempotencyConflictError';
  }
}

export class HitlApprovalService {
  constructor(private readonly uow: TenantScopedUoW = tenantScopedUoW) {}

  async createApprovalRequest(params: {
    tenantId: number;
    runId: string;
    agentGraphId?: string;
    nodeId?: string;
    toolName: string;
    effectKey: string;
    proposedActionHash: string;
    risk: string;
    inputPayload: Record<string, unknown>;
    conversationId?: number;
    expectedConversationVersion?: number;
    expiresInSeconds?: number;
  }): Promise<ApprovalRequestV1> {
    const id = `appr_${randomUUID()}`;
    const expiresAt = new Date(Date.now() + (params.expiresInSeconds ?? 86400) * 1000).toISOString();

    const redacted = this.redactSensitiveData(params.inputPayload);

    return this.uow.run(params.tenantId, async (client) => {
      const res = await client.query(
        `INSERT INTO approval_requests (
          id, tenant_id, run_id, agent_graph_id, node_id, tool_name,
          effect_key, proposed_action_hash, risk, status,
          input_payload, redacted_details, conversation_id, expected_conversation_version,
          version, expires_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10, $11, $12, $13, 1, $14)
        RETURNING *`,
        [
          id,
          params.tenantId,
          params.runId,
          params.agentGraphId || null,
          params.nodeId || null,
          params.toolName,
          params.effectKey,
          params.proposedActionHash,
          params.risk,
          JSON.stringify(params.inputPayload),
          JSON.stringify(redacted),
          params.conversationId || null,
          params.expectedConversationVersion ?? null,
          expiresAt,
        ]
      );

      return this.mapRowToContract(res.rows[0]);
    });
  }

  async listPendingApprovals(
    tenantId: number,
    options: { limit?: number; offset?: number; risk?: string } = {}
  ): Promise<ApprovalRequestV1[]> {
    return this.uow.run(tenantId, (client) => this.listPendingInScope(client, tenantId, options));
  }

  async listReviewerApprovals(
    tenantId: number, actorId: string, sessionRole: string | undefined,
    options: { limit?: number; offset?: number } = {},
  ): Promise<ApprovalRequestV1[]> {
    return this.uow.run(tenantId, async (client) => {
      await this.requireReviewer(client, tenantId, actorId, sessionRole);
      return this.listPendingInScope(client, tenantId, options);
    });
  }

  private async listPendingInScope(
    client: Queryable, tenantId: number, options: { limit?: number; offset?: number; risk?: string },
  ): Promise<ApprovalRequestV1[]> {
    const limit = Math.min(Math.max(1, options.limit || 50), 100);
    const offset = Math.max(0, options.offset || 0);
    const res = await client.query(
      `SELECT * FROM approval_requests
       WHERE tenant_id = $1 AND status = 'pending' AND expires_at > NOW()
         AND ($4::text IS NULL OR risk = $4)
       ORDER BY created_at DESC, id DESC
       LIMIT $2 OFFSET $3`,
      [tenantId, limit, offset, options.risk ?? null]
    );
    return res.rows.map((r) => this.mapRowToContract(r));
  }

  async getApprovalById(tenantId: number, approvalId: string): Promise<ApprovalRequestV1 | null> {
    return this.uow.run(tenantId, async (client) => {
      const res = await client.query(
        `SELECT * FROM approval_requests
         WHERE tenant_id = $1 AND id = $2
         LIMIT 1`,
        [tenantId, approvalId]
      );
      if (res.rowCount === 0) return null;
      return this.mapRowToContract(res.rows[0]);
    });
  }

  async findApprovalByEffectKey(tenantId: number, effectKey: string): Promise<ApprovalRequestV1 | null> {
    return this.uow.run(tenantId, async (client) => {
      const res = await client.query(
        `SELECT * FROM approval_requests
         WHERE tenant_id = $1 AND effect_key = $2
         ORDER BY created_at DESC
         LIMIT 1`,
        [tenantId, effectKey]
      );
      if (res.rowCount === 0) return null;
      return this.mapRowToContract(res.rows[0]);
    });
  }

  async decideReviewerApproval(params: Omit<ApprovalDecision, 'actorRole'> & {
    sessionRole: string | undefined;
    password?: unknown;
  }): Promise<ApprovalDecisionResultV1> {
    const { password, sessionRole, ...decision } = params;
    const result = await this.uow.run(params.tenantId, async (client) => {
      const actorId = await this.requireReviewer(client, params.tenantId, params.actorId, sessionRole);
      const { rows: [approval] } = await client.query(
        'SELECT risk FROM approval_requests WHERE tenant_id = $1 AND id = $2', [params.tenantId, params.approvalId],
      );
      if (!approval) throw new ApprovalNotFoundError(params.approvalId, params.tenantId);
      const reauthenticated = sensitiveApprovalRisks.has(approval.risk);
      if (reauthenticated) {
        const failure = await this.verifyReviewerPassword(client, params.tenantId, actorId, params.reason, password);
        if (failure) return failure;
      }
      return this.decideInScope(client, { ...decision, actorId: String(actorId), actorRole: 'admin' }, reauthenticated);
    });
    // The transaction must commit rejected password attempts so another replica observes them.
    if (result instanceof ApprovalReviewError) throw result;
    return result;
  }

  private async requireReviewer(client: Queryable, tenantId: number, identity: string, sessionRole: string | undefined): Promise<number> {
    const actorId = toPositiveInt(identity);
    const workspace = actorId && await readCurrentWorkspace(client, tenantId, actorId, sessionRole, true);
    if (!actorId || !workspace || !workspace.capabilities.includes('approvals.review')) {
      throw new ApprovalReviewError(403, 'POLICY_DENIED', 'Approval access requires an active administrator membership');
    }
    return actorId;
  }

  private async verifyReviewerPassword(client: Queryable, tenantId: number, actorId: number, reason: string | undefined, password: unknown) {
    if (typeof password !== 'string' || !password || Buffer.byteLength(password) > 1024) {
      return new ApprovalReviewError(403, 'APPROVAL_REAUTH_REQUIRED', 'The current password is required for this decision');
    }
    if (!reason?.trim()) {
      return new ApprovalReviewError(422, 'VALIDATION_ERROR', 'A reason is required for this decision');
    }
    const attempt = await client.query(`
      INSERT INTO approval_reauth_attempts AS previous (tenant_id, actor_id, attempts, window_ends_at)
      VALUES ($1, $2, 1, clock_timestamp() + INTERVAL '10 minutes')
      ON CONFLICT (tenant_id, actor_id) DO UPDATE SET
        attempts = CASE WHEN previous.window_ends_at <= clock_timestamp() THEN 1 ELSE previous.attempts + 1 END,
        window_ends_at = CASE WHEN previous.window_ends_at <= clock_timestamp() THEN EXCLUDED.window_ends_at ELSE previous.window_ends_at END
      WHERE previous.window_ends_at <= clock_timestamp() OR previous.attempts < 5
      RETURNING attempts
    `, [tenantId, actorId]);
    if (!attempt.rowCount) {
      return new ApprovalReviewError(429, 'APPROVAL_REAUTH_LIMITED', 'Too many password attempts for approval decisions');
    }
    const { rows: [user] } = await client.query(
      'SELECT password_hash FROM usuarios WHERE company_id = $1 AND id = $2', [tenantId, actorId],
    );
    if (!user?.password_hash || !await comparePassword(password, user.password_hash)) {
      return new ApprovalReviewError(403, 'APPROVAL_REAUTH_INVALID', 'Could not verify the current password');
    }
    await client.query('DELETE FROM approval_reauth_attempts WHERE tenant_id = $1 AND actor_id = $2', [tenantId, actorId]);
    return null;
  }

  async decideApproval(params: ApprovalDecision): Promise<ApprovalDecisionResultV1> {
    return this.uow.run(params.tenantId, (client) => this.decideInScope(client, params));
  }

  private async decideInScope(client: Queryable, params: ApprovalDecision, reauthenticated = false): Promise<ApprovalDecisionResultV1> {
    if (params.expectedVersion === undefined || params.expectedVersion < 1) {
      throw new Error(`Invalid expectedVersion: ${params.expectedVersion}. Version must be positive integer.`);
    }

    const key = params.idempotencyKey ? `approval-decision:${params.idempotencyKey}` : null;
    const requestHash = key ? createHash('sha256').update(JSON.stringify([
      params.approvalId, params.actorId, params.decision, params.expectedVersion, params.reason ?? null,
    ])).digest('hex') : null;
    if (key) {
      const claim = await client.query(
        `INSERT INTO idempotency_ledger (tenant_id, idempotency_key, source, request_hash)
         VALUES ($1, $2, 'approval_decision', $3) ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`,
        [params.tenantId, key, requestHash]
      );
      if (!claim.rowCount) {
        const { rows: [cached] } = await client.query(
          `SELECT request_hash, response_body FROM idempotency_ledger
           WHERE tenant_id = $1 AND idempotency_key = $2 AND source = 'approval_decision'`,
          [params.tenantId, key]
        );
        if (cached?.request_hash !== requestHash || !cached.response_body) throw new ApprovalIdempotencyConflictError();
        return cached.response_body as ApprovalDecisionResultV1;
      }
    }

    // CAS Atomic Update
    const updateRes = await client.query(
      `UPDATE approval_requests
       SET status = $1,
           decided_at = NOW(),
           decided_by = $2,
           decision_reason = $3,
           version = version + 1,
           updated_at = NOW()
       WHERE id = $4 AND tenant_id = $5 AND version = $6 AND status = 'pending'
         AND expires_at > clock_timestamp()
       RETURNING *`,
      [
        params.decision,
        params.actorId,
        params.reason || null,
        params.approvalId,
        params.tenantId,
        params.expectedVersion,
      ]
    );

    if (updateRes.rowCount === 0) {
      // Disambiguate failure reasons
      const checkRes = await client.query(
        `SELECT id, status, version, expires_at <= clock_timestamp() AS expired FROM approval_requests
         WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
        [params.approvalId, params.tenantId]
      );

      if (checkRes.rowCount === 0) {
        throw new ApprovalNotFoundError(params.approvalId, params.tenantId);
      }

      const current = checkRes.rows[0];
      if (current.status !== 'pending') {
        throw new ApprovalAlreadyDecidedError(params.approvalId, current.status);
      }

      if (current.expired) {
        throw new ApprovalExpiredError(params.approvalId);
      }

      if (Number(current.version) !== params.expectedVersion) {
        throw new ApprovalCasConflictError(params.approvalId, params.expectedVersion, Number(current.version));
      }

      throw new Error(`Failed to update approval request ${params.approvalId}`);
    }

    const row = updateRes.rows[0];

    await client.query(
      `INSERT INTO operational_actions (
        company_id, actor_user_id, action_type, status, description, metadata_json
      ) VALUES ($1, $2, 'approval_decision', 'completed', $3, $4::jsonb)`,
      [
        params.tenantId,
        toPositiveInt(params.actorId),
        `Supervisor decided approval request: ${params.decision}`,
        JSON.stringify({
          approvalId: row.id,
          decision: params.decision,
          reason: params.reason || null,
          previousVersion: params.expectedVersion,
          newVersion: Number(row.version),
          toolName: row.tool_name,
          risk: row.risk,
          actorId: params.actorId,
          actorRole: params.actorRole,
          ...(reauthenticated && { reauthentication: 'current_password' }),
        }),
      ]
    );

    const result: ApprovalDecisionResultV1 = {
      approvalId: row.id,
      status: params.decision,
      decidedAt: new Date(row.decided_at).toISOString(),
      decidedBy: row.decided_by,
    };
    if (key) {
      await client.query(
        `UPDATE idempotency_ledger SET response_status = 200, response_body = $3::jsonb
         WHERE tenant_id = $1 AND idempotency_key = $2`,
        [params.tenantId, key, JSON.stringify(result)]
      );
    }
    return result;
  }

  private redactSensitiveData(input: Record<string, unknown>): Record<string, unknown> {
    const sensitiveKey = /apikey|api_key|password|token|secret|creditcard|credit_card|cvv|auth/i;
    const redactValue = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(redactValue);
      if (value !== null && typeof value === 'object') {
        return this.redactSensitiveData(value as Record<string, unknown>);
      }
      return value;
    };
    return Object.fromEntries(Object.entries(input).map(([key, value]) => [
      key, sensitiveKey.test(key) ? '[REDACTED]' : redactValue(value),
    ]));
  }

  private mapRowToContract(row: any): ApprovalRequestV1 {
    return {
      id: row.id,
      tenantId: String(row.tenant_id),
      runId: row.run_id,
      nodeId: row.node_id || '',
      effectKey: row.effect_key,
      proposedActionHash: row.proposed_action_hash,
      policyVersion: Number(row.version),
      risk: row.risk,
      status: row.status,
      expiresAt: new Date(row.expires_at).toISOString(),
      details: {
        toolName: row.tool_name,
        summary: `Approval request for tool ${row.tool_name} (Risk: ${row.risk})`,
        parametersRedacted: typeof row.redacted_details === 'string'
          ? JSON.parse(row.redacted_details)
          : row.redacted_details || {},
      },
      createdAt: new Date(row.created_at).toISOString(),
      ...(row.decided_at && { decidedAt: new Date(row.decided_at).toISOString() }),
      ...(row.decided_by && { decidedBy: row.decided_by }),
    };
  }
}
