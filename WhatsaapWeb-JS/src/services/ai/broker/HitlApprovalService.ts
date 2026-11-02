import { TenantScopedUoW, tenantScopedUoW } from '../../../db/TenantScopedUoW';
import {
  ApprovalRequestV1,
  ApprovalDecisionResultV1,
} from '@whatsap-automat/contracts';
import { emitToTenant } from '../../../sockets/socketEmitter';

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
    const id = `appr_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
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
          params.expectedConversationVersion || null,
          expiresAt,
        ]
      );

      const row = res.rows[0];

      try {
        emitToTenant(params.tenantId, 'approval.created', {
          approvalId: row.id,
          toolName: row.tool_name,
          risk: row.risk,
          expiresAt: row.expires_at,
        });
      } catch {
        // Socket emission failure is non-fatal
      }

      return this.mapRowToContract(row);
    });
  }

  async listPendingApprovals(
    tenantId: number,
    options: { limit?: number; offset?: number } = {}
  ): Promise<ApprovalRequestV1[]> {
    const limit = Math.min(Math.max(1, options.limit || 50), 100);
    const offset = Math.max(0, options.offset || 0);

    return this.uow.run(tenantId, async (client) => {
      const res = await client.query(
        `SELECT * FROM approval_requests
         WHERE tenant_id = $1 AND status = 'pending' AND expires_at > NOW()
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        [tenantId, limit, offset]
      );
      return res.rows.map((r) => this.mapRowToContract(r));
    });
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

  /**
   * Atomic CAS Decision Execution
   */
  async decideApproval(params: {
    tenantId: number;
    approvalId: string;
    decision: 'approved' | 'rejected';
    expectedVersion: number;
    actorId: string;
    actorRole: string;
    reason?: string;
  }): Promise<ApprovalDecisionResultV1> {
    if (params.expectedVersion === undefined || params.expectedVersion < 1) {
      throw new Error(`Invalid expectedVersion: ${params.expectedVersion}. Version must be positive integer.`);
    }

    return this.uow.run(params.tenantId, async (client) => {
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
          `SELECT id, status, version, expires_at FROM approval_requests
           WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
          [params.approvalId, params.tenantId]
        );

        if (checkRes.rowCount === 0) {
          throw new ApprovalNotFoundError(params.approvalId, params.tenantId);
        }

        const current = checkRes.rows[0];
        if (new Date(current.expires_at).getTime() < Date.now()) {
          throw new ApprovalExpiredError(params.approvalId);
        }

        if (current.status !== 'pending') {
          throw new ApprovalAlreadyDecidedError(params.approvalId, current.status);
        }

        if (Number(current.version) !== params.expectedVersion) {
          throw new ApprovalCasConflictError(params.approvalId, params.expectedVersion, Number(current.version));
        }

        throw new Error(`Failed to update approval request ${params.approvalId}`);
      }

      const row = updateRes.rows[0];

      // Audit trail in operational_actions table if available
      try {
        await client.query(
          `INSERT INTO operational_actions (
            company_id, actor_user_id, action_type, status, description, metadata_json
          ) VALUES ($1, $2, 'approval_decision', 'completed', $3, $4::jsonb)`,
          [
            params.tenantId,
            Number(params.actorId) || 1,
            `Supervisor decided approval request: ${params.decision}`,
            JSON.stringify({
              approvalId: row.id,
              decision: params.decision,
              reason: params.reason || null,
              previousVersion: params.expectedVersion,
              newVersion: Number(row.version),
              toolName: row.tool_name,
              risk: row.risk,
              actorRole: params.actorRole,
            }),
          ]
        );
      } catch {
        // Audit log table optional in mock/lite environments
      }

      try {
        emitToTenant(params.tenantId, 'approval.decided', {
          approvalId: row.id,
          decision: row.status,
          decidedBy: row.decided_by,
          decidedAt: row.decided_at,
          newVersion: Number(row.version),
        });
      } catch {
        // Socket emission non-fatal
      }

      return {
        approvalId: row.id,
        status: row.status as any,
        decidedAt: new Date(row.decided_at).toISOString(),
        decidedBy: row.decided_by,
      };
    });
  }

  private redactSensitiveData(input: Record<string, unknown>): Record<string, unknown> {
    const sensitiveKeys = ['apiKey', 'password', 'token', 'secret', 'creditCard', 'cvv', 'auth'];
    const redacted: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(input)) {
      const lower = key.toLowerCase();
      if (sensitiveKeys.some((s) => lower.includes(s.toLowerCase()))) {
        redacted[key] = '[REDACTED]';
      } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        redacted[key] = this.redactSensitiveData(value as Record<string, unknown>);
      } else {
        redacted[key] = value;
      }
    }
    return redacted;
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
      decidedAt: row.decided_at ? new Date(row.decided_at).toISOString() : undefined,
      decidedBy: row.decided_by || undefined,
    };
  }
}
