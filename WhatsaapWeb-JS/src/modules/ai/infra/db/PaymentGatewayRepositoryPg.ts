import { Queryable } from '../../../../shared/UnitOfWorkPort';
import type {
  PaymentGateway,
  PaymentGatewayInput,
  PaymentGatewayProvider,
} from '../../domain/paymentGateway.types';

type Row = Record<string, any>;

function json(value: unknown): string {
  return JSON.stringify(value || {});
}

function mapGateway(row: Row): PaymentGateway {
  return {
    id: Number(row.id),
    companyId: Number(row.company_id),
    provider: row.provider as PaymentGatewayProvider,
    displayName: row.display_name,
    credentials: row.credentials_json || {},
    webhookSecret: row.webhook_secret || null,
    status: row.status,
    isDefault: Boolean(row.is_default),
    metadata: row.metadata_json || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PaymentGatewayRepositoryPg {
  constructor(private readonly pool: Queryable) {}

  async list(companyId: number): Promise<PaymentGateway[]> {
    const result = await this.pool.query(
      `SELECT * FROM payment_gateways
       WHERE company_id = $1 AND status <> 'archived'
       ORDER BY is_default DESC, updated_at DESC, id DESC`,
      [companyId]
    );
    return result.rows.map(mapGateway);
  }

  async get(companyId: number, gatewayId: number): Promise<PaymentGateway | null> {
    const result = await this.pool.query(
      `SELECT * FROM payment_gateways WHERE company_id = $1 AND id = $2 LIMIT 1`,
      [companyId, gatewayId]
    );
    return result.rows[0] ? mapGateway(result.rows[0]) : null;
  }

  async getDefault(companyId: number): Promise<PaymentGateway | null> {
    const result = await this.pool.query(
      `SELECT * FROM payment_gateways
       WHERE company_id = $1 AND status = 'active'
       ORDER BY is_default DESC, id ASC LIMIT 1`,
      [companyId]
    );
    return result.rows[0] ? mapGateway(result.rows[0]) : null;
  }

  async create(companyId: number, input: PaymentGatewayInput): Promise<PaymentGateway> {
    const client = await (this.pool as any).connect();
    try {
      await client.query('BEGIN');
      if (input.isDefault) {
        await client.query(
          `UPDATE payment_gateways SET is_default = false, updated_at = NOW()
           WHERE company_id = $1 AND is_default = true`,
          [companyId]
        );
      }
      const result = await client.query(
        `INSERT INTO payment_gateways (
           company_id, provider, display_name, credentials_json, webhook_secret,
           status, is_default, metadata_json
         )
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8::jsonb)
         RETURNING *`,
        [
          companyId,
          input.provider,
          input.displayName,
          json(input.credentials || {}),
          input.webhookSecret ?? null,
          input.status || 'active',
          Boolean(input.isDefault),
          json(input.metadata || {}),
        ]
      );
      await client.query('COMMIT');
      return mapGateway(result.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async update(companyId: number, gatewayId: number, input: Partial<PaymentGatewayInput>): Promise<PaymentGateway | null> {
    const client = await (this.pool as any).connect();
    try {
      await client.query('BEGIN');
      if (input.isDefault) {
        await client.query(
          `UPDATE payment_gateways SET is_default = false, updated_at = NOW()
           WHERE company_id = $1 AND id <> $2 AND is_default = true`,
          [companyId, gatewayId]
        );
      }
      const result = await client.query(
        `UPDATE payment_gateways
         SET display_name = COALESCE($3, display_name),
             credentials_json = COALESCE($4::jsonb, credentials_json),
             webhook_secret = COALESCE($5, webhook_secret),
             status = COALESCE($6, status),
             is_default = COALESCE($7, is_default),
             metadata_json = COALESCE($8::jsonb, metadata_json),
             updated_at = NOW()
         WHERE company_id = $1 AND id = $2
         RETURNING *`,
        [
          companyId,
          gatewayId,
          input.displayName ?? null,
          input.credentials ? json(input.credentials) : null,
          input.webhookSecret ?? null,
          input.status ?? null,
          input.isDefault ?? null,
          input.metadata ? json(input.metadata) : null,
        ]
      );
      await client.query('COMMIT');
      return result.rows[0] ? mapGateway(result.rows[0]) : null;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async archive(companyId: number, gatewayId: number): Promise<void> {
    await this.pool.query(
      `UPDATE payment_gateways SET status = 'archived', is_default = false, updated_at = NOW()
       WHERE company_id = $1 AND id = $2`,
      [companyId, gatewayId]
    );
  }
}
