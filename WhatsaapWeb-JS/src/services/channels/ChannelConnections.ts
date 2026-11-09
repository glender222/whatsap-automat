import {
  CHANNEL_KINDS,
  type ChannelCapability,
  type ChannelConnectionHealthV1,
  type ChannelConnectionV1,
  type ChannelKind,
  type ConnectionStatus,
} from '@whatsap-automat/contracts';
import { TenantScopedUoW, tenantScopedUoW } from '../../db/TenantScopedUoW';
import { MetaCloudClient } from '../whatsapp/meta/MetaCloudClient';
import MetaAccountStore from '../whatsapp/meta/MetaAccountStore';

type ProbeError = 'META_AUTH_ERROR' | 'META_PERMISSION_ERROR' | 'META_ACCOUNT_MISMATCH' |
  'META_PROVIDER_UNAVAILABLE' | 'META_CREDENTIAL_UNREADABLE';

type ConnectionRow = {
  id: string;
  tenant_id: number;
  channel: ChannelKind;
  account_id: string;
  name: string | null;
  status: ConnectionStatus;
  created_at: Date;
  updated_at: Date;
  meta_id: string | null;
  meta_status: string | null;
  graph_version: string | null;
  has_encrypted_token: boolean;
  diagnostic_checked_at: Date | null;
  diagnostic_error_code: ProbeError | null;
};

type ProbeRow = ConnectionRow & {
  phone_number_id: string | null;
  access_token_encrypted: string | null;
  credential_updated_at: string | null;
  probe_started_at: string;
};

const whatsappCapabilities: readonly ChannelCapability[] = [
  'text', 'image', 'audio', 'video', 'document', 'template', 'read-receipt',
];
const selectedColumns = `
  c.id, c.tenant_id, c.channel, c.account_id, c.name, c.status, c.created_at, c.updated_at,
  a.id AS meta_id, a.status AS meta_status, a.graph_version,
  a.access_token_encrypted IS NOT NULL AS has_encrypted_token,
  a.diagnostic_checked_at, a.diagnostic_error_code
`;
const connectionJoin = `
  FROM channel_connections c
  LEFT JOIN whatsapp_business_accounts a
    ON c.channel = 'whatsapp-cloud' AND a.provider = 'meta-cloud'
    AND a.company_id = c.tenant_id AND a.phone_number_id = c.account_id
`;

function localError(row: ConnectionRow): string | null {
  if (row.channel !== 'whatsapp-cloud') return 'CHANNEL_UNSUPPORTED';
  if (row.status === 'inactive' || row.meta_status === 'disconnected') return 'CONNECTION_INACTIVE';
  if (!row.meta_id) return 'META_ACCOUNT_NOT_CONNECTED';
  if (row.meta_status === 'missing_token' || !row.has_encrypted_token) return 'META_CREDENTIAL_MISSING';
  if (row.meta_status !== 'configured' && row.meta_status !== 'connected') return 'META_ACCOUNT_UNAVAILABLE';
  if (!/^\d+$/.test(row.account_id) || !/^v\d+\.\d+$/.test(row.graph_version ?? '')) return 'META_ACCOUNT_INVALID';
  return null;
}

function healthFor(row: ConnectionRow): ChannelConnectionHealthV1 {
  const problem = localError(row);
  if (problem) return { configured: false, authorized: false, lastErrorCode: problem, lastCheckedAt: null };
  return {
    configured: row.diagnostic_error_code !== 'META_CREDENTIAL_UNREADABLE',
    authorized: row.diagnostic_checked_at !== null && row.diagnostic_error_code === null,
    lastErrorCode: row.diagnostic_checked_at ? row.diagnostic_error_code : 'VALIDATION_REQUIRED',
    lastCheckedAt: row.diagnostic_checked_at?.toISOString() ?? null,
  };
}

function displayStatus(row: ConnectionRow, health: ChannelConnectionHealthV1): ConnectionStatus {
  switch (health.lastErrorCode) {
    case null:
      return row.status;
    case 'CHANNEL_UNSUPPORTED':
    case 'CONNECTION_INACTIVE':
    case 'META_ACCOUNT_NOT_CONNECTED':
      return 'inactive';
    case 'VALIDATION_REQUIRED':
      return row.status === 'active' ? 'inactive' : row.status;
    case 'META_AUTH_ERROR':
    case 'META_PERMISSION_ERROR':
    case 'META_CREDENTIAL_MISSING':
    case 'META_CREDENTIAL_UNREADABLE':
      return 'needs_reauthorization';
    default:
      return 'error';
  }
}

function toConnection(row: ConnectionRow): ChannelConnectionV1 {
  const health = healthFor(row);
  return {
    id: row.id,
    tenantId: String(row.tenant_id),
    channel: row.channel,
    name: row.name || (row.channel === 'whatsapp-cloud' ? 'WhatsApp Cloud' : row.channel),
    externalAccountId: row.account_id,
    status: displayStatus(row, health),
    capabilities: row.channel === 'whatsapp-cloud' ? whatsappCapabilities : [],
    health,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export class ChannelConnections {
  constructor(
    private readonly uow: TenantScopedUoW = tenantScopedUoW,
    private readonly accounts = new MetaAccountStore(),
    private readonly fetchGraph?: typeof fetch,
  ) {}

  async list(tenantId: number, after: string, limit: number) {
    const { rows } = await this.uow.run(tenantId, (db) => db.query(`
      SELECT ${selectedColumns} ${connectionJoin}
      WHERE c.tenant_id = $1 AND c.id > $2 AND c.channel = ANY($3::text[])
      ORDER BY c.id LIMIT $4
    `, [tenantId, after, CHANNEL_KINDS, limit + 1]));
    const items = (rows as ConnectionRow[]).slice(0, limit).map(toConnection);
    return { items, nextCursor: rows.length > limit ? items[items.length - 1].id : null };
  }

  async get(tenantId: number, id: string): Promise<ChannelConnectionV1 | null> {
    const { rows } = await this.uow.run(tenantId, (db) => db.query(`
      SELECT ${selectedColumns} ${connectionJoin}
      WHERE c.tenant_id = $1 AND c.id = $2 AND c.channel = ANY($3::text[])
    `, [tenantId, id, CHANNEL_KINDS]));
    return rows.length ? toConnection(rows[0] as ConnectionRow) : null;
  }

  async validate(tenantId: number, id: string): Promise<ChannelConnectionHealthV1 | null> {
    const found = await this.uow.run(tenantId, (db) => db.query(`
      SELECT ${selectedColumns}, a.phone_number_id, a.access_token_encrypted,
        a.updated_at::text AS credential_updated_at, clock_timestamp()::text AS probe_started_at
      ${connectionJoin}
      WHERE c.tenant_id = $1 AND c.id = $2
    `, [tenantId, id]));
    const row = found.rows[0] as ProbeRow | undefined;
    if (!row) return null;
    if (localError(row)) return healthFor(row);

    const code = await this.probe(row);
    const saved = await this.uow.run(tenantId, (db) => db.query(`
      UPDATE whatsapp_business_accounts a
      SET diagnostic_checked_at = $3::timestamptz, diagnostic_error_code = $4
      FROM channel_connections c
      WHERE c.tenant_id = $1 AND c.id = $2 AND c.channel = 'whatsapp-cloud' AND c.status <> 'inactive'
        AND a.id = $5 AND a.company_id = c.tenant_id AND a.phone_number_id = c.account_id
        AND a.provider = 'meta-cloud' AND a.status = $6 AND a.graph_version = $7
        AND a.updated_at = $8::timestamptz AND a.access_token_encrypted = $9
        AND (a.diagnostic_checked_at IS NULL OR a.diagnostic_checked_at < $3::timestamptz)
      RETURNING a.diagnostic_checked_at
    `, [tenantId, id, row.probe_started_at, code, row.meta_id, row.meta_status, row.graph_version,
      row.credential_updated_at, row.access_token_encrypted]));
    if (!saved.rows.length) {
      return { configured: false, authorized: false, lastErrorCode: 'CHECK_SUPERSEDED', lastCheckedAt: null };
    }
    return healthFor({ ...row, diagnostic_checked_at: saved.rows[0].diagnostic_checked_at, diagnostic_error_code: code });
  }

  private async probe(row: ProbeRow): Promise<ProbeError | null> {
    let config;
    try {
      config = this.accounts.toClientConfig(row, false);
    } catch {
      return 'META_CREDENTIAL_UNREADABLE';
    }
    if (!config?.accessToken) return 'META_CREDENTIAL_UNREADABLE';

    try {
      const accessible = await new MetaCloudClient(config, this.fetchGraph).verifyPhoneAccess();
      return accessible ? null : 'META_ACCOUNT_MISMATCH';
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if (code === 'META_AUTH_ERROR' || code === 'META_PERMISSION_ERROR') return code;
      return 'META_PROVIDER_UNAVAILABLE';
    }
  }
}
