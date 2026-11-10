import { Pool } from 'pg';
import pool from '../../../config/database';
import config from '../../../config/index';
import { TenantScopedUoW } from '../../../db/TenantScopedUoW';
import type { Queryable } from '../../../shared/UnitOfWorkPort';
import { PgUnitOfWork } from '../../../shared/PgUnitOfWork';
import SecretCipher from '../../security/SecretCipher';
import { MetaCloudConfig } from './MetaCloudClient';

function lastFour(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.slice(-4);
}

function json(value: unknown): string {
  return JSON.stringify(value || {});
}

export interface MetaConnectionInput {
  phoneNumberId: string;
  accessToken?: string | null;
  wabaId?: string | null;
  displayPhoneNumber?: string | null;
  businessPhoneNumber?: string | null;
  graphVersion?: string | null;
  appId?: string | null;
  businessId?: string | null;
  webhookVerifyToken?: string | null;
  status?: string | null;
  metadata?: unknown;
}

export class MetaAccountStore {
  private readonly cipher: SecretCipher | null;
  private readonly tenantWork: TenantScopedUoW;
  private readonly webhookWork: PgUnitOfWork;

  constructor(db: Pool = pool as Pool) {
    this.cipher = config.security.tokenEncryptionKey ? new SecretCipher() : null;
    this.tenantWork = new TenantScopedUoW(db);
    this.webhookWork = new PgUnitOfWork(db);
  }

  private query(companyId: number, sql: string, parameters: unknown[]) {
    return this.tenantWork.run(companyId, (client) => client.query(sql, parameters));
  }

  private changeConnections<T>(companyId: number, change: (client: Queryable) => Promise<T>) {
    return this.tenantWork.run(companyId, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('meta-company-connection:' || $1::text, 0))", [companyId]);
      return change(client);
    });
  }

  async ensureEnvAccount(companyId: number, metaConfig: MetaCloudConfig): Promise<Record<string, unknown> | null> {
    if (companyId !== (config.defaultCompanyId || 1) || !metaConfig.phoneNumberId ||
        metaConfig.phoneNumberId !== config.meta.phoneNumberId) return null;

    try {
      return await this.persistConnection(companyId, {
        phoneNumberId: metaConfig.phoneNumberId,
        accessToken: metaConfig.accessToken || null,
        wabaId: metaConfig.wabaId || null,
        displayPhoneNumber: metaConfig.displayPhoneNumber || null,
        businessPhoneNumber: metaConfig.displayPhoneNumber || null,
        graphVersion: metaConfig.graphVersion || 'v25.0',
        webhookVerifyToken: metaConfig.webhookVerifyToken || null,
        status: metaConfig.accessToken ? 'connected' : 'missing_token',
        metadata: { source: 'env' },
      }, true);
    } catch (error) {
      const failure = error as { code?: string; constraint?: string } | undefined;
      if (failure?.code === '23505' && failure.constraint === 'uq_whatsapp_accounts_provider_phone_active') return null;
      throw error;
    }
  }

  async upsertConnection(companyId: number, input: MetaConnectionInput): Promise<Record<string, unknown>> {
    if (input.accessToken && !this.cipher) {
      throw Object.assign(new Error('El cifrado de credenciales de WhatsApp no está disponible.'), {
        statusCode: 503, code: 'META_CREDENTIAL_ENCRYPTION_UNAVAILABLE',
      });
    }
    const account = await this.persistConnection(companyId, input, false).catch((error) => {
      if (error?.code === '23505' && error?.constraint === 'uq_whatsapp_accounts_provider_phone_active') {
        throw Object.assign(new Error('La línea de WhatsApp ya está vinculada.'), {
          statusCode: 409, code: 'META_PHONE_ALREADY_LINKED',
        });
      }
      throw error;
    });
    if (!account) {
      throw Object.assign(new Error('Para reconectar WhatsApp Business, introduce un token.'), {
        statusCode: 409, code: 'META_RECONNECTION_TOKEN_REQUIRED',
      });
    }
    return account;
  }

  private async persistConnection(companyId: number, input: MetaConnectionInput, bootstrap: boolean): Promise<Record<string, unknown> | null> {
    const encryptedToken = input.accessToken && this.cipher ? this.cipher.encrypt(input.accessToken) : null;
    const tokenLastFour = encryptedToken ? lastFour(input.accessToken) : null;
    const status = input.status || (input.accessToken ? 'connected' : 'missing_token');

    const result = await this.changeConnections(companyId, (client) => client.query(
      `INSERT INTO whatsapp_business_accounts (
         company_id, provider, waba_id, phone_number_id,
         display_phone_number, business_phone_number, graph_version,
         token_secret_ref, access_token_encrypted, token_last_four,
         token_configured_at, app_id, meta_business_id, webhook_verify_token,
         status, connected_at, disconnected_at, metadata_json, updated_at
       )
       SELECT
         $1::integer, 'meta-cloud', $2, $3::varchar,
         $4, $5, $6,
         $7, $8, $9,
         CASE WHEN $8::text IS NOT NULL THEN NOW() ELSE NULL END,
         $10, $11, $12,
         $13::varchar(50), CASE WHEN $13::varchar(50) IN ('connected', 'configured') THEN NOW() ELSE NULL END,
         NULL, $14::jsonb, NOW()
       WHERE NOT $15::boolean OR NOT EXISTS (
         SELECT 1 FROM whatsapp_business_accounts
         WHERE company_id = $1 AND provider = 'meta-cloud' AND phone_number_id <> $3::varchar
       )
       ON CONFLICT (company_id, provider, phone_number_id)
       DO UPDATE SET
         waba_id = COALESCE(EXCLUDED.waba_id, whatsapp_business_accounts.waba_id),
         display_phone_number = COALESCE(EXCLUDED.display_phone_number, whatsapp_business_accounts.display_phone_number),
         business_phone_number = COALESCE(EXCLUDED.business_phone_number, whatsapp_business_accounts.business_phone_number),
         graph_version = COALESCE(EXCLUDED.graph_version, whatsapp_business_accounts.graph_version),
         token_secret_ref = COALESCE(EXCLUDED.token_secret_ref, whatsapp_business_accounts.token_secret_ref),
         access_token_encrypted = COALESCE(EXCLUDED.access_token_encrypted, whatsapp_business_accounts.access_token_encrypted),
         token_last_four = COALESCE(EXCLUDED.token_last_four, whatsapp_business_accounts.token_last_four),
         token_configured_at = CASE
           WHEN EXCLUDED.access_token_encrypted IS NOT NULL THEN NOW()
           ELSE whatsapp_business_accounts.token_configured_at
         END,
         app_id = COALESCE(EXCLUDED.app_id, whatsapp_business_accounts.app_id),
         meta_business_id = COALESCE(EXCLUDED.meta_business_id, whatsapp_business_accounts.meta_business_id),
         webhook_verify_token = COALESCE(EXCLUDED.webhook_verify_token, whatsapp_business_accounts.webhook_verify_token),
         status = CASE
           WHEN $15::boolean OR EXCLUDED.access_token_encrypted IS NOT NULL THEN EXCLUDED.status
           ELSE whatsapp_business_accounts.status
         END,
         connected_at = CASE
           WHEN EXCLUDED.status IN ('connected', 'configured') THEN COALESCE(whatsapp_business_accounts.connected_at, NOW())
           ELSE whatsapp_business_accounts.connected_at
         END,
         disconnected_at = CASE WHEN EXCLUDED.access_token_encrypted IS NULL
           THEN whatsapp_business_accounts.disconnected_at ELSE NULL END,
         last_error_message = NULL,
         metadata_json = whatsapp_business_accounts.metadata_json || CASE
           WHEN NOT $15::boolean AND EXCLUDED.access_token_encrypted IS NULL THEN EXCLUDED.metadata_json - 'source'
           ELSE EXCLUDED.metadata_json END,
         updated_at = NOW()
       WHERE (NOT $15::boolean AND (
         EXCLUDED.access_token_encrypted IS NOT NULL OR
         (whatsapp_business_accounts.status <> 'disconnected' AND whatsapp_business_accounts.disconnected_at IS NULL)
       )) OR (
         $15::boolean AND whatsapp_business_accounts.status IN ('connected', 'configured', 'missing_token', 'verification_required')
         AND whatsapp_business_accounts.disconnected_at IS NULL
         AND whatsapp_business_accounts.access_token_encrypted IS NULL
         AND whatsapp_business_accounts.metadata_json ->> 'source' = 'env'
       )
       RETURNING *`,
      [
        companyId,
        input.wabaId || null,
        input.phoneNumberId,
        input.displayPhoneNumber || null,
        input.businessPhoneNumber || input.displayPhoneNumber || null,
        input.graphVersion || config.meta.graphVersion || 'v25.0',
        encryptedToken ? 'db:encrypted' : bootstrap ? 'META_WA_ACCESS_TOKEN' : null,
        encryptedToken,
        tokenLastFour,
        input.appId || null,
        input.businessId || null,
        input.webhookVerifyToken || null,
        status,
        json(input.metadata || {}),
        bootstrap,
      ]
    ));

    return result.rows[0] ?? null;
  }

  async getAccountForCompany(companyId: number): Promise<Record<string, any> | null> {
    const result = await this.query(companyId,
      `SELECT *
       FROM whatsapp_business_accounts
       WHERE company_id = $1
         AND provider = 'meta-cloud'
       ORDER BY
         CASE status WHEN 'connected' THEN 0 WHEN 'configured' THEN 1 WHEN 'verification_required' THEN 2 WHEN 'missing_token' THEN 3 WHEN 'disconnected' THEN 5 ELSE 4 END,
         updated_at DESC
       LIMIT 1`,
      [companyId]
    );
    return result.rows[0] || null;
  }

  async getAccountForCompanyPhone(companyId: number, phoneNumberId: string): Promise<Record<string, any> | null> {
    const result = await this.query(companyId,
      `SELECT *
       FROM whatsapp_business_accounts
       WHERE company_id = $1 AND phone_number_id = $2 AND provider = 'meta-cloud'
         AND status IN ('connected', 'configured') AND disconnected_at IS NULL`,
      [companyId, phoneNumberId]
    );
    return result.rows[0] ?? null;
  }

  async findByPhoneNumberId(phoneNumberId: string): Promise<{ company_id: number } | null> {
    return this.webhookWork.transaction(async ({ client }) => {
      await client.query("SELECT set_config('app.verified_meta_phone_number', $1, true)", [phoneNumberId]);
      const { rows } = await client.query(
        `SELECT company_id
         FROM whatsapp_business_accounts
         WHERE provider = 'meta-cloud' AND phone_number_id = $1
           AND status IN ('configured', 'connected') AND disconnected_at IS NULL
         LIMIT 2`,
        [phoneNumberId]
      );
      return rows.length === 1 ? rows[0] : null;
    });
  }

  async disconnect(companyId: number): Promise<void> {
    await this.changeConnections(companyId, async (client) => {
      const result = await client.query(
        `UPDATE whatsapp_business_accounts
         SET status = 'disconnected',
             disconnected_at = COALESCE(disconnected_at, NOW()),
             access_token_encrypted = NULL,
             token_secret_ref = NULL,
             token_last_four = NULL,
             token_configured_at = NULL,
             updated_at = NOW()
         WHERE company_id = $1 AND provider = 'meta-cloud'`,
        [companyId],
      );
      // A concurrent first bootstrap must also honor an explicit disconnect.
      if (result.rowCount === 0 && companyId === (config.defaultCompanyId || 1) && config.meta.phoneNumberId) {
        await client.query(
          `INSERT INTO whatsapp_business_accounts (company_id, provider, phone_number_id, status, disconnected_at)
           VALUES ($1, 'meta-cloud', $2, 'disconnected', NOW())`,
          [companyId, config.meta.phoneNumberId],
        );
      }
    });
  }

  async recordLastError(companyId: number, message: string | null): Promise<void> {
    await this.query(companyId,
      `UPDATE whatsapp_business_accounts
       SET last_error_message = $2,
           updated_at = NOW()
       WHERE company_id = $1
         AND provider = 'meta-cloud'
         AND status <> 'disconnected'`,
      [companyId, message ? message.slice(0, 1000) : null]
    );
  }

  toClientConfig(account: Record<string, any> | null, fallbackAllowed = false): MetaCloudConfig | null {
    if (!account || account.status === 'disconnected' || account.disconnected_at ||
        (fallbackAllowed && !['connected', 'configured'].includes(account.status))) return null;

    if (fallbackAllowed && !account.access_token_encrypted) {
      const accessToken = this.envAccessToken(account);
      if (accessToken) return { ...config.meta, accessToken, displayPhoneNumber: account.display_phone_number || config.meta.displayPhoneNumber };
    }

    return {
      graphVersion: account.graph_version || config.meta.graphVersion,
      accessToken: account.access_token_encrypted ? this.cipher?.decrypt(account.access_token_encrypted) || '' : '',
      phoneNumberId: account.phone_number_id,
      wabaId: account.waba_id || undefined,
      displayPhoneNumber: account.display_phone_number || undefined,
      webhookVerifyToken: account.webhook_verify_token || config.meta.webhookVerifyToken,
      appSecret: config.meta.appSecret,
      requestTimeoutMs: config.meta.requestTimeoutMs,
    };
  }

  private envAccessToken(account: Record<string, any>): string {
    return !this.cipher && account.provider === 'meta-cloud' && account.company_id === (config.defaultCompanyId || 1) &&
      account.phone_number_id === config.meta.phoneNumberId && account.metadata_json?.source === 'env' &&
      account.token_secret_ref === 'META_WA_ACCESS_TOKEN' ? config.meta.accessToken || '' : '';
  }

  sanitize(account: Record<string, any> | null): Record<string, unknown> | null {
    if (!account) return null;
    return {
      id: account.id,
      companyId: account.company_id,
      provider: account.provider,
      wabaId: account.waba_id,
      phoneNumberId: account.phone_number_id,
      displayPhoneNumber: account.display_phone_number,
      businessPhoneNumber: account.business_phone_number,
      graphVersion: account.graph_version,
      appId: account.app_id,
      businessId: account.meta_business_id,
      status: account.status,
      tokenConfigured: ['connected', 'configured'].includes(account.status) && !account.disconnected_at &&
        Boolean(account.access_token_encrypted ? this.cipher : this.envAccessToken(account)),
      tokenLastFour: account.token_last_four || null,
      tokenConfiguredAt: account.token_configured_at,
      webhookVerifyTokenConfigured: Boolean(account.webhook_verify_token || config.meta.webhookVerifyToken),
      lastErrorMessage: account.last_error_message || null,
      connectedAt: account.connected_at,
      disconnectedAt: account.disconnected_at,
      updatedAt: account.updated_at,
    };
  }
}

export default MetaAccountStore;
