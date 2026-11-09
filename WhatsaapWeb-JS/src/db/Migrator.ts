import { Pool, PoolClient } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import pool from '../config/database';

export interface Migration {
  version: string;
  filename: string;
  applied: boolean;
}

export class Migrator {
  private pool: Pool;
  private migrationsDir: string;
  private dryRun: boolean;

  constructor(options: { pool?: Pool; migrationsDir?: string; dryRun?: boolean } = {}) {
    this.pool = options.pool || pool;
    this.dryRun = options.dryRun || false;
    this.migrationsDir = options.migrationsDir || path.join(__dirname, 'migrations');
  }

  /** Asegura la existencia de la tabla de control bajo el bloqueo de migración. */
  private async init(db: PoolClient): Promise<void> {
    await db.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
  }

  /**
   * Lista todas las migraciones disponibles y su estado.
   */
  async listMigrations(db: Pool | PoolClient = this.pool): Promise<Migration[]> {
    const files = fs.readdirSync(this.migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();
    if (!files.length) throw new Error('No se encontraron migraciones SQL');

    if (this.dryRun) {
      return files.map(filename => {
        const version = path.basename(filename, '.sql');
        return { version, filename, applied: false };
      });
    }

    const query = { text: 'SELECT version FROM schema_migrations', query_timeout: 3000 };
    const { rows } = await db.query<{ version: string }>(query);
    const appliedSet = new Set(rows.map(r => r.version));

    return files.map(filename => {
      const version = path.basename(filename, '.sql');
      return { version, filename, applied: appliedSet.has(version) };
    });
  }

  /**
   * Aplica las migraciones pendientes en orden.
   * Retorna las aplicadas y las omitidas (ya aplicadas).
   */
  async migrate(): Promise<{ applied: string[]; skipped: string[] }> {
    if (this.dryRun) {
      const migrations = await this.listMigrations();
      for (const migration of migrations) console.log(`[DRY RUN] Would apply ${migration.version}`);
      return { applied: [], skipped: [] };
    }

    const applied: string[] = [];
    const skipped: string[] = [];
    const client = await this.pool.connect();
    let locked = false;
    let discardClient = false;

    try {
      await client.query("SELECT pg_advisory_lock(hashtextextended('whatsap-automat:migrations', 0))");
      locked = true;
      await this.init(client);
      const migrations = await this.listMigrations(client);
      for (const migration of migrations) {
        if (migration.applied) {
          skipped.push(migration.version);
          console.log(`⏭️  Migration ${migration.version} already applied`);
          continue;
        }

        const sql = fs.readFileSync(path.join(this.migrationsDir, migration.filename), 'utf-8');
        try {
          await client.query('BEGIN');
          await client.query(sql);
          await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [migration.version]);
          await client.query('COMMIT');
          console.log(`✅ Applied migration ${migration.version}`);
          applied.push(migration.version);
        } catch (error) {
          await client.query('ROLLBACK').catch(() => { discardClient = true; });
          console.error(`❌ Failed to apply migration ${migration.version}:`, error);
          throw error;
        }
      }
      return { applied, skipped };
    } finally {
      if (locked && !discardClient) {
        await client.query("SELECT pg_advisory_unlock(hashtextextended('whatsap-automat:migrations', 0))")
          .catch(() => { discardClient = true; });
      }
      client.release(discardClient);
    }
  }

  /**
   * Imprime el estado de cada migración.
   */
  async printStatus(): Promise<void> {
    const migrations = await this.listMigrations();
    console.log('Migration status:');
    for (const m of migrations) {
      const mark = m.applied ? '✅' : '⏳';
      console.log(`  ${mark} ${m.version}`);
    }
  }
}
