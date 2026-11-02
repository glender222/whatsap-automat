import { SecretCipher } from '../../../security/SecretCipher';
import { tenantScopedUoW, TenantScopedUoW } from '../../../../db/TenantScopedUoW';
import { SsrfGuard } from '../../../temporal/activities/ssrfGuard';
import { maskApiKey } from './keyMasker';
import {
  ModelProvider,
  ByokCredentialSummaryV1,
  ResolvedCredential,
} from '../types';
import config from '../../../../config/index';

export class ByokService {
  constructor(
    private readonly cipher: SecretCipher = new SecretCipher(),
    private readonly uow: TenantScopedUoW = tenantScopedUoW
  ) {}

  /**
   * Encrypts and persists provider credentials for a tenant.
   * Performs mandatory SSRF pre-flight check on custom base URLs.
   */
  async saveCredential(
    tenantId: number,
    provider: ModelProvider,
    apiKey?: string,
    baseUrl?: string | null,
    defaultModel?: string | null
  ): Promise<{ keyFingerprint: string | null }> {
    // 1. SSRF pre-check on baseUrl for local endpoints
    if (baseUrl && baseUrl.trim().length > 0) {
      const ssrfResult = await SsrfGuard.validateUrl(baseUrl);
      if (!ssrfResult.safe) {
        const err = new Error(
          `SSRF_BLOCKED: Prohibited base URL '${baseUrl}': ${ssrfResult.reason}`
        ) as any;
        err.statusCode = 403;
        err.code = 'POLICY_DENIED';
        throw err;
      }
    }

    // 2. Encrypt API key with AES-256-GCM
    let encryptedKey: string | null = null;
    let fingerprint: string | null = null;
    if (apiKey && apiKey.trim().length > 0) {
      encryptedKey = this.cipher.encrypt(apiKey.trim());
      fingerprint = maskApiKey(apiKey);
    }

    // 3. Upsert into tenant_ai_providers within TenantScopedUoW
    await this.uow.run(tenantId, async (client) => {
      await client.query(
        `INSERT INTO tenant_ai_providers
          (tenant_id, provider, encrypted_api_key, key_fingerprint, base_url, default_model, is_active, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, true, NOW())
         ON CONFLICT (tenant_id, provider) DO UPDATE SET
           encrypted_api_key = COALESCE(EXCLUDED.encrypted_api_key, tenant_ai_providers.encrypted_api_key),
           key_fingerprint = COALESCE(EXCLUDED.key_fingerprint, tenant_ai_providers.key_fingerprint),
           base_url = EXCLUDED.base_url,
           default_model = COALESCE(EXCLUDED.default_model, tenant_ai_providers.default_model),
           is_active = true,
           updated_at = NOW()`,
        [tenantId, provider, encryptedKey, fingerprint, baseUrl || null, defaultModel || null]
      );
    });

    return { keyFingerprint: fingerprint };
  }

  /**
   * Resolves and decrypts the credentials for a provider.
   * If tenant has BYOK credentials configured, decrypts with authenticated tag verification.
   * Falls back to global configuration if no tenant BYOK key is set.
   */
  async resolveDecryptedCredential(
    tenantId: number,
    provider: ModelProvider
  ): Promise<ResolvedCredential> {
    const row = await this.uow.run(tenantId, async (client) => {
      const res = await client.query(
        `SELECT encrypted_api_key, base_url, default_model, is_active
         FROM tenant_ai_providers
         WHERE tenant_id = $1 AND provider = $2`,
        [tenantId, provider]
      );
      return res.rows[0];
    });

    if (row && row.is_active) {
      const decryptedKey = row.encrypted_api_key
        ? this.cipher.decrypt(row.encrypted_api_key)
        : null;
      return {
        apiKey: decryptedKey,
        baseUrl: row.base_url || null,
        defaultModel: row.default_model || null,
        isByok: Boolean(decryptedKey),
      };
    }

    // Check system/global fallback if BYOK not configured
    let fallbackApiKey: string | null = null;
    let fallbackDefaultModel: string | null = null;
    if (provider === 'openai') {
      fallbackApiKey = (config as any)?.ai?.openai?.apiKey || null;
      fallbackDefaultModel = 'gpt-4o';
    }

    return {
      apiKey: fallbackApiKey,
      baseUrl: null,
      defaultModel: fallbackDefaultModel,
      isByok: false,
    };
  }

  /**
   * Lists safe summaries of credentials for all supported providers.
   * Guaranteed zero secret leakage (no plaintext or encrypted keys returned).
   */
  async listCredentialSummaries(tenantId: number): Promise<ByokCredentialSummaryV1[]> {
    const rows = await this.uow.run(tenantId, async (client) => {
      const res = await client.query(
        `SELECT provider, key_fingerprint, base_url, default_model, is_active
         FROM tenant_ai_providers
         WHERE tenant_id = $1`,
        [tenantId]
      );
      return res.rows;
    });

    const supportedProviders: ModelProvider[] = ['openai', 'anthropic', 'local_openai'];
    const rowMap = new Map<string, any>(rows.map((r: any) => [r.provider, r]));

    return supportedProviders.map((provider) => {
      const record = rowMap.get(provider);
      return {
        tenantId,
        provider,
        isConfigured: Boolean(record && record.is_active),
        keyFingerprint: record ? record.key_fingerprint : null,
        baseUrl: record ? record.base_url : null,
        defaultModel: record ? record.default_model : null,
        isActive: record ? Boolean(record.is_active) : false,
      };
    });
  }

  /**
   * Deactivates or removes a provider credential.
   */
  async deactivateCredential(tenantId: number, provider: ModelProvider): Promise<void> {
    await this.uow.run(tenantId, async (client) => {
      await client.query(
        `UPDATE tenant_ai_providers
         SET is_active = false, updated_at = NOW()
         WHERE tenant_id = $1 AND provider = $2`,
        [tenantId, provider]
      );
    });
  }
}
