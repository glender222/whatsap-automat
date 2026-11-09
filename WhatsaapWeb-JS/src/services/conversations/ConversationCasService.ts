import type { ConversationV1 } from '@whatsap-automat/contracts';
import { readConversation } from './ConversationQueryService';
import { Queryable } from '../../shared/UnitOfWorkPort';
import { TenantScopedUoW, tenantScopedUoW } from '../../db/TenantScopedUoW';
import { toPositiveInt } from '../../middleware/jwtAuth';
import { emitToTenant, emitConversation } from '../../sockets/socketEmitter';

export interface TakeoverResult {
  success: boolean;
  conversationId: string;
  previousVersion: number;
  newVersion: number;
  epoch: number;
  ownerType: 'human' | 'ai_agent';
  ownerId: string | null;
  aiPaused: boolean;
  conversation?: ConversationV1;
}

export interface TakeoverConversationParams {
  tenantId: string | number;
  conversationId: string | number;
  expectedVersion: number;
  userId: string | number;
  reason?: string;
  client?: Queryable;
  includeConversation?: boolean;
}

export interface PauseAiParams {
  tenantId: string | number;
  conversationId: string | number;
  expectedVersion: number;
  userId: string | number;
  durationSeconds?: number;
  reason?: string;
  client?: Queryable;
  includeConversation?: boolean;
}

export interface ResumeAiParams {
  tenantId: string | number;
  conversationId: string | number;
  expectedVersion: number;
  userId: string | number;
  reason?: string;
  client?: Queryable;
  includeConversation?: boolean;
}

export interface ValidateEpochParams {
  tenantId: string | number;
  conversationId: string | number;
  expectedEpoch: number;
  client?: Queryable;
}

export interface ConversationStateResult {
  id: string;
  version: number;
  ownershipEpoch: number;
  ownerType: 'human' | 'ai_agent';
  ownerId: string | null;
  aiPaused: boolean;
}

export class ConversationNotFoundError extends Error {
  readonly code = 'NOT_FOUND';
  readonly statusCode = 404;
  readonly status = 404;

  constructor(
    public readonly conversationId: string | number,
    public readonly tenantId: string | number
  ) {
    super(`Conversation ${conversationId} not found in tenant ${tenantId}`);
    this.name = 'ConversationNotFoundError';
  }
}

export class CasConflictError extends Error {
  readonly code = 'CONFLICT';
  readonly statusCode = 409;
  readonly status = 409;

  constructor(
    public readonly conversationId: string | number,
    public readonly expectedVersion: number,
    public readonly currentVersion: number,
    public readonly currentEpoch?: number,
    public readonly ownerType?: string,
    public readonly ownerId?: string | null
  ) {
    super(
      `Conversation ${conversationId} version conflict: expected version ${expectedVersion}, but current version is ${currentVersion}`
    );
    this.name = 'CasConflictError';
  }
}

// Alias for semantic flexibility
export const ConversationConflictError = CasConflictError;
export type ConversationConflictError = CasConflictError;

export class ConversationCasService {
  constructor(private readonly uow: TenantScopedUoW = tenantScopedUoW) {}

  /**
   * Performs an atomic Compare-And-Swap takeover of a conversation.
   * Increments version (v -> v + 1) and ownership_epoch (e -> e + 1).
   * Sets owner_type = 'human', owner_id = userId, and ia_paused = true.
   * Emits conversation.ownership_changed real-time notification post-commit.
   */
  async takeoverConversation(params: TakeoverConversationParams): Promise<TakeoverResult> {
    const validTenantId = toPositiveInt(params.tenantId);
    if (!validTenantId) {
      throw new Error(`[ConversationCasService] Invalid tenantId: ${params.tenantId}`);
    }

    const convId = toPositiveInt(params.conversationId);
    if (!convId) {
      throw new Error(`[ConversationCasService] Invalid conversationId: ${params.conversationId}`);
    }

    const userIdNum = toPositiveInt(params.userId);
    if (!userIdNum) {
      throw new Error(`[ConversationCasService] Invalid userId: ${params.userId}`);
    }

    if (params.expectedVersion === undefined || params.expectedVersion === null || params.expectedVersion < 0) {
      throw new Error(`[ConversationCasService] Invalid expectedVersion: ${params.expectedVersion}`);
    }

    const runOptions = params.client
      ? { client: params.client, activeTenantId: validTenantId }
      : undefined;

    const result = await this.uow.run(
      validTenantId,
      async (client) => {
        const updateSql = `
          UPDATE conversations
          SET owner_type = 'human',
              owner_id = $1,
              assigned_user_id = $2::integer,
              ownership_epoch = ownership_epoch + 1,
              version = version + 1,
              ia_paused = true,
              ia_paused_by = $2::integer,
              ia_paused_at = NOW(),
              ia_resume_at = NULL,
              updated_at = NOW()
          WHERE id = $3 AND company_id = $4 AND version = $5
          RETURNING id, company_id, version, ownership_epoch, owner_type, owner_id, status, assigned_user_id, ia_paused;
        `;

        const updateRes = await client.query(updateSql, [
          String(params.userId),
          userIdNum,
          convId,
          validTenantId,
          params.expectedVersion,
        ]);

        if (!updateRes.rows || updateRes.rows.length === 0 || updateRes.rowCount === 0) {
          // Disambiguate between 404 (non-existent) and 409 (version mismatch)
          const checkSql = `
            SELECT id, company_id, version, ownership_epoch, owner_type, owner_id
            FROM conversations
            WHERE id = $1 AND company_id = $2
            LIMIT 1;
          `;
          const checkRes = await client.query(checkSql, [convId, validTenantId]);

          if (!checkRes.rows || checkRes.rows.length === 0) {
            throw new ConversationNotFoundError(params.conversationId, validTenantId);
          }

          const current = checkRes.rows[0];
          throw new CasConflictError(
            String(params.conversationId),
            params.expectedVersion,
            Number(current.version),
            Number(current.ownership_epoch),
            current.owner_type,
            current.owner_id ? String(current.owner_id) : null
          );
        }

        const row = updateRes.rows[0];

        // Record in operational_actions audit trail within the same transaction
        const auditSql = `
          INSERT INTO operational_actions (
            company_id, conversation_id, actor_user_id, action_type, status, description, metadata_json
          )
          VALUES ($1, $2, $3, 'conversation_takeover', 'completed', $4, $5::jsonb);
        `;

        const auditMetadata = JSON.stringify({
          previousVersion: params.expectedVersion,
          newVersion: Number(row.version),
          epoch: Number(row.ownership_epoch),
          ownerType: row.owner_type,
          ownerId: String(row.owner_id),
          reason: params.reason || null,
        });

        await client.query(auditSql, [
          validTenantId,
          convId,
          userIdNum,
          params.reason || 'Human takeover initiated',
          auditMetadata,
        ]);

        const conversation = await this.snapshot(params, client, validTenantId, convId);
        return {
          success: true,
          ...(conversation && { conversation }),
          conversationId: String(row.id),
          previousVersion: params.expectedVersion,
          newVersion: Number(row.version),
          epoch: Number(row.ownership_epoch),
          ownerType: row.owner_type as 'human' | 'ai_agent',
          ownerId: row.owner_id ? String(row.owner_id) : null,
          aiPaused: Boolean(row.ia_paused),
        };
      },
      runOptions
    );

    // Post-commit: emit real-time notifications to authorized tenant and conversation rooms
    const eventPayload = {
      conversationId: result.conversationId,
      previousVersion: result.previousVersion,
      newVersion: result.newVersion,
      epoch: result.epoch,
      ownerType: result.ownerType,
      ownerId: result.ownerId,
      aiPaused: result.aiPaused,
      timestamp: new Date().toISOString(),
    };

    emitToTenant(validTenantId, 'conversation.ownership_changed', eventPayload);
    emitConversation(validTenantId, result.conversationId, 'conversation.ownership_changed', eventPayload);

    return result;
  }

  /**
   * Atomically pauses AI assistant for a conversation.
   * Increments version (v -> v + 1) without modifying ownership epoch.
   */
  async pauseAi(params: PauseAiParams): Promise<TakeoverResult> {
    const validTenantId = toPositiveInt(params.tenantId);
    if (!validTenantId) {
      throw new Error(`[ConversationCasService] Invalid tenantId: ${params.tenantId}`);
    }

    const convId = toPositiveInt(params.conversationId);
    if (!convId) {
      throw new Error(`[ConversationCasService] Invalid conversationId: ${params.conversationId}`);
    }

    const userIdNum = toPositiveInt(params.userId);
    if (!userIdNum) {
      throw new Error(`[ConversationCasService] Invalid userId: ${params.userId}`);
    }

    if (params.expectedVersion === undefined || params.expectedVersion === null || params.expectedVersion < 0) {
      throw new Error(`[ConversationCasService] Invalid expectedVersion: ${params.expectedVersion}`);
    }

    const runOptions = params.client
      ? { client: params.client, activeTenantId: validTenantId }
      : undefined;

    const result = await this.uow.run(
      validTenantId,
      async (client) => {
        const updateSql = `
          UPDATE conversations
          SET ia_paused = true,
              ia_paused_by = $1,
              ia_paused_at = NOW(),
              ia_resume_at = CASE WHEN $2::integer IS NOT NULL THEN NOW() + ($2 * INTERVAL '1 second') ELSE NULL END,
              version = version + 1,
              updated_at = NOW()
          WHERE id = $3 AND company_id = $4 AND version = $5
          RETURNING id, company_id, version, ownership_epoch, owner_type, owner_id, status, assigned_user_id, ia_paused;
        `;

        const updateRes = await client.query(updateSql, [
          userIdNum,
          params.durationSeconds || null,
          convId,
          validTenantId,
          params.expectedVersion,
        ]);

        if (!updateRes.rows || updateRes.rows.length === 0 || updateRes.rowCount === 0) {
          const checkSql = `
            SELECT id, company_id, version, ownership_epoch, owner_type, owner_id
            FROM conversations
            WHERE id = $1 AND company_id = $2
            LIMIT 1;
          `;
          const checkRes = await client.query(checkSql, [convId, validTenantId]);

          if (!checkRes.rows || checkRes.rows.length === 0) {
            throw new ConversationNotFoundError(params.conversationId, validTenantId);
          }

          const current = checkRes.rows[0];
          throw new CasConflictError(
            String(params.conversationId),
            params.expectedVersion,
            Number(current.version),
            Number(current.ownership_epoch),
            current.owner_type,
            current.owner_id ? String(current.owner_id) : null
          );
        }

        const row = updateRes.rows[0];

        // Audit log
        const auditSql = `
          INSERT INTO operational_actions (
            company_id, conversation_id, actor_user_id, action_type, status, description, metadata_json
          )
          VALUES ($1, $2, $3, 'conversation_ai_paused', 'completed', $4, $5::jsonb);
        `;

        await client.query(auditSql, [
          validTenantId,
          convId,
          userIdNum,
          params.reason || 'AI paused by user',
          JSON.stringify({
            previousVersion: params.expectedVersion,
            newVersion: Number(row.version),
            durationSeconds: params.durationSeconds || null,
            reason: params.reason || null,
          }),
        ]);

        const conversation = await this.snapshot(params, client, validTenantId, convId);
        return {
          success: true,
          ...(conversation && { conversation }),
          conversationId: String(row.id),
          previousVersion: params.expectedVersion,
          newVersion: Number(row.version),
          epoch: Number(row.ownership_epoch),
          ownerType: row.owner_type as 'human' | 'ai_agent',
          ownerId: row.owner_id ? String(row.owner_id) : null,
          aiPaused: Boolean(row.ia_paused),
        };
      },
      runOptions
    );

    // Post-commit notification
    const eventPayload = {
      conversationId: result.conversationId,
      previousVersion: result.previousVersion,
      newVersion: result.newVersion,
      epoch: result.epoch,
      ownerType: result.ownerType,
      ownerId: result.ownerId,
      aiPaused: true,
      timestamp: new Date().toISOString(),
    };

    emitToTenant(validTenantId, 'conversation.ownership_changed', eventPayload);
    emitConversation(validTenantId, result.conversationId, 'conversation.ownership_changed', eventPayload);

    return result;
  }

  /**
   * Atomically resumes AI assistant for a conversation.
   * Increments version (v -> v + 1) and ownership_epoch (e -> e + 1).
   * Restores owner_type = 'ai_agent' and sets ia_paused = false.
   */
  async resumeAi(params: ResumeAiParams): Promise<TakeoverResult> {
    const validTenantId = toPositiveInt(params.tenantId);
    if (!validTenantId) {
      throw new Error(`[ConversationCasService] Invalid tenantId: ${params.tenantId}`);
    }

    const convId = toPositiveInt(params.conversationId);
    if (!convId) {
      throw new Error(`[ConversationCasService] Invalid conversationId: ${params.conversationId}`);
    }

    const userIdNum = toPositiveInt(params.userId);
    if (!userIdNum) {
      throw new Error(`[ConversationCasService] Invalid userId: ${params.userId}`);
    }

    if (params.expectedVersion === undefined || params.expectedVersion === null || params.expectedVersion < 0) {
      throw new Error(`[ConversationCasService] Invalid expectedVersion: ${params.expectedVersion}`);
    }

    const runOptions = params.client
      ? { client: params.client, activeTenantId: validTenantId }
      : undefined;

    const result = await this.uow.run(
      validTenantId,
      async (client) => {
        const updateSql = `
          UPDATE conversations
          SET ia_paused = false,
              ia_paused_by = NULL,
              ia_paused_at = NULL,
              ia_resume_at = NULL,
              owner_type = 'ai_agent',
              owner_id = NULL,
              ownership_epoch = ownership_epoch + 1,
              version = version + 1,
              updated_at = NOW()
          WHERE id = $1 AND company_id = $2 AND version = $3
          RETURNING id, company_id, version, ownership_epoch, owner_type, owner_id, status, assigned_user_id, ia_paused;
        `;

        const updateRes = await client.query(updateSql, [
          convId,
          validTenantId,
          params.expectedVersion,
        ]);

        if (!updateRes.rows || updateRes.rows.length === 0 || updateRes.rowCount === 0) {
          const checkSql = `
            SELECT id, company_id, version, ownership_epoch, owner_type, owner_id
            FROM conversations
            WHERE id = $1 AND company_id = $2
            LIMIT 1;
          `;
          const checkRes = await client.query(checkSql, [convId, validTenantId]);

          if (!checkRes.rows || checkRes.rows.length === 0) {
            throw new ConversationNotFoundError(params.conversationId, validTenantId);
          }

          const current = checkRes.rows[0];
          throw new CasConflictError(
            String(params.conversationId),
            params.expectedVersion,
            Number(current.version),
            Number(current.ownership_epoch),
            current.owner_type,
            current.owner_id ? String(current.owner_id) : null
          );
        }

        const row = updateRes.rows[0];

        // Audit log
        const auditSql = `
          INSERT INTO operational_actions (
            company_id, conversation_id, actor_user_id, action_type, status, description, metadata_json
          )
          VALUES ($1, $2, $3, 'conversation_ai_resumed', 'completed', $4, $5::jsonb);
        `;

        await client.query(auditSql, [
          validTenantId,
          convId,
          userIdNum,
          params.reason || 'AI resumed by user',
          JSON.stringify({
            previousVersion: params.expectedVersion,
            newVersion: Number(row.version),
            epoch: Number(row.ownership_epoch),
            reason: params.reason || null,
          }),
        ]);

        const conversation = await this.snapshot(params, client, validTenantId, convId);
        return {
          success: true,
          ...(conversation && { conversation }),
          conversationId: String(row.id),
          previousVersion: params.expectedVersion,
          newVersion: Number(row.version),
          epoch: Number(row.ownership_epoch),
          ownerType: row.owner_type as 'human' | 'ai_agent',
          ownerId: null,
          aiPaused: false,
        };
      },
      runOptions
    );

    // Post-commit notification
    const eventPayload = {
      conversationId: result.conversationId,
      previousVersion: result.previousVersion,
      newVersion: result.newVersion,
      epoch: result.epoch,
      ownerType: 'ai_agent',
      ownerId: null,
      aiPaused: false,
      timestamp: new Date().toISOString(),
    };

    emitToTenant(validTenantId, 'conversation.ownership_changed', eventPayload);
    emitConversation(validTenantId, result.conversationId, 'conversation.ownership_changed', eventPayload);

    return result;
  }

  private async snapshot(
    params: { includeConversation?: boolean }, client: Queryable, tenantId: number, conversationId: number
  ): Promise<ConversationV1 | undefined> {
    if (!params.includeConversation) return undefined;
    const conversation = await readConversation(client, tenantId, conversationId);
    if (!conversation) throw new ConversationNotFoundError(conversationId, tenantId);
    return conversation;
  }

  /**
   * Validates AI fencing token.
   * Returns true only if conversation exists in tenant, ownership_epoch matches expectedEpoch,
   * owner_type is 'ai_agent', and ia_paused is false.
   */
  async validateEpoch(params: ValidateEpochParams): Promise<boolean> {
    const validTenantId = toPositiveInt(params.tenantId);
    if (!validTenantId) return false;

    const convId = toPositiveInt(params.conversationId);
    if (!convId) return false;

    if (params.expectedEpoch === undefined || params.expectedEpoch === null || params.expectedEpoch < 0) {
      return false;
    }

    const runOptions = params.client
      ? { client: params.client, activeTenantId: validTenantId }
      : undefined;

    return this.uow.run(
      validTenantId,
      async (client) => {
        const querySql = `
          SELECT id, ownership_epoch, owner_type,
                 ia_paused AND (ia_resume_at IS NULL OR ia_resume_at > NOW()) AS ia_paused
          FROM conversations
          WHERE id = $1 AND company_id = $2
          LIMIT 1;
        `;

        const res = await client.query(querySql, [convId, validTenantId]);
        if (!res.rows || res.rows.length === 0) {
          return false;
        }

        const row = res.rows[0];
        const epochMatches = Number(row.ownership_epoch) === params.expectedEpoch;
        const ownerIsAi = row.owner_type === 'ai_agent';
        const notPaused = !row.ia_paused;

        return epochMatches && ownerIsAi && notPaused;
      },
      runOptions
    );
  }

  /**
   * Retrieves conversation concurrency state within tenant scope.
   */
  async getConversationState(params: {
    tenantId: string | number;
    conversationId: string | number;
    client?: Queryable;
  }): Promise<ConversationStateResult | null> {
    const validTenantId = toPositiveInt(params.tenantId);
    if (!validTenantId) return null;

    const convId = toPositiveInt(params.conversationId);
    if (!convId) return null;

    const runOptions = params.client
      ? { client: params.client, activeTenantId: validTenantId }
      : undefined;

    return this.uow.run(
      validTenantId,
      async (client) => {
        const querySql = `
          SELECT id, version, ownership_epoch, owner_type, owner_id,
                 ia_paused AND (ia_resume_at IS NULL OR ia_resume_at > NOW()) AS ia_paused
          FROM conversations
          WHERE id = $1 AND company_id = $2
          LIMIT 1;
        `;

        const res = await client.query(querySql, [convId, validTenantId]);
        if (!res.rows || res.rows.length === 0) {
          return null;
        }

        const row = res.rows[0];
        return {
          id: String(row.id),
          version: Number(row.version),
          ownershipEpoch: Number(row.ownership_epoch),
          ownerType: row.owner_type as 'human' | 'ai_agent',
          ownerId: row.owner_id ? String(row.owner_id) : null,
          aiPaused: Boolean(row.ia_paused),
        };
      },
      runOptions
    );
  }
}

// Singleton default export
export const conversationCasService = new ConversationCasService();
