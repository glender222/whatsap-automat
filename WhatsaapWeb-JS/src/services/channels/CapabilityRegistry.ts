import {
  ChannelCapabilityMatrix,
  channelCapabilityMatrixSchema,
  PublishIntent,
  PublishGateResult,
  evaluatePublishGate,
  ProblemDetailsV1,
  createProblemDetails,
  StandardErrorCode,
  ConnectionHealth,
} from '@whatsap-automat/contracts';
import { Queryable } from '../../shared/UnitOfWorkPort';
import { TenantScopedUoW, tenantScopedUoW } from '../../db/TenantScopedUoW';

export class PublishGateError extends Error {
  readonly code: string;
  readonly problemDetails: ProblemDetailsV1;

  constructor(public readonly result: Extract<PublishGateResult, { permitted: false }>) {
    super(`[PublishGate] Action blocked: ${result.reasonCode} - ${result.problemDetails.detail}`);
    this.name = 'PublishGateError';
    this.code = result.reasonCode;
    this.problemDetails = result.problemDetails;
  }
}

export interface CapabilityRegistryOptions {
  ttlMs?: number;
}

export class CapabilityRegistry {
  private readonly matrixCache = new Map<string, { matrix: ChannelCapabilityMatrix; cachedAt: number }>();
  private readonly ttlMs: number;

  constructor(
    private readonly uow: TenantScopedUoW = tenantScopedUoW,
    options?: CapabilityRegistryOptions
  ) {
    this.ttlMs = options?.ttlMs ?? 60_000;
  }

  private cacheKey(tenantId: number, connectionId: string): string {
    return `${tenantId}:${connectionId}`;
  }

  /**
   * Persists or updates a connection capability matrix snapshot.
   */
  async saveSnapshot(
    tenantId: number,
    matrix: ChannelCapabilityMatrix | (Omit<ChannelCapabilityMatrix, 'tenantId' | 'updatedAt'> & { tenantId?: string | number; updatedAt?: string }),
    client?: Queryable
  ): Promise<void> {
    const matrixToValidate = {
      ...matrix,
      tenantId: matrix.tenantId ? String(matrix.tenantId) : String(tenantId),
      updatedAt: matrix.updatedAt || new Date().toISOString(),
    };
    const validated = channelCapabilityMatrixSchema.parse(matrixToValidate);

    const execute = async (qClient: Queryable): Promise<void> => {
      const sql = `
        INSERT INTO channel_capabilities_snapshots (
          tenant_id, connection_id, channel, matrix, health_status,
          last_evaluated_at, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, NOW(), NOW(), NOW()
        )
        ON CONFLICT (tenant_id, connection_id)
        DO UPDATE SET
          channel = EXCLUDED.channel,
          matrix = EXCLUDED.matrix,
          health_status = EXCLUDED.health_status,
          last_evaluated_at = NOW(),
          updated_at = NOW();
      `;

      await qClient.query(sql, [
        tenantId,
        validated.connectionId,
        validated.channel,
        JSON.stringify(validated),
        validated.health.status,
      ]);
    };

    if (client) {
      await execute(client);
    } else {
      await this.uow.run(tenantId, execute);
    }

    this.matrixCache.set(this.cacheKey(tenantId, validated.connectionId), {
      matrix: validated,
      cachedAt: Date.now(),
    });
  }

  /**
   * Retrieves a connection capability matrix snapshot from cache or database.
   */
  async getSnapshot(
    tenantId: number,
    connectionId: string,
    client?: Queryable
  ): Promise<ChannelCapabilityMatrix | null> {
    const key = this.cacheKey(tenantId, connectionId);
    const cached = this.matrixCache.get(key);
    if (cached && Date.now() - cached.cachedAt < this.ttlMs) {
      return cached.matrix;
    }

    const execute = async (qClient: Queryable): Promise<ChannelCapabilityMatrix | null> => {
      const sql = `
        SELECT matrix FROM channel_capabilities_snapshots
        WHERE tenant_id = $1 AND connection_id = $2
        LIMIT 1;
      `;
      const res = await qClient.query(sql, [tenantId, connectionId]);
      if (!res.rows || res.rows.length === 0) {
        return null;
      }

      const raw = res.rows[0].matrix;
      const rawObj = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return channelCapabilityMatrixSchema.parse(rawObj);
    };

    const matrix = client ? await execute(client) : await this.uow.run(tenantId, execute);
    if (matrix) {
      this.matrixCache.set(key, {
        matrix,
        cachedAt: Date.now(),
      });
    }

    return matrix;
  }

  /**
   * Deterministically evaluates whether an outbound message intent is permitted
   * according to the 6-dimensional ChannelCapabilityMatrix (PROD-004 / ADR-005).
   */
  async evaluatePublish(
    tenantId: number,
    connectionId: string,
    intent: PublishIntent,
    client?: Queryable
  ): Promise<PublishGateResult> {
    const matrix = await this.getSnapshot(tenantId, connectionId, client);
    if (!matrix) {
      return {
        permitted: false,
        reasonCode: 'CAPABILITY_UNSUPPORTED',
        problemDetails: createProblemDetails({
          code: StandardErrorCode.NOT_FOUND,
          title: 'Channel Capabilities Not Found',
          detail: `No capability matrix registered for connection '${connectionId}' in tenant '${tenantId}'.`,
          instance: `/connections/${connectionId}/publish-gate`,
          correlationId: intent.correlationId || 'none',
          metadata: {
            tenantId,
            connectionId,
          },
        }),
      };
    }

    return evaluatePublishGate(matrix, intent);
  }

  /**
   * Asserts that an outbound message intent is permitted.
   * If not permitted, throws PublishGateError containing RFC 7807 ProblemDetails.
   */
  async assertCanPublish(
    tenantId: number,
    connectionId: string,
    intent: PublishIntent,
    client?: Queryable
  ): Promise<void> {
    const result = await this.evaluatePublish(tenantId, connectionId, intent, client);
    if (!result.permitted) {
      throw new PublishGateError(result);
    }
  }

  /**
   * Updates health status in connection snapshot.
   */
  async updateHealth(
    tenantId: number,
    connectionId: string,
    health: ConnectionHealth,
    client?: Queryable
  ): Promise<void> {
    const execute = async (qClient: Queryable): Promise<void> => {
      // Fetch existing matrix to update health subfield
      const selectSql = `
        SELECT matrix FROM channel_capabilities_snapshots
        WHERE tenant_id = $1 AND connection_id = $2
        LIMIT 1;
      `;
      const res = await qClient.query(selectSql, [tenantId, connectionId]);
      if (res.rows && res.rows.length > 0) {
        const raw = res.rows[0].matrix;
        const currentMatrix = typeof raw === 'string' ? JSON.parse(raw) : raw;
        currentMatrix.health = health;
        const validated = channelCapabilityMatrixSchema.parse(currentMatrix);

        const updateSql = `
          UPDATE channel_capabilities_snapshots
          SET health_status = $1,
              matrix = $2,
              last_evaluated_at = NOW(),
              updated_at = NOW()
          WHERE tenant_id = $3 AND connection_id = $4;
        `;
        await qClient.query(updateSql, [
          health.status,
          JSON.stringify(validated),
          tenantId,
          connectionId,
        ]);

        this.matrixCache.set(this.cacheKey(tenantId, connectionId), {
          matrix: validated,
          cachedAt: Date.now(),
        });
      }
    };

    if (client) {
      await execute(client);
    } else {
      await this.uow.run(tenantId, execute);
    }
  }

  /**
   * Invalidates cached capability matrices.
   */
  invalidateCache(tenantId?: number, connectionId?: string): void {
    if (tenantId !== undefined && connectionId !== undefined) {
      this.matrixCache.delete(this.cacheKey(tenantId, connectionId));
    } else if (tenantId !== undefined) {
      const prefix = `${tenantId}:`;
      for (const key of this.matrixCache.keys()) {
        if (key.startsWith(prefix)) {
          this.matrixCache.delete(key);
        }
      }
    } else {
      this.matrixCache.clear();
    }
  }
}

export const capabilityRegistry = new CapabilityRegistry();
