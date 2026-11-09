import { SendMessageCommandV1, SendMessageResultV1 } from '@whatsap-automat/contracts';
import { TenantScopedUoW, tenantScopedUoW } from '../../db/TenantScopedUoW';
import { Queryable } from '../../shared/UnitOfWorkPort';
import MetaAccountStore from '../whatsapp/meta/MetaAccountStore';
import { isDefiniteMetaMessageRejection, MetaCloudClient, type MetaSendResult } from '../whatsapp/meta/MetaCloudClient';
import { CampaignRequestError } from './CampaignRequestError';

export const defaultWhatsAppCampaignLanguage = 'es_CO';

export class WhatsAppCampaignTransport {
  constructor(
    private readonly accounts = new MetaAccountStore(),
    private readonly uow: TenantScopedUoW = tenantScopedUoW,
  ) {}

  async resolveConnection(client: Queryable, tenantId: number, selectedId?: string | null) {
    let connectionId = selectedId;
    if (!connectionId) {
      const accounts = await client.query(
        `SELECT phone_number_id FROM whatsapp_business_accounts
         WHERE company_id = $1 AND provider = 'meta-cloud'
           AND status IN ('configured', 'connected') AND access_token_encrypted IS NOT NULL
         ORDER BY phone_number_id LIMIT 2`,
        [tenantId],
      );
      if (accounts.rows.length > 1) {
        throw new CampaignRequestError(409, 'CAMPAIGN_CONNECTION_REQUIRED', 'Selecciona una conexión de WhatsApp para esta campaña.');
      }
      if (accounts.rows.length === 1) {
        const phoneId = accounts.rows[0].phone_number_id;
        await client.query(
          `INSERT INTO channel_connections (id, tenant_id, channel, account_id)
           VALUES ($1, $2, 'whatsapp-cloud', $3)
           ON CONFLICT (tenant_id, channel, account_id) DO NOTHING`,
          [`wa-meta-${tenantId}-${phoneId}`, tenantId, phoneId],
        );
        const result = await client.query(
          `SELECT id FROM channel_connections
           WHERE tenant_id = $1 AND channel = 'whatsapp-cloud' AND account_id = $2`,
          [tenantId, phoneId],
        );
        connectionId = result.rows[0]?.id;
      }
    }
    const account = await this.findAccount(client, tenantId, connectionId);
    this.configuredClient(account);
    return { id: account.connection_id as string, accountId: account.phone_number_id as string };
  }

  async send(command: SendMessageCommandV1, expectedAccountId: string): Promise<SendMessageResultV1> {
    const client = await this.uow.run(command.tenantId, async (database) => {
      const account = await this.findAccount(database, Number(command.tenantId), command.connectionId);
      if (account.phone_number_id !== expectedAccountId) throw this.accountUnavailable();
      return this.configuredClient(account);
    });
    const recipient = command.conversationId.trim().replace(/^\+/, '');
    if (!/^[1-9]\d{6,14}$/.test(recipient)) {
      throw new CampaignRequestError(400, 'INVALID_WHATSAPP_DESTINATION', 'El contacto requiere un número internacional válido.');
    }
    const message = command.message;
    if (message.kind !== 'text' && (message.kind !== 'template' || !message.templateId)) {
      throw new CampaignRequestError(400, 'INVALID_WHATSAPP_MESSAGE', 'Usa un mensaje de texto o una plantilla de WhatsApp.');
    }
    let result: MetaSendResult;
    try {
      result = message.kind === 'template' && message.templateId
        ? await client.sendTemplate(
          recipient,
          message.templateId,
          typeof message.parameters?.languageCode === 'string'
            ? message.parameters.languageCode
            : defaultWhatsAppCampaignLanguage,
          Array.isArray(message.parameters?.components) ? message.parameters.components : undefined,
          { redirect: 'error' },
        )
        : await client.sendText(recipient, message.text || '', { redirect: 'error' });
    } catch (error) {
      if (isDefiniteMetaMessageRejection(error)) {
        throw new CampaignRequestError(502, 'CAMPAIGN_PROVIDER_REJECTED', 'WhatsApp rechazó el mensaje.');
      }
      throw new CampaignRequestError(502, 'CAMPAIGN_PROVIDER_OUTCOME_UNKNOWN', 'No se confirmó el resultado del envío a WhatsApp.');
    }
    if (typeof result.providerMessageId !== 'string' || !result.providerMessageId.trim()) {
      throw new CampaignRequestError(502, 'CAMPAIGN_PROVIDER_ACK_MISSING', 'El proveedor no devolvió un identificador de envío.');
    }
    return {
      providerMessageId: result.providerMessageId,
      accepted: true,
      rawStatus: 'accepted',
      deliveryState: 'provider_accepted',
    };
  }

  private async findAccount(client: Queryable, tenantId: number, connectionId?: string | null) {
    if (!connectionId) throw this.accountUnavailable();
    const result = await client.query(
      `SELECT connection.id AS connection_id, account.*
       FROM channel_connections connection
       JOIN whatsapp_business_accounts account
         ON account.company_id = connection.tenant_id AND account.phone_number_id = connection.account_id
       WHERE connection.tenant_id = $1 AND connection.id = $2
         AND connection.channel = 'whatsapp-cloud' AND connection.status = 'active'
         AND account.provider = 'meta-cloud' AND account.status IN ('configured', 'connected')
         AND account.access_token_encrypted IS NOT NULL
       FOR SHARE OF connection, account`,
      [tenantId, connectionId],
    );
    if (!result.rows[0]) throw this.accountUnavailable();
    return result.rows[0];
  }

  private configuredClient(account: Record<string, unknown>): MetaCloudClient {
    try {
      const config = this.accounts.toClientConfig(account, false);
      if (config?.accessToken && /^\d+$/.test(config.phoneNumberId) && /^v\d+\.\d+$/.test(config.graphVersion)) {
        return new MetaCloudClient(config);
      }
    } catch {
      // An unreadable stored credential is equivalent to an unavailable account.
    }
    throw this.accountUnavailable();
  }

  private accountUnavailable() {
    return new CampaignRequestError(409, 'CAMPAIGN_WHATSAPP_NOT_CONNECTED', 'Conecta una cuenta activa de WhatsApp Business para esta empresa.');
  }
}
