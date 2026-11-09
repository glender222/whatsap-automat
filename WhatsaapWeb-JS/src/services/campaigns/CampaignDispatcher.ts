import crypto from 'node:crypto';
import {
  CampaignDefinitionV1,
  CreateCampaignCommandV1,
  CampaignDeliveryV1,
  createCampaignCommandV1Schema,
  ChannelAdapterV1,
} from '@whatsap-automat/contracts';
import { TenantScopedUoW, tenantScopedUoW } from '../../db/TenantScopedUoW';
import config from '../../config';
import { ConsentService, consentService } from './ConsentService';
import { SegmentationService, segmentationService, RecipientRecord } from './SegmentationService';
import { CampaignRequestError } from './CampaignRequestError';
import { defaultWhatsAppCampaignLanguage, WhatsAppCampaignTransport } from './WhatsAppCampaignTransport';

const audienceLimit = 1000;

export interface DispatcherOptions {
  readonly skipPacingDelay?: boolean; // For deterministic unit tests
  readonly channelAdapters?: Map<string, ChannelAdapterV1>;
  readonly eventEmitter?: (event: string, payload: unknown) => void;
  readonly mockServiceWindowExpired?: (destination: string) => boolean;
  readonly whatsappTransport?: WhatsAppCampaignTransport;
}

export class CampaignDispatcher {
  private memoryCampaigns = new Map<string, CampaignDefinitionV1>();
  private memoryDeliveries = new Map<string, CampaignDeliveryV1>();
  private channelAdapters = new Map<string, ChannelAdapterV1>();

  constructor(
    private readonly uow: TenantScopedUoW | null = tenantScopedUoW,
    private readonly consent: ConsentService = consentService,
    private readonly segments: SegmentationService = segmentationService,
    private readonly options?: DispatcherOptions
  ) {
    if (options?.channelAdapters) {
      for (const [kind, adapter] of options.channelAdapters.entries()) {
        this.channelAdapters.set(kind, adapter);
      }
    }
  }

  registerAdapter(channel: string, adapter: ChannelAdapterV1): void {
    this.channelAdapters.set(channel, adapter);
  }

  async createCampaign(
    tenantId: number,
    rawInput: CreateCampaignCommandV1
  ): Promise<CampaignDefinitionV1> {
    const input = createCampaignCommandV1Schema.parse(rawInput);
    const name = input.name.trim();
    if (!name || name.length > 255) {
      throw new CampaignRequestError(400, 'INVALID_CAMPAIGN_NAME', 'El nombre de campaña debe tener entre 1 y 255 caracteres.');
    }
    const id = `cmp_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const now = new Date().toISOString();

    const campaign: CampaignDefinitionV1 = {
      id,
      tenantId,
      workspaceId: null,
      name,
      description: input.description || null,
      channel: input.channel,
      connectionId: input.connectionId || null,
      segmentId: input.segmentId || null,
      purpose: input.purpose || 'marketing',
      templateId: input.templateId || null,
      templateVariables: input.templateVariables || {},
      contentSubject: input.contentSubject || null,
      contentBody: input.contentBody || null,
      status: 'draft',
      rateLimitPerMinute: input.rateLimitPerMinute || 50,
      failurePauseThresholdPercent: input.failurePauseThresholdPercent ?? 5,
      pauseReason: null,
      scheduledAt: input.scheduledAt || null,
      startedAt: null,
      completedAt: null,
      statsTotal: 0,
      statsDispatched: 0,
      statsDelivered: 0,
      statsFailed: 0,
      statsSuppressed: 0,
      metadata: input.metadata || {},
      createdAt: now,
      updatedAt: now,
    };

    if (!this.uow) {
      this.memoryCampaigns.set(campaign.id, campaign);
      return campaign;
    }

    return await this.uow.run(tenantId, async (client) => {
      if (campaign.segmentId) {
        const segment = await client.query(
          'SELECT target_channel FROM segments WHERE tenant_id = $1 AND id = $2',
          [tenantId, campaign.segmentId],
        );
        const channel = segment.rows[0]?.target_channel;
        if (!channel) throw new CampaignRequestError(404, 'SEGMENT_NOT_FOUND', 'Segmento no encontrado.');
        if (channel !== 'any' && channel !== campaign.channel) {
          throw new CampaignRequestError(409, 'SEGMENT_CHANNEL_MISMATCH', 'El segmento pertenece a otro canal.');
        }
      }
      if (campaign.connectionId) {
        const connection = await client.query(
          'SELECT id FROM channel_connections WHERE tenant_id = $1 AND id = $2 AND channel = $3',
          [tenantId, campaign.connectionId, campaign.channel],
        );
        if (!connection.rows.length) throw new CampaignRequestError(404, 'CONNECTION_NOT_FOUND', 'Conexión no encontrada.');
      }
      const sql = `
        INSERT INTO campaigns (
          id, tenant_id, name, description, channel, connection_id, segment_id,
          purpose, template_id, template_variables, content_subject, content_body,
          status, rate_limit_per_minute, failure_pause_threshold_percent,
          scheduled_at, metadata_json, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12,
          $13, $14, $15, $16, $17::jsonb, NOW(), NOW()
        )
        RETURNING *;
      `;
      const res = await client.query(sql, [
        id,
        tenantId,
        campaign.name,
        campaign.description,
        campaign.channel,
        campaign.connectionId,
        campaign.segmentId,
        campaign.purpose,
        campaign.templateId,
        JSON.stringify(campaign.templateVariables),
        campaign.contentSubject,
        campaign.contentBody,
        campaign.status,
        campaign.rateLimitPerMinute,
        campaign.failurePauseThresholdPercent,
        campaign.scheduledAt,
        JSON.stringify(campaign.metadata),
      ]);
      const row = res.rows[0];
      const result: CampaignDefinitionV1 = {
        id: row.id,
        tenantId: Number(row.tenant_id),
        workspaceId: row.workspace_id ? Number(row.workspace_id) : null,
        name: row.name,
        description: row.description,
        channel: row.channel,
        connectionId: row.connection_id,
        segmentId: row.segment_id,
        purpose: row.purpose,
        templateId: row.template_id,
        templateVariables: typeof row.template_variables === 'string' ? JSON.parse(row.template_variables) : row.template_variables,
        contentSubject: row.content_subject,
        contentBody: row.content_body,
        status: row.status,
        rateLimitPerMinute: Number(row.rate_limit_per_minute),
        failurePauseThresholdPercent: Number(row.failure_pause_threshold_percent),
        pauseReason: row.pause_reason,
        scheduledAt: row.scheduled_at ? new Date(row.scheduled_at).toISOString() : null,
        startedAt: row.started_at ? new Date(row.started_at).toISOString() : null,
        completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
        statsTotal: Number(row.stats_total || 0),
        statsDispatched: Number(row.stats_dispatched || 0),
        statsDelivered: Number(row.stats_delivered || 0),
        statsFailed: Number(row.stats_failed || 0),
        statsSuppressed: Number(row.stats_suppressed || 0),
        metadata: typeof row.metadata_json === 'string' ? JSON.parse(row.metadata_json) : row.metadata_json,
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString(),
      };
      return result;
    });
  }

  async getCampaign(tenantId: number, campaignId: string): Promise<CampaignDefinitionV1 | null> {
    if (!this.uow) {
      const cmp = this.memoryCampaigns.get(campaignId);
      if (cmp && cmp.tenantId === tenantId) return cmp;
      return null;
    }

    return await this.uow.run(tenantId, async (client) => {
      const res = await client.query(
        `SELECT * FROM campaigns WHERE tenant_id = $1 AND id = $2 LIMIT 1;`,
        [tenantId, campaignId]
      );
      if (!res.rows[0]) return null;
      const row = res.rows[0];
      return {
        id: row.id,
        tenantId: Number(row.tenant_id),
        workspaceId: row.workspace_id ? Number(row.workspace_id) : null,
        name: row.name,
        description: row.description,
        channel: row.channel,
        connectionId: row.connection_id,
        segmentId: row.segment_id,
        purpose: row.purpose,
        templateId: row.template_id,
        templateVariables: typeof row.template_variables === 'string' ? JSON.parse(row.template_variables) : row.template_variables,
        contentSubject: row.content_subject,
        contentBody: row.content_body,
        status: row.status,
        rateLimitPerMinute: Number(row.rate_limit_per_minute),
        failurePauseThresholdPercent: Number(row.failure_pause_threshold_percent),
        pauseReason: row.pause_reason,
        scheduledAt: row.scheduled_at ? new Date(row.scheduled_at).toISOString() : null,
        startedAt: row.started_at ? new Date(row.started_at).toISOString() : null,
        completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
        statsTotal: Number(row.stats_total || 0),
        statsDispatched: Number(row.stats_dispatched || 0),
        statsDelivered: Number(row.stats_delivered || 0),
        statsFailed: Number(row.stats_failed || 0),
        statsSuppressed: Number(row.stats_suppressed || 0),
        metadata: typeof row.metadata_json === 'string' ? JSON.parse(row.metadata_json) : row.metadata_json,
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString(),
      };
    });
  }

  async listCampaigns(tenantId: number): Promise<CampaignDefinitionV1[]> {
    if (!this.uow) {
      const list: CampaignDefinitionV1[] = [];
      for (const cmp of this.memoryCampaigns.values()) {
        if (cmp.tenantId === tenantId) list.push(cmp);
      }
      return list;
    }

    return await this.uow.run(tenantId, async (client) => {
      const res = await client.query(
        `SELECT * FROM campaigns WHERE tenant_id = $1 ORDER BY created_at DESC;`,
        [tenantId]
      );
      return res.rows.map((row) => ({
        id: row.id,
        tenantId: Number(row.tenant_id),
        workspaceId: row.workspace_id ? Number(row.workspace_id) : null,
        name: row.name,
        description: row.description,
        channel: row.channel,
        connectionId: row.connection_id,
        segmentId: row.segment_id,
        purpose: row.purpose,
        templateId: row.template_id,
        templateVariables: typeof row.template_variables === 'string' ? JSON.parse(row.template_variables) : row.template_variables,
        contentSubject: row.content_subject,
        contentBody: row.content_body,
        status: row.status,
        rateLimitPerMinute: Number(row.rate_limit_per_minute),
        failurePauseThresholdPercent: Number(row.failure_pause_threshold_percent),
        pauseReason: row.pause_reason,
        scheduledAt: row.scheduled_at ? new Date(row.scheduled_at).toISOString() : null,
        startedAt: row.started_at ? new Date(row.started_at).toISOString() : null,
        completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
        statsTotal: Number(row.stats_total || 0),
        statsDispatched: Number(row.stats_dispatched || 0),
        statsDelivered: Number(row.stats_delivered || 0),
        statsFailed: Number(row.stats_failed || 0),
        statsSuppressed: Number(row.stats_suppressed || 0),
        metadata: typeof row.metadata_json === 'string' ? JSON.parse(row.metadata_json) : row.metadata_json,
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString(),
      }));
    });
  }

  /**
   * Prepares and executes campaign dispatch loop.
   * Enforces:
   * 1. Rate limiting / pacing (rateLimitPerMinute)
   * 2. Fail-closed consent verification
   * 3. WhatsApp 24h window gate check
   * 4. Circuit breaker auto-pause (> failurePauseThresholdPercent)
   */
  async executeCampaign(
    tenantId: number,
    campaignId: string,
    recipientsOverride?: RecipientRecord[],
    expectedReviewKey?: string,
  ): Promise<CampaignDefinitionV1> {
    const campaign = await this.getCampaign(tenantId, campaignId);
    if (!campaign) throw new CampaignRequestError(404, 'CAMPAIGN_NOT_FOUND', 'Campaña no encontrada.');
    if (campaign.status === 'completed') return campaign;
    if (campaign.status === 'dispatching' || campaign.status === 'cancelled' ||
        (campaign.scheduledAt && Date.parse(campaign.scheduledAt) > Date.now())) {
      throw new CampaignRequestError(409, 'CAMPAIGN_NOT_DISPATCHABLE', 'La campaña no está disponible para despacho.');
    }

    const adapter = this.channelAdapters.get(campaign.channel);
    const whatsapp = this.uow && !adapter && campaign.channel === 'whatsapp-cloud'
      ? this.options?.whatsappTransport
      : undefined;
    let send = adapter?.send.bind(adapter);
    let whatsappAccountId: string | undefined;
    if (!send && !whatsapp) {
      throw new CampaignRequestError(409, 'CAMPAIGN_CHANNEL_UNAVAILABLE', 'El canal todavía no tiene un transporte de campañas operativo.');
    }
    if (this.uow && recipientsOverride !== undefined) {
      throw new CampaignRequestError(400, 'CAMPAIGN_RECIPIENT_OVERRIDE', 'Selecciona la audiencia mediante un segmento de esta empresa.');
    }
    if (this.uow && !whatsapp && !campaign.connectionId) {
      throw new CampaignRequestError(409, 'CAMPAIGN_CONNECTION_REQUIRED', 'La campaña requiere una conexión de canal.');
    }
    if (!campaign.templateId && !campaign.contentBody?.trim()) {
      throw new CampaignRequestError(409, 'CAMPAIGN_CONTENT_REQUIRED', 'La campaña requiere contenido o una plantilla.');
    }

    const destinationKey = (destination: string) => this.destinationKey(campaign, destination);
    const recipients = await this.resolveAudience(campaign, recipientsOverride);
    if (recipients.length > audienceLimit) {
      throw new CampaignRequestError(409, 'CAMPAIGN_AUDIENCE_LIMIT', 'El segmento supera el límite de 1000 destinatarios.');
    }
    if (expectedReviewKey !== undefined && this.reviewKey(campaign, recipients) !== expectedReviewKey) {
      throw new CampaignRequestError(409, 'CAMPAIGN_AUDIENCE_CHANGED', 'La audiencia cambió. Revisa el segmento de nuevo antes de confirmar.');
    }

    const existingDeliveries = await this.getDeliveries(campaign.id, tenantId);
    if (recipients.length === 0 && existingDeliveries.length === 0) {
      throw new CampaignRequestError(409, 'CAMPAIGN_AUDIENCE_EMPTY', 'El segmento no tiene destinatarios aptos.');
    }
    const existingByDest = new Map(existingDeliveries.map((delivery) => [destinationKey(delivery.destination), delivery]));
    if (this.uow) {
      await this.uow.run(tenantId, async (client) => {
        if (whatsapp) {
          const selected = await whatsapp.resolveConnection(client, tenantId, campaign.connectionId);
          campaign.connectionId = selected.id;
          whatsappAccountId = selected.accountId;
          send = (command) => whatsapp.send(command, selected.accountId);
        }
        const connection = await client.query(
          `SELECT account_id FROM channel_connections
           WHERE tenant_id = $1 AND id = $2 AND channel = $3 AND status = 'active' FOR SHARE`,
          [tenantId, campaign.connectionId, campaign.channel],
        );
        if (!connection.rows.length) {
          throw new CampaignRequestError(409, 'CAMPAIGN_CONNECTION_UNAVAILABLE', 'La conexión de la campaña no está activa.');
        }
        if (campaign.channel === 'whatsapp-cloud' && campaign.templateId) {
          const language = campaign.templateVariables.languageCode ?? defaultWhatsAppCampaignLanguage;
          if (typeof language !== 'string' || !language.trim()) {
            throw new CampaignRequestError(409, 'CAMPAIGN_TEMPLATE_LANGUAGE_INVALID', 'El idioma de la plantilla no es válido.');
          }
          const template = await client.query(
            `SELECT 1 FROM whatsapp_message_templates template
             JOIN whatsapp_business_accounts account
               ON account.company_id = template.company_id AND account.provider = template.provider
               AND account.waba_id = template.waba_id
             WHERE template.company_id = $1 AND template.provider = 'meta-cloud'
               AND account.phone_number_id = $2 AND template.template_name = $3
               AND template.language_code = $4 AND UPPER(template.status) = 'APPROVED'`,
            [tenantId, connection.rows[0].account_id, campaign.templateId, language],
          );
          if (!template.rows.length) {
            throw new CampaignRequestError(409, 'CAMPAIGN_TEMPLATE_UNAVAILABLE', 'La conexión requiere una plantilla de WhatsApp aprobada en el idioma seleccionado.');
          }
        }
        const claim = await client.query(
          `UPDATE campaigns SET status = 'dispatching', started_at = COALESCE(started_at, NOW()), connection_id = $4, updated_at = NOW()
           WHERE tenant_id = $1 AND id = $2 AND status = $3 RETURNING id`,
          [tenantId, campaignId, campaign.status, campaign.connectionId],
        );
        if (!claim.rows.length) throw new CampaignRequestError(409, 'CAMPAIGN_ALREADY_CLAIMED', 'La campaña cambió durante el despacho.');
      });
    }
    if (!send) {
      throw new CampaignRequestError(409, 'CAMPAIGN_CHANNEL_UNAVAILABLE', 'El canal no tiene un transporte de campañas operativo.');
    }

    campaign.status = 'dispatching';
    campaign.startedAt = campaign.startedAt || new Date().toISOString();
    campaign.completedAt = null;
    campaign.pauseReason = null;
    campaign.statsTotal = new Set([...existingByDest.keys(), ...recipients.map(({ destination }) => destinationKey(destination))]).size;

    // Recalculate baseline stats from existing deliveries
    let statsDispatched = 0;
    let statsDelivered = 0;
    let statsFailed = 0;
    let statsSuppressed = 0;
    for (const del of existingDeliveries) {
      if (del.status === 'dispatched') statsDispatched++;
      else if (del.status === 'delivered') { statsDispatched++; statsDelivered++; }
      else if (del.status === 'suppressed') statsSuppressed++;
      else if (del.status === 'failed') statsFailed++;
    }
    campaign.statsDispatched = statsDispatched;
    campaign.statsDelivered = statsDelivered;
    campaign.statsFailed = statsFailed;
    campaign.statsSuppressed = statsSuppressed;

    let attemptDispatched = 0;
    let attemptFailed = 0;
    const evaluateCircuitBreaker = (): boolean => {
      if (campaign.status === 'paused') {
        return true;
      }
      const attempted = attemptDispatched + attemptFailed;
      if (attempted >= 5) {
        const failureRate = (attemptFailed / attempted) * 100;
        if (failureRate > campaign.failurePauseThresholdPercent) {
          campaign.status = 'paused';
          campaign.pauseReason = `High failure rate detected (${failureRate.toFixed(1)}% > ${campaign.failurePauseThresholdPercent}%)`;
          if (this.options?.eventEmitter) {
            this.options.eventEmitter('campaign.paused', {
              tenantId,
              campaignId,
              failureRate,
              pauseReason: campaign.pauseReason,
            });
          }
          return true;
        }
      }
      return false;
    };

    const pacingDelayMs = this.options?.skipPacingDelay
      ? 0
      : Math.floor(60_000 / campaign.rateLimitPerMinute);

    for (let i = 0; i < recipients.length; i++) {
      const recipient = recipients[i];
      const key = destinationKey(recipient.destination);
      const existing = existingByDest.get(key);
      // A pending delivery may already have reached the provider before an interruption.
      if (existing) continue;

      const deliveryId = `del_${crypto.randomUUID()}`;
      const idempotencyKey = crypto.createHash('sha256').update(campaign.id + ':' + key).digest('hex');

      // Circuit Breaker check before proceeding
      if (evaluateCircuitBreaker()) {
        break;
      }

      // 1. Consent Gate Check
      const consentResult = await this.consent.verifyConsent(
        tenantId,
        campaign.channel,
        recipient.destination,
        campaign.purpose
      );

      if (!consentResult.permitted) {
        campaign.statsSuppressed++;
        const delivery: CampaignDeliveryV1 = {
          id: deliveryId,
          campaignId,
          tenantId,
          contactId: recipient.contactId || null,
          destination: recipient.destination,
          idempotencyKey,
          status: 'suppressed',
          suppressionReason: consentResult.reason || 'SUPPRESSED',
          providerMessageId: null,
          errorCode: null,
          errorMessage: null,
          renderedPayload: {},
          dispatchedAt: null,
          deliveredAt: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        await this.saveDelivery(tenantId, delivery);
        continue;
      }

      // 2. WhatsApp 24-Hour Customer Care Window Check
      if (campaign.channel === 'whatsapp-cloud') {
        const isWindowExpired = this.uow
          ? !campaign.templateId && !await this.hasOpenWhatsAppWindow(tenantId, key, whatsappAccountId)
          : (this.options?.mockServiceWindowExpired?.(recipient.destination) ?? false);

        // If window is closed and no approved Meta template is used, block
        if (isWindowExpired && !campaign.templateId) {
          campaign.statsFailed++;
          attemptFailed++;
          const delivery: CampaignDeliveryV1 = {
            id: deliveryId,
            campaignId,
            tenantId,
            contactId: recipient.contactId || null,
            destination: recipient.destination,
            idempotencyKey,
            status: 'failed',
            suppressionReason: null,
            providerMessageId: null,
            errorCode: 'CH_WA_WINDOW_CLOSED',
            errorMessage: 'Cannot send free-form message outside 24h customer window without an approved template',
            renderedPayload: {},
            dispatchedAt: null,
            deliveredAt: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          await this.saveDelivery(tenantId, delivery);
          if (evaluateCircuitBreaker()) {
            break;
          }
          continue;
        }
      }

      const delivery: CampaignDeliveryV1 = {
        id: deliveryId,
        campaignId,
        tenantId,
        contactId: recipient.contactId || null,
        destination: recipient.destination,
        idempotencyKey,
        status: 'pending',
        renderedPayload: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await this.saveDelivery(tenantId, delivery);
      try {
        const result = await send({
          schemaVersion: 1,
          tenantId: String(tenantId),
          connectionId: campaign.connectionId || 'default',
          conversationId: recipient.destination,
          effectKey: idempotencyKey,
          expectedConversationVersion: 1,
          causedBy: { type: 'system', id: `campaign_${campaign.id}` },
          message: campaign.templateId
            ? { kind: 'template', templateId: campaign.templateId, parameters: campaign.templateVariables }
            : { kind: 'text', text: campaign.contentBody || '' },
        });
        if (!result.accepted) {
          throw new CampaignRequestError(502, 'CAMPAIGN_PROVIDER_REJECTED', 'El proveedor no aceptó el mensaje.');
        }
        if (!result.providerMessageId) {
          throw new CampaignRequestError(502, 'CAMPAIGN_PROVIDER_ACK_MISSING', 'El proveedor no devolvió un identificador de envío.');
        }
        delivery.status = 'dispatched';
        delivery.providerMessageId = result.providerMessageId;
        delivery.dispatchedAt = new Date().toISOString();
        campaign.statsDispatched++;
        attemptDispatched++;
      } catch (error) {
        delivery.status = 'failed';
        delivery.errorCode = error instanceof CampaignRequestError ? error.code : 'SEND_ERROR';
        delivery.errorMessage = 'No se confirmó el envío al proveedor.';
        campaign.statsFailed++;
        attemptFailed++;
      }
      await this.saveDelivery(tenantId, delivery);
      if (evaluateCircuitBreaker()) break;

      // Pacing delay (token bucket pacing)
      if (pacingDelayMs > 0 && i < recipients.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, pacingDelayMs));
      }
    }

    evaluateCircuitBreaker();

    if (campaign.status === 'dispatching') {
      if (existingDeliveries.some(({ status }) => status === 'pending')) {
        campaign.status = 'paused';
        campaign.pauseReason = 'Hay entregas sin confirmar que requieren conciliación.';
      } else if (campaign.statsTotal > 0 && campaign.statsDispatched === 0 && campaign.statsFailed > 0) {
        campaign.status = 'failed';
      } else {
        campaign.status = 'completed';
        campaign.completedAt = new Date().toISOString();
      }
    }
    campaign.updatedAt = new Date().toISOString();

    if (!this.uow) {
      this.memoryCampaigns.set(campaignId, campaign);
    } else {
      await this.uow.run(tenantId, async (client) => {
        await client.query(
          `UPDATE campaigns SET status = $1, started_at = $2, completed_at = $3,
            stats_total = $4, stats_dispatched = $5, stats_failed = $6, stats_suppressed = $7,
            pause_reason = $8, updated_at = NOW() WHERE tenant_id = $9 AND id = $10`,
          [
            campaign.status, campaign.startedAt, campaign.completedAt, campaign.statsTotal,
            campaign.statsDispatched, campaign.statsFailed, campaign.statsSuppressed, campaign.pauseReason,
            tenantId, campaignId,
          ],
        );
      });
    }
    return campaign;
  }

  async getDispatchReview(tenantId: number, campaignId: string) {
    const campaign = await this.getCampaign(tenantId, campaignId);
    if (!campaign) throw new CampaignRequestError(404, 'CAMPAIGN_NOT_FOUND', 'Campaña no encontrada.');
    const segment = campaign.segmentId ? await this.segments.getSegment(tenantId, campaign.segmentId) : null;
    const recipients = segment ? await this.resolveAudience(campaign) : [];
    const deliveries = campaign.startedAt ? await this.getDeliveries(campaignId, tenantId) : [];
    const attempted = new Set(deliveries.map(({ destination }) => this.destinationKey(campaign, destination)));
    return {
      campaignId,
      campaignStatus: campaign.status,
      segmentName: segment?.name ?? null,
      audienceCount: recipients.length,
      unattemptedCount: recipients.filter(({ destination }) => !attempted.has(this.destinationKey(campaign, destination))).length,
      audienceLimit,
      limitExceeded: recipients.length > audienceLimit,
      reviewKey: this.reviewKey(campaign, recipients),
      contentBody: campaign.contentBody,
      templateName: campaign.templateId,
      templateLanguage: campaign.templateId
        ? campaign.templateVariables.languageCode ?? defaultWhatsAppCampaignLanguage
        : null,
    };
  }

  private destinationKey(campaign: CampaignDefinitionV1, destination: string): string {
    return campaign.channel === 'whatsapp-cloud' ? destination.trim().replace(/^\+/, '') : destination;
  }

  private async resolveAudience(campaign: CampaignDefinitionV1, override?: RecipientRecord[]): Promise<RecipientRecord[]> {
    const recipients = override?.length ? override : campaign.segmentId
      ? await this.segments.resolveRecipients(Number(campaign.tenantId), campaign.segmentId, Number.MAX_SAFE_INTEGER, 0, campaign.channel)
      : [];
    const unique = new Map<string, RecipientRecord>();
    for (const recipient of recipients) {
      const destination = this.destinationKey(campaign, recipient.destination);
      if (campaign.channel === 'whatsapp-cloud' && this.uow && !/^[1-9]\d{6,14}$/.test(destination)) continue;
      unique.set(destination, recipient);
      if (unique.size > audienceLimit) break;
    }
    return [...unique.values()];
  }

  private reviewKey(campaign: CampaignDefinitionV1, recipients: RecipientRecord[]): string {
    const audience = recipients.map(({ destination }) => this.destinationKey(campaign, destination)).sort();
    return crypto.createHmac('sha256', config.jwt.secret)
      .update(JSON.stringify([campaign.id, campaign.updatedAt, audience]))
      .digest('hex');
  }

  private async hasOpenWhatsAppWindow(tenantId: number, destination: string, phoneNumberId?: string): Promise<boolean> {
    if (!this.uow) return false;
    return this.uow.run(tenantId, async (client) => {
      const result = await client.query(
        `SELECT 1 FROM conversations conversation WHERE company_id = $1 AND channel = 'whatsapp'
          AND external_conversation_id = $2 AND service_window_expires_at > NOW()
          AND ($3::text IS NULL OR EXISTS (
            SELECT 1 FROM messages message
            WHERE message.company_id = $1 AND message.conversation_id = conversation.id
              AND message.direction = 'inbound' AND message.provider = 'meta-cloud'
              AND message.metadata_json #>> '{metadata,phone_number_id}' = $3
              AND message.occurred_at BETWEEN NOW() - INTERVAL '24 hours' AND NOW()
          )) LIMIT 1`,
        [tenantId, destination, phoneNumberId ?? null],
      );
      return Boolean(result.rows.length);
    });
  }

  private async saveDelivery(tenantId: number, delivery: CampaignDeliveryV1): Promise<void> {
    if (!this.uow) {
      this.memoryDeliveries.set(delivery.id, delivery);
      return;
    }
    await this.uow.run(tenantId, async (client) => {
      await client.query(
        `INSERT INTO campaign_deliveries
          (id, campaign_id, tenant_id, contact_id, destination, idempotency_key, status, suppression_reason,
           provider_message_id, error_code, error_message, dispatched_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (id) DO UPDATE SET
           status = EXCLUDED.status, provider_message_id = EXCLUDED.provider_message_id,
           error_code = EXCLUDED.error_code, error_message = EXCLUDED.error_message,
           dispatched_at = EXCLUDED.dispatched_at, updated_at = NOW()`,
        [
          delivery.id, delivery.campaignId, tenantId, delivery.contactId ?? null, delivery.destination,
          delivery.idempotencyKey, delivery.status, delivery.suppressionReason ?? null, delivery.providerMessageId ?? null,
          delivery.errorCode ?? null, delivery.errorMessage ?? null, delivery.dispatchedAt ?? null,
        ],
      );
    });
  }

  async getDeliveries(campaignId: string, tenantId?: number): Promise<CampaignDeliveryV1[]> {
    if (!this.uow) {
      return [...this.memoryDeliveries.values()].filter((delivery) =>
        delivery.campaignId === campaignId && (tenantId === undefined || Number(delivery.tenantId) === tenantId));
    }
    if (tenantId === undefined) throw new CampaignRequestError(400, 'TENANT_REQUIRED', 'La consulta requiere una empresa.');

    return await this.uow.run(tenantId, async (client) => {
      const res = await client.query(
        `SELECT * FROM campaign_deliveries WHERE campaign_id = $1 AND tenant_id = $2 ORDER BY created_at ASC;`,
        [campaignId, tenantId]
      );
      return res.rows.map((row) => ({
        id: row.id,
        campaignId: row.campaign_id,
        tenantId: Number(row.tenant_id),
        contactId: row.contact_id ? Number(row.contact_id) : null,
        destination: row.destination,
        idempotencyKey: row.idempotency_key,
        status: row.status,
        suppressionReason: row.suppression_reason,
        providerMessageId: row.provider_message_id,
        errorCode: row.error_code,
        errorMessage: row.error_message,
        renderedPayload: typeof row.rendered_payload === 'string' ? JSON.parse(row.rendered_payload) : row.rendered_payload,
        dispatchedAt: row.dispatched_at ? new Date(row.dispatched_at).toISOString() : null,
        deliveredAt: row.delivered_at ? new Date(row.delivered_at).toISOString() : null,
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString(),
      }));
    });
  }
}

export const campaignDispatcher = new CampaignDispatcher(
  tenantScopedUoW, consentService, segmentationService, { whatsappTransport: new WhatsAppCampaignTransport() },
);
