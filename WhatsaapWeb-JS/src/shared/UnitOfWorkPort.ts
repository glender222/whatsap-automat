import { QueryResult } from 'pg';

/**
 * Mínimo contrato queryable compatible con Pool y PoolClient.
 * Usado para permitir que repositorios operen dentro o fuera de una transacción
 * sin depender del tipo concreto de conexión.
 */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<QueryResult>;
}

/**
 * Puerto de Unit of Work mínimo.
 * Ejecuta una función dentro de un límite transaccional con rollback automático ante error.
 */
export interface UnitOfWorkPort {
  transaction<T>(fn: (ctx: { client: Queryable }) => Promise<T>): Promise<T>;
}
