import { Pool } from 'pg';
import { TenantScopedUoW } from '../../../../db/TenantScopedUoW';
import { InvalidMasterKeyError, SecretVault } from '../../../../services/security/SecretVault';
import type { Queryable } from '../../../../shared/UnitOfWorkPort';
import type { PaymentGateway, PaymentGatewayInput } from '../../domain/paymentGateway.types';

type Row = {
  id: string;
  company_id: number;
  provider: PaymentGateway['provider'];
  display_name: string;
  credentials_json: Record<string, unknown>;
  webhook_secret: string | null;
  status: PaymentGateway['status'];
  is_default: boolean;
  metadata_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

const VAULT_PREFIX = 'payment-gateway-v1:';
const positiveId = /^[1-9][0-9]{0,18}$/;
const gatewayRevision = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

type OrdersCredentialScope = { companyId: number; gatewayId: string; gatewayRevision: string };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function ordersCredential(vault: string, scope: OrdersCredentialScope, masterKey: string) {
  if (!vault.startsWith(VAULT_PREFIX)) return null;
  try {
    const envelope = vault.slice(VAULT_PREFIX.length);
    const opened = record(JSON.parse(new SecretVault({ masterKey }).decrypt(envelope)));
    if (opened?.companyId !== scope.companyId || opened.gatewayId !== scope.gatewayId || opened.field !== 'credentials') {
      return null;
    }
    const fields = record(opened.value);
    const accessToken = fields?.access_token;
    const sellerId = fields?.seller_id;
    if (typeof accessToken !== 'string' || !/^[!-~]{1,512}$/.test(accessToken) ||
        typeof sellerId !== 'string' || !positiveId.test(sellerId)) return null;
    return { ...scope, accessToken, sellerId };
  } catch {
    return null;
  }
}

function mapGateway(row: Row): PaymentGateway {
  const instructions = row.metadata_json?.manualInstructions;
  return {
    id: Number(row.id),
    companyId: row.company_id,
    provider: row.provider,
    displayName: row.display_name,
    credentials: {},
    webhookSecret: null,
    credentialsStored: typeof row.credentials_json?.vault === 'string' &&
      row.credentials_json.vault.startsWith(VAULT_PREFIX),
    webhookSecretStored: Boolean(row.webhook_secret?.startsWith(VAULT_PREFIX)),
    checkoutAvailability: 'unavailable',
    status: row.status,
    isDefault: row.is_default,
    metadata: row.provider === 'manual' && typeof instructions === 'string'
      ? { manualInstructions: instructions } : {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function encrypt(companyId: number, gatewayId: string, field: string, value: unknown): string {
  const masterKey = process.env.MASTER_ENCRYPTION_KEY?.trim();
  try {
    if (!masterKey) throw new InvalidMasterKeyError();
    // Bind the encrypted value to the gateway and field that may read it.
    const envelope = new SecretVault({ masterKey }).encrypt(JSON.stringify({ companyId, gatewayId, field, value }));
    return VAULT_PREFIX + JSON.stringify(envelope);
  } catch (error) {
    if (!(error instanceof InvalidMasterKeyError)) throw error;
    throw Object.assign(new Error('El almacén de secretos de pagos no está disponible.'), {
      code: 'GATEWAY_SECRET_STORAGE_UNAVAILABLE',
      statusCode: 503,
    });
  }
}

export class PaymentGatewayRepositoryPg {
  private readonly uow: TenantScopedUoW;

  constructor(pool: Pool) {
    this.uow = new TenantScopedUoW(pool);
  }

  async list(companyId: number): Promise<PaymentGateway[]> {
    return this.uow.run(companyId, async (db) => {
      const result = await db.query(
        `SELECT * FROM payment_gateways
         WHERE company_id = $1 AND status <> 'archived'
         ORDER BY is_default DESC, updated_at DESC, id DESC`,
        [companyId],
      );
      return result.rows.map(mapGateway);
    });
  }

  async get(companyId: number, gatewayId: number): Promise<PaymentGateway | null> {
    return this.uow.run(companyId, async (db) => {
      const row = await this.find(db, companyId, gatewayId);
      return row ? mapGateway(row) : null;
    });
  }

  async resolveMercadoPagoOrdersCredential(scope: OrdersCredentialScope) {
    const masterKey = process.env.MASTER_ENCRYPTION_KEY?.trim();
    if (!masterKey || !Number.isInteger(scope.companyId) || scope.companyId <= 0 || scope.companyId > 2_147_483_647 ||
        typeof scope.gatewayId !== 'string' || !positiveId.test(scope.gatewayId) || BigInt(scope.gatewayId) > 9_223_372_036_854_775_807n ||
        typeof scope.gatewayRevision !== 'string' || !gatewayRevision.test(scope.gatewayRevision)) return null;
    const { rows: [row] } = await this.uow.run(scope.companyId, (db) => db.query(
      `SELECT credentials_json ->> 'vault' AS vault FROM payment_gateways
       WHERE company_id = $1 AND id = $2 AND provider = 'mercadopago' AND status = 'active'
         AND to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') = $3`,
      [scope.companyId, scope.gatewayId, scope.gatewayRevision],
    ));
    return typeof row?.vault === 'string' ? ordersCredential(row.vault, scope, masterKey) : null;
  }

  async getDefault(companyId: number): Promise<PaymentGateway | null> {
    return this.uow.run(companyId, async (db) => {
      const result = await db.query(
        `SELECT * FROM payment_gateways
         WHERE company_id = $1 AND status = 'active'
         ORDER BY is_default DESC, id ASC LIMIT 1`,
        [companyId],
      );
      return result.rows[0] ? mapGateway(result.rows[0]) : null;
    });
  }

  async create(companyId: number, input: PaymentGatewayInput): Promise<PaymentGateway> {
    return this.mutate(companyId, async (db) => {
      if (input.isDefault) await this.clearDefault(db, companyId);
      const result = await db.query(
        `INSERT INTO payment_gateways (company_id, provider, display_name, status, is_default, metadata_json)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         RETURNING *`,
        [
          companyId, input.provider, input.displayName, input.status ?? 'active',
          input.isDefault ?? false, JSON.stringify(input.metadata ?? {}),
        ],
      );
      const row: Row = result.rows[0];
      const secrets = this.secrets(companyId, row.id, input);
      if (secrets.credentials !== null || secrets.webhook !== null) {
        const stored = await db.query(
          `UPDATE payment_gateways SET credentials_json = COALESCE($3::jsonb, credentials_json),
             webhook_secret = $4 WHERE company_id = $1 AND id = $2 RETURNING *`,
          [companyId, row.id, secrets.credentials, secrets.webhook],
        );
        return mapGateway(stored.rows[0]);
      }
      return mapGateway(row);
    });
  }

  async update(companyId: number, gatewayId: number, input: Partial<PaymentGatewayInput>): Promise<PaymentGateway | null> {
    return this.mutate(companyId, async (db) => {
      const current = await this.find(db, companyId, gatewayId);
      if (!current) return null;
      if (input.provider !== undefined && input.provider !== current.provider) {
        throw Object.assign(new Error('Crea otra pasarela para cambiar el proveedor.'), {
          code: 'GATEWAY_PROVIDER_IMMUTABLE',
          statusCode: 409,
        });
      }
      const secrets = this.secrets(companyId, current.id, input);
      if (input.isDefault) await this.clearDefault(db, companyId, gatewayId);
      const result = await db.query(
        `UPDATE payment_gateways
         SET display_name = COALESCE($3, display_name),
             credentials_json = COALESCE($4::jsonb, credentials_json),
             webhook_secret = CASE WHEN $5::boolean THEN $6 ELSE webhook_secret END,
             status = COALESCE($7, status),
             is_default = COALESCE($8, is_default),
             metadata_json = COALESCE($9::jsonb, metadata_json),
             updated_at = NOW()
         WHERE company_id = $1 AND id = $2
         RETURNING *`,
        [
          companyId, gatewayId, input.displayName ?? null, secrets.credentials,
          input.webhookSecret === null || secrets.webhook !== null, secrets.webhook, input.status ?? null,
          input.isDefault ?? null, input.metadata === undefined ? null : JSON.stringify(input.metadata),
        ],
      );
      return mapGateway(result.rows[0]);
    });
  }

  async archive(companyId: number, gatewayId: number): Promise<boolean> {
    return this.mutate(companyId, async (db) => {
      const result = await db.query(
        `UPDATE payment_gateways
         SET status = 'archived', is_default = false, credentials_json = '{}',
             webhook_secret = NULL, updated_at = NOW()
         WHERE company_id = $1 AND id = $2 AND status <> 'archived'`,
        [companyId, gatewayId],
      );
      return result.rowCount === 1;
    });
  }

  private async find(db: Queryable, companyId: number, gatewayId: number): Promise<Row | null> {
    const result = await db.query(
      `SELECT * FROM payment_gateways WHERE company_id = $1 AND id = $2 AND status <> 'archived'`,
      [companyId, gatewayId],
    );
    return result.rows[0] ?? null;
  }

  private async mutate<T>(companyId: number, write: (db: Queryable) => Promise<T>): Promise<T> {
    return this.uow.run(companyId, async (db) => {
      // Serialize changes to the company's singleton default without locking other tenant catalogs.
      await db.query('SELECT pg_advisory_xact_lock(1843925584, $1::int)', [companyId]);
      return write(db);
    });
  }

  private async clearDefault(db: Queryable, companyId: number, exceptId?: number): Promise<void> {
    await db.query(
      `UPDATE payment_gateways SET is_default = false, updated_at = NOW()
       WHERE company_id = $1 AND is_default AND ($2::bigint IS NULL OR id <> $2)`,
      [companyId, exceptId ?? null],
    );
  }

  private secrets(companyId: number, gatewayId: string, input: Partial<PaymentGatewayInput>) {
    const credentials = input.credentials === null
      ? '{}'
      : input.credentials && Object.keys(input.credentials).length > 0
        ? JSON.stringify({ vault: encrypt(companyId, gatewayId, 'credentials', input.credentials) })
        : null;
    const webhook = input.webhookSecret
      ? encrypt(companyId, gatewayId, 'webhookSecret', input.webhookSecret)
      : null;
    return { credentials, webhook };
  }
}
