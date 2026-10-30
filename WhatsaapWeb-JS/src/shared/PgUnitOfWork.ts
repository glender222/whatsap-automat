import { Pool } from 'pg';
import { UnitOfWorkPort, Queryable } from './UnitOfWorkPort';

/**
 * Implementación PostgreSQL mínima de UnitOfWorkPort.
 * Maneja BEGIN / COMMIT / ROLLBACK y garantiza release del cliente
 * mediante bloque finally.
 */
export class PgUnitOfWork implements UnitOfWorkPort {
  constructor(private readonly pool: Pool) {}

  async transaction<T>(fn: (ctx: { client: Queryable }) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn({ client });
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
