import { Pool, PoolClient } from 'pg';
import defaultPool from '../config/database';
import { Queryable } from '../shared/UnitOfWorkPort';
import { toPositiveInt } from '../middleware/jwtAuth';

function formatTenantId(tenantId: unknown): string {
  if (typeof tenantId === 'bigint') {
    return `${tenantId}n`;
  }
  try {
    const json = JSON.stringify(tenantId);
    return json !== undefined ? json : String(tenantId);
  } catch {
    return String(tenantId);
  }
}

export class InvalidTenantIdError extends Error {
  readonly code = 'INVALID_TENANT_ID';

  constructor(public readonly tenantId: unknown) {
    super(`[TenantScopedUoW] Invalid tenantId: must be a positive integer, received ${formatTenantId(tenantId)}`);
    this.name = 'InvalidTenantIdError';
  }
}

export class MissingActiveTenantIdError extends Error {
  readonly code = 'MISSING_ACTIVE_TENANT_ID';

  constructor() {
    super(
      '[TenantScopedUoW] activeTenantId is required when providing an existing client to prevent cross-tenant leakage'
    );
    this.name = 'MissingActiveTenantIdError';
  }
}

export class CrossTenantNestingError extends Error {
  readonly code = 'CROSS_TENANT_NESTING_FORBIDDEN';

  constructor(public readonly expectedTenantId: number, public readonly receivedTenantId: number) {
    super(`[TenantScopedUoW] Cross-tenant nested transaction forbidden: active tenant is ${expectedTenantId}, attempted ${receivedTenantId}`);
    this.name = 'CrossTenantNestingError';
  }
}

export interface TenantScopedOptions {
  client?: Queryable;
  activeTenantId?: number;
}

export class TenantScopedUoW {
  constructor(private readonly pool: Pool = defaultPool) {}

  /**
   * Ejecuta una operacion dentro de una transaccion acotada al tenant especificado.
   * Aplica BEGIN -> SET LOCAL app.current_tenant_id = :tenantId -> work -> COMMIT / ROLLBACK.
   * Garantiza liberacion del cliente y descarte de conexiones contaminadas ante falla.
   */
  async run<T>(
    tenantId: number | string | unknown,
    work: (client: Queryable) => Promise<T>,
    options?: TenantScopedOptions
  ): Promise<T> {
    const validTenantId = toPositiveInt(tenantId);
    if (!validTenantId) {
      throw new InvalidTenantIdError(tenantId);
    }

    // Soporte para transacciones anidadas o clientes preexistentes
    if (options?.client) {
      if (options.activeTenantId === undefined || options.activeTenantId === null) {
        throw new MissingActiveTenantIdError();
      }
      if (options.activeTenantId !== validTenantId) {
        throw new CrossTenantNestingError(options.activeTenantId, validTenantId);
      }
      return work(options.client);
    }

    const client = await this.pool.connect();
    let inTransaction = false;
    let releaseError: Error | undefined;

    try {
      await client.query('BEGIN');
      inTransaction = true;
      await client.query(`SET LOCAL app.current_tenant_id = '${validTenantId}'`);

      const result = await work(client);

      await client.query('COMMIT');
      inTransaction = false;
      return result;
    } catch (error) {
      if (inTransaction) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          // Si el rollback falla, la conexion queda en estado potencialmente corrupto;
          // marcamos releaseError para que pool.release() destruya el socket.
          releaseError = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
          console.error('[TenantScopedUoW] Error durante ROLLBACK; destruyendo conexion:', releaseError);
        }
      }
      throw error;
    } finally {
      client.release(releaseError);
    }
  }

  /**
   * Alias de conveniencia compatible con convencion de transacciones.
   */
  async transaction<T>(
    tenantId: number | string | unknown,
    work: (client: Queryable) => Promise<T>,
    options?: TenantScopedOptions
  ): Promise<T> {
    return this.run(tenantId, work, options);
  }

  /**
   * Alias explicito sugerido en especificaciones de arquitectura.
   */
  async runInTenantScope<T>(
    tenantId: number | string | unknown,
    work: (client: Queryable) => Promise<T>,
    options?: TenantScopedOptions
  ): Promise<T> {
    return this.run(tenantId, work, options);
  }
}

// Instancia singleton por defecto usando el pool central
export const tenantScopedUoW = new TenantScopedUoW();

// Helper funcional de conveniencia
export async function withTenantTransaction<T>(
  tenantId: number | string | unknown,
  work: (client: Queryable) => Promise<T>,
  pool: Pool = defaultPool
): Promise<T> {
  const uow = pool === defaultPool ? tenantScopedUoW : new TenantScopedUoW(pool);
  return uow.run(tenantId, work);
}
