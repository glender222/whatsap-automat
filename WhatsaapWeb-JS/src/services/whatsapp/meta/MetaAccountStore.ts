import { Pool } from 'pg';
import pool from '../../../config/database';
import config from '../../../config/index';
import { TenantScopedUoW } from '../../../db/TenantScopedUoW';
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

  async ensureEnvAccount(companyId: number, metaConfig: any): Promise<Record<string, unknown> | null> {
    if (!metaConfig.phoneNumberId) return null;

    const encryptedToken = metaConfig.accessToken && this.cipher
      ? this.cipher.encrypt(metaConfig.accessToken)
      : null;
    return this.upsertConnection(companyId, {
      phoneNumberId: metaConfig.phoneNumberId,
      accessToken: metaConfig.accessToken || null,
      wabaId: metaConfig.wabaId || null,
      displayPhoneNumber: metaConfig.displayPhoneNumber || null,
      businessPhoneNumber: metaConfig.displayPhoneNumber || null,
      graphVersion: metaConfig.graphVersion || 'v25.0',
      webhookVerifyToken: metaConfig.webhookVerifyToken || null,
      status: metaConfig.accessToken ? 'connected' : 'missing_token',
      metadata: { source: 'env' },
    }, encryptedToken, { preserveExistingToken: true });
  }

  async upsertConnection(
    companyId: number,
    input: MetaConnectionInput,
    preEncryptedToken?: string | null,
    options: { preserveExistingToken?: boolean } = {}
  ): Promise<Record<string, unknown>> {
    const encryptedToken = preEncryptedToken !== undefined
      ? preEncryptedToken
      : input.accessToken && this.cipher
        ? this.cipher.encrypt(input.accessToken)
        : null;
    const tokenLastFour = encryptedToken ? lastFour(input.accessToken) : null;
    const status = input.status || (input.accessToken ? 'connected' : 'missing_token');

    const result = await this.query(companyId,
      `INSERT INTO whatsapp_business_accounts (
         company_id, provider, waba_id, phone_number_id,
         display_phone_number, business_phone_number, graph_version,
         token_secret_ref, access_token_encrypted, token_last_four,
         token_configured_at, app_id, meta_business_id, webhook_verify_token,
         status, connected_at, disconnected_at, metadata_json, updated_at
       )
       VALUES (
         $1, 'meta-cloud', $2, $3,
         $4, $5, $6,
         $7, $8, $9,
         CASE WHEN $8::text IS NOT NULL THEN NOW() ELSE NULL END,
         $10, $11, $12,
         $13::varchar(50), CASE WHEN $13::varchar(50) IN ('connected', 'configured') THEN NOW() ELSE NULL END,
         NULL, $14::jsonb, NOW()
       )
       ON CONFLICT (company_id, provider, phone_number_id)
       DO UPDATE SET
         waba_id = COALESCE(EXCLUDED.waba_id, whatsapp_business_accounts.waba_id),
         display_phone_number = COALESCE(EXCLUDED.display_phone_number, whatsapp_business_accounts.display_phone_number),
         business_phone_number = COALESCE(EXCLUDED.business_phone_number, whatsapp_business_accounts.business_phone_number),
         graph_version = COALESCE(EXCLUDED.graph_version, whatsapp_business_accounts.graph_version),
         token_secret_ref = CASE
           WHEN $15::boolean AND whatsapp_business_accounts.access_token_encrypted IS NOT NULL
             THEN whatsapp_business_accounts.token_secret_ref
           ELSE COALESCE(EXCLUDED.token_secret_ref, whatsapp_business_accounts.token_secret_ref)
         END,
         access_token_encrypted = CASE
           WHEN $15::boolean AND whatsapp_business_accounts.access_token_encrypted IS NOT NULL
             THEN whatsapp_business_accounts.access_token_encrypted
           ELSE COALESCE(EXCLUDED.access_token_encrypted, whatsapp_business_accounts.access_token_encrypted)
         END,
         token_last_four = CASE
           WHEN $15::boolean AND whatsapp_business_accounts.access_token_encrypted IS NOT NULL
             THEN whatsapp_business_accounts.token_last_four
           ELSE COALESCE(EXCLUDED.token_last_four, whatsapp_business_accounts.token_last_four)
         END,
         token_configured_at = CASE
           WHEN $15::boolean AND whatsapp_business_accounts.access_token_encrypted IS NOT NULL THEN whatsapp_business_accounts.token_configured_at
           WHEN EXCLUDED.access_token_encrypted IS NOT NULL THEN NOW()
           ELSE whatsapp_business_accounts.token_configured_at
         END,
         app_id = COALESCE(EXCLUDED.app_id, whatsapp_business_accounts.app_id),
         meta_business_id = COALESCE(EXCLUDED.meta_business_id, whatsapp_business_accounts.meta_business_id),
         webhook_verify_token = COALESCE(EXCLUDED.webhook_verify_token, whatsapp_business_accounts.webhook_verify_token),
         status = CASE
           WHEN $15::boolean AND whatsapp_business_accounts.access_token_encrypted IS NOT NULL THEN whatsapp_business_accounts.status
           ELSE EXCLUDED.status
         END,
         connected_at = CASE
           WHEN EXCLUDED.status IN ('connected', 'configured') THEN COALESCE(whatsapp_business_accounts.connected_at, NOW())
           ELSE whatsapp_business_accounts.connected_at
         END,
         disconnected_at = NULL,
         last_error_message = NULL,
         metadata_json = COALESCE(whatsapp_business_accounts.metadata_json, '{}'::jsonb) || EXCLUDED.metadata_json,
         updated_at = NOW()
       RETURNING *`,
      [
        companyId,
        input.wabaId || null,
        input.phoneNumberId,
        input.displayPhoneNumber || null,
        input.businessPhoneNumber || input.displayPhoneNumber || null,
        input.graphVersion || config.meta.graphVersion || 'v25.0',
        encryptedToken ? 'db:encrypted' : 'META_WA_ACCESS_TOKEN',
        encryptedToken,
        tokenLastFour,
        input.appId || null,
        input.businessId || null,
        input.webhookVerifyToken || null,
        status,
        json(input.metadata || {}),
        Boolean(options.preserveExistingToken),
      ]
    );

    return result.rows[0];
  }

  async getAccountForCompany(companyId: number): Promise<Record<string, any> | null> {
    const result = await this.query(companyId,
      `SELECT *
       FROM whatsapp_business_accounts
       WHERE company_id = $1
         AND provider = 'meta-cloud'
         AND status <> 'disconnected'
       ORDER BY
         CASE status WHEN 'connected' THEN 0 WHEN 'configured' THEN 1 WHEN 'missing_token' THEN 2 ELSE 3 END,
         updated_at DESC
       LIMIT 1`,
      [companyId]
    );
    return result.rows[0] || null;
  }

  async findByPhoneNumberId(phoneNumberId: string): Promise<{ company_id: number } | null> {
    return this.webhookWork.transaction(async ({ client }) => {
      await client.query("SELECT set_config('app.verified_meta_phone_number', $1, true)", [phoneNumberId]);
      const { rows } = await client.query(
        `SELECT company_id
         FROM whatsapp_business_accounts
         WHERE provider = 'meta-cloud' AND phone_number_id = $1 AND status <> 'disconnected'
         LIMIT 2`,
        [phoneNumberId]
      );
      return rows.length === 1 ? rows[0] : null;
    });
  }

  async disconnect(companyId: number): Promise<void> {
    await this.query(companyId,
      `UPDATE whatsapp_business_accounts
       SET status = 'disconnected',
           disconnected_at = NOW(),
           updated_at = NOW()
       WHERE company_id = $1 AND provider = 'meta-cloud'`,
      [companyId]
    );
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
    if (!account) {
      if (!fallbackAllowed || !config.meta.phoneNumberId) return null;
      return config.meta;
    }

    let accessToken = '';
    if (account.access_token_encrypted && this.cipher) {
      accessToken = this.cipher.decrypt(account.access_token_encrypted);
    } else if (fallbackAllowed) {
      accessToken = config.meta.accessToken || '';
    }

    return {
      graphVersion: account.graph_version || config.meta.graphVersion,
      accessToken,
      phoneNumberId: account.phone_number_id,
      wabaId: account.waba_id || undefined,
      displayPhoneNumber: account.display_phone_number || undefined,
      webhookVerifyToken: account.webhook_verify_token || config.meta.webhookVerifyToken,
      appSecret: config.meta.appSecret,
      requestTimeoutMs: config.meta.requestTimeoutMs,
    };
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
      tokenConfigured: Boolean(account.access_token_encrypted || account.token_secret_ref),
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
